import { describe, expect, it } from 'vitest'
import { liftDays, runDays, wodLoad } from './interference.js'

// Thursday 2026-10-22, local noon (the suite runs in TZ=UTC).
const NOW = new Date(2026, 9, 22, 12).getTime()
const SQUAT = '0043'      // barbell full squat: glutes 1, quads 0.4, hams 0.4
const SWING = '0549'      // kettlebell swing: glutes 1, hams 0.4
const PUSHUP = '0662'     // push-up: chest 1, triceps 0.4, delts 0.4
const BURPEE = '1160'     // burpee: quads/hams 0.4 each

const run = (d, src = 'hc', id = '0685') => ({ id: 'hc-' + d, d, src, entries: [{ id, sets: [{ min: 30, done: true }] }] })
const block = (ids, extra = {}) => ({ id: 'b', format: 'amrap', movements: ids.map(exId => ({ exId })), ...extra })
const program = (blocks, kind = 'main') => ({ tracks: [{ id: 'full', kind, blocks }] })
const byDate = days => Object.fromEntries(days.map(d => [d.date, d]))

describe('runDays', () => {
  it('a weekday with runs on two dates in the last four weeks is a run day', () => {
    // Tuesdays 10-13 and 10-20, one Saturday, one Monday outside the window.
    const days = runDays([run('2026-10-13'), run('2026-10-20'), run('2026-10-17'), run('2026-09-21'), run('2026-09-28')], NOW)
    expect([...days]).toEqual([2])
  })

  it('counts dates, not runs: two runs on one Tuesday are one', () => {
    expect(runDays([run('2026-10-20'), { ...run('2026-10-20'), id: 'hc-b' }], NOW).size).toBe(0)
  })

  it('only Health Connect runs count: treadmill yes, rides and hand-logged runs no', () => {
    expect([...runDays([run('2026-10-14', 'hc', '2197'), run('2026-10-21', 'hc', '2197')], NOW)]).toEqual([3])
    expect(runDays([run('2026-10-14', 'hc', '5214'), run('2026-10-21', 'hc', '5214')], NOW).size).toBe(0)
    expect(runDays([run('2026-10-14', null), run('2026-10-21', null)], NOW).size).toBe(0)
  })
})

describe('wodLoad', () => {
  it('a squat or swings + burpees is leg-heavy; burpees alone are not', () => {
    expect(wodLoad(program([block([SQUAT])]))).toEqual({ legs: true, upper: false })
    expect(wodLoad(program([block([SWING, BURPEE])])).legs).toBe(true)
    expect(wodLoad(program([block([BURPEE])])).legs).toBe(false)
  })

  it('push-ups make it upper-heavy', () => {
    expect(wodLoad(program([block([PUSHUP])]))).toEqual({ legs: false, upper: true })
  })

  it('reads main tracks only, skips warm-ups and excluded blocks, and unresolved movements', () => {
    expect(wodLoad(program([block([SQUAT])], 'extra')).legs).toBe(false)
    expect(wodLoad(program([block([SQUAT], { warmup: true })])).legs).toBe(false)
    expect(wodLoad(program([block([SQUAT], { warmup: true })]), { wodWarmup: true }).legs).toBe(true)
    expect(wodLoad(program([block([SQUAT], { include: false })])).legs).toBe(false)
    expect(wodLoad(program([{ id: 'b', movements: [{ exId: null, rawName: 'sushy rolls' }] }])).legs).toBe(false)
  })

  it('two main tracks are alternatives: the heavier one counts, they do not add up', () => {
    const p = { tracks: [{ id: 'full', kind: 'main', blocks: [block([BURPEE])] }, { id: 'evo', kind: 'main', blocks: [block([BURPEE])] }] }
    expect(wodLoad(p).legs).toBe(false)
  })
})

describe('liftDays', () => {
  it('returns the next seven days from today, all fine with nothing planned', () => {
    const days = liftDays([], {}, NOW)
    expect(days.map(d => d.date)).toEqual(['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28'])
    expect(days.every(d => d.upperOk && d.lowerOk && !d.reasons.length)).toBe(true)
  })

  it('a run day blocks lower body that day and the day before; upper stays fine', () => {
    const d = byDate(liftDays([run('2026-10-13'), run('2026-10-20')], {}, NOW))
    expect(d['2026-10-27']).toMatchObject({ lowerOk: false, upperOk: true, reasons: ['run'] })
    expect(d['2026-10-26']).toMatchObject({ lowerOk: false, upperOk: true, reasons: ['run-next'] })
    expect(d['2026-10-25'].lowerOk).toBe(true)
    expect(d['2026-10-28'].lowerOk).toBe(true)
  })

  it('a leg-heavy WOD blocks lower body that day and the day before', () => {
    const d = byDate(liftDays([], { '2026-10-24': program([block([SQUAT])]) }, NOW))
    expect(d['2026-10-24']).toMatchObject({ lowerOk: false, upperOk: true, reasons: ['wod-legs'] })
    expect(d['2026-10-23']).toMatchObject({ lowerOk: false, reasons: ['wod-legs-next'] })
    expect(d['2026-10-25'].lowerOk).toBe(true)
  })

  it('an upper-heavy WOD blocks upper body only that day', () => {
    const d = byDate(liftDays([], { '2026-10-24': program([block([PUSHUP])]) }, NOW))
    expect(d['2026-10-24']).toMatchObject({ upperOk: false, lowerOk: true, reasons: ['wod-upper'] })
    expect(d['2026-10-23'].upperOk).toBe(true)
  })

  it('the day after the window still counts for the last day', () => {
    expect(liftDays([], { '2026-10-29': program([block([SQUAT])]) }, NOW)[6]).toMatchObject({ date: '2026-10-28', lowerOk: false })
  })

  it('a cleared program ({ _ts }) is no program', () => {
    expect(byDate(liftDays([], { '2026-10-24': { _ts: 1 } }, NOW))['2026-10-24'].lowerOk).toBe(true)
  })
})
