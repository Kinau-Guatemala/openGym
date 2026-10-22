// The gymnastics skills a CrossFitter tracks (crossfit-module-plan, training logic §8): a fixed
// list, each mapped to the catalogue ids it is logged as, wherever it was logged (a WOD or a
// lifting session alike).
//
// The ids are checked against the catalogue's own pictures: 0631 and 0558 are on rings, 5194 and
// 1401 on a bar; 0471 is the strict handstand push-up, 5151 the kipping one. The catalogue has a
// single pull-up (0652), which the box's "pull up" and "pull up estricto" both resolve to, so
// strict and kipping pull-ups can't be told apart here and share one skill.
//
// ponytail: "max reps in one row" reads a logged row, which for a WOD is the reps of one round,
// not an unbroken set; good enough to see a skill come in, not a max-unbroken test.
import { completedRepsOf } from './history.js'
import { isSideSet, isWarmupRow } from './workout-model.js'
import { isoOf } from './format.js'

export const SKILLS = [
  { key: 'bmu', name: 'Bar muscle-up', ids: ['5194', '1401'] },
  { key: 'rmu', name: 'Ring muscle-up', ids: ['0631', '0558'] },
  { key: 't2b', name: 'Toes-to-bar', ids: ['3891'] },
  { key: 'hspu', name: 'Handstand push-up', ids: ['0471', '5151'] },
  { key: 'du', name: 'Double-unders', ids: ['3885'] },
  { key: 'pullup', name: 'Pull-up', ids: ['0652'] },
]

const list = v => (Array.isArray(v) ? v : [])
const DAY = 86400000
const reps = s => Math.max(0, Number(s?.r) || 0)

/**
 * Per skill: `{ key, name, ids, first, maxReps, perSide, volume, rxDone }`. `first` is the date
 * it was first logged (null when never), `maxReps` the most reps in one row (per side for a
 * per-side row, `perSide` then true), `volume` the reps of the last 4 weeks, `rxDone` the WOD
 * blocks marked Rx it was done in as programmed.
 */
export function skillStats(workouts, now = Date.now(), skills = SKILLS) {
  const from = isoOf(new Date(now - 28 * DAY))
  return skills.map(sk => {
    const ids = new Set(sk.ids)
    const out = { key: sk.key, name: sk.name, ids: sk.ids, first: null, maxReps: 0, perSide: false, volume: 0, rxDone: 0 }
    for (const w of list(workouts)) {
      for (const e of list(w?.entries)) {
        if (!ids.has(e?.id)) continue
        let did = false
        for (const s of list(e.sets)) {
          if (isWarmupRow(s)) continue
          const n = completedRepsOf(s)
          if (!n) continue
          did = true
          const top = isSideSet(s) ? Math.max(...['L', 'R'].map(k => (s.sides[k]?.done ? reps(s.sides[k]) : 0))) : n
          if (top > out.maxReps) { out.maxReps = top; out.perSide = isSideSet(s) }
          if (w.d >= from) out.volume += n
        }
        if (!did) continue
        if (!out.first || w.d < out.first) out.first = w.d
        if (!e.swappedFrom && list(w.wod?.blocks).some(b => b.ref === e.wodBlock && b.rx)) out.rxDone++
      }
    }
    return out
  })
}
