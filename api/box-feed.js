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
// array) it holds.
const LOAD = { w: true, unit: true }
const RX = { male: LOAD, female: LOAD }
const DOSE = { reps: true, repsMax: true, cal: true, m: true, sec: true, sets: true, restSec: true }
const STEP = { reps: true, cal: true, m: true, sec: true, rx: RX }
const ALT = { raw: true, rawName: true, exId: true, dose: DOSE, doseFemale: DOSE, rx: RX, perSide: true }
export const MOVEMENT_FIELDS = {
  raw: true, rawName: true, exId: true, dose: DOSE, doseFemale: DOSE, rx: RX, steps: STEP,
  perSide: true, slot: true, alts: ALT
}
export const BLOCK_FIELDS = {
  label: true, format: true, capMin: true, rounds: true, roundsMax: true, everySec: true,
  scheme: true, benchmark: true, warmup: true, raw: true, movements: MOVEMENT_FIELDS
}
export const TRACK_FIELDS = { label: true, kind: true, blocks: BLOCK_FIELDS }
export const PROGRAM_FIELDS = { title: true, tracks: TRACK_FIELDS }

const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v)
const ISO = /^\d{4}-\d{2}-\d{2}$/
const scalar = v => v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))

/** `v` with only the fields `spec` names; an array is each of its objects so. Anything else is dropped. */
function pick(v, spec) {
  if (Array.isArray(v)) return v.filter(isMap).map(x => pick(x, spec))
  const out = {}
  for (const [k, sub] of Object.entries(spec)) {
    if (!Object.hasOwn(v, k)) continue
    const x = v[k]
    if (sub === true) { if (scalar(x)) out[k] = x }
    else if (Array.isArray(x) || isMap(x)) out[k] = pick(x, sub)
    else if (x === null) out[k] = null
  }
  return out
}

/** A saved program as a feed carries it: the allowlisted fields only. Null for no program. */
export function feedProgram(program) {
  if (!isMap(program)) return null
  const p = pick(program, PROGRAM_FIELDS)
  if (!Array.isArray(p.tracks)) p.tracks = []
  return p
}

const shift = (iso, days) => new Date(Date.parse(iso + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10)

/**
 * The programs of `wods` (S.wods) a feed publishes, oldest first: every live one dated from
 * `today` (an ISO date) minus `days` onwards, future ones included. A cleared date (`{ _ts }`)
 * is not a program, so a deleted one leaves the feed.
 */
export function feedPrograms(wods, { today, days = BOX_FEED_DAYS } = {}) {
  if (!isMap(wods) || !ISO.test(String(today || ''))) return []
  const from = shift(today, -Math.max(0, Math.floor(Number(days)) || 0))
  return Object.keys(wods)
    .filter(d => ISO.test(d) && d >= from && isMap(wods[d]) && Object.keys(wods[d]).some(k => k !== '_ts'))
    .sort()
    .map(date => ({ date, ...feedProgram(wods[date]) }))
}

/** The whole feed.json document. `now` stamps `updatedAt`. */
export function buildFeed(wods, { name = '', today, days = BOX_FEED_DAYS, now = Date.now() } = {}) {
  return {
    v: BOX_FEED_VERSION,
    box: String(name || ''),
    updatedAt: new Date(now).toISOString(),
    programs: feedPrograms(wods, { today, days })
  }
}

/** Where a feed pushed to GitHub repo `owner/repo` (branch main) is read from. */
export const feedUrl = repo => `https://raw.githubusercontent.com/${repo}/main/feed.json`
