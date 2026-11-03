// @vitest-environment happy-dom
// T32: the box feed on the member's phone. The feed is somebody else's file, so most of this is
// what it must not get through: other schemes, redirects off https, junk, a hostile program, and
// fields the publisher never meant to share. No real network: every fetch is a fake.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  REFRESH_MS, MAX_FEED_BYTES, boxRows, cachedFeed, clearBoxFeed, cleanProgram, fetchFeed, forgetOtherFeeds,
  httpsUrl, keepFeed, parseFeed, refreshBoxFeed, _reset,
} from './box-subscribe.js'
import { buildFeed } from './box-feed.js'

const URL1 = 'https://raw.githubusercontent.com/box/wods/main/feed.json'
const CACHE_KEY = 'gym_box_feed_v1'

// A program as T31 publishes it: no editor ids, the allowlisted fields only.
const program = (extra = {}) => ({
  title: 'Lunes',
  tracks: [{ label: 'Full Equipment', kind: 'main', blocks: [
    { label: 'WOD', format: 'fortime', capMin: 10, scheme: '21-15-9', benchmark: 'Fran', raw: 'FRAN', movements: [
      { raw: 'Thrusters 95/65', rawName: 'thrusters', exId: '3305', dose: {}, rx: { male: { w: 95, unit: 'lb' }, female: { w: 65, unit: 'lb' } }, alts: [] },
      { raw: 'Pull-ups', rawName: 'pull-ups', exId: '0652', dose: {}, alts: [{ rawName: 'ring rows', exId: '0043', dose: {} }] },
    ] },
  ] }],
  ...extra,
})
const feedOf = (programs, extra = {}) => ({ v: 1, box: 'Holy Program', updatedAt: '2026-10-28T08:00:00Z', programs, ...extra })
const res = (body, { status = 200, url = URL1, headers = {} } = {}) => ({
  ok: status >= 200 && status < 300, status, url,
  headers: { get: k => headers[k.toLowerCase()] ?? null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
})

beforeEach(() => { localStorage.clear(); _reset() })

describe('httpsUrl', () => {
  it('takes https only', () => {
    expect(httpsUrl('  ' + URL1 + ' ')).toBe(URL1)
    for (const bad of ['http://example.com/feed.json', 'javascript:alert(1)', 'file:///etc/passwd', 'data:application/json,{}',
      'ftp://x/feed.json', 'example.com/feed.json', '', null, 'https://user:pass@example.com/feed.json']) expect(httpsUrl(bad)).toBe(null)
  })
})

describe('parseFeed', () => {
  it('reads a v1 feed: the box, when, and each program with ids filled in', () => {
    const f = parseFeed(feedOf([{ date: '2026-10-28', ...program() }]))
    expect(f.box).toBe('Holy Program')
    expect(f.updatedAt).toBe(Date.parse('2026-10-28T08:00:00Z'))
    const p = f.programs['2026-10-28']
    expect(p.title).toBe('Lunes')
    expect(p.tracks[0].id).toBe('t0')
    expect(p.tracks[0].blocks[0].id).toBe('b0')
    expect(p.tracks[0].blocks[0].movements.map(m => m.id)).toEqual(['m0', 'm1'])
  })

  it('reads back what the publisher builds (T31 buildFeed), editor ids and private fields gone', () => {
    const saved = { ...program(), _ts: 5, tracks: program().tracks.map(tr => ({ ...tr, id: 'full', blocks: tr.blocks.map(b => ({ ...b, id: 'b3', include: false,
      movements: b.movements.map((m, i) => ({ ...m, id: 'm' + (i + 4), via: 'guess' })) })) })) }
    saved.tracks[0].blocks[0].movements[1].exId = 'abc123'   // a custom exercise of the publisher's
    const feed = JSON.parse(JSON.stringify(buildFeed({ '2026-10-28': saved }, { name: 'Holy Program', today: '2026-10-28', now: 0 })))
    const p = parseFeed(feed).programs['2026-10-28']
    expect(p.tracks[0].blocks[0].id).toBe('b0')
    expect(p.tracks[0].blocks[0].movements.map(m => [m.id, m.exId])).toEqual([['m0', '3305'], ['m1', null]])
    expect(p.tracks[0].blocks[0].movements[1].alts[0].exId).toBe('0043')
    expect(JSON.stringify(p)).not.toMatch(/"(include|via|_ts)"/)
  })

  it('keeps the feed’s catalogue exercise ids, and only those', () => {
    const p = program()
    p.tracks[0].blocks[0].movements[1].exId = 'not-an-exercise'
    const ms = parseFeed(feedOf([{ date: '2026-10-28', ...p }])).programs['2026-10-28'].tracks[0].blocks[0].movements
    expect(ms[0].exId).toBe('3305')
    expect(ms[1].exId).toBe(null)
    expect(ms[1].alts[0].exId).toBe('0043')
  })

  it('refuses anything that is not a v1 box feed', () => {
    for (const bad of [null, [], 'x', {}, feedOf([], { v: 2 }), feedOf([], { v: '1' }), feedOf([], { box: '' }), feedOf([], { box: 5 }), feedOf({})])
      expect(parseFeed(bad)).toBe(null)
  })

  it('drops a program that fails the parsed-program checks, and keeps the others', () => {
    const bad = program()
    bad.tracks[0].blocks[0].format = 'party'
    const tooBig = program()
    tooBig.tracks[0].blocks[0].movements = Array.from({ length: 40 }, () => ({ rawName: 'burpees', dose: { reps: 5 } }))
    const f = parseFeed(feedOf([
      { date: '2026-10-27', ...bad },
      { date: '2026-10-26', ...tooBig },
      { date: '2026-10-25', title: 'x', tracks: 'nope' },
      { date: '2026-10-24', title: 'empty', tracks: [] },
      { date: 'yesterday', ...program() },
      { date: '2026-02-31', ...program() },
      { date: '2026-10-28', ...program() },
      { date: '2026-10-28', ...program({ title: 'second' }) },
      'junk', null,
    ]))
    expect(Object.keys(f.programs)).toEqual(['2026-10-28'])
    expect(f.programs['2026-10-28'].title).toBe('Lunes')
  })

  it('lets no unknown field through, at any level', () => {
    const p = program({ logged: { score: 1 }, picks: { a: 1 }, _ts: 9, script: '<x>' })
    Object.assign(p.tracks[0], { secret: 1, include: { b0: false } })
    Object.assign(p.tracks[0].blocks[0], { include: false, note: 'mine', __proto__x: 1 })
    Object.assign(p.tracks[0].blocks[0].movements[0], { logged: { w: 100 }, via: 'guess', candidates: [{ exId: '0001' }], onclick: 'x' })
    const json = JSON.parse(JSON.stringify(p).replace('"thrusters"', '"thrusters","__proto__":{"polluted":1}'))
    const out = JSON.stringify(parseFeed(feedOf([{ date: '2026-10-28', ...json }])))
    for (const k of ['logged', 'picks', '_ts', 'script', 'secret', 'include', 'note', '__proto__x', 'via', 'candidates', 'onclick', 'polluted'])
      expect(out).not.toContain(`"${k}"`)
    expect({}.polluted).toBeUndefined()
  })

  it('clips long text the way a parsed program is clipped', () => {
    const p = program({ title: 'x'.repeat(5000) })
    p.tracks[0].blocks[0].movements[0].raw = 'y'.repeat(5000)
    const q = parseFeed(feedOf([{ date: '2026-10-28', ...p }], { box: 'B'.repeat(500) }))
    expect(q.box.length).toBe(60)
    expect(q.programs['2026-10-28'].title.length).toBe(120)
    expect(q.programs['2026-10-28'].tracks[0].blocks[0].movements[0].raw.length).toBe(200)
  })

  it('matches exercise ids past a rest window that validateWod drops', () => {
    const p = program()
    p.tracks[0].blocks.unshift({ label: 'MIN 7-8', format: 'other', raw: 'REST', movements: [] })
    const b = parseFeed(feedOf([{ date: '2026-10-28', ...p }])).programs['2026-10-28'].tracks[0].blocks
    expect(b).toHaveLength(1)
    expect(b[0].movements[0].exId).toBe('3305')
  })
})

describe('fetchFeed', () => {
  const good = feedOf([{ date: '2026-10-28', ...program() }])

  it('never asks for a non-https address', async () => {
    const f = vi.fn()
    expect(await fetchFeed('http://example.com/feed.json', f)).toEqual({ error: 'https' })
    expect(f).not.toHaveBeenCalled()
  })

  it('reads a good feed, without credentials', async () => {
    const f = vi.fn(async () => res(good))
    const r = await fetchFeed(URL1, f)
    expect(r.feed.box).toBe('Holy Program')
    expect(f.mock.calls[0][1]).toMatchObject({ credentials: 'omit', cache: 'no-store' })
  })

  it('refuses a redirect off https, an error, junk and an oversized file', async () => {
    expect(await fetchFeed(URL1, async () => res(good, { url: 'http://evil.example/feed.json' }))).toEqual({ error: 'https' })
    expect(await fetchFeed(URL1, async () => res('nope', { status: 404 }))).toEqual({ error: 'network' })
    expect(await fetchFeed(URL1, async () => { throw new TypeError('offline') })).toEqual({ error: 'network' })
    expect(await fetchFeed(URL1, async () => res('<html>'))).toEqual({ error: 'invalid' })
    expect(await fetchFeed(URL1, async () => res({ hello: 1 }))).toEqual({ error: 'invalid' })
    expect(await fetchFeed(URL1, async () => res(good, { headers: { 'content-length': String(MAX_FEED_BYTES + 1) } }))).toEqual({ error: 'network' })
    expect(await fetchFeed(URL1, async () => res(' '.repeat(MAX_FEED_BYTES + 1)))).toEqual({ error: 'network' })
  })
})

describe('refreshing and the cache', () => {
  const good = feedOf([{ date: '2026-10-28', ...program() }])

  it('fetches at most every 10 minutes, and keeps the last good feed on the device', async () => {
    const f = vi.fn(async () => res(good))
    expect((await refreshBoxFeed(URL1, { now: 1000, fetchImpl: f })).feed).toBeTruthy()
    expect(await refreshBoxFeed(URL1, { now: 1000 + REFRESH_MS - 1, fetchImpl: f })).toBe(null)
    expect(f).toHaveBeenCalledTimes(1)
    await refreshBoxFeed(URL1, { now: 1000 + REFRESH_MS, fetchImpl: f })
    expect(f).toHaveBeenCalledTimes(2)
    expect(JSON.parse(localStorage.getItem(CACHE_KEY)).url).toBe(URL1)
    await refreshBoxFeed(URL1, { now: 1001 + REFRESH_MS, fetchImpl: f, force: true })
    expect(f).toHaveBeenCalledTimes(3)
  })

  it('a failed fetch does not ask again at once, and the cached copy still shows (offline)', async () => {
    await refreshBoxFeed(URL1, { now: 0, fetchImpl: async () => res(good) })
    const off = vi.fn(async () => { throw new TypeError('offline') })
    expect(await refreshBoxFeed(URL1, { now: REFRESH_MS, fetchImpl: off })).toEqual({ error: 'network' })
    expect(await refreshBoxFeed(URL1, { now: REFRESH_MS + 1, fetchImpl: off })).toBe(null)
    _reset()   // the app opened again: memory gone, the device's copy read back
    expect(cachedFeed(URL1).programs['2026-10-28'].title).toBe('Lunes')
  })

  it('a malformed feed leaves the cached one alone; a hostile program in a good one is dropped', async () => {
    await refreshBoxFeed(URL1, { now: 0, fetchImpl: async () => res(good) })
    await refreshBoxFeed(URL1, { now: REFRESH_MS, fetchImpl: async () => res({ v: 1, box: 'x', programs: 'all of them' }) })
    expect(cachedFeed(URL1).box).toBe('Holy Program')
    await refreshBoxFeed(URL1, { now: 2 * REFRESH_MS, fetchImpl: async () => res(feedOf([{ date: '2026-10-28', tracks: [{ kind: 'evil' }] }])) })
    expect(cachedFeed(URL1).programs).toEqual({})
  })

  it('is kept out of the synced state', async () => {
    const { useStore } = await import('../store/useStore.js')
    await refreshBoxFeed(URL1, { now: 0, fetchImpl: async () => res(good) })
    expect(JSON.stringify(useStore.getState().S)).not.toContain('Holy Program')
  })

  it('unsubscribing clears the cache, and a fetch still in flight writes nothing', async () => {
    let answer
    const pending = refreshBoxFeed(URL1, { now: 0, fetchImpl: () => new Promise(r => { answer = r }) })
    clearBoxFeed()
    answer(res(good))
    await pending
    expect(localStorage.getItem(CACHE_KEY)).toBe(null)
    keepFeed(URL1, parseFeed(good), 0)
    clearBoxFeed()
    expect(localStorage.getItem(CACHE_KEY)).toBe(null)
    expect(cachedFeed(URL1)).toBe(null)
  })

  it('a feed cached for another address is not shown, and goes', () => {
    keepFeed(URL1, parseFeed(good), 0)
    expect(cachedFeed('https://other.example/feed.json')).toBe(null)
    forgetOtherFeeds(URL1)
    expect(cachedFeed(URL1)).toBeTruthy()
    forgetOtherFeeds('')
    expect(localStorage.getItem(CACHE_KEY)).toBe(null)
  })
})

describe('boxRows', () => {
  const p = cleanProgram(program())
  const feed = { box: 'Holy', programs: { '2026-10-20': p, '2026-10-26': p, '2026-10-27': p, '2026-10-28': p, '2026-10-29': p, '2026-10-30': p } }
  it('today and tomorrow, the days before newest first; the member’s own program wins', () => {
    const r = boxRows(feed, d => d === '2026-10-27' || d === '2026-10-29', '2026-10-28', '2026-10-29')
    expect(r.next.map(x => x.date)).toEqual(['2026-10-28'])
    expect(r.earlier.map(x => x.date)).toEqual(['2026-10-26', '2026-10-20'])
  })
  it('nothing without a feed', () => {
    expect(boxRows(null, () => false, '2026-10-28', '2026-10-29')).toEqual({ next: [], earlier: [] })
  })
})
