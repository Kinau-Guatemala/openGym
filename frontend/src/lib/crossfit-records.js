// Benchmark scores over time (crossfit-module-plan, training logic §6): every block of a logged
// WOD (lib/wod-log.js) that names a benchmark ("Fran", "DT") is one attempt at it. Per name, the
// best Rx and the best scaled score are kept apart, the way a box's whiteboard keeps them.
//
// A time is lower-is-better; rounds+reps and a load are higher-is-better. A load score is stored
// in the unit it was typed in ({ type: 'load', w, unit }, never converted), so it is converted
// when read. Lift PRs are not here: logWod files through rebuildPrHistory, so they are the
// workouts' own `prs` badges, read where the app already shows them.
import { convertWeight } from './units.js'

const list = v => (Array.isArray(v) ? v : [])
const keyOf = name => String(name || '').trim().toLowerCase()

/** A score as one number where higher is better (a time counts down), or null for no score. */
export function scoreValue(score, unit = 'kg') {
  const n = k => Math.max(0, Number(score?.[k]) || 0)
  if (score?.type === 'time') return n('sec') > 0 ? -n('sec') : null
  if (score?.type === 'rounds') return n('rounds') || n('reps') ? n('rounds') * 10000 + n('reps') : null
  if (score?.type === 'load') return n('w') > 0 ? convertWeight(n('w'), ['kg', 'lb'].includes(score.unit) ? score.unit : unit, unit) : null
  return null
}

/**
 * Every benchmark logged: `[{ name, type, last, rx, scaled, history }]`, the one done last first.
 * `rx` and `scaled` are the best attempt of each kind (`{ d, score, value }`, or null), among the
 * attempts scored the way the latest one was; `history` is every attempt, newest first
 * (`{ d, wid, score, rx, value }`).
 */
export function benchmarks(workouts, unit = 'kg') {
  const by = new Map()
  for (const w of list(workouts)) {
    for (const b of list(w?.wod?.blocks)) {
      const key = keyOf(b?.benchmark)
      if (!key) continue
      if (!by.has(key)) by.set(key, [])
      by.get(key).push({ d: w.d, wid: w.id, name: String(b.benchmark).trim(), score: b.score || { type: 'none' }, rx: !!b.rx, value: scoreValue(b.score, unit) })
    }
  }
  const out = []
  for (const tries of by.values()) {
    const history = tries.sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0))
    const type = history.find(h => h.value != null)?.score.type || 'none'
    const best = rx => history
      .filter(h => h.rx === rx && h.value != null && h.score.type === type)
      .reduce((top, h) => (!top || h.value > top.value ? h : top), null)
    const pick = h => (h ? { d: h.d, score: h.score, value: h.value } : null)
    out.push({
      name: history[0].name, type, last: history[0].d,
      rx: pick(best(true)), scaled: pick(best(false)),
      history: history.map(({ name, ...h }) => h),
    })
  }
  return out.sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0))
}

/** The lifts a logged WOD earned a PR badge on: `[{ d, wid, exId }]`, newest first. */
export const wodPrs = workouts => list(workouts)
  .filter(w => w?.src === 'wod')
  .flatMap(w => list(w.prs).map(exId => ({ d: w.d, wid: w.id, exId })))
  .sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0))
