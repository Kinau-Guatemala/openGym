/* The HTTP source: an openGym instance reached over its own api, with the bearer token a pairing
   code was redeemed for (Settings → Account → Pair the mobile app), the same one the mobile app
   holds. The token is a full session of the profile, so it lives in a file only its owner can
   read: ~/.config/opengym-mcp/<host>.json, mode 0600, and only ever travels over HTTPS (plain
   HTTP to this machine aside). */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const base = url => String(url).trim().replace(/\/+$/, '')
const fail = (code, message) => Object.assign(new Error(message), { code })

// A server that takes the connection and never answers would otherwise hold a tool call for
// undici's 300 s header timeout. OPENGYM_TIMEOUT_MS is there for a slow link.
const timeoutMs = () => Number(process.env.OPENGYM_TIMEOUT_MS) || 20000

// The token is a full session of the profile, the pairing code one too, so neither crosses the
// network in cleartext: plain HTTP only to this machine, unless OPENGYM_ALLOW_HTTP=1 says the
// network in between is trusted.
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
export function checkUrl(url) {
  let u
  try { u = new URL(base(url)) } catch { throw fail('EINVAL', `not a URL: ${JSON.stringify(String(url))}`) }
  if (u.protocol === 'https:') return
  if (u.protocol !== 'http:') throw fail('EINVAL', `openGym URL must be https:// (got ${u.protocol})`)
  if (LOOPBACK.has(u.hostname) || process.env.OPENGYM_ALLOW_HTTP === '1') return
  throw fail('EINSECURE', `refusing to send the openGym session token to ${base(url)} over plain HTTP. Use the https:// address, or set OPENGYM_ALLOW_HTTP=1 if the network in between is trusted`)
}

export const configDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opengym-mcp')
// One file per instance, host and base path: two instances on one host don't share a token. A
// port stays in the name; ':' and '/' do not (Windows).
export const tokenFile = url => {
  const u = new URL(base(url))
  return path.join(configDir(), (u.host + u.pathname.replace(/\/+$/, '')).replace(/[^a-zA-Z0-9.-]/g, '_') + '.json')
}

export function loadToken(url) {
  try { return JSON.parse(fs.readFileSync(tokenFile(url), 'utf8')) } catch { return null }
}

// Written to a temp file created 0600 and renamed over the old one, so the token is never
// readable by anyone else, not even for the moment between a write and a chmod.
export function saveToken(url, data) {
  const file = tokenFile(url)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
}

const pairAgain = url => fail('EAUTH', `the openGym session for ${base(url)} is not valid (expired, revoked or never paired). Pair again: in openGym open Settings → Account → Pair the mobile app, then run \`node src/index.js pair ${base(url)} <CODE>\``)

async function call(url, method, p, { token, body } = {}) {
  checkUrl(url)
  const unreachable = e => e?.name === 'TimeoutError'
    ? fail('ENET', `openGym at ${base(url)} did not answer within ${timeoutMs() / 1000} s`)
    : e?.cause?.message === 'unexpected redirect'
      // Followed, the redirect would drop the Authorization header and come back as a 401: a
      // "pair again" for a token that is fine. Usually http:// answered by a redirect to https://.
      ? fail('EHTTP', `openGym at ${base(url)} answered ${method} ${p} with a redirect. Use the address it redirects to (https://, or the right base path) as the URL`)
      : fail('ENET', `cannot reach openGym at ${base(url)}: ${e?.cause?.code || e?.cause?.message || e?.message}`)
  let res
  try {
    res = await fetch(base(url) + p, {
      method,
      headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs())
    })
  } catch (e) {
    throw unreachable(e)
  }
  if (res.status === 401 && token) throw pairAgain(url)
  const data = await res.json().catch(e => { if (e?.name === 'TimeoutError') throw unreachable(e); return null })
  if (!res.ok) throw Object.assign(fail('EHTTP', `openGym answered ${res.status} to ${method} ${p}${data?.error ? `: ${data.error}` : ''}`), { status: res.status, data })
  return data
}

/** Redeems a pairing code and stores the session token. Returns the user it belongs to. */
export async function pair(url, code) {
  const r = await call(url, 'POST', '/api/pair/redeem', { body: { code } })
  if (!r?.token) throw fail('EHTTP', 'openGym did not return a token for that code')
  saveToken(url, { url: base(url), token: r.token, user: r.user })
  return r.user
}

/**
 * The HTTP source for `url`: checks the stored token with GET /api/me (which hands out a fresh
 * one once the old is past half its life — saved in its place), then reads with GET /api/data.
 * `request` is the authenticated call the write tools build on.
 */
export async function connect(url) {
  checkUrl(url)
  const saved = loadToken(url)
  if (!saved?.token) throw pairAgain(url)
  let token = saved.token
  const request = (method, p, body) => call(url, method, p, { token, body })
  const me = await request('GET', '/api/me')
  if (me?.token) {
    token = me.token
    saveToken(url, { ...saved, token, user: me.user })
  }
  const user = { id: me.user.id, name: me.user.name, created: null }
  return {
    user: async () => user,
    read: async () => (await request('GET', '/api/data'))?.state ?? null,
    write: mutator => write(request, mutator),
    request
  }
}

/**
 * Applies `mutator` (state → { state, … }, pure) to the profile and saves it: the document and its
 * revision from one GET /api/data (the write id is inside the document), then PUT /api/data with
 * that `baseRev`/`baseWid` and no `stamped` flag, so the server stamps the change against the copy
 * it holds. A 409 means another device wrote in between: the mutator runs again on the document
 * the conflict carries, once. Returns the mutator's result plus the new `rev`.
 */
export async function write(request, mutator) {
  let { state, rev } = await request('GET', '/api/data')
  for (let attempt = 0; ; attempt++) {
    const out = mutator(state || {})
    // Nothing changed (a day set to what it already holds): no write, no new revision.
    if (JSON.stringify(out.state) === JSON.stringify(state || {})) return { ...out, rev, retried: attempt > 0, unchanged: true }
    try {
      const r = await request('PUT', '/api/data', { state: out.state, baseRev: rev || 0, ...(typeof state?._wid === 'string' ? { baseWid: state._wid } : {}) })
      return { ...out, rev: r?.rev ?? null, retried: attempt > 0 }
    } catch (e) {
      if (e.status !== 409 || attempt > 0) {
        if (e.status === 409) throw fail('ECONFLICT', 'the profile changed twice while saving (another device is syncing). Nothing was written; try again')
        throw e
      }
      ;({ state, rev } = e.data || {})
    }
  }
}
