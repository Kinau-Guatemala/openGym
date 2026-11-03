// @vitest-environment happy-dom
// T29: every CrossFit switch says what it does, under the switch (the first block's on the log
// screen, where blocks repeat) and all together in the header's ? sheet.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { DEF, useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { CrossFitEdit, HELP } from './CrossFit.jsx'
import CrossFitLog from './CrossFitLog.jsx'

const clone = v => JSON.parse(JSON.stringify(v))
const block = (id, extra) => ({ id, label: id, format: 'amrap', movements: [{ id: 'm0', raw: '10 Burpees', rawName: 'burpees', exId: '1160', dose: { reps: 10 } }], ...extra })
const program = { title: 'Coaches', tracks: [{ id: 'full', label: 'Full', kind: 'main', blocks: [block('Warm', { warmup: true }), block('WOD'), block('Finisher')] }] }

let root, host, sheetHost, sheetRoot
async function mount(entry) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root.render(<MemoryRouter initialEntries={[entry]}>
    <Routes>
      <Route path="/crossfit/edit/:date" element={<CrossFitEdit />} />
      <Route path="/crossfit/log/:date" element={<CrossFitLog />} />
    </Routes>
  </MemoryRouter>))
}
// The top sheet, rendered where the test can reach it (the app's sheet host isn't mounted here).
async function renderSheet() {
  sheetHost = document.createElement('div'); document.body.appendChild(sheetHost); sheetRoot = createRoot(sheetHost)
  const sheet = useUI.getState().sheets.at(-1)
  await act(async () => sheetRoot.render(sheet.render(() => useUI.getState().closeSheet(sheet.id))))
}
const count = (el, text) => el.textContent.split(text).length - 1
const help = async () => {
  await act(async () => host.querySelector('button[aria-label="What the switches do"]').click())
  await renderSheet()
}
const card = name => [...host.querySelectorAll('.card')].find(c => c.textContent.startsWith(name))

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  useUI.setState({ sheets: [], toasts: [] })
  useStore.setState({ S: { ...clone(DEF), wods: { '2026-10-27': { ...program, _ts: 1 } } }, user: null })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  if (sheetHost) { act(() => sheetRoot.unmount()); sheetHost.remove(); sheetHost = null }
})

describe('the log screen', () => {
  it('explains Include on the first block and Rx on the first included one, once each', async () => {
    await mount('/crossfit/log/2026-10-27')
    expect(count(host, HELP.includeLog())).toBe(1)
    expect(card('Warm').textContent).toContain(HELP.includeLog())
    // The warm-up starts left out, so its Rx row isn't there: the WOD's explains Rx.
    expect(count(host, HELP.rx())).toBe(1)
    expect(card('WOD').textContent).toContain(HELP.rx())
    expect(card('Finisher').textContent).not.toContain(HELP.rx())
  })

  // T30's kg / lb switch still reaches every block the explained list renders, not just the first.
  it('the kg / lb switch converts a later block’s weight', async () => {
    const wod = block('WOD', { format: 'fortime', rounds: 1, movements: [{ id: 'm0', raw: '10 C&J', rawName: 'c and j', exId: '5122', dose: { reps: 10 }, rx: { male: { w: 135, unit: 'lb' }, female: { w: 95, unit: 'lb' } }, alts: [] }] })
    useStore.setState({ S: { ...clone(DEF), unit: 'kg', wods: { '2026-10-27': { ...program, tracks: [{ ...program.tracks[0], blocks: [block('Warm', { warmup: true }), wod] }], _ts: 1 } } } })
    await mount('/crossfit/log/2026-10-27')
    const weight = () => [...card('WOD').querySelectorAll('.measure-field')].find(f => f.firstChild.textContent === 'Weight')
    expect([weight().querySelector('input').value, weight().querySelector('i').textContent]).toEqual(['60', 'kg'])
    await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === 'lb').click())
    expect([weight().querySelector('input').value, weight().querySelector('i').textContent]).toEqual(['135', 'lb'])
    expect(card('WOD').textContent).toContain(HELP.rx())
  })

  it('the ? sheet lists Include, Rx and the score', async () => {
    await mount('/crossfit/log/2026-10-27')
    await help()
    const rows = [...sheetHost.querySelectorAll('.lrow')].map(r => r.textContent)
    expect(rows).toEqual([`Include${HELP.includeLog()}`, `Rx${HELP.rx()}`, `Score${HELP.score()}`])
  })
})

describe('the program editor', () => {
  it('explains Include on the first block only', async () => {
    await mount('/crossfit/edit/2026-10-27')
    expect(count(host, HELP.include())).toBe(1)
    expect(card('Warm').textContent).toContain(HELP.include())
  })

  it('the ? sheet lists Include, Warm-up and Each side', async () => {
    await mount('/crossfit/edit/2026-10-27')
    await help()
    const rows = [...sheetHost.querySelectorAll('.lrow')].map(r => r.textContent)
    expect(rows).toEqual([`Include${HELP.include()}`, `Warm-up${HELP.warmup()}`, `Each side${HELP.perSide()}`])
  })

  it('the block and movement sheets explain Warm-up and Each side', async () => {
    await mount('/crossfit/edit/2026-10-27')
    await act(async () => card('WOD').querySelector('[role=button], .row > div').click())
    await renderSheet()
    expect(sheetHost.textContent).toContain(HELP.warmup())
    act(() => sheetRoot.unmount()); sheetHost.remove(); sheetHost = null
    await act(async () => [...card('WOD').querySelectorAll('div')].find(d => d.textContent === '10 Burpees').click())
    await renderSheet()
    expect(sheetHost.textContent).toContain(HELP.perSide())
  })
})
