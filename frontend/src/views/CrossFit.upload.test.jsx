// @vitest-environment happy-dom
// T18: "Add today's WOD" opens a new, empty program; it offers the box's image there, read for the
// program's own day, with no question. T20: the list's upload and a Share ask which day first.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { DEF, useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import CrossFit, { CrossFitEdit, UploadImage, whichDaySheet } from './CrossFit.jsx'
import { currentIntake, initShareIntake } from '../lib/wod-intake.js'

const intake = vi.hoisted(() => ({ setIntakeImage: vi.fn(), image: { url: 'data:image/jpeg;base64,AAAA', w: 10, h: 10 } }))
const share = vi.hoisted(() => ({ cb: null }))
vi.mock('../lib/mobile.js', async importOriginal => ({ ...await importOriginal(), onSharedImage: cb => { share.cb = cb } }))
vi.mock('../lib/wod-intake.js', async importOriginal => ({
  ...await importOriginal(),
  downscale: vi.fn(async () => intake.image),
  setIntakeImage: intake.setIntakeImage,
}))

const clone = v => JSON.parse(JSON.stringify(v))
// An UploadImage on its own, for its go(day) contract.
const upload = { el: null }
let root, host, seen = []

// Every place the router went: the intake screen sends an image it doesn't hold back to the list.
function Where() { const l = useLocation(); seen.push(l.pathname + l.search); return null }
async function mount(entry) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root.render(<MemoryRouter initialEntries={[entry]}>
    <Routes>
      <Route path="/crossfit" element={<CrossFit />} />
      <Route path="/crossfit/new" element={<CrossFitEdit />} />
      <Route path="/crossfit/edit/:date" element={<CrossFitEdit />} />
      <Route path="/upload" element={upload.el} />
    </Routes>
    <Where />
  </MemoryRouter>))
}
const button = (text, el = host) => [...el.querySelectorAll('button')].find(b => b.textContent.trim() === text)
// The top sheet, rendered where the test can reach it (the app's sheet host isn't mounted here).
let sheetHost, sheetRoot
function renderSheet() {
  if (!sheetHost) { sheetHost = document.createElement('div'); document.body.appendChild(sheetHost); sheetRoot = createRoot(sheetHost) }
  const sheet = useUI.getState().sheets.at(-1)
  sheetRoot.render(sheet.render(() => useUI.getState().closeSheet(sheet.id)))
}
const pick = async () => {
  const input = host.querySelector('input[type=file]')
  Object.defineProperty(input, 'files', { value: [new File(['x'], 'wod.jpg', { type: 'image/jpeg' })], configurable: true })
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => { await Promise.resolve() })
}
const type = (el, value) => {
  Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
const program = { title: 'Coaches', tracks: [{ id: 'full', label: 'Full', kind: 'main', blocks: [{ id: 'b0', label: 'WOD', format: 'amrap', movements: [{ id: 'm0', raw: '10 Burpees', rawName: 'burpees', exId: '1160', dose: { reps: 10 } }] }] }] }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-28T09:00:00'))
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  intake.setIntakeImage.mockClear()
  seen = []
  useUI.setState({ sheets: [], toasts: [] })
  useStore.setState({ S: { ...clone(DEF), wods: { '2026-10-27': { ...program, _ts: 1 } } }, user: null })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  if (sheetHost) { act(() => sheetRoot.unmount()); sheetHost.remove(); sheetHost = null }
  vi.useRealTimers()
})

describe('Upload image on a new program (T18)', () => {
  it('Add today’s WOD offers it, and reads the image for the editor’s date', async () => {
    await mount('/crossfit/new?date=2026-10-28')
    expect(button('Upload image')).toBeTruthy()
    await pick()
    expect(intake.setIntakeImage).toHaveBeenCalledWith(intake.image, '2026-10-28')
    expect(seen).toContain('/crossfit/new?shared=1')
  })

  it('reads for the date picked in the editor, and today when the field is cleared', async () => {
    await mount('/crossfit/new?date=2026-10-28')
    const date = host.querySelector('input[type=date]')
    await act(async () => { type(date, '2026-10-30') })
    await pick()
    // a date alone is not an edit an upload throws away: no question asked
    expect(useUI.getState().sheets).toHaveLength(0)
    expect(intake.setIntakeImage).toHaveBeenLastCalledWith(intake.image, '2026-10-30')
    act(() => root.unmount()); host.remove()
    await mount('/crossfit/new?date=2026-10-28')
    await act(async () => { type(host.querySelector('input[type=date]'), '') })
    await pick()
    expect(intake.setIntakeImage).toHaveBeenLastCalledWith(intake.image, '2026-10-28')
  })

  it('asks before throwing away a title typed first', async () => {
    await mount('/crossfit/new?date=2026-10-28')
    await act(async () => { type(host.querySelector('input[placeholder="Optional"]'), 'Monday') })
    await pick()
    expect(intake.setIntakeImage).not.toHaveBeenCalled()
    const sheets = useUI.getState().sheets
    expect(sheets).toHaveLength(1)
    const sheetHost = document.createElement('div'); document.body.appendChild(sheetHost)
    const sheetRoot = createRoot(sheetHost)
    act(() => sheetRoot.render(sheets[0].render(() => {})))
    expect(sheetHost.textContent).toContain('Discard changes?')
    await act(async () => { [...sheetHost.querySelectorAll('button')].find(b => b.textContent.trim() === 'Discard').click() })
    expect(intake.setIntakeImage).toHaveBeenCalledWith(intake.image, '2026-10-28')
    act(() => sheetRoot.unmount()); sheetHost.remove()
  })

  it('is not offered on an existing program, nor on a draft the intake handed over', async () => {
    await mount('/crossfit/edit/2026-10-27')
    expect(host.textContent).toContain('Edit program')
    expect(button('Upload image')).toBeUndefined()
    act(() => root.unmount()); host.remove()
    await mount({ pathname: '/crossfit/new', state: { draft: program, date: '2026-10-28' } })
    expect(host.textContent).toContain('New program')
    expect(button('Upload image')).toBeUndefined()
    // the manual path, with the image the intake could not read: it has "Read the image again"
    act(() => root.unmount()); host.remove()
    await mount({ pathname: '/crossfit/new', state: { image: intake.image.url, reason: 'off', date: '2026-10-28' } })
    expect(host.textContent).toContain('Posted image')
    expect(button('Upload image')).toBeUndefined()
  })

  it('goes away once a block has a movement', async () => {
    await mount('/crossfit/new?date=2026-10-28')
    expect(button('Upload image')).toBeTruthy()
    await act(async () => { button('Add block').click() })
    await act(async () => { renderSheet() })
    await act(async () => { button('Done', sheetHost).click() })
    await act(async () => { button('Add movement').click() })
    await act(async () => { renderSheet() })
    await act(async () => { type(sheetHost.querySelector('input[maxlength="120"]'), '10 Burpees') })
    await act(async () => { button('Done', sheetHost).click() })
    expect(host.textContent).toContain('10 Burpees')
    expect(button('Upload image')).toBeUndefined()
  })
})

describe('Which day, from the list and a Share (T20)', () => {
  const day = (label, el = sheetHost) => [...el.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(label))
  const listPick = async () => {
    await mount('/crossfit')
    await pick()
    await act(async () => { renderSheet() })
  }

  it('asks before reading, Today highlighted in the morning; Today reads for today', async () => {
    await listPick()
    expect(intake.setIntakeImage).not.toHaveBeenCalled()
    expect(sheetHost.textContent).toContain('Which day is this program for?')
    expect(day('Today').className).toContain('primary')
    expect(day('Tomorrow').className).not.toContain('primary')
    expect(day('Today').textContent).toContain('Wed 28 Oct')
    await act(async () => { day('Today').click() })
    expect(useUI.getState().sheets).toHaveLength(0)
    expect(intake.setIntakeImage).toHaveBeenCalledWith(intake.image, '2026-10-28')
    expect(seen).toContain('/crossfit/new?shared=1')
  })

  it('highlights Tomorrow from noon, and Tomorrow reads for tomorrow', async () => {
    vi.setSystemTime(new Date('2026-10-28T18:00:00'))
    await listPick()
    expect(day('Tomorrow').className).toContain('primary')
    expect(day('Today').className).not.toContain('primary')
    await act(async () => { day('Tomorrow').click() })
    expect(intake.setIntakeImage).toHaveBeenCalledWith(intake.image, '2026-10-29')
  })

  it('Other day reads for the date picked', async () => {
    await listPick()
    await act(async () => { day('Other day').click() })
    await act(async () => { renderSheet() })
    await act(async () => { type(sheetHost.querySelector('input[type=date]'), '2026-11-02') })
    await act(async () => { renderSheet() })
    await act(async () => { button('Continue', sheetHost).click() })
    expect(intake.setIntakeImage).toHaveBeenCalledWith(intake.image, '2026-11-02')
  })

  it('Cancel reads nothing', async () => {
    await listPick()
    await act(async () => { button('Cancel', sheetHost).click() })
    expect(useUI.getState().sheets).toHaveLength(0)
    expect(intake.setIntakeImage).not.toHaveBeenCalled()
    expect(seen).not.toContain('/crossfit/new?shared=1')
  })

  it('says when the day already has a program, and still allows it', async () => {
    useStore.setState({ S: { ...useStore.getState().S, wods: { '2026-10-29': { ...program, _ts: 1 } } } })
    await listPick()
    expect(sheetHost.textContent).toContain('Replaces the program saved for Thu 29 Oct')
    expect(sheetHost.textContent.match(/Replaces/g)).toHaveLength(1)
    await act(async () => { day('Tomorrow').click() })
    expect(intake.setIntakeImage).toHaveBeenCalledWith(intake.image, '2026-10-29')
  })

  it('the days are when the image is picked, not when the list was opened', async () => {
    await mount('/crossfit')
    vi.setSystemTime(new Date('2026-10-30T09:00:00'))
    await pick()
    await act(async () => { renderSheet() })
    await act(async () => { day('Tomorrow').click() })
    expect(intake.setIntakeImage).toHaveBeenCalledWith(intake.image, '2026-10-31')
  })

  it('a shared image shows the sheet first, then is read for the day picked', async () => {
    await mount('/crossfit')
    initShareIntake(() => {}, whichDaySheet, async () => intake.image)
    const before = currentIntake()
    window.location.hash = ''
    await act(async () => { await share.cb({ mime: 'image/jpeg', data: 'AAAA' }) })
    expect(useUI.getState().sheets).toHaveLength(1)
    expect(currentIntake()).toBe(before)
    expect(window.location.hash).toBe('')
    await act(async () => { renderSheet() })
    expect(sheetHost.textContent).toContain('Which day is this program for?')
    await act(async () => { day('Today').click() })
    expect(currentIntake()).toMatchObject({ date: '2026-10-28', image: intake.image, phase: 'pending' })
    expect(window.location.hash).toBe('#/crossfit/new?shared=1')
    window.location.hash = ''
  })

  it('a second Share while the sheet is open replaces it: only the newest image is read', async () => {
    await mount('/crossfit')
    const first = vi.fn(), second = vi.fn()
    await act(async () => { whichDaySheet(first); whichDaySheet(second) })
    expect(useUI.getState().sheets).toHaveLength(1)
    await act(async () => { renderSheet() })
    await act(async () => { day('Today').click() })
    expect(second).toHaveBeenCalledWith('2026-10-28')
    expect(first).not.toHaveBeenCalled()
  })
})

describe('UploadImage reads only for a real day (T20)', () => {
  const event = new MouseEvent('click')
  it('a forwarded click event is not a day: it falls back to date()', async () => {
    upload.el = <UploadImage date={() => '2026-10-30'} ask={go => go(event)} />
    await mount('/upload')
    await pick()
    expect(intake.setIntakeImage).toHaveBeenCalledWith(intake.image, '2026-10-30')
  })

  it('no day and no date() reads nothing, and does not throw', async () => {
    for (const arg of [undefined, event, 'next week']) {
      upload.el = <UploadImage ask={go => go(arg)} />
      await mount('/upload')
      await pick()
      act(() => root.unmount()); host.remove()
    }
    await mount('/crossfit')
    expect(intake.setIntakeImage).not.toHaveBeenCalled()
    expect(seen).not.toContain('/crossfit/new?shared=1')
  })
})
