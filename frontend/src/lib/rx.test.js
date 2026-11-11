import { describe, expect, it } from 'vitest'
import { _setLangState } from './i18n-core.js'
import { rxFor, doseFor, emptyStep, fmtDose, fmtRounds, fmtSteps, stepRxFor, stepsOf } from './rx.js'

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

  it('a TARGET total across the slot\'s minutes: "70 total" (T34)', () => {
    expect(fmtDose({ total: 70 })).toBe('70 total')
    _setLangState('es', { '{0} total': '{0} en total' }, null, null)
    try { expect(fmtDose({ total: 70 })).toBe('70 en total') } finally { _setLangState('en', {}, null, null) }
  })
})

describe('fmtRounds (T23)', () => {
  it('an EVERY block, a round range, plain rounds, none', () => {
    expect(fmtRounds({ rounds: 4, everySec: 180 })).toBe('Every 3:00 × 4')
    expect(fmtRounds({ rounds: 8, everySec: 90 })).toBe('Every 1:30 × 8')
    expect(fmtRounds({ rounds: 3, roundsMax: 4 })).toBe('3–4 rounds')
    expect(fmtRounds({ rounds: 3, roundsMax: 3 })).toBe('3 rounds')
    expect(fmtRounds({ rounds: 5, everySec: null, roundsMax: null })).toBe('5 rounds')
    expect(fmtRounds({ rounds: null, everySec: 90 })).toBe('Every 1:30')
    expect(fmtRounds({})).toBe('')
  })
})

describe('steps (T26)', () => {
  const lb = (male, female) => ({ male: { w: male, unit: 'lb' }, female: { w: female, unit: 'lb' } })
  const jerks = { dose: {}, rx: lb(135, 95), steps: [135, 155, 185, 205, 225].map((w, i) => ({ rx: lb(w, [95, 105, 135, 145, 155][i]) })) }
  const lunges = { dose: { reps: 12 }, rx: lb(95, 65), steps: [[12, 95], [10, 115], [8, 135], [6, 155], [4, 175]].map(([reps, w]) => ({ reps, rx: lb(w, w - 30) })) }
  const male = { body: 'male', unit: 'lb' }

  it('stepsOf: the steps, or null for none', () => {
    expect(stepsOf(jerks)).toHaveLength(5)
    for (const m of [{}, { steps: null }, { steps: [] }, null]) expect(stepsOf(m)).toBe(null)
  })

  it('stepRxFor: the step\'s load by S.body and S.unit, else the movement\'s', () => {
    expect(stepRxFor(jerks.steps[4], jerks, male)).toEqual({ w: 225, unit: 'lb' })
    expect(stepRxFor(jerks.steps[4], jerks, { body: 'female', unit: 'kg' })).toEqual({ w: 70, unit: 'kg' })
    expect(stepRxFor({ reps: 3 }, jerks, male)).toEqual({ w: 135, unit: 'lb' })
    expect(stepRxFor({ reps: 3 }, { dose: {} }, male)).toBe(null)
  })

  it('fmtSteps: the counts and the load range on one line', () => {
    expect(fmtSteps(jerks, male, [10, 8, 6, 4, 2])).toBe('10-8-6-4-2 @ 135→225 lb')
    expect(fmtSteps(jerks, male)).toBe('135→225 lb')
    expect(fmtSteps(lunges, { body: 'female', unit: 'lb' })).toBe('12-10-8-6-4 @ 65→145 lb')
    expect(fmtSteps({ dose: { reps: 20 }, rx: { male: { w: 24, unit: 'kg' }, female: null }, steps: [20, 18, 16].map(reps => ({ reps })) }, { body: 'male', unit: 'kg' })).toBe('20-18-16 @ 24 kg')
    expect(fmtSteps({ dose: { cal: 10 }, steps: [{ cal: 10 }, { cal: 12 }] }, male)).toBe('10-12 cal')
    expect(fmtSteps({ dose: {} }, male)).toBe('')
  })

  it('fmtSteps: a drop set\'s empty step is max, "15 → 12 → Max"; in a ladder it is the rung (T34)', () => {
    const curls = { dose: { reps: 15 }, steps: [{ reps: 15 }, { reps: 12 }, {}] }
    expect(fmtSteps(curls, male)).toBe('15 → 12 → Max')
    expect(fmtSteps({ ...curls, rx: { male: { w: 30, unit: 'lb' } } }, male)).toBe('15 → 12 → Max @ 30 lb')
    expect(fmtSteps({ dose: {}, steps: [{ reps: 10 }, {}, {}] }, male, [10, 8, 6])).toBe('10-8-6')
    // a ladder's empty steps with no rungs to hand (the movement sheet): no counts, never "Max"
    expect(fmtSteps({ dose: {}, steps: [{ rx: { male: { w: 135, unit: 'lb' } } }, {}, { rx: { male: { w: 225, unit: 'lb' } } }] }, male)).toBe('135→225 lb')
    expect([{}, { rx: null }, { reps: 0 }, { rx: { male: null } }].map(emptyStep)).toEqual([true, true, false, false])
  })

  // T28: a converted load keeps its half plate, written the language's way ("102,5" in Spanish).
  it('fmtSteps: the loads are numbers in the app language', () => {
    const kg = { body: 'male', unit: 'kg' }
    expect(fmtSteps(jerks, kg)).toBe('60→102.5 kg')
    _setLangState('es', {}, null, null)
    try { expect(fmtSteps(jerks, kg)).toBe('60→102,5 kg') } finally { _setLangState('en', {}, null, null) }
  })
})
