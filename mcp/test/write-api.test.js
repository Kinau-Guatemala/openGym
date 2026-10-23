// The write path against the real api (api/server.js, booted on a temp data directory): the MCP
// PUTs unstamped over the revision it read and the server stamps it; a phone's push of something
// else keeps both; a write that meets another one gets the 409, runs again on the newer document
// and keeps both; a dry run never writes. Needs the api's own dependencies (`cd api && npm ci`).
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergeStates } from '../../frontend/src/lib/sync-merge.js'
import { buildDemoState } from '../../frontend/src/lib/demoSeed.js'
import { pair, connect, write } from '../src/remote.js'
import { createRoutine } from '../src/writes.js'

const SERVER = fileURLToPath(new URL('../../api/server.js', import.meta.url))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-write-api-'))
let proc, url, cookie, src

// A request as the phone makes it: the same session, `stamped: true` on its pushes (an updated
// app stamps its own changes), and on a 409 the app's own merge (useStore doPush → mergeStates).
async function api(method, p, body) {
  const res = await fetch(url + p, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) })
  return { status: res.status, data: await res.json().catch(() => null), headers: res.headers }
}
async function phonePush(change) {
  const { data } = await api('GET', '/api/data')
  let local = change(structuredClone(data.state)), rev = data.rev, wid = data.state._wid
  for (;;) {
    const r = await api('PUT', '/api/data', { state: local, baseRev: rev, baseWid: wid, stamped: true })
    if (r.status !== 409) return r
    local = mergeStates(local, r.data.state)
    rev = r.data.rev
    wid = r.data.state._wid
  }
}
// The phone read before the MCP wrote, and pushes its own change over that older copy.
async function stalePhone() {
  const { data } = await api('GET', '/api/data')
  return async change => {
    let local = change(structuredClone(data.state)), rev = data.rev, wid = data.state._wid
    const first = await api('PUT', '/api/data', { state: local, baseRev: rev, baseWid: wid, stamped: true })
    if (first.status !== 409) return first
    local = mergeStates(local, first.data.state)
    return { ...(await api('PUT', '/api/data', { state: local, baseRev: first.data.rev, baseWid: first.data.state._wid, stamped: true })), merged: true }
  }
}
const weighIn = (d, w) => s => ({ ...s, bodyweight: [...(s.bodyweight || []), { d, w, t: Date.now() }], _ts: Date.now() })
const stored = async () => (await api('GET', '/api/data')).data

beforeAll(async () => {
  proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, DATA_DIR: path.join(tmp, 'data'), PORT: '0', PASSWORD_LOGIN: '1', RP_ID: 'localhost', ORIGIN: 'http://localhost' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  fs.mkdirSync(path.join(tmp, 'data'))
  const port = await new Promise((resolve, reject) => {
    let out = ''
    proc.stdout.on('data', b => { out += b; const m = /gym-api on :(\d+)/.exec(out); if (m) resolve(m[1]) })
    proc.stderr.on('data', b => { out += b })
    proc.on('exit', code => reject(new Error(`api exited ${code}: ${out}`)))
  })
  url = `http://127.0.0.1:${port}`
  const reg = await fetch(url + '/api/register/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Diego', password: 'correct horse battery staple 42' }) })
  cookie = reg.headers.get('set-cookie').split(';')[0]
  // A profile a phone has synced: the demo's routines and history.
  const r = await api('PUT', '/api/data', { state: buildDemoState(), baseRev: 0, stamped: true })
  expect(r.status).toBe(200)
}, 30000)

afterAll(() => {
  proc?.kill()
  fs.rmSync(tmp, { recursive: true, force: true })
})

beforeEach(async () => {
  vi.stubEnv('XDG_CONFIG_HOME', path.join(tmp, 'cfg'))
  const { data } = await api('POST', '/api/pair/create')
  await pair(url, data.code)
  src = await connect(url)
})
afterEach(() => { vi.unstubAllEnvs() })

const upperA = S => createRoutine(S, { name: 'Upper A', exercises: [{ id: '0662' }, { id: '0652', sets: 4 }] })

describe('MCP writes against the api', () => {
  test('a write is server-stamped, and a phone push of something else afterwards keeps both', async () => {
    const phone = await stalePhone()                  // the phone read before the MCP wrote
    const out = await src.write(upperA)
    expect(out.retried).toBe(false)
    const routine = (await stored()).state.routines.find(r => r.id === out.result.routine_id)
    expect(routine._ts).toBeGreaterThan(0)            // stamped by the server, not by the MCP
    expect(await phone(weighIn('2026-10-01', 81.2))).toMatchObject({ status: 200, merged: true })
    const { state } = await stored()
    expect(state.routines.some(r => r.id === out.result.routine_id)).toBe(true)
    expect(state.bodyweight.some(b => b.d === '2026-10-01' && b.w === 81.2)).toBe(true)
  })

  test('a write that meets another one gets the 409, runs again on the newer copy and keeps both', async () => {
    let calls = 0
    // The phone pushes between the MCP's read and its PUT.
    const request = async (method, p, body) => {
      if (method === 'PUT' && calls++ === 0) expect((await phonePush(weighIn('2026-10-02', 80.9))).status).toBe(200)
      return src.request(method, p, body)
    }
    let runs = 0
    const out = await write(request, S => { runs++; return upperA(S) })
    expect(out.retried).toBe(true)
    expect(runs).toBe(2)
    const { state } = await stored()
    expect(state.routines.filter(r => r.name === 'Upper A' && r.id === out.result.routine_id).length).toBe(1)
    expect(state.bodyweight.some(b => b.d === '2026-10-02' && b.w === 80.9)).toBe(true)
  })

  test('a dry run never writes', async () => {
    vi.stubEnv('OPENGYM_URL', url)
    vi.resetModules()
    const { _useSourceForTests } = await import('../src/state.js')
    _useSourceForTests(null)
    const { TOOLS } = await import('../src/tools.js')
    const before = await api('GET', '/api/data/rev')
    for (const [name, args] of [
      ['create_routine', { name: 'Upper B', exercises: [{ id: '0662' }] }],
      ['assign_weekday', { weekday: 2, routine_ids: [] }],
      ['log_workout', { date: '2026-10-01', entries: [{ id: '0685', sets: [{ min: 30 }] }] }]
    ]) {
      const r = await TOOLS.find(t => t.name === name).handler(args)
      expect(r).toMatchObject({ dry_run: true, saved: false })
      expect(r.diff.length).toBeGreaterThan(0)
    }
    expect((await api('GET', '/api/data/rev')).data).toEqual(before.data)
    // …and dry_run: false through the same tool does
    const rid = (await stored()).state.routines[0].id
    const saved = await TOOLS.find(t => t.name === 'assign_weekday').handler({ weekday: 2, routine_ids: [rid], mode: 'add', dry_run: false })
    expect(saved).toMatchObject({ dry_run: false, saved: true })
    expect((await api('GET', '/api/data/rev')).data.rev).toBeGreaterThan(before.data.rev)
    expect([].concat((await stored()).state.week[2])).toContain(rid)
  })
})
