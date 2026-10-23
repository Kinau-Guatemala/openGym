// Health Connect on the Android app (#200): turning it on, and keeping it in step with the log.
// What gets written is worked out in lib/health-connect.js; this file owns the native plugin
// (HealthConnectPlugin.java) and the phone's own record of what it wrote.
//
// It is a fact about this phone, not about the training log: kept in its own file in the app's
// data directory, never in S, so it does not sync to a server, ride in a backup, or switch on a
// second phone. Off until the user turns it on; nothing is asked of Health Connect before that.
//
// It also reads back what other apps put there: runs, walks, hikes and rides come into the log on
// their own (lib/health-import.js), each once, on launch and whenever the app comes back.
//
// The web build never gets here (MOBILE is a build-time flag), and iOS answers 'unsupported'.
import { MOBILE, isAndroid, readJsonFile, writeJsonFile } from './mobile.js'
import { healthRecords, planSync, writtenIds } from './health-connect.js'
import { addImported, knownIds, planImport } from './health-import.js'
import { exerciseNameFor } from './i18n-core.js'
import { EXIDX } from './exercises.js'
import { speedUnitOf } from './speed.js'

export const HEALTH_FILE = 'opengym-health.json'
const OFF = { on: false, written: {}, at: 0, error: null, readError: null, importedAt: 0 }
// How far back runs are read: what can have been missed while the app was not opened.
export const IMPORT_DAYS = 30
// The app comes back to the foreground all through a workout (music, messages, the rest timer):
// reading 30 days each time costs battery and Health Connect's per-app quota, so a resume reads
// again only this long after the last read. Launch and a just-granted permission read at once.
export const IMPORT_EVERY_MS = 15 * 60 * 1000
// What initHealthSync was given: the store's state and how to add runs to it.
let hooks = null

// Wrapped in an object, as in rest-alert.js: a Capacitor plugin proxy answers `then`, so a
// promise resolved with the bare proxy never settles.
let pluginP = null
const plugin = () => pluginP || (pluginP = (async () => {
  if (!(await isAndroid())) return null
  const { registerPlugin } = await import('@capacitor/core')
  return { HC: registerPlugin('HealthConnect') }
})().catch(() => null))

// The file's content, read once and then kept here: a save while it is off (the usual case) must
// not cost a file read, and every change to it goes through saveHealth anyway.
let cached = null
export async function loadHealth() {
  if (cached) return cached
  const f = await readJsonFile(HEALTH_FILE)
  cached = f && typeof f === 'object' ? { ...OFF, ...f, written: f.written && typeof f.written === 'object' ? f.written : {} } : { ...OFF }
  return cached
}
const saveHealth = h => { cached = h; return writeJsonFile(HEALTH_FILE, h) }

/** { status: 'available' | 'update' | 'missing' | 'unsupported', granted, read } — `granted` for writing, `read` for reading runs. */
export async function healthStatus() {
  if (!MOBILE) return { status: 'unsupported', granted: false }
  try {
    const p = await plugin()
    if (!p) return { status: 'unsupported', granted: false }
    return await p.HC.status()
  } catch { return { status: 'unsupported', granted: false } }
}

/** Health Connect's own screen for what apps wrote, or its store page where it is missing. */
export async function openHealthConnect() {
  const p = await plugin()
  if (p) await p.HC.openSettings()
}

const nameOf = e => (EXIDX[e.id] ? exerciseNameFor(EXIDX[e.id]) : (e.n || e.id))

// One sync at a time. A change that comes in while one runs is not lost: the running one is
// followed by a single further pass with the newest state.
let running = null
let again = null
const listeners = new Set()
/** Called with the file's new content after every sync, for the Settings row. */
export function onHealthChange(cb) { listeners.add(cb); return () => listeners.delete(cb) }
const told = h => { listeners.forEach(cb => { try { cb(h) } catch { /* a closed screen */ } }) }

/**
 * Writes what changed since the last sync and removes what was deleted from openGym. A no-op
 * while it is off. Resolves with the file's content afterwards; `error` is 'permission' when
 * Health Connect refused (the user took the permission back), 'unavailable' when it is gone.
 */
export function syncHealth(S) {
  if (!MOBILE) return Promise.resolve(null)
  // Not read yet: initHealthSync reads it at launch and syncs then, which covers a save made
  // before that; the save path itself never waits on the file.
  if (!cached || !cached.on) return Promise.resolve(cached)
  if (running) { again = S; return running }
  again = null
  running = (async () => {
    let h = await loadHealth()
    let next = S
    while (next) {
      if (h.on) h = await syncOnce(next, h)
      // A state that came in meanwhile, taken only now: cleared before a pass, it would lose a
      // change made while the pass was starting.
      next = again
      again = null
    }
    return h
  })().finally(() => { running = null })
  return running
}

async function syncOnce(S, h) {
  const p = await plugin()
  if (!p) return h
  const plan = planSync(healthRecords(S, { nameOf, speedUnit: speedUnitOf(S) }), h.written)
  const nothing = !plan.sessions.length && !plan.weights.length && !plan.remove.sessions.length && !plan.remove.weights.length
  if (nothing) {
    if (!h.error) return h
    // Nothing to write, but the last attempt failed: clear it once Health Connect says yes again.
    const st = await p.HC.status().catch(() => null)
    if (!(st?.status === 'available' && st.granted)) return h
    const out = { ...h, error: null }
    await saveHealth(out)
    told(out)
    return out
  }
  let out = { ...h }
  try {
    if (plan.sessions.length || plan.weights.length) {
      await p.HC.write({ sessions: plan.sessions, weights: plan.weights })
      // Written but not yet removed: kept as written, so a failed remove is tried again.
      const kept = Object.fromEntries(Object.entries(h.written).filter(([id]) => !plan.written[id]))
      out.written = { ...kept, ...plan.written }
    }
    if (plan.remove.sessions.length || plan.remove.weights.length) await p.HC.remove(plan.remove)
    out = { ...out, written: plan.written, at: Date.now(), error: null }
  } catch (e) {
    out.error = e?.code === 'permission' ? 'permission' : e?.code === 'unavailable' ? 'unavailable' : 'failed'
  }
  await saveHealth(out)
  told(out)
  return out
}

/**
 * Turning it on: asks for the permissions, then writes the whole log once and reads the runs.
 * Resolves with { ok, reason } — reason 'denied' when the user did not grant both write
 * permissions, or the status when Health Connect is not there to ask. Reading is asked for in the
 * same dialog, but writing does not wait on it: a refused read only leaves the runs out.
 */
export async function enableHealth(S) {
  const p = await plugin()
  if (!p) return { ok: false, reason: 'unsupported' }
  const st = await p.HC.status().catch(() => ({ status: 'unsupported' }))
  if (st.status !== 'available') return { ok: false, reason: st.status }
  const granted = (st.granted && st.read !== false) ? true : (await p.HC.requestPermissions().catch(() => ({ granted: false }))).granted
  if (!granted) return { ok: false, reason: 'denied' }
  const h = await loadHealth()
  await saveHealth({ ...h, on: true, error: null })
  const after = await syncHealth(S)
  if (hooks) importRuns({ force: true }).catch(() => {})
  return { ok: !after?.error, reason: after?.error || null, health: after }
}

/**
 * Turning it off stops the writing. With `removeWritten`, what openGym wrote is taken out of
 * Health Connect too; without it, it stays there as the user's own data. Rejects when the
 * removal fails, and then stays on, so nothing is left behind that the phone forgot it wrote.
 */
export async function disableHealth({ removeWritten = false } = {}) {
  if (running) await running.catch(() => {})
  const h = await loadHealth()
  if (removeWritten) {
    const ids = writtenIds(h.written)
    if (ids.sessions.length || ids.weights.length) {
      const p = await plugin()
      if (!p) throw new Error('unavailable')
      await p.HC.remove(ids)
    }
  }
  const out = { ...h, on: false, error: null, written: removeWritten ? {} : h.written }
  await saveHealth(out)
  told(out)
  return out
}

// The file as it stands with `patch`, saved and told, when that changes anything. Taken from the
// copy in memory at the time of the save, so a sync's `written` saved meanwhile is kept.
const patchHealth = async patch => {
  const h = await loadHealth()
  if (Object.entries(patch).every(([k, v]) => h[k] === v)) return h
  const out = { ...cached, ...patch }
  await saveHealth(out)
  told(out)
  return out
}

/**
 * Reads the last IMPORT_DAYS of runs, walks, hikes and rides from Health Connect and hands the
 * ones the log lacks to `add(records)` (which files them, lib/health-import.js addImported). A
 * no-op while it is off, and within IMPORT_EVERY_MS of the last read unless `force`d. The ids
 * already in the log or deleted from it go along, so the native side adds up no distance for
 * them. A refused read is kept as `readError: 'permission'`, for Settings to offer the
 * permission again; writing goes on either way. Resolves with how many were added.
 */
let importing = null
export function importRuns({ force = false, getState = hooks?.getState, add = hooks?.add } = {}) {
  if (!MOBILE || !getState || !add) return Promise.resolve(0)
  if (importing) return importing
  importing = (async () => {
    const h = await loadHealth()
    if (!h.on) return 0
    if (!force && Date.now() - (Number(h.importedAt) || 0) < IMPORT_EVERY_MS) return 0
    const p = await plugin()
    if (!p) return 0
    let records
    try {
      const since = Date.now() - IMPORT_DAYS * 864e5
      records = (await p.HC.readSessions({ since, skip: knownIds(getState()) }))?.sessions || []
    } catch (e) {
      if (e?.code === 'permission') await patchHealth({ readError: 'permission' })
      return 0
    }
    await patchHealth({ readError: null, importedAt: Date.now() })
    if (!planImport(records, getState(), { nameOf }).length) return 0
    return add(records)
  })().catch(() => 0).finally(() => { importing = null })
  return importing
}

// The store's own update, reached only once there is something to add: the store imports this
// file, so it cannot be imported back at load.
const addToStore = records => import('../store/useStore.js').then(({ useStore }) => {
  let n = 0
  useStore.getState().update(S => { n = addImported(S, records, { nameOf }) })
  return n
})

// Back in the foreground: a change synced from another device while the phone was away, or a
// permission the user granted again in Health Connect's own settings, is picked up then, and so
// is a run recorded meanwhile.
let started = false
export function initHealthSync(getState) {
  if (!MOBILE || started) return
  started = true
  hooks = { getState, add: addToStore }
  import('@capacitor/app').then(({ App }) => {
    App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) syncHealth(getState()).catch(() => {}).then(() => importRuns())
    })
  }).catch(() => {})
  // Once at launch, for a workout finished just before the app was closed. Reading the file here
  // also settles whether it is on, which the saves wait for (syncHealth).
  setTimeout(() => loadHealth().then(() => syncHealth(getState())).catch(() => {}).then(() => importRuns({ force: true })), 3000)
}
