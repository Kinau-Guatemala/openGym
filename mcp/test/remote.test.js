// The HTTP source's credentials: pairing, the token file, renewal on start, and what a dead
// token looks like. Against the stub api in test/source.js; temp config dirs only.
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stubApi, TOKEN } from './source.js'
import { pair, connect, tokenFile, saveToken, loadToken } from '../src/remote.js'

const USER = { id: 'u1', name: 'Diego', admin: true }
let dir, api

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cfg-'))
  vi.stubEnv('XDG_CONFIG_HOME', dir)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  if (api) await api.close()
  api = null
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('pair', () => {
  test('redeems the code and keeps { token, user } in a 0600 file named for the host', async () => {
    let sent = null
    api = await stubApi({ 'POST /api/pair/redeem': (req, body) => { sent = body; return [200, { token: TOKEN, user: USER }] } })
    expect(await pair(api.url + '/', 'abc123')).toEqual(USER)
    expect(sent).toEqual({ code: 'abc123' })
    const file = tokenFile(api.url)
    expect(path.dirname(file)).toBe(path.join(dir, 'opengym-mcp'))
    expect(path.basename(file)).toMatch(/^127\.0\.0\.1_\d+\.json$/)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ url: api.url, token: TOKEN, user: USER })
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
  })

  test('a bad code is the server\'s own message, and nothing is written', async () => {
    api = await stubApi({ 'POST /api/pair/redeem': () => [400, { error: 'invalid or expired code' }] })
    await expect(pair(api.url, 'nope')).rejects.toThrow(/400 .*invalid or expired code/)
    expect(fs.existsSync(tokenFile(api.url))).toBe(false)
  })
})

describe('connect', () => {
  test('reads the user from /api/me and the state from /api/data', async () => {
    api = await stubApi({
      'GET /api/me': () => [200, { user: USER }],
      'GET /api/data': () => [200, { state: { unit: 'lb' }, rev: 4 }]
    })
    saveToken(api.url, { url: api.url, token: TOKEN, user: USER })
    const src = await connect(api.url)
    expect(await src.user()).toEqual({ id: 'u1', name: 'Diego', created: null })
    expect(await src.read()).toEqual({ unit: 'lb' })
  })

  test('a token past half-life is renewed on start: saved, and used from then on', async () => {
    api = await stubApi({
      'GET /api/me': req => [200, { user: USER, ...(req.headers.authorization === 'Bearer ' + TOKEN ? { token: 'renewed' } : {}) }],
      'GET /api/data': req => [200, { state: { by: req.headers.authorization }, rev: 1 }]
    }, [TOKEN, 'renewed'])
    saveToken(api.url, { url: api.url, token: TOKEN, user: USER })
    const src = await connect(api.url)
    expect(loadToken(api.url).token).toBe('renewed')
    expect(fs.statSync(tokenFile(api.url)).mode & 0o777).toBe(0o600)
    expect(await src.read()).toEqual({ by: 'Bearer renewed' })
  })

  test('a token the server refuses says to pair again', async () => {
    api = await stubApi({}, [])
    saveToken(api.url, { url: api.url, token: 'tok-SECRET-42' })
    const err = await connect(api.url).catch(e => e)
    expect(err.code).toBe('EAUTH')
    expect(err.message).toMatch(/Pair again/)
    expect(err.message).toContain(`pair ${api.url} <CODE>`)
    expect(err.message).not.toContain('tok-SECRET-42')
  })

  test('never paired says to pair, without calling the server', async () => {
    const err = await connect('http://127.0.0.1:9').catch(e => e)
    expect(err.code).toBe('EAUTH')
  })

  test('an unreachable server says so', async () => {
    api = await stubApi()
    const url = api.url
    await api.close()
    api = null
    saveToken(url, { url, token: TOKEN })
    const err = await connect(url).catch(e => e)
    expect(err.code).toBe('ENET')
    expect(err.message).toMatch(/cannot reach openGym at/)
  })
})

describe('state.js picks the HTTP source from OPENGYM_URL', () => {
  test('getState and getUser answer from the api, with the app defaults merged in', async () => {
    api = await stubApi({ 'GET /api/data': () => [200, { state: { unit: 'lb' }, rev: 1 }] })
    saveToken(api.url, { url: api.url, token: TOKEN })
    vi.resetModules()
    vi.stubEnv('OPENGYM_URL', api.url)
    vi.stubEnv('OPENGYM_DATA', path.join(dir, 'does-not-exist'))
    const { getState, getUser } = await import('../src/state.js')
    const S = await getState()
    expect(S.unit).toBe('lb')
    expect(S.workouts).toEqual([])
    expect((await getUser()).name).toBe('Test')
  })
})
