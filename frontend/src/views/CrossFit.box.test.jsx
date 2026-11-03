// @vitest-environment happy-dom
// T32: the box feed on the member's side. Subscribing from Settings → CrossFit (a pasted address
// or a scanned QR, both checked by fetching), the box's programs in the CrossFit list with the
// member's own winning, the read-only view, Log and Edit copying the program into the member's
// own, and unsubscribing. Every fetch is a fake.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { DEF, useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { _reset, cachedFeed, keepFeed, parseFeed } from '../lib/box-subscribe.js'
import CrossFit, { CrossFitBox, CrossFitSettings } from './CrossFit.jsx'

const scan = vi.hoisted(() => ({ code: null }))
vi.mock('../lib/scan.js', () => ({ scanCode: vi.fn(async () => scan.code) }))
vi.mock('../lib/mobile.js', async orig => ({ ...await orig(), MOBILE: true }))

const URL1 = 'https://raw.githubusercontent.com/box/wods/main/feed.json'
const TODAY = '2026-10-28', TOMORROW = '2026-10-29', PAST = '2026-10-26'
const clone = v => JSON.parse(JSON.stringify(v))
const published = title => ({ title, tracks: [{ label: 'Full', kind: 'main', blocks: [
  { label: 'WOD', format: 'amrap', capMin: 12, raw: '', movements: [{ raw: '10 Burpees', rawName: 'burpees', exId: '1160', dose: { reps: 10 } }] },
] }] })
const FEED = { v: 1, box: 'Holy Program', updatedAt: TODAY + 'T06:00:00Z', programs: [
  { date: PAST, ...published('Past one') }, { date: TODAY, ...published('Box today') }, { date: TOMORROW, ...published('Box tomorrow') },
] }
const ok = body => ({ ok: true, status: 200, url: URL1, headers: { get: () => null }, text: async () => JSON.stringify(body) })

let root, host, sheetHost, sheetRoot, toasts, unsub, at
function Where() { at = useLocation().pathname; return null }
function Settings() { const S = useStore(s => s.S); return <CrossFitSettings S={S} update={fn => useStore.getState().update(fn)} /> }
async function mount(entry) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root.render(<MemoryRouter initialEntries={[entry]}>
    <Where />
    <Routes>
      <Route path="/crossfit" element={<CrossFit />} />
      <Route path="/crossfit/box/:date" element={<CrossFitBox />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="*" element={null} />
    </Routes>
  </MemoryRouter>))
}
async function sheet() {
  const top = useUI.getState().sheets.at(-1)
  sheetHost = document.createElement('div'); document.body.appendChild(sheetHost); sheetRoot = createRoot(sheetHost)
  await act(async () => sheetRoot.render(top.render(() => useUI.getState().closeSheet(top.id))))
  return sheetHost
}
const flush = async () => { for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve() }) }
const button = (el, text) => [...el.querySelectorAll('button')].find(b => b.textContent.trim() === text)
const click = async el => { if (!el) throw new Error('nothing to click'); await act(async () => el.click()); await flush() }
const type = async (el, value) => {
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  await act(async () => { set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) })
}
const subscribed = () => { keepFeed(URL1, parseFeed(FEED)); useStore.setState({ S: { ...useStore.getState().S, boxFeed: URL1 } }) }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(TODAY + 'T09:00:00'))
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear(); _reset()
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('no network in tests') }))
  toasts = []
  unsub = useUI.subscribe(s => { if (s.toastMsg) toasts.push(s.toastMsg) })
  useUI.setState({ sheets: [], toastMsg: '' })
  useStore.setState({ S: clone(DEF), user: null, ready: true })
  scan.code = null
})
afterEach(() => {
  unsub()
  act(() => root.unmount())
  host.remove()
  if (sheetHost) { act(() => sheetRoot.unmount()); sheetHost.remove(); sheetHost = null }
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('subscribing', () => {
  it('a pasted address is fetched and checked, then kept; the box’s name shows', async () => {
    fetch.mockImplementation(async () => ok(FEED))
    await mount('/settings')
    await type(host.querySelector('input'), URL1)
    await click(button(host, 'Subscribe'))
    expect(fetch).toHaveBeenCalledWith(URL1, expect.anything())
    expect(useStore.getState().S.boxFeed).toBe(URL1)
    expect(toasts).toContain('Subscribed to Holy Program')
    expect(host.textContent).toContain('Holy Program')
    expect(cachedFeed(URL1).programs[TODAY].title).toBe('Box today')
  })

  it('a scanned QR goes the same way', async () => {
    fetch.mockImplementation(async () => ok(FEED))
    scan.code = { value: URL1, fmt: 'qr' }
    await mount('/settings')
    await click(button(host, 'Scan QR code'))
    expect(useStore.getState().S.boxFeed).toBe(URL1)
  })

  it('an http address is refused without being fetched', async () => {
    await mount('/settings')
    await type(host.querySelector('input'), 'http://example.com/feed.json')
    await click(button(host, 'Subscribe'))
    expect(fetch).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Only https addresses can be used.')
    expect(useStore.getState().S.boxFeed).toBe('')
  })

  it('an address that is not a box feed is refused', async () => {
    fetch.mockImplementation(async () => ok({ hello: 'world' }))
    await mount('/settings')
    await type(host.querySelector('input'), URL1)
    await click(button(host, 'Subscribe'))
    expect(host.textContent).toContain('This address is not a box feed.')
    expect(useStore.getState().S.boxFeed).toBe('')
    expect(cachedFeed(URL1)).toBe(null)
  })

  it('unsubscribing clears the address and the cache', async () => {
    subscribed()
    await mount('/settings')
    await click(button(host, 'Unsubscribe'))
    expect(useStore.getState().S.boxFeed).toBe('')
    expect(localStorage.getItem('gym_box_feed_v1')).toBe(null)
  })
})

describe('the program list', () => {
  it('a feed unsubscribed on another device goes, but not before the profile has loaded', async () => {
    keepFeed(URL1, parseFeed(FEED))
    useStore.setState({ ready: false })
    await mount('/crossfit')
    expect(cachedFeed(URL1)).toBeTruthy()
    await act(async () => useStore.setState({ ready: true }))
    expect(cachedFeed(URL1)).toBe(null)
  })

  it('shows the box’s programs for today and tomorrow, and earlier ones folded away', async () => {
    subscribed()
    await mount('/crossfit')
    expect(host.textContent).toContain('From Holy Program')
    expect(host.textContent).toContain('Box today')
    expect(host.textContent).toContain('Box tomorrow')
    expect(host.querySelector('details').textContent).toContain('Past one')
    expect(fetch).not.toHaveBeenCalled()   // fetched a moment ago
  })

  it('the member’s own program wins, with a link to the box’s', async () => {
    subscribed()
    useStore.getState().setWod(TODAY, { title: 'Mine', tracks: [] })
    await mount('/crossfit')
    expect(host.textContent).toContain('Mine')
    expect(host.textContent).not.toContain('Box today')
    await click(button(host, 'Box version available'))
    expect(at).toBe('/crossfit/box/' + TODAY)
  })

  it('fetches again once 10 minutes have passed', async () => {
    subscribed()
    vi.setSystemTime(new Date(TODAY + 'T09:11:00'))
    await mount('/crossfit')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('Log copies the box program into the member’s own and opens the log', async () => {
    subscribed()
    await mount('/crossfit')
    const row = [...host.querySelectorAll('.item')].find(r => r.textContent.includes('Box today'))
    await click(button(row, 'Log'))
    expect(at).toBe('/crossfit/log/' + TODAY)
    const own = useStore.getState().S.wods[TODAY]
    expect(own.title).toBe('Box today')
    expect(own.tracks[0].blocks[0].movements[0].exId).toBe('1160')
  })
})

describe('the box program', () => {
  it('a movement with no catalogue exercise is resolved from its name and the member’s picks when copied', async () => {
    const p = published('Unresolved')
    p.tracks[0].blocks[0].movements = [
      { raw: '10 Burpees', rawName: 'burpees', exId: null, dose: { reps: 10 } },
      { raw: 'Zorro walk', rawName: 'zorro walk', exId: null, dose: {}, alts: [{ rawName: 'burpees', exId: null }] },
    ]
    keepFeed(URL1, parseFeed({ ...FEED, programs: [{ date: TODAY, ...p }] }))
    useStore.setState({ S: { ...useStore.getState().S, boxFeed: URL1 } })
    useStore.getState().setAlias('zorro walk', '0043')
    await mount('/crossfit/box/' + TODAY)
    await click(button(host, 'Log'))
    const ms = useStore.getState().S.wods[TODAY].tracks[0].blocks[0].movements
    expect(ms.map(m => m.exId)).toEqual(['1160', '0043'])
    expect(ms[1].alts[0].exId).toBe('1160')
  })

  it('is shown read-only, and Edit copies it into the editor', async () => {
    subscribed()
    await mount('/crossfit/box/' + TOMORROW)
    expect(host.textContent).toContain('Box tomorrow')
    expect(host.textContent).toContain('10 Burpees')
    expect(host.querySelector('[aria-label="Include"]')).toBe(null)
    expect(button(host, 'Add movement')).toBe(undefined)
    expect(button(host, 'Log')).toBe(undefined)   // tomorrow's
    await click(button(host, 'Edit'))
    expect(at).toBe('/crossfit/edit/' + TOMORROW)
    expect(useStore.getState().S.wods[TOMORROW].title).toBe('Box tomorrow')
  })

  it('replaces the member’s own program only once they say so, and a later feed leaves the copy alone', async () => {
    subscribed()
    useStore.getState().setWod(TODAY, { title: 'Mine', tracks: [] })
    await mount('/crossfit/box/' + TODAY)
    await click(button(host, 'Log'))
    expect(useStore.getState().S.wods[TODAY].title).toBe('Mine')
    await click(button(await sheet(), 'Replace'))
    expect(useStore.getState().S.wods[TODAY].title).toBe('Box today')
    keepFeed(URL1, parseFeed({ ...FEED, programs: [{ date: TODAY, ...published('Changed by the box') }] }))
    expect(useStore.getState().S.wods[TODAY].title).toBe('Box today')
  })
})
