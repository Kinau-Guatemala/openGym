// Lift-day suggestions: which of the next seven days suit a lower-body or an upper-body lifting
// session around the runs and the posted CrossFit programs.
//
//   - Run days are inferred: a weekday with at least two runs imported from Health Connect
//     (src 'hc') on different dates in the last four weeks.
//   - A posted program is leg-heavy (or upper-heavy) when the movements of its included blocks
//     load those muscles past a threshold (loadOf, one set per movement). Only main tracks count:
//     the extras (Holy Pump, Running Club) are optional.
//   - Lower body wants no run and no leg-heavy WOD on that day or the next one; upper body is
//     kept off only a day whose WOD is upper-heavy.
import { loadOf } from './muscles.js'
import { isoOf } from './format.js'
import { wodOf } from './wods.js'
import { includeOf } from './wod-draft.js'

const DAY = 86400000
// Health Connect imports file runs under these catalogue ids (health-import.js EXERCISE_BY_TYPE).
export const RUN_IDS = new Set(['0685', '2197'])
export const LEG_MUSCLES = ['quadriceps', 'gluteal', 'hamstring']
export const UPPER_MUSCLES = ['chest', 'deltoids', 'upper-back', 'triceps', 'biceps', 'trapezius']
// ponytail: one set per movement, dose ignored, so Karen's 150 wall balls weigh as much as 10.
// A single primary-leg movement (squat 1.8, KB swing 1.4 + anything) clears it; a run or burpees
// alone (0.8) don't. Weigh by reps x rounds if this turns out too blunt.
export const HEAVY = 1.5

const dateAt = (now, plus) => { const d = new Date(now); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + plus, 12) }
const isRun = w => w?.src === 'hc' && (w.entries || []).some(e => RUN_IDS.has(e?.id))

/** Weekdays (getDay numbers) with runs on at least two dates in the four weeks up to `now`. */
export function runDays(workouts, now = Date.now()) {
  const from = isoOf(dateAt(now, -27))
  const today = isoOf(dateAt(now, 0))
  const dates = [new Set(), new Set(), new Set(), new Set(), new Set(), new Set(), new Set()]
  for (const w of workouts || []) {
    if (!isRun(w) || !(w.d >= from && w.d <= today)) continue
    dates[new Date(w.d + 'T12:00:00').getDay()].add(w.d)
  }
  return new Set(dates.flatMap((s, wd) => (s.size >= 2 ? [wd] : [])))
}

/** `{ legs, upper }`: whether a posted program is leg-heavy / upper-heavy (the heaviest main track). */
export function wodLoad(program, S) {
  let legs = 0
  let upper = 0
  for (const track of program?.tracks || []) {
    if (track?.kind !== 'main') continue
    const items = (track.blocks || []).filter(b => includeOf(track, b, S))
      .flatMap(b => (b.movements || []).filter(m => m?.exId).map(m => ({ id: m.exId, sets: 1 })))
    const load = loadOf(items)
    const sum = muscles => muscles.reduce((n, m) => n + (load[m] || 0), 0)
    legs = Math.max(legs, sum(LEG_MUSCLES))
    upper = Math.max(upper, sum(UPPER_MUSCLES))
  }
  return { legs: legs >= HEAVY, upper: upper >= HEAVY }
}

/**
 * The next seven days, today first: `{ date, upperOk, lowerOk, reasons }`. `reasons` are codes:
 * 'run' / 'run-next' (an inferred run day today / tomorrow), 'wod-legs' / 'wod-legs-next' (a
 * leg-heavy program), 'wod-upper' (an upper-heavy program that day).
 *
 * @param {Array<object>} workouts Workout history (S.workouts).
 * @param {object} wods S.wods.
 * @param {number} now Current time in ms.
 * @param {object} [S] The state, for the warm-up setting includeOf reads (S.wodWarmup).
 */
export function liftDays(workouts, wods, now = Date.now(), S) {
  const runs = runDays(workouts, now)
  const day = i => {
    const d = dateAt(now, i)
    const program = wodOf({ wods }, isoOf(d))
    return { date: isoOf(d), run: runs.has(d.getDay()), ...(program ? wodLoad(program, S) : { legs: false, upper: false }) }
  }
  const days = Array.from({ length: 8 }, (_, i) => day(i))
  return days.slice(0, 7).map((d, i) => {
    const next = days[i + 1]
    const reasons = [
      ...(d.run ? ['run'] : []), ...(next.run ? ['run-next'] : []),
      ...(d.legs ? ['wod-legs'] : []), ...(next.legs ? ['wod-legs-next'] : []),
      ...(d.upper ? ['wod-upper'] : [])
    ]
    return { date: d.date, upperOk: !d.upper, lowerOk: !(d.run || next.run || d.legs || next.legs), reasons }
  })
}
