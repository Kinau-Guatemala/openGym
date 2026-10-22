// @vitest-environment happy-dom

/* The CrossFit maps through the store (lib/wods.js): a program saved or cleared per date and an
   alias picked or cleared per name, each stamped by the change, never as a whole setting; old
   programs pruned on load; an export carries them and an older backup without them imports with
   the defaults. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api.js', () => ({ api: vi.fn(), setRemoteAuth: vi.fn() }))
vi.mock('./useUI.js', () => ({ useUI: { getState: () => ({ toast: vi.fn() }) } }))

import { DEF, useStore } from './useStore.js'
import { aliasesOf, wodOf } from '../lib/wods.js'

const clone = v => JSON.parse(JSON.stringify(v))
const S = () => useStore.getState().S
const isoDaysAgo = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)

beforeEach(() => { localStorage.clear(); useStore.setState({ S: clone(DEF), user: null, ready: false }) })
afterEach(() => localStorage.clear())

describe('store actions', () => {
  it('saves and clears a program by date, stamped by the change', () => {
    const { setWod, clearWod } = useStore.getState()
    expect(setWod('2026-10-23', { title: 'A', tracks: [] })).toBe(true)
    expect(S().wods['2026-10-23']._ts).toBeGreaterThan(0)
    expect(setWod('2026-10-24', { title: 'B', tracks: [] })).toBe(true)
    expect(wodOf(S(), '2026-10-23').title).toBe('A')
    expect(S().wods['2026-10-24']._ts).toBeGreaterThan(S().wods['2026-10-23']._ts)
    const before = S().wods['2026-10-24']._ts
    expect(clearWod('2026-10-23')).toBe(true)   // right after: the clear still moves past every stamp
    expect(Object.keys(S().wods['2026-10-23'])).toEqual(['_ts'])
    expect(S().wods['2026-10-23']._ts).toBeGreaterThan(before)
    expect(wodOf(S(), '2026-10-23')).toBeNull()
    expect(wodOf(S(), '2026-10-24').title).toBe('B')
    expect(S().edited?.wods).toBeUndefined()
    expect(setWod('not a date', {})).toBe(false)
    expect(setWod('2026-10-25', null)).toBe(false)
    expect(setWod('2026-10-25', [1])).toBe(false)
    expect(clearWod('nope')).toBe(false)
  })

  it('picks and clears an alias by its normalised name', () => {
    const { setAlias, clearAlias } = useStore.getState()
    expect(setAlias('t2b', '0099')).toBe(true)
    expect(setAlias('hang cleans', '1234')).toBe(true)
    expect(clearAlias('t2b')).toBe(true)
    expect(aliasesOf(S())).toEqual({ 'hang cleans': '1234' })
    expect(S().exAliases.t2b._ts).toBeGreaterThan(0)
    expect(S().edited?.exAliases).toBeUndefined()
    expect(setAlias('', '1')).toBe(false)
    expect(setAlias('x', '')).toBe(false)
    expect(clearAlias(null)).toBe(false)
  })

  it('hypTarget is a plain setting with a default of 10, stamped when changed', () => {
    expect(S().hypTarget).toBe(10)
    useStore.getState().update(s => { s.hypTarget = 14 })
    expect(S().edited.hypTarget).toBeGreaterThan(0)
  })
})

describe('load, export and import', () => {
  it('drops programs older than 120 days when the saved copy is loaded', async () => {
    const old = isoDaysAgo(200), recent = isoDaysAgo(3)
    localStorage.setItem('gym_state_v1', JSON.stringify({ ...clone(DEF), _ts: 5, wods: { [old]: { title: 'Old', _ts: 1 }, [recent]: { title: 'New', _ts: 2 } } }))
    vi.resetModules()
    const { useStore: fresh } = await import('./useStore.js')
    expect(Object.keys(fresh.getState().S.wods)).toEqual([recent])
  })

  it('an export carries the maps; an older backup without them imports with the defaults', () => {
    useStore.getState().setWod('2026-10-23', { title: 'A' })
    useStore.getState().setAlias('t2b', '0099')
    const exported = JSON.parse(JSON.stringify(S()))
    expect(exported.wods['2026-10-23'].title).toBe('A')
    expect(exported.exAliases.t2b.exId).toBe('0099')
    expect(exported.hypTarget).toBe(10)
    const older = clone(DEF); delete older.wods; delete older.exAliases; delete older.hypTarget
    useStore.setState({ S: clone(DEF) })
    useStore.getState().importBackup({ ...older, _ts: 1, restSec: 77 })
    expect(S().restSec).toBe(77)
    expect(S().wods).toEqual({})
    expect(S().exAliases).toEqual({})
    expect(S().hypTarget).toBe(10)
  })
})

describe('logWod', () => {
  const program = { title: 'EMOM', tracks: [{ id: 'full', label: 'Full Equipment', kind: 'main', blocks: [
    { id: 'b1', format: 'emom', capMin: 10, movements: [{ id: 'm0', rawName: 'c and j', exId: '5122', dose: { reps: 2 }, rx: { male: { w: 100, unit: 'kg' } }, alts: [] }] },
  ] }] }

  it('files wod-<date> next to a live session, and a re-log edits it', () => {
    const { setWod, logWod, update } = useStore.getState()
    setWod('2026-10-13', program)
    update(s => { s.active = { id: 'live', d: '2026-10-20', start: 5, entries: [{ id: '0032', sets: [{ w: 100, r: 5, done: false }] }] } })
    const live = clone(S().active)
    const first = logWod('2026-10-13', { tracks: ['full'] }, { moves: { 'full/b1/m0': { w: 90 } } })
    expect(first.w).toMatchObject({ id: 'wod-2026-10-13', src: 'wod' })
    expect(first.prs).toEqual(['5122'])
    expect(S().active).toEqual(live)
    logWod('2026-10-13', { tracks: ['full'] }, { moves: { 'full/b1/m0': { w: 95 } } })
    const wods = S().workouts.filter(w => w.d === '2026-10-13')
    expect(wods).toHaveLength(1)
    expect(wods[0].entries[0].sets[0].w).toBe(95)
    expect(S().active).toEqual(live)
    expect(logWod('2026-10-14', { tracks: ['full'] }, {})).toBeNull()
  })
})
