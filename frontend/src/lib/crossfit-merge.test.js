// T35: CrossFit picks and saved programs follow upstream's Merge into… (lib/exercise-merge.js),
// read through mergedInto and never rewritten, so an Undo brings the original back.
import { describe, expect, it } from 'vitest'
import { mergeExercise, mergedInto, undoMerge } from './exercise-merge.js'
import { resolveMovement, splitMovement } from './crossfit-resolve.js'
import { liveWod, prepareDraft } from './wod-draft.js'
import { relogState, wodToSession } from './wod-log.js'
import { liftDays } from './interference.js'
import { mergedExId } from './box-feed.js'

const ROW = '1161', SKI = '2142', BIKE = '3893'
const own = (id, n) => ({ id, n, bp: 'cardio', eq: 'machine', custom: true })
const state = (more = {}) => ({ unit: 'kg', body: 'male', workouts: [], exWeights: {}, customEx: [own('myRow', 'My row'), own('myRow2', 'My row 2')], ...more })
const mv = (id, exId, alts = []) => ({ id, rawName: id, exId, dose: { reps: 10 }, perSide: false, rx: null, alts })
const program = movements => ({ title: 'T', tracks: [{ id: 't0', label: 'Full', kind: 'main', blocks: [{ id: 'b0', label: 'For time', format: 'fortime', movements }] }] })
const merge = (S, from, to, now = 100) => mergeExercise(S, from, to, { now }).undo

describe('T35: a CrossFit pick follows Merge into…', () => {
  it('a pick of a merged-away exercise resolves to the target; an Undo brings the pick back', () => {
    const S = state({ wodAliases: { 'erg row': { exId: 'myRow', _ts: 1 } } })
    const before = JSON.stringify(S.wodAliases)
    expect(resolveMovement({ rawName: 'erg row' }, S.wodAliases, S).exId).toBe('myRow')
    const undo = merge(S, 'myRow', ROW)
    expect(resolveMovement({ rawName: 'erg row' }, S.wodAliases, S)).toMatchObject({ exId: ROW, via: 'user' })
    expect(JSON.stringify(S.wodAliases)).toBe(before)
    undoMerge(S, undo, { now: 200 })
    expect(resolveMovement({ rawName: 'erg row' }, S.wodAliases, S).exId).toBe('myRow')
  })

  it('a chain A → B → C lands on C, and a shipped name follows a merged catalogue exercise too', () => {
    const S = state({ wodAliases: { 'erg row': { exId: 'myRow', _ts: 1 } } })
    merge(S, 'myRow', 'myRow2', 100)
    merge(S, 'myRow2', SKI, 101)
    expect(resolveMovement({ rawName: 'erg row' }, S.wodAliases, S).exId).toBe(SKI)
    merge(S, ROW, BIKE, 102)
    expect(resolveMovement({ rawName: 'row' }, {}, S)).toMatchObject({ exId: BIKE, via: 'shipped' })
    // without S, as before
    expect(resolveMovement({ rawName: 'row' }, {}).exId).toBe(ROW)
  })

  it('a target that is itself gone still comes back as mergedInto says', () => {
    const S = state({ wodAliases: { 'erg row': { exId: 'myRow', _ts: 1 } } })
    merge(S, 'myRow', 'myRow2')
    S.customEx = S.customEx.filter(c => c.id !== 'myRow2')
    expect(resolveMovement({ rawName: 'erg row' }, S.wodAliases, S).exId).toBe(mergedInto(S, 'myRow'))
  })

  it('a line split in two resolves each part through the merge', () => {
    const S = state()
    merge(S, ROW, BIKE)
    const parts = splitMovement({ id: 'm0', rawName: 'row + ski', dose: { reps: 10 } }, {}, S)
    expect(parts.map(p => p.exId)).toEqual([BIKE, SKI])
  })
})

describe('T35: a saved program follows Merge into…', () => {
  it('logs under the target, swaps and options included, without rewriting S.wods; an Undo logs the original', () => {
    const p = program([mv('m0', 'myRow', [{ rawName: 'ski', exId: 'myRow2', dose: {} }]), mv('m1', SKI)])
    const S = state({ wods: { '2026-11-10': { ...p, _ts: 1 } } })
    const saved = JSON.stringify(S.wods)
    const undo = merge(S, 'myRow', ROW, 100)
    merge(S, 'myRow2', BIKE, 101)
    const all = { tracks: ['t0'] }
    expect(wodToSession(S.wods['2026-11-10'], all, {}, S).entries.map(e => e.id)).toEqual([ROW, SKI])
    // the option picked on the log screen, which reads the program through liveWod
    const live = liveWod(S, S.wods['2026-11-10'])
    expect(live.tracks[0].blocks[0].movements[0]).toMatchObject({ exId: ROW, alts: [{ exId: BIKE }] })
    const swapped = wodToSession(S.wods['2026-11-10'], all, { moves: { 't0/b0/m0': { exId: BIKE } } }, S).entries[0]
    expect([swapped.id, swapped.swappedFrom]).toEqual([BIKE, undefined])
    expect(JSON.stringify(S.wods)).toBe(saved)
    // Undo the first merge: the movement logs as saved again
    undoMerge(S, undo, { now: 200 })
    expect(wodToSession(S.wods['2026-11-10'], all, {}, S).entries.map(e => e.id)).toEqual(['myRow', SKI])
  })

  it('liveWod is the program itself when nothing was merged, and the editor reads merged ids too', () => {
    const p = program([mv('m0', 'myRow')])
    expect(liveWod(state(), p)).toBe(p)
    expect(liveWod(state({ exMerged: { myRow: { into: null, _ts: 1 } } }), p)).toBe(p)
    const S = state()
    merge(S, 'myRow', ROW)
    expect(prepareDraft(p, {}, S).tracks[0].blocks[0].movements[0].exId).toBe(ROW)
    expect(p.tracks[0].blocks[0].movements[0].exId).toBe('myRow')
  })

  it('a day logged with a swap opens again on the target', () => {
    const p = program([mv('m0', SKI)])
    const S = state()
    const w = { id: 'wod-2026-11-10', d: '2026-11-10', wod: { tracks: ['t0'], blocks: [{ ref: 't0/b0' }], moves: { 't0/b0/m0': { exId: 'myRow' } } }, entries: [] }
    merge(S, 'myRow', ROW)
    expect(relogState(liveWod(S, p), w, 'kg', S).logged.moves['t0/b0/m0'].exId).toBe(ROW)
    expect(w.wod.moves['t0/b0/m0'].exId).toBe('myRow')
  })

  it('the lift-day planner reads a program through the merge', () => {
    const now = new Date('2026-11-10T12:00:00').getTime()
    const legs = { title: 'L', tracks: [{ id: 't0', kind: 'main', blocks: [{ id: 'b0', format: 'strength', movements: Array.from({ length: 4 }, (_, i) => mv('m' + i, 'myRow')) }] }] }
    const S = state({ customEx: [own('myRow', 'My row')] })
    const wods = { '2026-11-10': legs }
    const before = liftDays([], wods, now, S)[0]
    merge(S, 'myRow', '0043') // back squat
    expect(before.lowerOk).toBe(true)
    expect(liftDays([], wods, now, S)[0].lowerOk).toBe(false)
  })
})

describe('T35: the box feed\'s hand copy of mergedInto', () => {
  it('gives mergedInto\'s answers', () => {
    const exMerged = {
      a: { into: 'b', _ts: 1 }, b: { into: 'c', _ts: 2 }, c: { into: null, _ts: 3 },
      x: { into: 'y', _ts: 4 }, y: { into: 'x', _ts: 5 }, self: { into: 'self', _ts: 6 },
      ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => ['l' + i, { into: 'l' + (i + 1), _ts: 7 }]))
    }
    for (const id of ['a', 'b', 'c', 'x', 'y', 'self', 'l0', 'l5', 'none', '__proto__', 'constructor', null, undefined]) {
      expect(mergedExId(exMerged, id), String(id)).toBe(mergedInto({ exMerged }, id))
    }
    expect(mergedExId(undefined, 'a')).toBe(mergedInto({}, 'a'))
  })
})
