import { describe, expect, it } from 'vitest'
import { muscleGap, sourceOf, GAP_MUSCLES } from './muscle-gap.js'
import { sessionEffSets, rirWeightFor, FATIGUE_MAX_SETS_PER_SESSION } from './recovery.js'

const DAY = 86400000
const NOW = Date.UTC(2026, 9, 22, 20)
// Synthetic exercises: an unknown id falls back to the entry's own muscle weights, so the
// numbers below don't move when the catalogue does.
const CHEST = { chest: 1, triceps: 0.4 }
const QUADS = { quadriceps: 1, gluteal: 0.4 }
const entry = (weights, sets, extra = {}) => ({ id: 'x-' + Object.keys(weights)[0], muscleWeights: weights, sets, ...extra })
const done = (n, row = {}) => Array.from({ length: n }, () => ({ r: 10, done: true, ...row }))
const at = (daysAgo, entries, extra = {}) => ({ start: NOW - daysAgo * DAY, d: '2026-10-01', entries, ...extra })
const wod = (daysAgo, entries) => at(daysAgo, entries, { src: 'wod' })
const row = (out, muscle) => out.find(r => r.muscle === muscle)

describe('sourceOf', () => {
  it('metcon entries of a WOD are wod, its other entries pump, everything else lift', () => {
    expect(sourceOf({ src: 'wod' }, { noProg: true })).toBe('wod')
    expect(sourceOf({ src: 'wod' }, {})).toBe('pump')
    expect(sourceOf({}, { noProg: true })).toBe('lift')
    expect(sourceOf({ src: 'hc' }, {})).toBe('lift')
  })
})

describe('sessionEffSets options', () => {
  const w = at(1, [entry(CHEST, done(3)), entry(QUADS, [{ mode: 'cardio', min: 30, done: true }])])
  it('byEntry splits the default session sums per entry, uncapped', () => {
    const total = sessionEffSets(w, new Map())
    const parts = sessionEffSets(w, new Map(), { byEntry: true })
    expect(parts.map(p => p.entry)).toEqual(w.entries)
    expect(parts[0].sets.chest + parts[1].sets.chest).toBe(total.chest)
    expect(parts[1].sets.quadriceps).toBe(3)       // 30 min of cardio = 3 sets
  })
  it('excludeCardio drops cardio-mode rows, by row mode', () => {
    const out = sessionEffSets(w, new Map(), { excludeCardio: true })
    expect(out.quadriceps).toBe(0)
    expect(out.chest).toBe(3)
  })
})

describe('muscleGap', () => {
  // Two weeks: lift twice a week (4 chest sets), a WOD each week with a metcon (push-ups at
  // wodRir 5) and a Pump block (3 chest sets), and one leg day.
  const metcon = () => entry(CHEST, done(5, { wodRir: 5 }), { noProg: true })
  const pump = () => entry(CHEST, done(3))
  const history = [
    at(1, [entry(CHEST, done(4))]), at(4, [entry(CHEST, done(4))]),
    at(8, [entry(CHEST, done(4))]), at(11, [entry(CHEST, done(4))]),
    wod(2, [metcon(), pump()]), wod(9, [metcon(), pump()]),
    at(5, [entry(QUADS, done(6))]),
    at(20, [entry(CHEST, done(10))]),        // outside the 14-day window
  ]

  it('two weeks of WOD + Pump + lift give per-muscle sets per week and the source split', () => {
    const out = muscleGap(history, NOW)
    const chest = row(out, 'chest')
    const wodSets = 5 * rirWeightFor(5)
    expect(chest.sources.lift).toBeCloseTo(8, 9)            // 16 sets / 2 weeks
    expect(chest.sources.pump).toBeCloseTo(3, 9)            // 6 / 2
    expect(chest.sources.wod).toBeCloseTo(wodSets, 9)       // 2 × 5 × 0.53 / 2
    expect(chest.setsPerWeek).toBeCloseTo(11 + wodSets, 9)
    expect(chest.target).toBe(10)
    expect(chest.deficit).toBe(0)
    const triceps = row(out, 'triceps')
    expect(triceps.setsPerWeek).toBeCloseTo(0.4 * (11 + wodSets), 9)
    expect(triceps.deficit).toBeCloseTo(10 - triceps.setsPerWeek, 9)
    expect(row(out, 'quadriceps')).toMatchObject({ setsPerWeek: 3, deficit: 7, sources: { wod: 0, pump: 0, lift: 3 } })
    expect(row(out, 'gluteal').setsPerWeek).toBeCloseTo(1.2, 9)
  })

  it('is sorted by deficit, largest first, over the gap muscles only', () => {
    const out = muscleGap(history, NOW)
    expect(out.map(r => r.muscle).sort()).toEqual([...GAP_MUSCLES].sort())
    for (let i = 1; i < out.length; i += 1) expect(out[i - 1].deficit).toBeGreaterThanOrEqual(out[i].deficit)
    expect(out.at(-1).muscle).toBe('chest')
  })

  it('a session over the cap scales its sources proportionally', () => {
    // 6 wod + 12 pump = 18 chest sets in one session: capped at 12, split 4 / 8.
    const big = [wod(1, [entry(CHEST, done(6), { noProg: true }), entry(CHEST, done(12))])]
    const chest = row(muscleGap(big, NOW, { days: 7 }), 'chest')
    expect(FATIGUE_MAX_SETS_PER_SESSION).toBe(12)
    expect(chest.sources.wod).toBeCloseTo(4, 9)
    expect(chest.sources.pump).toBeCloseTo(8, 9)
    expect(chest.setsPerWeek).toBeCloseTo(12, 9)
    // triceps (7.2 sets) stays under the cap and keeps its full share
    expect(row(muscleGap(big, NOW, { days: 7 }), 'triceps').sources).toMatchObject({ wod: 2.4, pump: 4.8 })
  })

  it('runs and other cardio rows contribute nothing', () => {
    const runs = [
      at(1, [entry(QUADS, [{ min: 45, speed: 10, done: true }])], { src: 'hc' }),
      // a WOD ski erg row: catalogued as triceps, logged with an explicit cardio mode
      wod(2, [entry({ triceps: 1 }, [{ mode: 'cardio', cal: 200, min: 10, done: true }], { noProg: true })]),
    ]
    const out = muscleGap(runs, NOW)
    expect(out.every(r => r.setsPerWeek === 0 && r.deficit === 10)).toBe(true)
    // fatigue still counts them
    expect(sessionEffSets(runs[0], new Map()).quadriceps).toBe(4.5)
  })

  it('hypTarget changes the deficits', () => {
    const at10 = row(muscleGap(history, NOW), 'quadriceps')
    const at16 = row(muscleGap(history, NOW, { target: 16 }), 'quadriceps')
    expect(at10.deficit).toBe(7)
    expect(at16).toMatchObject({ target: 16, deficit: 13 })
    expect(row(muscleGap(history, NOW, { target: 16 }), 'chest').deficit).toBeCloseTo(16 - 11 - 5 * rirWeightFor(5), 9)
  })

  it('ignores future and undated workouts and returns zeros for no history', () => {
    const out = muscleGap([at(-1, [entry(CHEST, done(4))]), { entries: [entry(CHEST, done(4))] }], NOW)
    expect(row(out, 'chest').setsPerWeek).toBe(0)
    expect(muscleGap(undefined, NOW)).toHaveLength(GAP_MUSCLES.length)
  })
})
