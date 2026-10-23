// The hypertrophy gap: which muscles get fewer effective sets a week than the target once
// CrossFit, Holy Pump and lift days are all counted, and where the credit came from.
//
// A set counts the way fatigue counts it (recovery.js sessionEffSets: RIR weight, wodRir for
// metcon rows, muscle weights, the 12-set per-session cap) except cardio-mode rows, which
// load fatigue but don't build muscle. The cap applies to the session total, so each entry is
// scored on its own first and every source's share is scaled by cap / total: a WOD and a Pump
// done in one workout still split.
import { MUSCLES } from './muscles.js'
import { workoutAt } from './history.js'
import { anchorsByWorkout, sessionEffSets, FATIGUE_MAX_SETS_PER_SESSION, FATIGUE_RIR_WINDOW_MS } from './recovery.js'

const DAY = 86400000

// The muscles a weekly set target means something for. Serratus, hip flexors and shins only
// ever pick up secondary credit, so a 10-set target would flag them forever.
export const GAP_MUSCLES = MUSCLES.filter(m => !['serratus', 'hip-flexors', 'tibialis'].includes(m))

/** Where an entry's credit goes: a WOD's metcon (`noProg`) is wod, its other blocks pump, the rest lift. */
export const sourceOf = (workout, entry) => workout?.src === 'wod' ? (entry?.noProg ? 'wod' : 'pump') : 'lift'

/**
 * Effective sets per week per muscle over the last `days`, against a weekly target.
 *
 * @param {Array<object>} workouts Workout history.
 * @param {number} now Current time in ms.
 * @param {{days?: number, target?: number, unit?: string, bodyweightKg?: number}} opts
 *   `target` is S.hypTarget; `unit`/`bodyweightKg` are the same profile options fatigueOf takes.
 * @returns {Array<{muscle: string, setsPerWeek: number, target: number, deficit: number,
 *   sources: {wod: number, pump: number, lift: number}}>} Every GAP_MUSCLES slug, largest deficit first.
 */
export function muscleGap(workouts, now, { days = 14, target = 10, unit, bodyweightKg } = {}) {
  const from = now - days * DAY
  // Anchors look back 90 days from each session, so the pool reaches that far before the window.
  const pool = (workouts || []).filter(w => workoutAt(w) > from - FATIGUE_RIR_WINDOW_MS && workoutAt(w) <= now)
  const anchors = anchorsByWorkout(pool, { unit, bodyweightKg })
  const sums = Object.fromEntries(GAP_MUSCLES.map(m => [m, { wod: 0, pump: 0, lift: 0 }]))
  for (const w of pool) {
    if (!(workoutAt(w) > from)) continue
    const parts = sessionEffSets(w, anchors.get(w), { unit, bodyweightKg, excludeCardio: true, byEntry: true })
    for (const m of GAP_MUSCLES) {
      const total = parts.reduce((sum, p) => sum + p.sets[m], 0)
      if (!(total > 0)) continue
      const scale = Math.min(1, FATIGUE_MAX_SETS_PER_SESSION / total)
      for (const p of parts) sums[m][sourceOf(w, p.entry)] += p.sets[m] * scale
    }
  }
  const weeks = days / 7
  return GAP_MUSCLES.map(muscle => {
    const { wod, pump, lift } = sums[muscle]
    const sources = { wod: wod / weeks, pump: pump / weeks, lift: lift / weeks }
    const setsPerWeek = sources.wod + sources.pump + sources.lift
    return { muscle, setsPerWeek, target, deficit: Math.max(0, target - setsPerWeek), sources }
  }).sort((a, b) => b.deficit - a.deficit || MUSCLES.indexOf(a.muscle) - MUSCLES.indexOf(b.muscle))
}
