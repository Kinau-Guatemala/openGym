// The box feed: the programs one account saves (S.wods), as a public feed.json its box's members
// subscribe to. This half is pure and runs anywhere: the api builds the feed with it
// (box-feed-publish.js), and the app imports it as frontend/src/lib/box-feed.js to read one.
//
//   { v: 1, box: 'Holy Program', updatedAt: ISO, programs: [{ date, title, tracks }] }
//
// The feed is public, so what goes in is an allowlist, all the way down: a field only travels if
// it is named here. Logged scores, picks, notes, the include toggles and the editor's ids stay
// with the owner, and so does anything a later version adds until it is named here too.

export const BOX_FEED_VERSION = 1
export const BOX_FEED_DAYS = 14

// Every field a feed carries, by level. A value of `true` is copied as it is if it is a string,
// number, boolean or null; an object names the fields of the object (or of each entry of the
// array) it holds; a function makes the value.
const LOAD = { w: true, unit: true }
const RX = { male: LOAD, female: LOAD }
const DOSE = { reps: true, repsMax: true, cal: true, m: true, sec: true, sets: true, restSec: true, total: true }
const STEP = { reps: true, cal: true, m: true, sec: true, rx: RX }
// A catalogue id (4 or 5 digits) travels; a custom exercise's (the owner's uid(), with letters)
// points into a customEx the feed does not carry, so it goes as null and the reader resolves
// the movement from its rawName. Either is first read through the owner's Merge into… (`merged`,
// S.exMerged): an exercise merged away goes out as the one it went to.
const EX_ID = (v, merged) => { const id = mergedExId(merged, v); return typeof id === 'string' && /^\d{4,5}$/.test(id) ? id : null }
const ALT = { raw: true, rawName: true, exId: EX_ID, dose: DOSE, doseFemale: DOSE, rx: RX, perSide: true }
export const MOVEMENT_FIELDS = {
  raw: true, rawName: true, exId: EX_ID, dose: DOSE, doseFemale: DOSE, rx: RX, steps: STEP,
  perSide: true, drop: true, slot: true, alts: ALT
}
export const BLOCK_FIELDS = {
  label: true, format: true, capMin: true, rounds: true, roundsMax: true, everySec: true,
  scheme: true, benchmark: true, warmup: true, raw: true, movements: MOVEMENT_FIELDS
}
export const TRACK_FIELDS = { label: true, kind: true, blocks: BLOCK_FIELDS }
export const PROGRAM_FIELDS = { title: true, tracks: TRACK_FIELDS }

const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * Where `id` went through the merges in `merged` (S.exMerged, `{ [fromId]: { into, _ts } }`),
 * following merges of merges; `id` itself when it was never merged. A hand copy of the app's
 * lib/exercise-merge.js mergedInto, which the api image cannot import: the app's
 * crossfit-merge.test.js holds the two to the same answers.
 */
export function mergedExId(merged, id) {
  const m = isMap(merged) ? merged : {}
  let cur = id
  for (let i = 0; i < 16; i++) {
    const into = m[cur]?.into
    if (!into || into === id) return cur
    cur = into
  }
  return cur
}

const ISO = /^\d{4}-\d{2}-\d{2}$/
const scalar = v => v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))

/**
 * `v` with only the fields `spec` names; an array is each of its objects so. Anything else is
 * dropped. A function in `spec` gets the value and `merged`.
 */
function pick(v, spec, merged) {
  if (Array.isArray(v)) return v.filter(isMap).map(x => pick(x, spec, merged))
  const out = {}
  for (const [k, sub] of Object.entries(spec)) {
    if (!Object.hasOwn(v, k)) continue
    const x = v[k]
    if (typeof sub === 'function') out[k] = sub(x, merged)
    else if (sub === true) { if (scalar(x)) out[k] = x }
    else if (Array.isArray(x) || isMap(x)) out[k] = pick(x, sub, merged)
    else if (x === null) out[k] = null
  }
  return out
}

/**
 * A saved program as a feed carries it: the allowlisted fields only, exercises read through the
 * owner's merges (`merged`, S.exMerged). Null for no program.
 */
export function feedProgram(program, merged) {
  if (!isMap(program)) return null
  const p = pick(program, PROGRAM_FIELDS, merged)
  if (!Array.isArray(p.tracks)) p.tracks = []
  return p
}

const shift = (iso, days) => new Date(Date.parse(iso + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10)

/**
 * The programs of `wods` (S.wods) a feed publishes, oldest first: every live one dated from
 * `today` (an ISO date) minus `days` onwards, future ones included. A cleared date (`{ _ts }`)
 * is not a program, so a deleted one leaves the feed.
 */
export function feedPrograms(wods, { today, days = BOX_FEED_DAYS, merged } = {}) {
  if (!isMap(wods) || !ISO.test(String(today || ''))) return []
  const from = shift(today, -Math.max(0, Math.floor(Number(days)) || 0))
  return Object.keys(wods)
    .filter(d => ISO.test(d) && d >= from && isMap(wods[d]) && Object.keys(wods[d]).some(k => k !== '_ts'))
    .sort()
    .map(date => ({ date, ...feedProgram(wods[date], merged) }))
}

/** The whole feed.json document. `now` stamps `updatedAt`; `merged` is the owner's S.exMerged. */
export function buildFeed(wods, { name = '', today, days = BOX_FEED_DAYS, now = Date.now(), merged } = {}) {
  return {
    v: BOX_FEED_VERSION,
    box: String(name || ''),
    updatedAt: new Date(now).toISOString(),
    programs: feedPrograms(wods, { today, days, merged })
  }
}

/** Where a feed pushed to GitHub repo `owner/repo` (branch main) is read from. */
export const feedUrl = repo => `https://raw.githubusercontent.com/${repo}/main/feed.json`
