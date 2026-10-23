// The source the tool tests read through. By default the file source, seeded in memory; with
// MCP_TEST_SOURCE=http (the `http` project in vitest.config.js) the same tests read every state
// over real HTTP from a stub api, through the real pairing-token file and GET /api/me + /api/data.
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _seedStateForTests, _useSourceForTests } from '../src/state.js'
import { saveToken } from '../src/remote.js'

export const HTTP = process.env.MCP_TEST_SOURCE === 'http'
export const TOKEN = 'stub-token'

let current = null

/** Makes `S` the state every tool reads (null: a profile that never synced). */
export function seed(S) {
  current = S
  if (!HTTP) _seedStateForTests(S)
}

/**
 * A stub of the openGym api: GET /api/me and GET /api/data for one bearer token, serving
 * whatever was last seeded (serialised per request, so a test that mutates S after seeding is
 * read the way it would be after a sync). `routes` adds or overrides handlers by 'METHOD /path';
 * `tokens` are the bearer tokens it accepts.
 */
export function stubApi(routes = {}, tokens = [TOKEN]) {
  const all = {
    'GET /api/me': () => [200, { user: { id: 'test-uid', name: 'Test', admin: false } }],
    'GET /api/data': () => [200, { state: current, rev: 1 }],
    ...routes
  }
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    body = body ? JSON.parse(body) : null
    const route = all[req.method + ' ' + req.url]
    const authed = tokens.some(t => req.headers.authorization === 'Bearer ' + t)
    const [status, out] = !route ? [404, { error: 'not found' }]
      : !authed && !req.url.startsWith('/api/pair/') ? [401, { error: 'not signed in' }]
        : route(req, body)
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(out))
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) })
  }))
}

/** In HTTP mode: starts the stub, pairs a token for it in a temp config dir, points the MCP at it. */
export async function startSource() {
  if (!HTTP) return async () => {}
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cfg-'))
  const prev = { cfg: process.env.XDG_CONFIG_HOME, url: process.env.OPENGYM_URL }
  const api = await stubApi()
  process.env.XDG_CONFIG_HOME = dir
  process.env.OPENGYM_URL = api.url
  saveToken(api.url, { url: api.url, token: TOKEN })
  _useSourceForTests(null)
  return async () => {
    await api.close()
    for (const [k, v] of [['XDG_CONFIG_HOME', prev.cfg], ['OPENGYM_URL', prev.url]]) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
