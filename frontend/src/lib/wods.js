// Posted CrossFit programs and the movement-name picks made for them (the CrossFit module).
//
//   S.wods      = { '2026-10-22': { title, tracks, …, _ts }, … }   a program per date it is for
//   S.exAliases = { 'hang cleans': { exId: '1234', _ts }, … }      a printed name → catalogue id
//
// Both are stamped maps (lib/sync-merge.js STAMPED_MAPS), merged per key like dayNotes: two
// devices that each saved a different date keep both, the same date keeps the one written last.
// Taking one away is a stamped clear (`{ _ts }`), never a deleted key, which would come straight
// back from the other copy on the next sync (lib/day-notes.js).
//
// Programs are only kept for WODS_KEEP_DAYS (pruneWods), by their date key, on every merge, on
// load and in the server's PUT (api/sync-stamps.js holds a hand copy): the whole state travels in
// every push, and a year of programs would push it towards the 5 MB cap. Being by date alone, it
// converges: a copy that still has an old key loses it again on the next merge anywhere.
//
// exAliases keys are already normalised (norm(rawName), lib/crossfit-resolve.js): the helpers here
// take the key as given. Bounded by the distinct names printed, so never pruned.

export const WODS_KEEP_DAYS = 120

const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v)
const ISO = /^\d{4}-\d{2}-\d{2}$/
const DAY = 86400000

// Today as a UTC date, the server's view too: within a 120-day window the day either side of
// midnight does not matter, and both sides then cut at the same key.
const utcToday = (now = Date.now()) => new Date(now).toISOString().slice(0, 10)

/**
 * `map` without the programs dated more than WODS_KEEP_DAYS before `today` (an ISO date), nor
 * any key that is not a date. Returns a new object.
 */
export function pruneWods(map, today = utcToday()) {
  if (!isMap(map)) return {}
  const t = Date.parse(today + 'T00:00:00Z')
  const cutoff = Number.isFinite(t) ? utcToday(t - WODS_KEEP_DAYS * DAY) : ''
  const out = {}
  for (const [k, v] of Object.entries(map)) if (ISO.test(k) && k >= cutoff) out[k] = v
  return out
}

// A stored entry that holds more than its stamp; a cleared one (`{ _ts }`) or junk is none.
const live = v => isMap(v) && Object.keys(v).some(k => k !== '_ts')

/** Whether `date` and `program` can be saved: a real date and an object (the contents are T07's). */
export const validWod = (date, program) => ISO.test(String(date || '')) && isMap(program)

/** S.wods with `program` saved for `date`, stamped `now`; `program` null writes a stamped clear. */
export function withWod(map, date, program, now = Date.now()) {
  const entry = isMap(program) ? { ...program, _ts: now } : { _ts: now }
  return { ...(isMap(map) ? map : {}), [date]: entry }
}

/** The program posted for `date`, or null for none or a cleared one. */
export const wodOf = (S, date) => {
  const v = isMap(S?.wods) ? S.wods[date] : null
  return live(v) ? v : null
}

/** S.exAliases with `key` (already normalised) pointing at `exId`, stamped `now`; null clears it. */
export function withAlias(map, key, exId, now = Date.now()) {
  const entry = typeof exId === 'string' && exId ? { exId, _ts: now } : { _ts: now }
  return { ...(isMap(map) ? map : {}), [key]: entry }
}

/** The user's picks as `{ key: exId }`, cleared ones left out. */
export function aliasesOf(S) {
  const out = {}
  for (const [k, v] of Object.entries(isMap(S?.exAliases) ? S.exAliases : {})) {
    if (isMap(v) && typeof v.exId === 'string' && v.exId) out[k] = v.exId
  }
  return out
}
