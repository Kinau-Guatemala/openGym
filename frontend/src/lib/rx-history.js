// Rx against what you actually lifted (crossfit-module-plan, training logic §7).
//
// A logged WOD entry done as printed carries the prescribed load as `entry.rx`, in the unit the
// box printed it in ({ w: 185, unit: 'lb' }); it is never stored converted, so it is converted
// to the profile's unit here, when read. An entry swapped for an exercise outside the printed
// ones carries `swappedFrom` (the programmed id) and no Rx: a swap is counted on its own, never
// as a ratio, since a ring row is not "40 % of a pull-up".
//
// The conversion is the one the log screen prefills with (lib/rx.js rxIn, on the plate grid), so
// lifting the 60 kg it showed for a 135 lb Rx reads as Rx, not as 98 %.
import { rxIn } from './rx.js'
import { bestWeightForEntry } from './history.js'
import { isoOf } from './format.js'

const list = v => (Array.isArray(v) ? v : [])
const DAY = 86400000

/**
 * Every logged WOD that programmed `exId` with a load: `[{ d, used, rx, ratio, swapped }]`,
 * oldest first. `used` is the entry's best working weight and `rx` the prescription, both in
 * `unit`; `ratio` is used / rx. A swap is `{ swapped: true, ratio: null, rx: null }` with the
 * exercise done instead as `as`.
 */
export function rxHistory(workouts, exId, unit = 'kg') {
  const out = []
  for (const w of list(workouts)) {
    for (const e of list(w?.entries)) {
      if (e?.swappedFrom === exId) {
        out.push({ d: w.d, used: bestWeightForEntry(e) || 0, rx: null, ratio: null, swapped: true, as: e.id })
      } else if (e?.id === exId && !e.swappedFrom && Number(e.rx?.w) > 0) {
        const rx = rxIn(e.rx, unit), used = bestWeightForEntry(e) || 0
        out.push({ d: w.d, used, rx, ratio: used / rx, swapped: false })
      }
    }
  }
  return out.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))
}

/**
 * The movements furthest from Rx over the last `weeks`: `[{ exId, ratio, last, n, swaps }]`, by
 * where each one stands now: `last` is the latest rated attempt and `ratio` its ratio, lowest
 * first, `n` the rated attempts in the window. A movement last done at Rx and never swapped is
 * left out; one only ever swapped (ratio null) comes after every ratio.
 */
export function furthestFromRx(workouts, weeks = 8, unit = 'kg', now = Date.now()) {
  const from = isoOf(new Date(now - weeks * 7 * DAY))
  const recent = list(workouts).filter(w => w?.d >= from)
  const ids = new Set()
  for (const w of recent) for (const e of list(w.entries)) {
    if (e?.swappedFrom) ids.add(e.swappedFrom)
    else if (Number(e?.rx?.w) > 0) ids.add(e.id)
  }
  const out = []
  for (const exId of ids) {
    const h = rxHistory(recent, exId, unit)
    const rated = h.filter(x => !x.swapped)
    const swaps = h.length - rated.length
    const last = rated[rated.length - 1] || null
    if (last && last.ratio >= 1 && !swaps) continue
    out.push({ exId, ratio: last ? last.ratio : null, last, n: rated.length, swaps })
  }
  return out.sort((a, b) => (a.ratio ?? Infinity) - (b.ratio ?? Infinity) || b.swaps - a.swaps)
}
