// @vitest-environment happy-dom
// T40: the box photo follows the program. A read program carries `photo` (the image's sha256,
// set by the server for the publishing account); review and save keep it under whatever date the
// program is saved, and editing a saved program keeps it too.
import React, { act } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { DEF, useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { CrossFitEdit } from './CrossFit.jsx'

const PHOTO = 'c0ffee'.repeat(10) + 'c0ff'
const clone = v => JSON.parse(JSON.stringify(v))
const program = () => ({ title: 'Lunes', photo: PHOTO, tracks: [{ id: 'full', label: 'Full', kind: 'main', blocks: [
  { id: 'b0', label: 'WOD', format: 'amrap', movements: [{ id: 'm0', raw: '10 Burpees', rawName: 'burpees', exId: '1160', dose: { reps: 10 }, alts: [] }] },
] }] })

let root, host
async function mount(entry) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root.render(<MemoryRouter initialEntries={[entry]}>
    <Routes>
      <Route path="/crossfit/new" element={<CrossFitEdit />} />
      <Route path="/crossfit/edit/:date" element={<CrossFitEdit />} />
      <Route path="*" element={null} />
    </Routes>
  </MemoryRouter>))
}
const save = () => act(async () => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save program').click())

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  useUI.setState({ sheets: [], toastMsg: '' })
  useStore.setState({ S: clone(DEF), user: null, ready: true })
})
afterEach(() => { act(() => root.unmount()); host.remove() })

it('a program read for one day and reviewed into another keeps its photo on that day', async () => {
  await mount({ pathname: '/crossfit/new', state: { draft: program(), date: '2026-10-29' } })
  await save()
  expect(useStore.getState().S.wods['2026-10-29'].photo).toBe(PHOTO)
})

it('editing a saved program keeps its photo', async () => {
  useStore.getState().setWod('2026-10-27', program())
  await mount('/crossfit/edit/2026-10-27')
  const title = [...host.querySelectorAll('input')].find(i => i.value === 'Lunes')
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  await act(async () => { set.call(title, 'Lunes 2'); title.dispatchEvent(new Event('input', { bubbles: true })) })
  await save()
  const w = useStore.getState().S.wods['2026-10-27']
  expect([w.title, w.photo]).toEqual(['Lunes 2', PHOTO])
})
