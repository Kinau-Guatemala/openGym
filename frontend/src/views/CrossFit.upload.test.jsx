// @vitest-environment happy-dom
// T18: "Add today's WOD" opens a new, empty program; it offers the box's image there, read for the
// program's own day. The list's upload still reads for tomorrow.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { DEF, useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import CrossFit, { CrossFitEdit } from './CrossFit.jsx'

const intake = vi.hoisted(() => ({ setIntakeImage: vi.fn(), image: { url: 'data:image/jpeg;base64,AAAA', w: 10, h: 10 } }))
vi.mock('../lib/wod-intake.js', async importOriginal => ({
  ...await importOriginal(),
  downscale: vi.fn(async () => intake.image),
  setIntakeImage: intake.setIntakeImage,
}))

const clone = v => JSON.parse(JSON.stringify(v))
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

  it('the list still reads for tomorrow', async () => {
    await mount('/crossfit')
    expect(button('Upload image')).toBeTruthy()
    await pick()
    expect(intake.setIntakeImage).toHaveBeenCalledWith(intake.image, '2026-10-29')
    expect(seen).toContain('/crossfit/new?shared=1')
  })

  it('tomorrow is when the image is picked, not when the list was opened', async () => {
    await mount('/crossfit')
    vi.setSystemTime(new Date('2026-10-30T09:00:00'))
    await pick()
    expect(intake.setIntakeImage).toHaveBeenCalledWith(intake.image, '2026-10-31')
  })
})
