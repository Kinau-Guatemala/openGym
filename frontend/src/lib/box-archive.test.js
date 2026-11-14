// @vitest-environment happy-dom
// T40: the box's archive on the phone: where it is, its index and days read as untrusted input,
// the photo kept to https on the archive's own host, and the index cached for offline. Every
// fetch is a fake.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { _reset, archiveSource, cachedIndex, fetchDay, imageUrl, parseDay, parseIndex, refreshArchive } from './box-archive.js'
import { REFRESH_MS } from './box-subscribe.js'
import { archiveIndex, archivePrograms } from './box-feed.js'

const FEED = 'https://raw.githubusercontent.com/box/wods/main/feed.json'
const INDEX = 'https://raw.githubusercontent.com/box/wods/main/archive/index.json'
const program = title => ({ title, tracks: [{ label: 'Full', kind: 'main', blocks: [
  { label: 'WOD', format: 'amrap', capMin: 12, movements: [{ raw: '10 Burpees', rawName: 'burpees', exId: '1160', dose: { reps: 10 } }] },
] }] })
const res = (body, url) => ({ ok: true, status: 200, url, headers: { get: () => null }, text: async () => JSON.stringify(body) })

beforeEach(() => { localStorage.clear(); _reset() })

describe('archiveSource', () => {
  it('the subscribed feed’s archive, else the publisher’s own, else none', () => {
    expect(archiveSource(FEED, { archive: 'archive/index.json' }, null)).toBe(INDEX)
    expect(archiveSource(FEED, { programs: {} }, null)).toBe(null)
    expect(archiveSource('', null, FEED)).toBe(INDEX)
    expect(archiveSource(FEED, { programs: {} }, 'https://raw.githubusercontent.com/me/mine/main/feed.json'))
      .toBe('https://raw.githubusercontent.com/me/mine/main/archive/index.json')
    expect(archiveSource(FEED, { archive: 'http://evil.example/index.json' }, null)).toBe(null)
    expect(archiveSource('', null, null)).toBe(null)
  })
})

describe('parseIndex', () => {
  it('reads what the publisher builds, newest first', () => {
    const index = archiveIndex(archivePrograms({ '2026-09-01': program('Old'), '2026-11-03': program('New') }), { name: 'Holy Program', now: 0, images: new Set(['2026-09-01']) })
    expect(parseIndex(JSON.parse(JSON.stringify(index)))).toEqual({ box: 'Holy Program', updatedAt: 0, days: [
      { date: '2026-11-03', title: 'New', tracks: ['Full'], image: false },
      { date: '2026-09-01', title: 'Old', tracks: ['Full'], image: true },
    ] })
  })

  it('refuses what is not an index, and drops bad days', () => {
    for (const bad of [null, [], { v: 2, days: [] }, { v: 1, days: 'x' }]) expect(parseIndex(bad)).toBe(null)
    const r = parseIndex({ v: 1, box: 'B', days: [
      { date: '2026-02-31', title: 'not a day' }, 'junk', { date: '2026-10-01', title: { x: 1 }, tracks: [1, 'A'], image: 'yes' },
      { date: '2026-10-01', title: 'twice' },
    ] })
    expect(r.days).toEqual([{ date: '2026-10-01', title: '', tracks: ['A'], image: false }])
  })
})

describe('the photo', () => {
  it('is https in the archive’s own folder only', () => {
    expect(imageUrl(INDEX, '2026-09-01.jpg')).toBe('https://raw.githubusercontent.com/box/wods/main/archive/2026-09-01.jpg')
    for (const bad of ['http://raw.githubusercontent.com/box/wods/main/archive/x.jpg', 'https://evil.example/x.jpg', 'javascript:alert(1)',
      'data:image/png;base64,AAAA', '//evil.example/x.jpg', '../../../../other/repo/main/x.jpg', '/other/repo/main/x.jpg', '', null, 7]) expect(imageUrl(INDEX, bad)).toBe(null)
  })

  it('a day is read through cleanProgram, with its photo checked', () => {
    const d = parseDay({ date: '2026-09-01', ...program('Old'), image: '2026-09-01.jpg', logged: { score: 1 } }, '2026-09-01', INDEX)
    expect(d.program.title).toBe('Old')
    expect(d.program.tracks[0].blocks[0].movements[0].exId).toBe('1160')
    expect(d.image).toBe('https://raw.githubusercontent.com/box/wods/main/archive/2026-09-01.jpg')
    expect(parseDay({ date: '2026-09-01', ...program('Old'), image: 'http://evil.example/x.jpg' }, '2026-09-01', INDEX).image).toBe(null)
    expect(parseDay({ date: '2026-09-02', ...program('Old') }, '2026-09-01', INDEX)).toBe(null)
    expect(parseDay({ date: '2026-09-01', tracks: [] }, '2026-09-01', INDEX)).toBe(null)
  })

  it('fetchDay asks for <date>.json next to the index, once', async () => {
    const f = vi.fn(async url => res({ date: '2026-09-01', ...program('Old') }, url))
    expect((await fetchDay(INDEX, '2026-09-01', f)).value.program.title).toBe('Old')
    await fetchDay(INDEX, '2026-09-01', f)
    expect(f).toHaveBeenCalledTimes(1)
    expect(f.mock.calls[0][0]).toBe('https://raw.githubusercontent.com/box/wods/main/archive/2026-09-01.json')
    expect(await fetchDay(INDEX, '../feed', f)).toEqual({ error: 'invalid' })
  })
})

describe('the index on the device', () => {
  it('is cached, fetched again after 10 minutes, and kept when offline', async () => {
    const index = { v: 1, box: 'B', updatedAt: 0, days: [{ date: '2026-10-01', title: 'A', tracks: [], image: false }] }
    const ok = vi.fn(async url => res(index, url))
    await refreshArchive(INDEX, { now: 1000, fetchImpl: ok })
    expect(cachedIndex(INDEX).days[0].title).toBe('A')
    expect(await refreshArchive(INDEX, { now: 1000 + REFRESH_MS - 1, fetchImpl: ok })).toBe(null)
    _reset()   // a restart: the copy comes back from storage
    expect(cachedIndex(INDEX).days[0].title).toBe('A')
    const down = vi.fn(async () => { throw new TypeError('offline') })
    expect(await refreshArchive(INDEX, { now: 1000 + REFRESH_MS, fetchImpl: down })).toEqual({ error: 'network' })
    expect(cachedIndex(INDEX).days[0].title).toBe('A')
    expect(cachedIndex('https://other.example/archive/index.json')).toBe(null)
  })
})
