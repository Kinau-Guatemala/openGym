import { describe, it, expect } from 'vitest'
import { rxHistory, furthestFromRx } from './rx-history.js'

const row = w => ({ w, r: 5, done: true, wodRir: 5 })
const day = (d, entries) => ({ id: 'wod-' + d, d, src: 'wod', entries })
const NOW = new Date('2026-10-22T12:00:00').getTime()

describe('rxHistory', () => {
  it('converts an lb Rx to a kg profile when read (on the plate grid the log screen shows), and rates the best working weight against it', () => {
    const h = rxHistory([
      day('2026-10-01', [{ id: '1520', noProg: true, rx: { w: 135, unit: 'lb' }, sets: [row(50), row(55), row(52.5)] }]),
    ], '1520', 'kg')
    expect(h).toEqual([{ d: '2026-10-01', used: 55, rx: 60, ratio: 55 / 60, swapped: false }])
  })

  it('reads a kg Rx into an lb profile, and leaves the stored Rx as printed', () => {
    const e = { id: '0549', rx: { w: 24, unit: 'kg' }, sets: [row(45)] }
    const [x] = rxHistory([day('2026-10-01', [e])], '0549', 'lb')
    expect(x.rx).toBe(55)
    expect(x.ratio).toBeCloseTo(45 / 55, 6)
    expect(e.rx).toEqual({ w: 24, unit: 'kg' })
  })

  it('counts a swap on its own, never as a ratio', () => {
    const h = rxHistory([
      day('2026-10-01', [{ id: '1520', rx: { w: 135, unit: 'lb' }, sets: [row(60)] }]),
      day('2026-10-08', [{ id: '0535', swappedFrom: '1520', sets: [row(16)] }]),
    ], '1520', 'kg')
    expect(h).toHaveLength(2)
    expect(h[1]).toEqual({ d: '2026-10-08', used: 16, rx: null, ratio: null, swapped: true, as: '0535' })
  })

  it('ignores entries with no printed load, and other exercises', () => {
    expect(rxHistory([day('2026-10-01', [{ id: '1520', sets: [row(60)] }, { id: '0648', rx: { w: 135 }, sets: [row(60)] }])], '1520')).toEqual([])
  })
})

describe('furthestFromRx', () => {
  const log = [
    day('2026-07-01', [{ id: '0648', rx: { w: 135, unit: 'lb' }, sets: [row(20)] }]),            // outside 8 weeks
    day('2026-10-01', [
      { id: '1520', rx: { w: 135, unit: 'lb' }, sets: [row(40)] },
      { id: '0648', rx: { w: 135, unit: 'lb' }, sets: [row(61.25)] },
      { id: '0549', rx: { w: 24, unit: 'kg' }, sets: [row(20)] },
    ]),
    day('2026-10-08', [
      { id: '1520', rx: { w: 135, unit: 'lb' }, sets: [row(50)] },
      { id: '0535', swappedFrom: '0652', sets: [row(0)] },
    ]),
  ]

  it('ranks the lowest average ratio first, drops what is at Rx, and puts swap-only last', () => {
    const out = furthestFromRx(log, 8, 'kg', NOW)
    expect(out.map(x => x.exId)).toEqual(['1520', '0549', '0652'])
    expect(out[0]).toMatchObject({ n: 2, swaps: 0 })
    expect(out[0].ratio).toBeCloseTo((40 + 50) / 2 / 60, 6)
    expect(out[0].last.d).toBe('2026-10-08')
    expect(out[2]).toEqual({ exId: '0652', ratio: null, last: null, n: 0, swaps: 1 })
  })

  it('reaches back as far as asked', () => {
    // The July clean (20 of 60 kg) pulls its average to 0.68, under the hang clean's 0.75.
    expect(furthestFromRx(log, 20, 'kg', NOW).map(x => x.exId)).toEqual(['0648', '1520', '0549', '0652'])
  })
})
