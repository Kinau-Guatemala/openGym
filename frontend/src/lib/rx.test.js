import { describe, expect, it } from 'vitest'
import { rxFor, doseFor, fmtDose } from './rx.js'

const hang = { rx: { male: { w: 185, unit: 'lb' }, female: { w: 135, unit: 'lb' } } }

describe('rxFor', () => {
  it('picks by S.body and shows the printed unit as printed', () => {
    expect(rxFor(hang, { body: 'male', unit: 'lb' })).toEqual({ w: 185, unit: 'lb' })
    expect(rxFor(hang, { body: 'female', unit: 'lb' })).toEqual({ w: 135, unit: 'lb' })
  })

  it('converts to S.unit on the plate-pair grid', () => {
    // 135 lb = 61.2 kg → 60 on the 2.5 kg grid; 185 lb = 83.9 kg → 85
    expect(rxFor(hang, { body: 'female', unit: 'kg' })).toEqual({ w: 60, unit: 'kg' })
    expect(rxFor(hang, { body: 'male', unit: 'kg' })).toEqual({ w: 85, unit: 'kg' })
    const kb = { rx: { male: { w: 24, unit: 'KG' }, female: { w: 16, unit: 'kg' } } }
    expect(rxFor(kb, { body: 'male', unit: 'lb' })).toEqual({ w: 55, unit: 'lb' })
    expect(rxFor(kb, { body: 'female', unit: 'lb' })).toEqual({ w: 35, unit: 'lb' })
    expect(rxFor(kb, { body: 'male', unit: 'kg' })).toEqual({ w: 24, unit: 'kg' })
  })

  it('reads a unitless load as lb', () => {
    const m = { rx: { male: { w: 95 }, female: { w: 65 } } }
    expect(rxFor(m, { body: 'male', unit: 'lb' })).toEqual({ w: 95, unit: 'lb' })
    expect(rxFor(m, { body: 'male', unit: 'kg' })).toEqual({ w: 42.5, unit: 'kg' })
  })

  it('one printed load is everybody’s; nothing printed is null', () => {
    const one = { rx: { male: { w: 50, unit: 'lb' }, female: null } }
    expect(rxFor(one, { body: 'female', unit: 'lb' })).toEqual({ w: 50, unit: 'lb' })
    expect(rxFor({ rx: null }, { body: 'male', unit: 'kg' })).toBeNull()
    expect(rxFor({}, {})).toBeNull()
    expect(rxFor({ rx: { male: { w: 0 } } }, { unit: 'kg' })).toBeNull()
  })
})

describe('doseFor / fmtDose', () => {
  const row = { dose: { cal: 20 }, doseFemale: { cal: 15 } }
  it('picks the female dose only for a female profile with a split printed', () => {
    expect(doseFor(row, { body: 'male' })).toEqual({ cal: 20 })
    expect(doseFor(row, { body: 'female' })).toEqual({ cal: 15 })
    expect(doseFor({ dose: { reps: 5 } }, { body: 'female' })).toEqual({ reps: 5 })
    expect(doseFor({}, {})).toEqual({})
    expect(doseFor({ dose: { sets: 2, cal: 20, restSec: 60 }, doseFemale: { cal: 15 } }, { body: 'female' })).toEqual({ sets: 2, restSec: 60, cal: 15 })
  })
  it('formats each kind', () => {
    expect(fmtDose({ reps: 12, repsMax: 15 })).toBe('12-15')
    expect(fmtDose({ reps: 5 })).toBe('5')
    expect(fmtDose({ cal: 20 })).toBe('20 cal')
    expect(fmtDose({ m: 1000 })).toBe('1000 m')
    expect(fmtDose({ sec: 40 })).toBe('40 s')
    expect(fmtDose({})).toBe('')
  })
  it('puts the repeats in front: 2 × 200 m, and 2 × Max for sets with no number', () => {
    expect(fmtDose({ sets: 2, m: 200, restSec: 60 })).toBe('2 × 200 m')
    expect(fmtDose({ sets: 3, reps: 10 })).toBe('3 × 10')
    expect(fmtDose({ sets: 2 })).toBe('2 × Max')
    expect(fmtDose({ sets: 1, m: 8000 })).toBe('8000 m')
  })
})
