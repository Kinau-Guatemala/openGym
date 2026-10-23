/* The HTTP source: an openGym instance reached over its own api, with the bearer token a pairing
   code was redeemed for (Settings → Account → Pair the mobile app), the same one the mobile app
   holds. The token is a full session of the profile, so it lives in a file only its owner can
   read: ~/.config/opengym-mcp/<host>.json, mode 0600. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const base = url => String(url).trim().replace(/\/+$/, '')

export const configDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opengym-mcp')
// One file per instance; a port stays in the name, ':' does not (Windows).
export const tokenFile = url => path.join(configDir(), new URL(base(url)).host.replace(/[^a-zA-Z0-9.-]/g, '_') + '.json')

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

const fail = (code, message) => Object.assign(new Error(message), { code })
const pairAgain = url => fail('EAUTH', `the openGym session for ${base(url)} is not valid (expired, revoked or never paired). Pair again: in openGym open Settings → Account → Pair the mobile app, then run \`node src/index.js pair ${base(url)} <CODE>\``)

async function call(url, method, p, { token, body } = {}) {
  let res
  try {
    res = await fetch(base(url) + p, {
      method,
      headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    })
  } catch (e) {
    throw fail('ENET', `cannot reach openGym at ${base(url)}: ${e.cause?.code || e.cause?.message || e.message}`)
  }
  if (res.status === 401 && token) throw pairAgain(url)
  const data = await res.json().catch(() => null)
  if (!res.ok) throw fail('EHTTP', `openGym answered ${res.status} to ${method} ${p}${data?.error ? `: ${data.error}` : ''}`)
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
    request
  }
}
