/* opengym-mcp state — one async interface, `source.read()` / `source.user()`, over two sources:
   - file (OPENGYM_DATA): reads ./data/state-<uid>.json + db.json (read-only). Cached with an
     fs.watch + mtime fallback so a session the api server just wrote is visible on the next
     tool call without a restart.
   - HTTP (OPENGYM_URL): GET /api/data with the token `pair` stored (remote.js), for an instance
     the MCP has no disk access to (Railway). Writes (T13) go through the same source object. */
import fs from 'node:fs'
import path from 'node:path'
import { connect } from './remote.js'

const DATA_DIR = process.env.OPENGYM_DATA || path.join(process.cwd(), 'data')

// null = no state file (brand-new account); undefined = not yet loaded.
let _state = undefined
let _db = undefined
let _uid = null
let _watcher = null
let _loadedMtime = 0    // mtimeMs we last read at — used to catch watcher omissions

// null means one thing only: the file is not there (an account that never synced from a device).
// Every other failure — no permission on the mount, a truncated or corrupt file — is a real fault,
// and reporting it as "no synced state yet, sign in from a device" sends the operator to fix the
// wrong thing while the data sits there unreadable.
function readJsonOrNull(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return null
    // Node's own message repeats the path it was given, and that is the server's absolute path:
    // the basename identifies the file just as well.
    const base = path.basename(file)
    const err = new Error(`cannot read ${base}: ${e.code || e.name} — ${String(e.message).replaceAll(file, base)}`)
    err.code = 'EIO'
    throw err
  }
  try {
    return JSON.parse(raw)
  } catch (e) {
    const err = new Error(`${path.basename(file)} is not valid JSON: ${e.message}`)
    err.code = 'EIO'
    throw err
  }
}

function reloadDb() { _db = readJsonOrNull(path.join(DATA_DIR, 'db.json')) || { users: [], creds: [], subs: [], invites: [] } }

function stateFile(uid) {
  return path.join(DATA_DIR, 'state-' + uid.replace(/[^a-zA-Z0-9_-]/g, '') + '.json')
}

// Pick the uid: OPENGYM_UID env, else the only state-* file, else the only user in db.json.
// Throws listing the options if ambiguous. The sanitiser on stateFile() keeps a sneaky
// '..' in OPENGYM_UID harmless.
function resolveUid() {
  const envUid = (process.env.OPENGYM_UID || '').trim()
  if (envUid) {
    if (!/^[a-zA-Z0-9_-]+$/.test(envUid)) throw new Error(`OPENGYM_UID contains characters that aren't safe in a filename: ${JSON.stringify(envUid)}`)
    return envUid
  }
  const files = fs.readdirSync(DATA_DIR)
    .filter(f => /^state-[a-zA-Z0-9_-]+\.json$/.test(f))
    .map(f => f.replace(/^state-/, '').replace(/\.json$/, ''))
  if (files.length === 1) return files[0]
  if (files.length === 0) {
    reloadDb()
    if (_db.users.length === 1) return _db.users[0].id
    if (_db.users.length === 0) throw new Error(`no openGym users found in ${path.join(DATA_DIR, 'db.json')} — sign in at least once on a device`)
    // Multiple users in db.json but no state file yet — hit when accounts exist but none has
    // signed in on a device.
    throw ambiguousUid(_db.users.map(u => u.id))
  }
  throw ambiguousUid(files)
}

// "Which profile?" is a config question for the operator, and this message travels as a tool
// result: into the model's context and into whatever transcript it lands in. Every account id on
// the box, plus the server's absolute paths, has no business there. The count and the setting to
// change are what the model can act on; the ids and the path go to the server log on stderr,
// where the operator is already reading the startup line.
function ambiguousUid(ids) {
  console.error(`[opengym-mcp] ${ids.length} openGym profiles in ${DATA_DIR}: ${ids.join(', ')} — set OPENGYM_UID to one of them`)
  const err = new Error(`this openGym data directory holds ${ids.length} profiles — set OPENGYM_UID to the one this server should read (the ids are on the server's stderr, and in db.json under "users"[].id)`)
  err.code = 'EINVAL'
  return err
}

// The source every read goes through; null until init() succeeds, so a failed start (a stale
// token, an unreachable server) is retried on the next tool call and reported there.
let _source = null

// Idempotent. Picks the source: OPENGYM_URL is the HTTP source, else the data directory.
export async function init() {
  if (_source) return
  const url = (process.env.OPENGYM_URL || '').trim()
  if (url) {
    const remote = await connect(url)
    // A refused token drops the source, so the next call connects again with whatever `pair`
    // stored meanwhile: re-pairing needs no restart of the MCP.
    const read = async () => {
      try { return withDefaults(await remote.read()) } catch (e) {
        if (e.code === 'EAUTH' && _source?.read === read) _source = null
        throw e
      }
    }
    _source = { read, user: remote.user, remote }
    return
  }
  initFile()
  _source = FILE
}

// Picks the uid, loads db.json, attaches the watcher, primes state.
function initFile() {
  if (_uid !== null) return
  if (!fs.existsSync(DATA_DIR)) throw new Error(`OPENGYM_DATA dir does not exist: ${DATA_DIR}`)
  _uid = resolveUid()
  reloadDb()
  const file = stateFile(_uid)
  if (fs.existsSync(file)) {
    _state = withDefaults(readJsonOrNull(file))
    try { _loadedMtime = fs.statSync(file).mtimeMs } catch {}
  }
  if (_watcher) _watcher.close()
  // fs.watch is best-effort: the api server's atomic write at PUT /api/data is the source of
  // truth, and a stale read just gets corrected on the next change or the next tool call.
  try {
    _watcher = fs.watch(file, () => {
      // On change, simply clear the cache — the next getState() will re-read. Avoids reading
      // twice if the watcher fires multiple events for one atomic-write (rename + create).
      _state = undefined
      _loadedMtime = 0
    })
    // Unref'd, or the watcher alone holds the event loop open and the process outlives the
    // client that spawned it — "exits when the LLM client disconnects" stops being true the
    // moment there is a state file to watch. Most clients kill the child anyway, but one that
    // merely closes the pipe would leak a process per session. Watching is unaffected: the
    // stdio transport is what keeps the loop alive while a client is actually attached.
    _watcher.unref()
  } catch { /* fs.watch unsupported on this platform; tools will re-read on mtime change */ }
}

// Returns the state object, or null for a fresh account that never signed in on a device.
export async function getState() {
  await init()
  return _source.read()
}

// Returns the user record (id + name). No passkey material, no VAPID keys, no push subs.
export async function getUser() {
  await init()
  return _source.user()
}

const FILE = { read: async () => readFile(), user: async () => fileUser() }

function readFile() {
  const file = stateFile(_uid)
  // Re-read if the file's mtime changed since our last load — covers watcher omissions and
  // platforms with no fs.watch.
  let mtime
  try { mtime = fs.statSync(file).mtimeMs } catch {
    return _state === undefined ? null : _state
  }
  if (_state === undefined || mtime !== _loadedMtime) {
    const fresh = readJsonOrNull(file)
    if (fresh) {
      _state = withDefaults(fresh)
      _loadedMtime = mtime
    } else if (_state === undefined) {
      _state = null  // no state file at all — never signed in on a device
    }
  }
  return _state
}

function fileUser() {
  const u = _db.users.find(x => x.id === _uid) || { id: _uid, name: 'Profile', created: null }
  return { id: u.id, name: u.name, created: u.created || null }
}

export const dataDir = () => DATA_DIR

// Test-only: work against a passed-in state, not the disk.
export function _seedStateForTests(state) {
  _uid = 'test-uid'
  _db = { users: [{ id: _uid, name: 'Test', created: '2026-07-26T00:00:00.000Z' }], creds: [], subs: [], invites: [] }
  _state = state
  _loadedMtime = Number.MAX_SAFE_INTEGER   // never re-read from disk in a test
  if (_watcher) { _watcher.close(); _watcher = null }
  _source = FILE
}

// Test-only: answer from `source`, or null to pick it again from the env on the next read.
export function _useSourceForTests(source) { _source = source }

// Same shape the frontend builds on pullState — defaults merged with stored state so any
// field the app added since the snapshot was last saved shows up undefined-safe.
const withDefaults = S => (S ? Object.assign({}, defaultsShape(), S) : null)

function defaultsShape() {
  return {
    unit: 'kg', restSec: 90, sound: true, lang: 'en',
    theme: 'dark', accent: 'lime', body: 'male', targetW: null,
    bodyweight: [], routines: [], week: {}, dayPlan: {},
    exWeights: {}, workouts: [], customEx: [], gifSize: 'full',
    reminder: { on: false, time: '08:00', tz: null },
    wods: {}, exAliases: {}, hypTarget: 10, wodWarmup: false
  }
}
