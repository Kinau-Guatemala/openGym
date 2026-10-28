import { describe, expect, it } from 'vitest'
import { wodToSession, cardioMinutes, buildWodWorkout, wodStart, ladderOf, relogState, isCardioRow, scoreFor } from './wod-log.js'
import { fileBackfill } from './finish-workout.js'
import { editCompletedSession, saveWorkoutEdit } from './session-edit.js'
import { resolveSetRir, rirWeightFor, sessionEffSets } from './recovery.js'
import { effortSummary, effortWeeks, effortHistogram } from './effort.js'
import { musclesOf } from './muscles.js'
import { EXIDX } from './exercises.js'
import { entryExcluded } from './history.js'
import { backfillStart } from './backfill.js'
import { prepareDraft } from './wod-draft.js'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SNATCH = '3888', CJ = '5122', PUSHUP = '0662', ROW = '1161', SKI = '2142', BURPEE = '1160', DL = '0032'
const mv = (id, exId, dose, extra = {}) => ({ id, rawName: id, exId, dose, perSide: false, rx: null, alts: [], ...extra })
const block = (id, format, movements, extra = {}) => ({ id, label: id, format, capMin: null, rounds: null, scheme: null, benchmark: null, movements, ...extra })
const program = (blocks, extraTracks = []) => ({ title: 'T', tracks: [{ id: 'full', label: 'Full Equipment', kind: 'main', blocks }, ...extraTracks] })
const all = { tracks: ['full', 'pump'] }
const S0 = (more = {}) => ({ unit: 'kg', body: 'male', workouts: [], exWeights: {}, active: null, ...more })
const entryOf = (out, ref) => out.entries.filter(e => e.wodBlock === ref)

describe('wodToSession: sets per block format', () => {
  it('EMOM with k slots over n minutes: ⌊n / k⌋ sets each, metcon rows', () => {
    const p = program([block('b1', 'emom', [
      mv('m0', '1520', { reps: 5 }, { slot: 'M1', rx: { male: { w: 185, unit: 'lb' }, female: { w: 135, unit: 'lb' } } }),
      mv('m1', '1529', { reps: 5 }, { slot: 'M2' }),
    ], { capMin: 10 })])
    const out = wodToSession(p, all, {}, S0())
    expect(out.entries).toHaveLength(2)
    for (const e of out.entries) {
      expect(e.sets).toHaveLength(5)
      expect(e.noProg).toBe(true)
      expect(e.sets.every(s => s.r === 5 && s.wodRir === 5 && s.done === true)).toBe(true)
    }
    // Rx prefilled in the profile's unit, stored in the printed one
    expect(out.entries[0].sets[0].w).toBe(85)
    expect(out.entries[0].rx).toEqual({ w: 185, unit: 'lb' })
    // a rounds score lowers it
    const capped = wodToSession(p, all, { blocks: { 'full/b1': { score: { type: 'rounds', rounds: 3, reps: 0 } } } }, S0())
    expect(capped.entries[0].sets).toHaveLength(3)
  })

  it('EMOM without slots: every movement every minute', () => {
    const p = program([block('b2', 'emom', [mv('m0', '2458', { reps: 10 }), mv('m1', BURPEE, { reps: 3 })], { capMin: 10 })])
    expect(wodToSession(p, all, {}, S0()).entries.map(e => e.sets.length)).toEqual([10, 10])
  })

  it('AMRAP: completed rounds, plus the movements the leftover reps reached', () => {
    const p = program([block('b1', 'amrap', [mv('m0', PUSHUP, { reps: 10 }), mv('m1', BURPEE, { reps: 5 }), mv('m2', '2458', { reps: 10 })], { capMin: 12 })])
    const out = wodToSession(p, all, { blocks: { 'full/b1': { score: { type: 'rounds', rounds: 4, reps: 13 } } } }, S0())
    const [pu, bu, wb] = out.entries
    expect(pu.sets.map(s => s.r)).toEqual([10, 10, 10, 10, 10])
    expect(bu.sets.map(s => s.r)).toEqual([5, 5, 5, 5, 3])
    expect(wb.sets).toHaveLength(4)
    expect(out.entries.every(e => e.noProg && e.sets.every(s => s.wodRir === 5))).toBe(true)
  })

  it('For time with N rounds: N sets; capped (a rounds score) the rounds completed', () => {
    const p = program([block('b1', 'fortime', [mv('m0', DL, { reps: 12 }, { rx: { male: { w: 100, unit: 'kg' }, female: null } })], { rounds: 5, capMin: 15 })])
    expect(wodToSession(p, all, { blocks: { 'full/b1': { score: { type: 'time', sec: 600 } } } }, S0()).entries[0].sets).toHaveLength(5)
    const capped = wodToSession(p, all, { blocks: { 'full/b1': { score: { type: 'rounds', rounds: 3, reps: 7 } } } }, S0())
    expect(capped.entries[0].sets.map(s => s.r)).toEqual([12, 12, 12, 7])
  })

  it('a ladder: one set per rung, the rung as its reps', () => {
    const p = program([block('b3', 'fortime', [mv('m0', BURPEE, {}), mv('m1', PUSHUP, {})], { scheme: '50-40-30-20-10', capMin: 10 })])
    const out = wodToSession(p, all, {}, S0())
    for (const e of out.entries) expect(e.sets.map(s => s.r)).toEqual([50, 40, 30, 20, 10])
    expect(out.entries.every(e => e.noProg)).toBe(true)
    expect(ladderOf('21-15-9')).toEqual([21, 15, 9])
    expect(ladderOf('Fran')).toBeNull()
  })

  it('warm-up blocks in a main track yield nothing unless included; extra tracks keep theirs', () => {
    const wu = block('b0', 'amrap', [mv('m0', PUSHUP, { reps: 8 })], { warmup: true, capMin: 5 })
    const extra = { id: 'cond', label: 'Holy Conditioning', kind: 'extra', blocks: [block('b0', 'amrap', [mv('m0', BURPEE, { reps: 8 })], { warmup: true, capMin: 40 })] }
    const p = program([wu], [extra])
    const out = wodToSession(p, { tracks: ['full', 'cond'] }, {}, S0())
    expect(out.entries.map(e => e.wodBlock)).toEqual(['cond/b0'])
    expect(wodToSession(p, { tracks: ['full'], include: { 'full/b0': true } }, {}, S0()).entries).toHaveLength(1)
    expect(wodToSession(p, { tracks: ['full'] }, {}, S0({ wodWarmup: true })).entries).toHaveLength(1)
    // a track not chosen yields nothing
    expect(wodToSession(p, { tracks: ['full'] }, {}, S0()).entries).toHaveLength(0)
  })

  it('Holy Pump rounds and strength: logged reps and rows, neither noProg nor wodRir', () => {
    const pump = { id: 'pump', label: 'Holy Pump', kind: 'extra', blocks: [
      block('b0', 'rounds', [mv('m0', '0294', { reps: 12, repsMax: 15 })], { rounds: 4 }),
      block('b1', 'strength', [mv('m0', CJ, {})]),
    ] }
    const p = program([], [pump])
    const logged = { moves: {
      'pump/b0/m0': { w: 12.5, r: 14 },
      'pump/b1/m0': { sets: [{ w: 60, r: 3 }, { w: 70, r: 2 }, { w: 80, r: 1 }] },
    } }
    const [curl, cj] = wodToSession(p, { tracks: ['pump'] }, logged, S0()).entries
    expect(curl.sets).toEqual(Array(4).fill({ w: 12.5, r: 14, done: true }))
    expect(cj.sets).toEqual([{ w: 60, r: 3, done: true }, { w: 70, r: 2, done: true }, { w: 80, r: 1, done: true }])
    for (const e of [curl, cj]) {
      expect(e).not.toHaveProperty('noProg')
      expect(entryExcluded({}, e)).toBe(false)
    }
    // metcon entries are kept out of progression
    const met = wodToSession(program([block('b1', 'amrap', [mv('m0', PUSHUP, { reps: 10 })])]), all, {}, S0()).entries[0]
    expect(entryExcluded({}, met)).toBe(true)
  })

  it('the 10-13 example: 4 rounds of 9 DB snatch R + L is 4 per-side sets, ≈2.1 effective sets', () => {
    const p = program([block('b3', 'fortime', [mv('m0', SNATCH, { reps: 9 }, { perSide: true })], { rounds: 4, capMin: 12 })])
    const [e] = wodToSession(p, all, { moves: { 'full/b3/m0': { w: 22.5 } } }, S0()).entries
    expect(e.sets).toHaveLength(4)
    expect(e.sets[0]).toMatchObject({ sides: { L: { w: 22.5, r: 9, done: true }, R: { w: 22.5, r: 9, done: true } }, done: true, wodRir: 5 })
    // no anchor yet: each per-side set counts once at RIR 5
    const eff = sessionEffSets({ d: '2026-10-13', start: 1, entries: [e] }, new Map())
    const weights = musclesOf(EXIDX[SNATCH])
    const [slug, top] = Object.entries(weights).sort((a, b) => b[1] - a[1])[0]
    expect(eff[slug] / top).toBeCloseTo(4 * rirWeightFor(5), 5)
    expect(eff[slug] / top).toBeCloseTo(2.13, 2)
  })

  it('cardio movements: one row per movement, cal or m with minutes, explicit cardio mode', () => {
    const p = program([
      block('b1', 'emom', [mv('m0', ROW, { cal: 20 }, { doseFemale: { cal: 15 }, alts: [{ exId: SKI, rawName: 'ski', dose: {} }] })], { capMin: 10 }),
      block('b2', 'fortime', [mv('m0', '0685', { m: 1000 }), mv('m1', PUSHUP, { reps: 100 })], { capMin: 10 }),
    ])
    const out = wodToSession(p, all, { moves: { 'full/b1/m0': { exId: SKI } } }, S0())
    const [ski] = entryOf(out, 'full/b1')
    expect(ski.id).toBe(SKI)
    expect(ski).not.toHaveProperty('swappedFrom')      // a printed alternative is not a swap
    expect(ski.sets).toEqual([{ mode: 'cardio', cal: 200, min: 10, done: true }])   // 200 cal ≈ 13 min, capped at 10
    const [run, pu] = entryOf(out, 'full/b2')
    expect(run.sets).toEqual([{ mode: 'cardio', m: 1000, min: 5, done: true }])
    expect(pu.sets).toEqual([{ w: 0, r: 100, done: true, wodRir: 5 }])
    // the women's dose when the profile is female; minutes typed win
    const f = wodToSession(p, all, { moves: { 'full/b1/m0': { min: 9 } } }, S0({ body: 'female' }))
    expect(entryOf(f, 'full/b1')[0].sets[0]).toMatchObject({ cal: 150, min: 9 })
  })

  it('a machine down a ladder is one cardio row: the rungs are its calories, or its metres', () => {
    const fran = block('b1', 'fortime', [mv('m0', ROW, {}, { raw: 'Cal Row' }), mv('m1', '3305', {}, { raw: 'Thrusters' })], { scheme: '21-15-9', capMin: 12 })
    const [row, thr] = wodToSession(program([fran]), all, {}, S0()).entries
    expect(row.sets).toEqual([{ mode: 'cardio', cal: 45, min: 3, done: true }])
    expect(row.sets[0]).not.toHaveProperty('wodRir')
    expect(thr.sets.map(x => [x.r, x.wodRir])).toEqual([[21, 5], [15, 5], [9, 5]])
    expect(isCardioRow(fran.movements[0], ROW, {}, fran)).toBe(true)
    expect(isCardioRow(fran.movements[1], '3305', {}, fran)).toBe(false)
    const ski = block('b2', 'fortime', [mv('m0', SKI, {}, { raw: '500-400-300 mts Ski' })], { scheme: '500-400-300' })
    expect(wodToSession(program([ski]), all, { moves: { 'full/b2/m0': { min: 5 } } }, S0()).entries[0].sets).toEqual([{ mode: 'cardio', m: 1200, min: 5, done: true }])
    // burpees down a ladder stay reps per rung
    const bur = block('b3', 'fortime', [mv('m0', BURPEE, {}, { raw: 'Burpees' })], { scheme: '21-15-9' })
    expect(wodToSession(program([bur]), all, {}, S0()).entries[0].sets.map(x => x.r)).toEqual([21, 15, 9])
  })

  it('a substitute from the search box sets swappedFrom and drops the Rx', () => {
    const p = program([block('b1', 'emom', [mv('m0', CJ, { reps: 2 }, { rx: { male: { w: 225, unit: 'lb' }, female: { w: 155, unit: 'lb' } } })], { capMin: 10 })])
    const [e] = wodToSession(p, all, { moves: { 'full/b1/m0': { exId: '1200', w: 60 } } }, S0()).entries
    expect(e).toMatchObject({ id: '1200', swappedFrom: CJ, wodBlock: 'full/b1' })
    expect(e).not.toHaveProperty('rx')
    expect(e.sets[0].w).toBe(60)
  })

  it('movements without an exercise are left out', () => {
    const p = program([block('b1', 'amrap', [mv('m0', null, { reps: 5 }), mv('m1', PUSHUP, { reps: 5 })])])
    expect(wodToSession(p, all, {}, S0()).entries.map(e => e.id)).toEqual([PUSHUP])
  })

  it('records each included block with its score and Rx flag', () => {
    const p = program([
      block('b0', 'amrap', [mv('m0', PUSHUP, { reps: 8 })], { warmup: true, capMin: 5 }),
      block('b1', 'fortime', [mv('m0', BURPEE, { reps: 10 })], { rounds: 3, capMin: 12, benchmark: 'Fran' }),
    ])
    const out = wodToSession(p, all, { blocks: { 'full/b1': { score: { type: 'time', sec: 512 }, rx: true } } }, S0())
    expect(out.wod).toEqual({ tracks: ['full'], blocks: [{ ref: 'full/b1', format: 'fortime', score: { type: 'time', sec: 512 }, rx: true, benchmark: 'Fran' }] })
    expect(out.capMin).toBe(12)
  })
})

describe('cardioMinutes', () => {
  it('rough rates per machine and per run', () => {
    expect(cardioMinutes(ROW, { cal: 15 }, 1)).toBe(1)
    expect(cardioMinutes(SKI, { m: 250 }, 4)).toBe(4)
    expect(cardioMinutes('3893', { cal: 20 }, 3)).toBe(3)
    expect(cardioMinutes('0685', { m: 1000 }, 1)).toBe(5)
    expect(cardioMinutes(ROW, { sec: 30 }, 4)).toBe(2)
    expect(cardioMinutes(ROW, {}, 1)).toBeNull()
  })
})

describe('buildWodWorkout + fileBackfill (logWod)', () => {
  const DATE = '2026-10-13'
  const prog = () => program([
    block('b1', 'emom', [mv('m0', CJ, { reps: 2 }, { slot: 'M1', rx: { male: { w: 100, unit: 'kg' }, female: { w: 70, unit: 'kg' } } }),
      mv('m1', '0685', { m: 200 }, { slot: 'M2' })], { capMin: 10 }),
    block('b2', 'amrap', [mv('m0', BURPEE, { reps: 10 })], { capMin: 8 }),
  ])
  const log = (S, logged, choice = all) => {
    const { active, w } = buildWodWorkout(S, DATE, prog(), choice, logged, Date.parse('2026-10-20T12:00:00Z'))
    return { shown: fileBackfill(S, active, w), active, w }
  }

  it('files one workout wod-<date> carrying the WOD fields, timed by the caps', () => {
    const S = S0()
    const { shown } = log(S, { moves: { 'full/b1/m0': { exId: '1200', w: 70 } }, blocks: { 'full/b2': { score: { type: 'rounds', rounds: 5, reps: 0 }, rx: true } } })
    expect(S.workouts).toHaveLength(1)
    const w = S.workouts[0]
    expect(shown).toBe(w)
    expect(w).toMatchObject({ id: 'wod-' + DATE, d: DATE, src: 'wod', name: 'WOD · Full Equipment' })
    expect(w.start).toBe(backfillStart(DATE, '18:00'))
    expect(w.end - w.start).toBe(18 * 60000)
    expect(w.wod).toMatchObject({ date: DATE, tracks: ['full'] })
    expect(w.wod.blocks.map(b => b.ref)).toEqual(['full/b1', 'full/b2'])
    expect(w.entries[0]).toMatchObject({ id: '1200', swappedFrom: CJ, wodBlock: 'full/b1', noProg: true })
    expect(w._ts).toBeGreaterThan(0)
    expect(w.vol).toBeGreaterThan(0)
  })

  it('wod, entry.rx, wodBlock, swappedFrom and src survive filing and a later edit', () => {
    const S = S0()
    log(S, { moves: { 'full/b2/m0': { exId: PUSHUP } } })
    const before = S.workouts[0]
    expect(before.entries[0].rx).toEqual({ w: 100, unit: 'kg' })
    editCompletedSession(S, 'wod-' + DATE)
    S.active.entries[0].sets[0].w = 90
    const saved = saveWorkoutEdit(S)
    expect(saved.entries[0].sets[0].w).toBe(90)
    expect(saved).toMatchObject({ id: 'wod-' + DATE, src: 'wod', wod: before.wod })
    expect(saved.entries[0]).toMatchObject({ rx: { w: 100, unit: 'kg' }, wodBlock: 'full/b1', noProg: true })
    expect(saved.entries[2]).toMatchObject({ id: PUSHUP, swappedFrom: BURPEE, wodBlock: 'full/b2' })
    expect(saved.entries[0].sets[0].wodRir).toBe(5)
  })

  it('re-opening a logged day restores what was typed, and saving it again changes nothing', () => {
    const p = program([
      block('b1', 'amrap', [mv('m0', BURPEE, { reps: 10 }), mv('m1', null, { reps: 8 }, { rawName: 'nastys' }), mv('m2', ROW, { cal: 15 })], { rounds: 3, capMin: 12 }),
    ])
    const logged = { moves: {
      'full/b1/m0': { r: 11 },
      'full/b1/m1': { exId: PUSHUP, w: 0 },
      'full/b1/m2': { cal: 12, min: 4 },
    }, blocks: { 'full/b1': { score: { type: 'rounds', rounds: 3, reps: 0 }, rx: false } } }
    const S = S0()
    const first = buildWodWorkout(S, DATE, p, all, logged, Date.parse('2026-10-20T12:00:00Z'))
    fileBackfill(S, first.active, first.w)
    expect(S.workouts[0].wod.moves).toEqual(logged.moves)
    // kept through a later edit of the saved workout too
    editCompletedSession(S, 'wod-' + DATE)
    S.active.entries[0].sets[0].r = 12
    expect(saveWorkoutEdit(S).wod.moves).toEqual(logged.moves)

    const state = relogState(p, S.workouts[0])
    expect(state.tracks).toEqual(['full'])
    expect(state.include).toEqual({ 'full/b1': true })
    expect(state.logged).toEqual(logged)
    const again = buildWodWorkout(S, DATE, p, { tracks: state.tracks, include: state.include }, state.logged, Date.parse('2026-10-20T12:00:00Z'))
    expect(again.w.entries).toEqual(first.w.entries)
    expect(again.w.entries.map(e => e.id)).toEqual([BURPEE, PUSHUP, ROW])
    expect(again.w.entries[0].sets.map(x => x.r)).toEqual([11, 11, 11])
    expect(again.w.entries[2].sets).toEqual([{ mode: 'cardio', cal: 36, min: 4, done: true }])
  })

  it('a score saves as the type the selector shows: the format default when never touched', () => {
    const p = program([
      block('b1', 'fortime', [mv('m0', BURPEE, { reps: 10 })], { rounds: 3, capMin: 12, benchmark: 'Fran' }),
      block('b2', 'amrap', [mv('m0', PUSHUP, { reps: 10 })], { capMin: 8 }),
      block('b3', 'strength', [mv('m0', CJ, {})]),
      block('b4', 'emom', [mv('m0', CJ, { reps: 2 })], { capMin: 10 }),
    ])
    const S = S0()
    // untouched selectors: only the values typed are sent
    const logged = { blocks: { 'full/b1': { score: { sec: 512 }, rx: true }, 'full/b2': { score: { rounds: 4, reps: 3 } }, 'full/b3': { score: { w: 90 } } } }
    const { active, w } = buildWodWorkout(S, DATE, p, all, logged, Date.parse('2026-10-20T12:00:00Z'))
    fileBackfill(S, active, w)
    expect(S.workouts[0].wod.blocks.map(b => b.score)).toEqual([
      { type: 'time', sec: 512 }, { type: 'rounds', rounds: 4, reps: 3 }, { type: 'load', w: 90 }, { type: 'none' },
    ])
    // re-opened, it shows what was saved; a block saved without a score opens on its default
    const state = relogState(p, S.workouts[0])
    expect(state.logged.blocks['full/b1']).toEqual({ score: { type: 'time', sec: 512 }, rx: true })
    expect(state.logged.blocks['full/b4']).toEqual({ rx: false })
    // a type picked with nothing entered, or none picked, is none
    expect(scoreFor(p.tracks[0].blocks[0], { type: 'time' })).toEqual({ type: 'none' })
    expect(scoreFor(p.tracks[0].blocks[0], { type: 'none', sec: 30 })).toEqual({ type: 'none' })
    expect(scoreFor(p.tracks[0].blocks[0], undefined)).toEqual({ type: 'none' })
    expect(scoreFor(p.tracks[0].blocks[0], { type: 'rounds', rounds: 2, reps: 0 })).toEqual({ type: 'rounds', rounds: 2, reps: 0 })
  })

  it('an older log without the typed values is read back off its rows', () => {
    const S = S0()
    log(S, { moves: { 'full/b1/m0': { exId: '1200', w: 70 }, 'full/b1/m1': { min: 6 } } })
    const w = structuredClone(S.workouts[0])
    delete w.wod.moves
    expect(relogState(prog(), w).logged.moves).toEqual({
      'full/b1/m0': { exId: '1200', w: 70 },
      'full/b1/m1': { min: 6 },
      'full/b2/m0': { w: 0 },
    })
  })

  it('logging the same date again edits it: one workout, the second contents', () => {
    const S = S0()
    log(S, { moves: { 'full/b1/m0': { w: 80 } } })
    log(S, { moves: { 'full/b1/m0': { w: 95 } } }, { tracks: ['full'], include: { 'full/b2': false } })
    expect(S.workouts.filter(w => w.d === DATE)).toHaveLength(1)
    expect(S.workouts[0].id).toBe('wod-' + DATE)
    expect(S.workouts[0].entries.map(e => e.wodBlock)).toEqual(['full/b1', 'full/b1'])
    expect(S.workouts[0].entries[0].sets[0].w).toBe(95)
  })

  it('leaves a live session in S.active untouched', () => {
    const live = { id: 'live', d: '2026-10-20', start: 5, entries: [{ id: DL, sets: [{ w: 100, r: 5, done: false }] }] }
    const S = S0({ active: live })
    const snapshot = structuredClone(live)
    log(S, {})
    expect(S.active).toBe(live)
    expect(S.active).toEqual(snapshot)
  })

  it('a heavier C&J in a WOD gets a PR badge, as a backfilled session would', () => {
    const old = { id: 'old', d: '2026-10-01', start: 1, end: 2, entries: [{ id: CJ, sets: [{ w: 80, r: 2, done: true }] }], prs: [CJ] }
    const S = S0({ workouts: [old] })
    const { shown } = log(S, { moves: { 'full/b1/m0': { w: 90 } } })
    expect(shown.prs).toContain(CJ)
    const lighter = S0({ workouts: [structuredClone(old)] })
    expect(log(lighter, { moves: { 'full/b1/m0': { w: 70 } } }).shown.prs).not.toContain(CJ)
  })

  it('starts at 18:00 on a past day, an hour ago today, and never ends in the future', () => {
    const now = new Date(2026, 9, 20, 10, 0).getTime()
    expect(wodStart('2026-10-13', now)).toBe(backfillStart('2026-10-13', '18:00'))
    expect(wodStart('2026-10-20', now)).toBe(now - 3600000)
    const { w } = buildWodWorkout(S0(), '2026-10-20', program([block('b1', 'amrap', [mv('m0', BURPEE, { reps: 5 })], { capMin: 90 })]), all, {}, now)
    expect(w.end).toBe(now)
  })
})

describe('effort: wodRir is a fallback, kept out of the Effort card', () => {
  const anchors = new Map([[CJ, 120]])
  const w = { d: '2026-10-13', start: 1, entries: [] }

  it('a heavy EMOM set the anchor reads as RIR ≤ 3 keeps full credit', () => {
    const row = { w: 100, r: 5, wodRir: 5, done: true }
    const r = resolveSetRir(row, row, { id: CJ }, w, anchors, { unit: 'kg' })
    expect(r.source).toBe('estimated')
    expect(r.rir).toBeLessThanOrEqual(3)
    expect(rirWeightFor(r.rir)).toBe(1)
  })

  it('a push-up row with no anchor scores ≈0.53; a logged rating still wins', () => {
    const row = { w: 0, r: 20, wodRir: 5, done: true }
    const r = resolveSetRir(row, row, { id: PUSHUP }, w, new Map(), {})
    expect(r).toEqual({ rir: 5, source: 'wod' })
    expect(rirWeightFor(r.rir)).toBeCloseTo(0.53, 2)
    expect(resolveSetRir({ ...row, rir: 1 }, row, { id: PUSHUP }, w, new Map(), {})).toEqual({ rir: 1, source: 'logged' })
    expect(resolveSetRir({ w: 0, r: 20, done: true }, null, { id: PUSHUP }, w, new Map(), {})).toBeNull()
  })

  it('effortSummary, effortWeeks and effortHistogram ignore source: wod', () => {
    const at = Date.now() - 86400000
    const d = new Date(at).toISOString().slice(0, 10)
    const st = { workouts: [{ d, start: at, end: at + 1, entries: [{ id: PUSHUP, sets: Array.from({ length: 8 }, () => ({ w: 0, r: 20, wodRir: 5, done: true })) }] }] }
    const resolve = s => (s.wodRir != null ? { rir: s.wodRir, source: 'wod' } : null)
    const sum = effortSummary(st, 0, resolve)
    expect(sum).toMatchObject({ done: 8, rated: 0, est: 0, covered: 0, avg: null })
    expect(effortWeeks(st, 0, resolve)).toEqual([])
    expect(effortHistogram(st, 0, resolve).every(b => b.n === 0)).toBe(true)
  })
})

describe('wodToSession: repeats and sets (T17)', () => {
  // The 2026-10-21 image as the fixture provider answers it, resolved the way the review screen does.
  const fixture = prepareDraft(JSON.parse(readFileSync(resolve(__dirname, '../../../api/coach/fixture-wod.json'), 'utf8')))

  it('the Running Club logs 8.4 km: 1 × 8000 m and 2 × 200 m, the minutes for the whole distance', () => {
    const out = wodToSession(fixture, { tracks: ['running'] }, {}, S0())
    const runs = entryOf(out, 'running/b1')
    expect(runs.map(e => e.id)).toEqual(['0685', '0685'])
    expect(runs.map(e => e.sets)).toEqual([[{ mode: 'cardio', m: 8000, min: 40, done: true }], [{ mode: 'cardio', m: 400, min: 2, done: true }]])
    expect(runs.reduce((km, e) => km + e.sets[0].m, 0) / 1000).toBe(8.4)
    // a distance typed on the log screen is one repeat's, so it is multiplied too
    expect(entryOf(wodToSession(fixture, { tracks: ['running'] }, { moves: { 'running/b1/m1': { m: 250 } } }, S0()), 'running/b1')[1].sets[0].m).toBe(500)
  })

  it('2 Set de Max Wall Balls logs two rows of max reps for the user to fill in', () => {
    const [wb] = wodToSession(fixture, { tracks: ['rox'] }, {}, S0()).entries
    expect(wb.id).toBe('2458')
    expect(wb.sets).toEqual([{ w: 0, r: 0, done: true }, { w: 0, r: 0, done: true }])
    const typed = wodToSession(fixture, { tracks: ['rox'] }, { moves: { 'rox/b0/m0': { r: 25, w: 9 } } }, S0()).entries[0]
    expect(typed.sets).toEqual([{ w: 9, r: 25, done: true }, { w: 9, r: 25, done: true }])
  })

  it('sets multiply the reps and calories of a metcon line; a dose without sets logs as before', () => {
    const p = program([
      block('b0', 'fortime', [mv('m0', PUSHUP, { sets: 3, reps: 10 }), mv('m1', ROW, { sets: 2, cal: 15, restSec: 60 }), mv('m2', BURPEE, { reps: 10 })], { rounds: 2 }),
    ])
    const [pu, row, bur] = wodToSession(p, all, {}, S0()).entries
    expect(pu.sets.map(x => x.r)).toEqual([10, 10, 10, 10, 10, 10])
    expect(row.sets).toEqual([{ mode: 'cardio', cal: 60, min: 4, done: true }])
    expect(bur.sets.map(x => x.r)).toEqual([10, 10])
  })

  it('an AMRAP rounds + reps score counts a round as every set of the line, the leftover set by set', () => {
    const score = (rounds, reps) => ({ blocks: { 'full/b0': { score: { type: 'rounds', rounds, reps } } } })
    const wb = program([block('b0', 'amrap', [mv('m0', '2458', { sets: 2, reps: 10 }), mv('m1', BURPEE, { reps: 5 })], { capMin: 12 })])
    const [balls, bur] = wodToSession(wb, all, score(3, 15), S0()).entries
    expect(balls.sets.map(x => x.r)).toEqual([10, 10, 10, 10, 10, 10, 10, 5])   // 3 × 2 × 10, then 10 + 5
    expect(bur.sets.map(x => x.r)).toEqual([5, 5, 5])
    const row = program([block('b0', 'amrap', [mv('m0', ROW, { sets: 2, cal: 10 }), mv('m1', BURPEE, { reps: 5 })], { capMin: 12 })])
    const [cal, bur2] = wodToSession(row, all, score(2, 12), S0()).entries
    expect(cal.sets).toEqual([{ mode: 'cardio', cal: 52, min: 3.5, done: true }])   // 2 × 2 × 10, then 10 + 2
    expect(bur2.sets.map(x => x.r)).toEqual([5, 5])
  })
})
