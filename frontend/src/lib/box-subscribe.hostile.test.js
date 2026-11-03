// @vitest-environment happy-dom
// T32 review: hostile feeds the member side must survive.
import { beforeEach, describe, expect, it } from 'vitest'
import { _reset, cachedFeed, cleanProgram, fetchFeed, httpsUrl, keepFeed, MAX_FEED_BYTES, parseFeed } from './box-subscribe.js'

const prog = (date, blocks = [{ format: 'amrap', movements: [{ rawName: 'burpees', exId: '1160' }] }]) => ({ date, tracks: [{ kind: 'main', blocks }] })
const URL1 = 'https://box.example/feed.json'
beforeEach(() => { localStorage.clear(); _reset() })

describe('hostile box feeds (T32 review)', () => {
  it('a date that is no day drops its program, not the feed', () => {
    const f = parseFeed({ v: 1, box: 'B', programs: [prog('2026-11-03'), prog('2026-13-01'), prog('2026-01-32')] })
    expect(Object.keys(f.programs)).toEqual(['2026-11-03'])
  })

  it('exercise ids stay on their own movement past a dropped rest window with the same text', () => {
    const c = cleanProgram(prog('2026-11-03', [
      { label: 'Rest', raw: '', format: 'other', movements: [] },
      { label: 'Rest', raw: '', format: 'other', movements: [{ rawName: 'walk', exId: '1160' }] },
      { label: 'Rest', raw: '', format: 'other', movements: [{ rawName: 'row', exId: '1161' }] },
    ]))
    expect(c.tracks[0].blocks.map(b => b.movements[0].exId)).toEqual(['1160', '1161'])
  })

  it('a body past the cap is cut off as it arrives', async () => {
    let sent = 0
    const body = new ReadableStream({ pull(c) { sent += 65536; c.enqueue(new Uint8Array(65536).fill(32)); if (sent >= 32 * 2 ** 20) c.close() } })
    const r = await fetchFeed(URL1, async () => Object.defineProperty(new Response(body), 'url', { value: URL1 }))
    expect(r).toEqual({ error: 'network' })
    expect(sent).toBeLessThan(4 * MAX_FEED_BYTES)
  })

  it('a feed that cleans up past twice the cap is kept in memory, not in localStorage', () => {
    const mv = Array(20).fill({ rawName: 'a' }), blocks = Array(12).fill({ format: 'amrap', movements: mv })
    const programs = Array.from({ length: 20 }, (_, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, tracks: Array(6).fill({ kind: 'main', blocks }) }))
    const feed = parseFeed({ v: 1, box: 'B', programs })
    keepFeed(URL1, feed)
    expect(localStorage.getItem('gym_box_feed_v1')).toBeNull()
    expect(cachedFeed(URL1)).toBe(feed)
  })

  it('an address too long to sync is refused', () => {
    expect(httpsUrl('https://box.example/' + 'a'.repeat(5000))).toBeNull()
    expect(httpsUrl(URL1)).toBe(URL1)
  })
})
