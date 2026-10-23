import { describe, expect, it } from 'vitest'
import { addImported, knownIds, planImport } from './health-import.js'
import { healthRecords } from './health-connect.js'
import { stampDeletions } from './sync-merge.js'

const at = (d, hh, mm = 0) => new Date(2026, 9, d, hh, mm).getTime()
const run = (id, extra = {}) => ({
  id, start: at(20, 7), end: at(20, 7, 45), type: 'running', distanceM: 9000,
  clientRecordId: null, packageName: 'com.garmin.android.apps.connectmobile', ...extra,
})
// The same 45-minute run on another day, so records of different sessions never overlap.
const runOn = (d, id, extra = {}) => run(id, { start: at(d, 7), end: at(d, 7, 45), ...extra })
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
    const out = planImport(types.map((type, i) => runOn(1 + i, type, { type })), state())
    expect(out.map(w => w.entries[0].id)).toEqual(['0685', '2197', '2258', '2258', '5214', '2138'])
  })

  it('takes walks and hikes from 20 minutes on, runs and rides of any length', () => {
    const lasting = (d, id, type, min) => run(id, { type, start: at(d, 7), end: at(d, 7) + min * 60000 })
    const recs = [
      lasting(1, 'walk15', 'walking', 15), lasting(2, 'walk25', 'walking', 25), lasting(3, 'walk20', 'walking', 20),
      lasting(4, 'run10', 'running', 10), lasting(5, 'hike15', 'hiking', 15), lasting(6, 'bike5', 'biking_stationary', 5),
    ]
    expect(planImport(recs, state()).map(w => w.id)).toEqual(['hc-walk25', 'hc-walk20', 'hc-run10', 'hc-bike5'])
  })

  it('leaves the speed out when Health Connect knows no distance', () => {
    expect(planImport([run('a1', { distanceM: null })], state())[0].entries[0].sets[0]).toEqual({ min: 45, done: true })
  })

  it('skips what openGym wrote itself, from either package or by its client id', () => {
    const recs = [
      runOn(1, 'own1', { packageName: 'gt.kinau.opengym' }),
      runOn(2, 'own2', { packageName: 'gt.kinau.opengym.test' }),
      runOn(3, 'own3', { packageName: 'ch.duartesantos.opengym' }),
      runOn(4, 'own4', { clientRecordId: 'opengym-w-123' }),
      runOn(5, 'other', { packageName: 'gt.kinau.opengymnast' }),
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

  it('takes one run recorded by two apps once, keeping the copy with the distance', () => {
    const garmin = run('g1', { start: at(20, 7, 1), end: at(20, 7, 44), distanceM: 9000 })
    const strava = run('s1', { packageName: 'com.strava', distanceM: null })
    const out = planImport([strava, garmin], state())
    expect(out.map(w => w.id)).toEqual(['hc-g1'])
    // Both without distance: the longer one wins.
    expect(planImport([{ ...garmin, distanceM: null }, strava], state()).map(w => w.id)).toEqual(['hc-s1'])
  })

  it('adds nothing over a run already logged by hand, in a WOD, or imported before', () => {
    const byHand = { id: 'w1', d: '2026-10-20', start: at(20, 7, 5), end: at(20, 7, 50),
      entries: [{ id: '0685', target: { mode: 'cardio' }, sets: [{ min: 45, speed: 10, done: true }] }] }
    expect(planImport([run('a1')], state([byHand]))).toEqual([])
    const wod = { id: 'wod-2026-10-20', src: 'wod', d: '2026-10-20', start: at(20, 6, 50), end: at(20, 8),
      entries: [{ id: '2142', sets: [{ mode: 'cardio', min: 10, done: true }] }] }
    expect(planImport([run('a1')], state([wod]))).toEqual([])
    const imported = planImport([run('a1')], state())
    expect(planImport([run('b1', { packageName: 'com.strava' })], state(imported))).toEqual([])
  })

  it('still adds a run beside a lifting session, a planned cardio row, or a run at another time', () => {
    const lift = { id: 'w1', d: '2026-10-20', start: at(20, 7), end: at(20, 8),
      entries: [{ id: '0025', target: { mode: 'reps' }, sets: [{ w: 60, r: 8, done: true }, { min: 10, done: false }] }] }
    expect(planImport([run('a1')], state([lift])).map(w => w.id)).toEqual(['hc-a1'])
    // Overlapping by less than half the shorter one: two sessions.
    const morning = run('m1'), later = run('l1', { start: at(20, 7, 30), end: at(20, 8, 30) })
    expect(planImport([morning, later], state()).map(w => w.id)).toEqual(['hc-m1', 'hc-l1'])
    expect(planImport([runOn(18, 'x1'), runOn(19, 'x2')], state()).map(w => w.id)).toEqual(['hc-x1', 'hc-x2'])
  })

  it('keeps a deleted run out, and its copy from a second app with it', () => {
    const deleted = state([], { deleted: { workouts: { 'hc-a1': 5 } } })
    expect(planImport([run('a1'), run('b1', { packageName: 'com.strava' })], deleted)).toEqual([])
    expect(planImport([runOn(22, 'c1')], deleted).map(w => w.id)).toEqual(['hc-c1'])
  })

  it('names the ids it already knows, present or deleted, for the native side to skip', () => {
    const S = state([{ id: 'hc-a1' }, { id: 'w1' }], { deleted: { workouts: { 'hc-b1': 5, 'hc-c1': -6, w2: 7 } } })
    expect(knownIds(S)).toEqual(['a1', 'b1'])
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
