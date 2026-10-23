// The write tools' pure changes (src/writes.js) and the tools around them on the file source:
// what each change produces, what it refuses, and that a dry run saves nothing. The HTTP write
// path against a real api is test/write-api.test.js.
import { describe, test, expect, beforeEach } from 'vitest'
import { buildDemoState } from '../../frontend/src/lib/demoSeed.js'
import { anchorsByWorkout } from '../../frontend/src/lib/recovery.js'
import { buildSessionEntries } from '../../frontend/src/lib/session-start.js'
import { isWarmupRow } from '../../frontend/src/lib/workout-model.js'
import { createRoutine, updateRoutine, assignWeekday, logWorkout } from '../src/writes.js'
import { _seedStateForTests } from '../src/state.js'
import { TOOLS } from '../src/tools.js'

const SQUAT = '0043', PUSHUP = '0662', RUN = '0685', CURL = '0294'
let S
beforeEach(() => { S = buildDemoState(); S.unit = 'kg' })

describe('createRoutine', () => {
  test('builds a routine from the app defaults plus what was asked, and leaves the input alone', () => {
    const before = JSON.stringify(S)
    const { state, diff, result } = createRoutine(S, {
      name: ' Lower A ', progression: 'double',
      exercises: [{ id: SQUAT, sets: 4, reps: 12, reps_min: 8, rest_sec: 120 }, { id: PUSHUP }, { id: RUN, min: 25 }]
    })
    expect(JSON.stringify(S)).toBe(before)
    const r = state.routines.at(-1)
    expect(r).toMatchObject({ id: result.routine_id, name: 'Lower A', prog: 'double' })
    expect(r.ex).toEqual([
      { id: SQUAT, sets: 4, reps: 12, repsMin: 8, weight: 0, mode: 'reps', restSec: 120 },
      { id: PUSHUP, sets: 3, reps: 10, weight: 0, mode: 'reps', bodyweight: true },
      { id: RUN, sets: 1, min: 25, speed: 8 }
    ])
    expect(state.routines.length).toBe(S.routines.length + 1)
    expect(diff[0]).toBe('+ routine "Lower A" (progression: double)')
    expect(diff[1]).toMatch(/^ {2}\+ 0043 barbell full squat: 4 × 8–12, rest 120 s$/)
  })

  test('refuses an id that is not an exercise, naming it', () => {
    expect(() => createRoutine(S, { name: 'X', exercises: [{ id: SQUAT }, { id: 'back squat' }, { id: '99999' }] }))
      .toThrow(/not exercise ids .*: back squat, 99999/)
  })

  test('takes the profile\'s own custom exercises', () => {
    S.customEx = [{ id: 'c-sled', n: 'Sled sprint', bp: 'upper legs' }]
    expect(createRoutine(S, { name: 'X', exercises: [{ id: 'c-sled' }] }).state.routines.at(-1).ex[0].id).toBe('c-sled')
  })

  test('its first session takes the lifting history, never a metcon row', () => {
    S.workouts.push(
      { id: 'lift', d: '2026-07-20', start: Date.parse('2026-07-20T18:00:00Z'), end: Date.parse('2026-07-20T19:00:00Z'), name: 'Legs', entries: [{ id: SQUAT, target: { mode: 'reps', sets: 1 }, sets: [{ w: 80, r: 8, done: true }] }] },
      { id: 'wod-2026-07-22', d: '2026-07-22', src: 'wod', start: Date.parse('2026-07-22T18:00:00Z'), end: Date.parse('2026-07-22T19:00:00Z'), name: 'WOD', entries: [{ id: SQUAT, noProg: true, sets: [{ w: 40, r: 15, wodRir: 5, done: true }] }] }
    )
    const { state, result } = createRoutine(S, { name: 'Lower A', exercises: [{ id: SQUAT, sets: 3, reps: 8 }] })
    const r = state.routines.find(x => x.id === result.routine_id)
    const work = buildSessionEntries(state, r)[0].sets.filter(s => !isWarmupRow(s))
    expect(work[0].w).toBe(80)
  })
})

describe('updateRoutine', () => {
  test('replaces the list; an exercise that stays keeps its own settings', () => {
    const r0 = S.routines[0]
    const [keep, drop] = r0.ex
    r0.ex[0] = { ...keep, restSec: 150, inc: 5, sg: 'ss1' }
    r0.ex[1] = { ...drop, sg: 'ss1' }
    const { state, diff } = updateRoutine(S, { routine_id: r0.id, name: 'Push B', exercises: [{ id: keep.id, sets: 5 }, { id: CURL }] })
    const r = state.routines.find(x => x.id === r0.id)
    expect(r.name).toBe('Push B')
    expect(r.ex.map(e => e.id)).toEqual([keep.id, CURL])
    expect(r.ex[0]).toMatchObject({ sets: 5, restSec: 150, inc: 5, reps: keep.reps })
    expect(r.ex[0].sg).toBeUndefined()            // its partner left: a superset of one is no superset
    expect(diff).toContain(`  name: "${r0.name}" → "Push B"`)
    expect(diff.some(l => l.startsWith(`  - ${drop.id}`))).toBe(true)
    expect(diff.some(l => l.startsWith(`  + ${CURL}`))).toBe(true)
    expect(diff.some(l => l.startsWith(`  ~ ${keep.id}`))).toBe(true)
    expect(state.routines.filter(x => x.id !== r0.id)).toEqual(S.routines.filter(x => x.id !== r0.id))
  })

  test('an unknown routine or exercise is refused', () => {
    expect(() => updateRoutine(S, { routine_id: 'nope', name: 'X' })).toThrow(/no routine with id "nope"/)
    expect(() => updateRoutine(S, { routine_id: S.routines[0].id, exercises: [{ id: 'squat' }] })).toThrow(/not exercise ids/)
  })
})

describe('assignWeekday', () => {
  test('replaces one day and leaves every other day exactly as it was', () => {
    S.week = { 1: [S.routines[0].id], 3: [S.routines[1].id], 5: [S.routines[2].id, S.routines[0].id] }
    const { state, diff } = assignWeekday(S, { weekday: 3, routine_ids: [S.routines[2].id] })
    expect(state.week).toEqual({ ...S.week, 3: [S.routines[2].id] })
    expect(diff).toEqual([`Wednesday: ${S.routines[1].name} → ${S.routines[2].name}`])
  })

  test('adds to a day, and an empty list makes it a rest day', () => {
    S.week = { 1: [S.routines[0].id], 2: [S.routines[1].id] }
    expect(assignWeekday(S, { weekday: 1, routine_ids: [S.routines[1].id], mode: 'add' }).state.week)
      .toEqual({ 1: [S.routines[0].id, S.routines[1].id], 2: [S.routines[1].id] })
    const rest = assignWeekday(S, { weekday: 1, routine_ids: [] })
    expect(rest.state.week).toEqual({ 2: [S.routines[1].id] })
    expect(rest.diff).toEqual([`Monday: ${S.routines[0].name} → rest`])
  })

  test('an unknown routine is refused', () => {
    expect(() => assignWeekday(S, { weekday: 1, routine_ids: ['ghost'] })).toThrow(/no routine with id "ghost"/)
  })
})

describe('logWorkout', () => {
  // The demo history runs up to today; a session logged into the middle of it.
  const NOW = Date.now()
  const iso = t => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') }
  const TODAY = iso(NOW)
  test('files a strength session like a backfill: stamped, in date order, PRs against history, never metcon-shaped', () => {
    const date = S.workouts[Math.floor(S.workouts.length / 2)].d
    const { state, diff, result } = logWorkout(S, {
      date, start_time: '07:30', duration_min: 45, name: 'Hotel gym',
      entries: [{ id: SQUAT, sets: [{ w: 200, r: 5, rir: 2 }, { w: 200, r: 5 }] }]
    }, NOW)
    const w = state.workouts.find(x => x.id === result.workout_id)
    expect(w).toMatchObject({ d: date, name: 'Hotel gym', end: w.start + 45 * 60000 })
    expect(new Date(w.start).getHours()).toBe(7)
    expect(w._ts).toBeGreaterThan(0)
    expect(w.entries[0].sets).toEqual([{ w: 200, r: 5, done: true, rir: 2 }, { w: 200, r: 5, done: true }])
    expect(w.entries[0].noProg).toBeUndefined()
    expect(w.entries[0].sets.some(s => 'wodRir' in s)).toBe(false)
    expect(w.excludeFromProgression).toBeUndefined()
    expect(result.prs).toEqual([SQUAT])
    const i = state.workouts.indexOf(w)
    expect(i).toBeGreaterThan(0)
    expect(state.workouts[i - 1].d <= date && state.workouts[i + 1].d >= date).toBe(true)
    expect(diff[0]).toBe(`+ workout ${date} "Hotel gym" 07:30–08:15`)
    expect(diff[1]).toBe(`  + ${SQUAT} barbell full squat: 5 @ 200 kg (RIR 2), 5 @ 200 kg`)
    // real lifting: it sets the squat's anchor for what comes after it
    expect(anchorsByWorkout(state.workouts).get(w).get(SQUAT)).toBeGreaterThan(0)
  })

  test('a run is a cardio row and sets no anchor', () => {
    const { state, result } = logWorkout(S, { date: TODAY, entries: [{ id: RUN, sets: [{ min: 32, m: 5000 }] }] }, NOW)
    const w = state.workouts.find(x => x.id === result.workout_id)
    expect(w.entries[0]).toMatchObject({ id: RUN, target: { mode: 'cardio', sets: 1 }, sets: [{ min: 32, m: 5000, done: true }] })
    expect(anchorsByWorkout(state.workouts).get(w).has(RUN)).toBe(false)
  })

  test('today with no time is a session that just ended; the future is refused', () => {
    const { state, result } = logWorkout(S, { date: TODAY, duration_min: 30, entries: [{ id: RUN, sets: [{ min: 30 }] }] }, NOW)
    expect(state.workouts.find(x => x.id === result.workout_id)).toMatchObject({ start: NOW - 30 * 60000, end: NOW })
    expect(() => logWorkout(S, { date: iso(NOW + 86400000), entries: [{ id: RUN, sets: [{ min: 30 }] }] }, NOW)).toThrow(/in the future/)
  })

  test('sets with no work in them are refused', () => {
    expect(() => logWorkout(S, { date: TODAY, entries: [{ id: SQUAT, sets: [{ w: 100 }] }] }, NOW)).toThrow(/no work/)
    expect(() => logWorkout(S, { date: TODAY, entries: [{ id: RUN, sets: [{ min: 0 }] }] }, NOW)).toThrow(/no work/)
  })
})

describe('the write tools', () => {
  const tool = name => TOOLS.find(t => t.name === name).handler

  test('a dry run (the default) returns the diff and saves nothing', async () => {
    _seedStateForTests(S)
    const before = JSON.stringify(S)
    const r = await tool('create_routine')({ name: 'Upper A', exercises: [{ id: PUSHUP }] })
    expect(r).toMatchObject({ dry_run: true, saved: false, diff: ['+ routine "Upper A"', expect.stringMatching(/^ {2}\+ 0662 push-up/)] })
    expect(r).not.toHaveProperty('routine_id')
    expect(r.note).toMatch(/Nothing was saved/)
    expect(JSON.stringify(S)).toBe(before)
  })

  test('the file source refuses to save, saying how to write', async () => {
    _seedStateForTests(S)
    const err = await tool('assign_weekday')({ weekday: 1, routine_ids: [], dry_run: false }).catch(e => e)
    expect(err.code).toBe('EROFS')
    expect(err.message).toMatch(/OPENGYM_URL/)
  })

  test('every write tool takes dry_run, and describes it', () => {
    for (const name of ['create_routine', 'update_routine', 'assign_weekday', 'log_workout']) {
      const t = TOOLS.find(x => x.name === name)
      expect(t.schema.dry_run.isOptional()).toBe(true)
      expect(t.description).toMatch(/dry run/)
    }
  })
})
