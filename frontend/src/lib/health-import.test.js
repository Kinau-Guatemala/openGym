import { describe, expect, it } from 'vitest'
import { addImported, planImport } from './health-import.js'
import { healthRecords } from './health-connect.js'
import { stampDeletions } from './sync-merge.js'

const at = (d, hh, mm = 0) => new Date(2026, 9, d, hh, mm).getTime()
const run = (id, extra = {}) => ({
  id, start: at(20, 7), end: at(20, 7, 45), type: 'running', distanceM: 9000,
  clientRecordId: null, packageName: 'com.garmin.android.apps.connectmobile', ...extra,
})
const state = (workouts = [], extra = {}) => ({ unit: 'kg', workouts, ...extra })

describe('planImport', () => {
  it('turns a run into one workout with a single cardio row', () => {
    expect(planImport([run('a1')], state())).toEqual([{
      id: 'hc-a1', d: '2026-10-20', start: at(20, 7), end: at(20, 7, 45), routineIds: [], routineId: null,
      name: '0685', src: 'hc', prs: [],
      entries: [{ id: '0685', sets: [{ min: 45, speed: 12, done: true }], topW: null, target: { mode: 'cardio' } }],
    }])
  })

  it('files each type under its exercise, and leaves out what it cannot place', () => {
    const types = ['running', 'running_treadmill', 'walking', 'hiking', 'biking', 'biking_stationary', 'swimming']
    const out = planImport(types.map(type => run(type, { type })), state())
    expect(out.map(w => w.entries[0].id)).toEqual(['0685', '2197', '2258', '2258', '5214', '2138'])
  })

  it('leaves the speed out when Health Connect knows no distance', () => {
    expect(planImport([run('a1', { distanceM: null })], state())[0].entries[0].sets[0]).toEqual({ min: 45, done: true })
  })

  it('skips what openGym wrote itself, from either package or by its client id', () => {
    const recs = [
      run('own1', { packageName: 'gt.kinau.opengym' }),
      run('own2', { packageName: 'gt.kinau.opengym.test' }),
      run('own3', { packageName: 'ch.duartesantos.opengym' }),
      run('own4', { clientRecordId: 'opengym-w-123' }),
      run('other', { packageName: 'gt.kinau.opengymnast' }),
    ]
    expect(planImport(recs, state()).map(w => w.id)).toEqual(['hc-other'])
  })

  it('does not bring back a run deleted in openGym', () => {
    const S = state([])
    addImported(S, [run('a1')], { now: 1 })
    const next = { ...S, workouts: [] }
    stampDeletions(S, next, 2)
    expect(next.deleted.workouts['hc-a1']).toBeGreaterThan(0)
    expect(planImport([run('a1')], next)).toEqual([])
  })

  it('skips sessions without real times and repeated ids', () => {
    expect(planImport([run('a1', { end: at(20, 7) }), run('a2'), run('a2')], state()).map(w => w.id)).toEqual(['hc-a2'])
  })
})

describe('addImported', () => {
  it('files runs in date order, stamped, and a second import is a no-op', () => {
    const lift = { id: 'w1', d: '2026-10-21', start: at(21, 18), end: at(21, 19), entries: [] }
    const S = state([lift])
    expect(addImported(S, [run('a1')], { now: 5 })).toBe(1)
    expect(S.workouts.map(w => w.id)).toEqual(['hc-a1', 'w1'])
    expect(S.workouts[0]._ts).toBe(5)
    const before = JSON.stringify(S)
    expect(addImported(S, [run('a1')], { now: 6 })).toBe(0)
    expect(JSON.stringify(S)).toBe(before)
  })

  it('is never written back to Health Connect', () => {
    const S = state([])
    addImported(S, [run('a1')])
    expect(healthRecords(S, { nameOf: e => e.id }).sessions).toEqual([])
  })
})
