import { FATIGUE_SCAN_MS, fatigueOf } from '../src/lib/recovery.js'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const BASE = Date.UTC(2026, 0, 31, 12)
const ID = '1254'
const RUN = '0685'

// `runMin`: a cardio row of that many minutes on top (duration-weighted, up to 6 sets).
const workout = (start, weight, count = 8, runMin = 0) => ({
  d: new Date(start).toISOString(),
  start,
  entries: [{
    id: ID,
    sets: Array.from({ length: count }, () => ({ done: true, w: weight, r: 8 })),
  }, ...(runMin ? [{ id: RUN, sets: [{ done: true, min: runMin, speed: 10 }] }] : [])],
})

// Deterministic LCG: failures reproduce exactly without an external property-testing dependency.
let seed = 0x5eed1234
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return seed / 0x100000000
}

let comparisons = 0
let deletionComparisons = 0
let largestIncrease = -Infinity
for (let historyIndex = 0; historyIndex < 100; historyIndex += 1) {
  const sessionCount = 3 + Math.floor(random() * 10)
  const history = Array.from({ length: sessionCount }, () => {
    const ageHours = Math.floor(random() * 120 * 24)
    const weight = 40 + Math.floor(random() * 141)
    const count = 1 + Math.floor(random() * 12)
    // Half the sessions carry a run, from 5 minutes (one set) to 2 hours (past the 6-set cap).
    const runMin = random() < 0.5 ? 5 + Math.floor(random() * 116) : 0
    return workout(BASE - ageHours * HOUR, weight, count, runMin)
  })

  // Every muscle, not only chest: the runs load the legs.
  let previous = fatigueOf(history, BASE)
  for (let hour = 1; hour <= 1080; hour += 1) {
    const current = fatigueOf(history, BASE + hour * HOUR)
    for (const [slug, value] of Object.entries(current)) {
      const increase = value - previous[slug]
      largestIncrease = Math.max(largestIncrease, increase)
      if (increase > 1e-12) {
        throw new Error(
          `${slug} fatigue increased in history ${historyIndex} at hour ${hour}: ${previous[slug]} -> ${value}`,
        )
      }
    }
    previous = current
    comparisons += 1
  }

  const beforeDeletion = fatigueOf(history, BASE)
  // Phase-2 contract: only the chronologically latest session's deletion is monotonic.
  // Anchors and acute:chronic gains are history-dependent, so removing a mid-history
  // workout may re-score later sessions (a removed PR lowers their anchors). Deleting
  // the latest session touches no earlier window and can only remove stimulus.
  const latestIndex = history.reduce((best, w, i) => (w.start > history[best].start ? i : best), 0)
  const afterLatestDeletion = fatigueOf(history.filter((_, index) => index !== latestIndex), BASE)
  for (const [slug, before] of Object.entries(beforeDeletion)) {
    if (afterLatestDeletion[slug] > before + Number.EPSILON) {
      throw new Error(
        `deleting the latest workout in history ${historyIndex} increased ${slug}: `
        + `${before} -> ${afterLatestDeletion[slug]}`,
      )
    }
    deletionComparisons += 1
  }
}

if (comparisons !== 108000) throw new Error(`expected 108000 comparisons, got ${comparisons}`)

// Pin the two history-edit invariants alongside the randomized property probes.
const today = workout(BASE, 100, 5)
const baseline = fatigueOf([today], BASE).chest
for (const oldImport of [workout(BASE - 90 * DAY, 140, 10), workout(BASE - 90 * DAY, 100, 20)]) {
  if (fatigueOf([oldImport, today], BASE).chest !== baseline) {
    throw new Error('an import older than the scan changed current fatigue')
  }
}

const deletionHistory = [
  workout(BASE - FATIGUE_SCAN_MS - DAY, 100, 15),
  workout(BASE - 3 * DAY, 100, 8, 45),
  workout(BASE - 2 * DAY, 100, 8),
  workout(BASE - DAY, 60, 4, 90),
  workout(BASE, 120, 10, 30),
]
const beforePinnedDeletion = fatigueOf(deletionHistory, BASE)
// Pinned latest-deletion case: removing the newest session never increases fatigue.
const afterPinnedDeletion = fatigueOf(deletionHistory.slice(0, -1), BASE)
for (const [slug, before] of Object.entries(beforePinnedDeletion)) {
  if (afterPinnedDeletion[slug] > before + Number.EPSILON) {
    throw new Error(`deleting the latest workout increased ${slug}: ${before} -> ${afterPinnedDeletion[slug]}`)
  }
}

console.log(`monotonic probe: ${comparisons} comparisons, largest increase ${largestIncrease}, PASS`)
console.log(
  `history-edit probe: out-of-scan imports stable; ${deletionComparisons} randomized `
  + 'latest-workout deletion comparisons non-increasing, PASS',
)
