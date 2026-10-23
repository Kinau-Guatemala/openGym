// What a posted movement asks of *you*: its Rx load and its dose, picked by S.body.
//
// movement.rx holds both sexes as printed, in the printed unit ({ male: { w: 185, unit: 'lb' },
// female: { w: 135, unit: 'lb' } }), and is never stored converted (crossfit-module-plan, data
// model §1). A barbell pair printed without a unit is pounds, so a missing unit reads as lb. One
// printed load is the male figure with female null: it is everybody's load, so a female profile
// falls back to it.
//
// Converted, the load lands on the plate-pair grid (2.5 kg / 5 lb), the way a box writes its kg
// version of an lb program (135 lb → 60 kg, 24 kg → 55 lb). In the printed unit it is shown
// exactly as printed.
import { LB_PER_KG } from './units.js'

const GRID = { kg: 2.5, lb: 5 }
const unitOf = u => (String(u || '').toLowerCase() === 'kg' ? 'kg' : 'lb')

/** The movement's Rx load for S.body, in S.unit: `{ w, unit }`, or null when none is printed. */
export function rxFor(movement, S) {
  const rx = movement?.rx
  if (!rx || typeof rx !== 'object') return null
  const pick = S?.body === 'female' ? (rx.female || rx.male) : rx.male
  const w = Number(pick?.w)
  if (!(w > 0)) return null
  const from = unitOf(pick.unit), to = S?.unit === 'lb' ? 'lb' : 'kg'
  if (from === to) return { w, unit: to }
  const v = to === 'lb' ? w * LB_PER_KG : w / LB_PER_KG
  return { w: Math.round(v / GRID[to]) * GRID[to], unit: to }
}

/** The dose for S.body: doseFemale when the image printed a split and the profile is female. */
export const doseFor = (movement, S) =>
  (S?.body === 'female' && movement?.doseFemale) || movement?.dose || {}

/** A dose as one short line: "12-15", "20 cal", "1000 m", "40 s"; '' for none. */
export function fmtDose(dose) {
  if (!dose || typeof dose !== 'object') return ''
  const n = k => Number(dose[k]) > 0
  if (n('reps')) return n('repsMax') ? `${dose.reps}-${dose.repsMax}` : String(dose.reps)
  if (n('cal')) return `${dose.cal} cal`
  if (n('m')) return `${dose.m} m`
  if (n('sec')) return `${dose.sec} s`
  return ''
}
