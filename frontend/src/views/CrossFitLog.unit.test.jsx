// @vitest-environment happy-dom
// T30: the log screen's kg / lb switch. It starts at the profile's unit, shows and takes weights in
// the one picked (the Rx line too), stores them in the profile's, and a re-open keeps the pick.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { DEF, useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import CrossFitLog from './CrossFitLog.jsx'

const clone = v => JSON.parse(JSON.stringify(v))
const DATE = '2026-10-27'
const DL = '0032', CJ = '5122'
const program = { title: 'Coaches', tracks: [{ id: 'full', label: 'Full', kind: 'main', blocks: [
  { id: 'b0', label: 'Strength', format: 'strength', movements: [{ id: 'm0', raw: 'Deadlift 5', rawName: 'deadlift', exId: DL, dose: { reps: 5 }, rx: null, alts: [] }] },
  { id: 'b1', label: 'WOD', format: 'fortime', rounds: 1, movements: [{ id: 'm0', raw: '10 C&J', rawName: 'c and j', exId: CJ, dose: { reps: 10 }, rx: { male: { w: 135, unit: 'lb' }, female: { w: 95, unit: 'lb' } }, alts: [] }] },
] }] }

let root, host
async function mount() {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root.render(<MemoryRouter initialEntries={['/crossfit/log/' + DATE]}>
    <Routes>
      <Route path="/crossfit/log/:date" element={<CrossFitLog />} />
      <Route path="*" element={null} />
    </Routes>
  </MemoryRouter>))
}
const unmount = () => { act(() => root.unmount()); host.remove() }
const button = text => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === text)
const click = async text => { await act(async () => { button(text).click() }) }
// The weight fields in screen order: the strength row, the strength block's load score, the C&J.
const weights = () => [...host.querySelectorAll('.measure-field')].filter(f => f.firstChild.textContent === 'Weight')
const field = i => weights()[i].querySelector('input')
const unitOf = i => weights()[i].querySelector('i').textContent
const type = async (el, value) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { el.dispatchEvent(new Event('blur', { bubbles: true })) })
}
const pressed = () => ['kg', 'lb'].find(u => button(u).getAttribute('aria-pressed') === 'true')
const logged = () => useStore.getState().S.workouts.find(w => w.id === 'wod-' + DATE)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-28T09:00:00'))
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  useUI.setState({ sheets: [], toasts: [] })
})
afterEach(() => { if (host?.isConnected) unmount(); vi.useRealTimers() })

const start = unit => useStore.setState({ S: { ...clone(DEF), unit, wods: { [DATE]: { ...program, _ts: 1 } } }, user: null })

describe('kg / lb while logging a WOD (T30)', () => {
  it('a kg profile types in lb, stores kg, and a re-open keeps lb', async () => {
    start('kg')
    await mount()
    expect(pressed()).toBe('kg')
    expect(host.textContent).toContain('Rx 60 kg')
    expect(field(2).value).toBe('60')

    await click('lb')
    expect(host.textContent).toContain('Rx 135 lb')
    expect(field(2).value).toBe('135')
    expect([0, 1, 2].map(unitOf)).toEqual(['lb', 'lb', 'lb'])
    await type(field(0), '135')
    await type(field(1), '135')
    await type(field(2), '95')

    // back to kg: the typed values are shown converted, not changed
    await click('kg')
    expect([field(0).value, field(1).value, field(2).value]).toEqual(['61.25', '61.25', '43'])
    await click('lb')
    expect([field(0).value, field(1).value, field(2).value]).toEqual(['135', '135', '95'])

    await click('Log workout')
    const w = logged()
    expect(w.entries.find(e => e.id === DL).sets[0].w).toBe(61.25)
    expect(w.entries.find(e => e.id === CJ).sets[0].w).toBe(43)
    expect(w.wod.blocks[0].score).toEqual({ type: 'load', w: 61.25, unit: 'kg' })
    expect(w.wod.unit).toBe('lb')
    expect(useStore.getState().S.unit).toBe('kg')

    unmount()
    await mount()
    expect(pressed()).toBe('lb')
    expect([field(0).value, field(1).value, field(2).value]).toEqual(['135', '135', '95'])
    // saving the re-open again changes nothing
    await click('Save log')
    expect(logged().entries.find(e => e.id === CJ).sets[0].w).toBe(43)
    expect(logged().wod.blocks[0].score.w).toBe(61.25)
  })

  it('an lb profile works the same in reverse; a new log starts at the profile unit', async () => {
    start('lb')
    await mount()
    expect(pressed()).toBe('lb')
    expect(host.textContent).toContain('Rx 135 lb')
    await click('kg')
    expect(host.textContent).toContain('Rx 60 kg')
    await type(field(0), '60')
    await type(field(1), '100')
    await click('Log workout')
    const w = logged()
    expect(w.entries.find(e => e.id === DL).sets[0].w).toBe(132.5)
    expect(w.wod.blocks[0].score).toEqual({ type: 'load', w: 220.5, unit: 'lb' })
    // the C&J left at its Rx is logged as the profile's Rx, converted once
    expect(w.entries.find(e => e.id === CJ).sets[0].w).toBe(135)

    // another day starts at the profile's unit again
    useStore.getState().setWod('2026-10-26', program)
    unmount()
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
    await act(async () => root.render(<MemoryRouter initialEntries={['/crossfit/log/2026-10-26']}>
      <Routes><Route path="/crossfit/log/:date" element={<CrossFitLog />} /><Route path="*" element={null} /></Routes>
    </MemoryRouter>))
    expect(pressed()).toBe('lb')
  })
})
