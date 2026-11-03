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
import { t } from './i18n-core.js'
import { fmtNum } from './format.js'

const GRID = { kg: 2.5, lb: 5 }
const unitOf = u => (String(u || '').toLowerCase() === 'kg' ? 'kg' : 'lb')

/** The movement's Rx load for S.body as printed: `{ w, unit }`, or null when none is printed. */
export function rxPrinted(movement, S) {
  const rx = movement?.rx
  if (!rx || typeof rx !== 'object') return null
  const pick = S?.body === 'female' ? (rx.female || rx.male) : rx.male
  const w = Number(pick?.w)
  return w > 0 ? { w, unit: unitOf(pick.unit) } : null
}

/** The movement's Rx load for S.body, in S.unit: `{ w, unit }`, or null when none is printed. */
export function rxFor(movement, S) {
  const pick = rxPrinted(movement, S)
  return pick ? { w: rxIn(pick, S?.unit), unit: S?.unit === 'lb' ? 'lb' : 'kg' } : null
}

/** A printed Rx `{ w, unit }` as a load in `unit`: exact in its own unit, else on the plate grid. */
export function rxIn(rx, unit) {
  const w = Number(rx?.w) || 0
  const from = unitOf(rx?.unit), to = unit === 'lb' ? 'lb' : 'kg'
  if (from === to) return w
  const v = to === 'lb' ? w * LB_PER_KG : w / LB_PER_KG
  return Math.round(v / GRID[to]) * GRID[to]
}

/** The dose for S.body: doseFemale when the image printed a split and the profile is female. */
export function doseFor(movement, S) {
  const dose = movement?.dose || {}
  if (S?.body !== 'female' || !movement?.doseFemale) return dose
  // The repeats and the rest are the line's, whoever does it: `2x 20/15 Cal`.
  const { sets, restSec } = dose
  return { ...(sets != null ? { sets } : {}), ...(restSec != null ? { restSec } : {}), ...movement.doseFemale }
}

/** A dose as one short line: "12-15", "20 cal", "1000 m", "40 s", "2 × 200 m", "2 × Max"; '' for none. */
export function fmtDose(dose) {
  if (!dose || typeof dose !== 'object') return ''
  const n = k => Number(dose[k]) > 0
  const one = n('reps') ? (n('repsMax') ? `${dose.reps}-${dose.repsMax}` : String(dose.reps))
    : n('cal') ? `${dose.cal} cal` : n('m') ? `${dose.m} m` : n('sec') ? `${dose.sec} s` : ''
  return Number(dose.sets) > 1 ? `${dose.sets} × ${one || t('Max')}` : one
}

/** A block's rounds as the program, review and log screens show them: "Every 3:00 × 4" for an
 *  EVERY block ("Every 1:30" without rounds, a partner WOD), "3–4 rounds" for a printed range,
 *  "5 rounds"; '' for none. */
export function fmtRounds(block) {
  const n = k => Number(block?.[k]) > 0
  const every = n('everySec') && `${Math.floor(block.everySec / 60)}:${String(block.everySec % 60).padStart(2, '0')}`
  if (!n('rounds')) return every ? t('Every {0}', every) : ''
  if (every) return t('Every {0} × {1}', every, block.rounds)
  if (block.roundsMax > block.rounds) return t('{0}–{1} rounds', block.rounds, block.roundsMax)
  return t('{0} rounds', block.rounds)
}

/** A movement done once per set with its own reps or load (`10-8-6-4-2` jerks at 135 → 225, an
 *  EMOM's M2 / M4 … lunges): its steps, one set each, or null. */
export const stepsOf = movement => (Array.isArray(movement?.steps) && movement.steps.length ? movement.steps : null)

/** A step's Rx load for S.body in S.unit, else the movement's: `{ w, unit }`, or null. */
export const stepRxFor = (step, movement, S) => rxFor(step, S) || rxFor(movement, S)

const STEP_KINDS = [['reps', ''], ['cal', ' cal'], ['m', ' m'], ['sec', ' s']]

/** A movement's steps as one short line: "10-8-6-4-2 @ 135→225 lb", "12-10-8-6-4", "95→175 lb";
 *  '' for none. A step without its own count takes the movement's, else the ladder rung `rungs[i]`. */
export function fmtSteps(movement, S, rungs) {
  const steps = stepsOf(movement)
  if (!steps) return ''
  const dose = doseFor(movement, S)
  const kind = STEP_KINDS.find(([k]) => steps.some(s => Number(s?.[k]) > 0) || Number(dose[k]) > 0)
  const counts = steps.map((s, i) => (kind && (Number(s?.[kind[0]]) || Number(dose[kind[0]]))) || rungs?.[i] || 0)
  const reps = counts.every(n => n > 0) && new Set(counts).size > 1 ? counts.join('-') + (kind?.[1] || '') : ''
  const loads = steps.map(s => stepRxFor(s, movement, S)).filter(Boolean)
  const first = loads[0], last = loads.at(-1)
  const load = !first ? '' : loads.every(l => l.w === first.w) ? `${fmtNum(first.w)} ${first.unit}` : `${fmtNum(first.w)}→${fmtNum(last.w)} ${first.unit}`
  return [reps, load].filter(Boolean).join(' @ ')
}
