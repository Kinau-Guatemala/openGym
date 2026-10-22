import { describe, it, expect } from 'vitest'
import { benchmarks, scoreValue, wodPrs } from './crossfit-records.js'

const wod = (d, blocks, extra = {}) => ({ id: 'wod-' + d, d, src: 'wod', entries: [], wod: { date: d, tracks: ['full'], blocks }, ...extra })
const time = sec => ({ type: 'time', sec })
const rounds = (r, reps = 0) => ({ type: 'rounds', rounds: r, reps })

describe('benchmarks', () => {
  it('keeps the fastest time per name, Rx and scaled apart', () => {
    const out = benchmarks([
      wod('2026-09-01', [{ ref: 'full/b1', benchmark: 'Fran', score: time(420), rx: false }]),
      wod('2026-09-15', [{ ref: 'full/b1', benchmark: 'Fran', score: time(380), rx: false }]),
      wod('2026-10-01', [{ ref: 'full/b1', benchmark: 'fran ', score: time(510), rx: true }]),
      wod('2026-10-10', [{ ref: 'full/b1', benchmark: 'Fran', score: time(495), rx: true }]),
    ])
    expect(out).toHaveLength(1)
    const [fran] = out
    expect(fran).toMatchObject({ name: 'Fran', type: 'time', last: '2026-10-10' })
    expect(fran.rx).toEqual({ d: '2026-10-10', score: time(495), value: -495 })
    expect(fran.scaled).toEqual({ d: '2026-09-15', score: time(380), value: -380 })
    expect(fran.history.map(h => h.d)).toEqual(['2026-10-10', '2026-10-01', '2026-09-15', '2026-09-01'])
    expect(fran.history[0]).toMatchObject({ wid: 'wod-2026-10-10', rx: true })
  })

  it('keeps the most rounds+reps, a round beating any number of leftover reps', () => {
    const [cindy] = benchmarks([
      wod('2026-09-01', [{ ref: 'full/b1', benchmark: 'Cindy', score: rounds(15, 29), rx: true }]),
      wod('2026-09-20', [{ ref: 'full/b1', benchmark: 'Cindy', score: rounds(16, 0), rx: true }]),
      wod('2026-10-05', [{ ref: 'full/b1', benchmark: 'Cindy', score: rounds(15, 30), rx: true }]),
    ])
    expect(cindy.type).toBe('rounds')
    expect(cindy.rx.d).toBe('2026-09-20')
    expect(cindy.scaled).toBeNull()
  })

  it('compares loads across units, read in the profile unit', () => {
    const [grace] = benchmarks([
      wod('2026-09-01', [{ ref: 'full/b1', benchmark: 'Max C&J', score: { type: 'load', w: 225, unit: 'lb' }, rx: true }]),
      wod('2026-10-01', [{ ref: 'full/b1', benchmark: 'Max C&J', score: { type: 'load', w: 100, unit: 'kg' }, rx: true }]),
    ], 'kg')
    expect(grace.rx.d).toBe('2026-09-01')        // 225 lb ≈ 102 kg beats 100 kg
    expect(grace.rx.value).toBeCloseTo(102, 0)
  })

  it('lists benchmarks by the one done last, and skips blocks with none', () => {
    const out = benchmarks([
      wod('2026-09-01', [{ ref: 'full/b1', benchmark: 'DT', score: time(600), rx: true }, { ref: 'full/b2', score: time(100), rx: true }]),
      wod('2026-10-01', [{ ref: 'full/b1', benchmark: 'Fran', score: { type: 'none' }, rx: false }]),
    ])
    expect(out.map(b => b.name)).toEqual(['Fran', 'DT'])
    expect(out[0]).toMatchObject({ type: 'none', rx: null, scaled: null })
    expect(out[0].history).toHaveLength(1)
  })

  it('reads no score as null and a time as counting down', () => {
    expect(scoreValue({ type: 'none' })).toBeNull()
    expect(scoreValue(time(0))).toBeNull()
    expect(scoreValue(time(300)) > scoreValue(time(301))).toBe(true)
    expect(scoreValue(rounds(0, 0))).toBeNull()
  })
})

describe('wodPrs', () => {
  it('reads the PR badges logged WODs were filed with, newest first', () => {
    expect(wodPrs([
      wod('2026-09-01', [], { prs: ['1520'] }),
      { id: 'x', d: '2026-09-05', prs: ['0025'], entries: [] },
      wod('2026-10-01', [], { prs: ['0648', '1520'] }),
    ])).toEqual([
      { d: '2026-10-01', wid: 'wod-2026-10-01', exId: '0648' },
      { d: '2026-10-01', wid: 'wod-2026-10-01', exId: '1520' },
      { d: '2026-09-01', wid: 'wod-2026-09-01', exId: '1520' },
    ])
  })
})
