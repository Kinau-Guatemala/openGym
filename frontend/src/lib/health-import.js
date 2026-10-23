// Runs, walks, hikes and rides other apps put in Health Connect (a watch, the phone's own step
// app), filed into the log as one cardio workout each. Nothing here talks to Health Connect:
// lib/health-sync.js reads the sessions through the native plugin (HealthConnectPlugin.java
// readSessions) and hands them here. Each comes in once and stays a workout of its own, `hc-<id>`:
//   - what openGym wrote itself (lib/health-connect.js) is never read back as a second copy;
//   - a run deleted in openGym is not brought back (its removal is on record in S.deleted);
//   - an imported run is never written back to Health Connect (healthRecords skips src 'hc');
//   - one run recorded by two apps, or also logged in openGym, comes in once at most.
import { insertChronological } from './backfill.js'
import { stampWorkout } from './sync-merge.js'
import { isoOf } from './format.js'
import { modeForSet } from './workout-model.js'

// openGym's own package ids — this fork's and upstream's — and their debug builds (".test").
export const OWN_PACKAGES = ['gt.kinau.opengym', 'ch.duartesantos.opengym']
// The catalogue exercise a session type is filed under (the names HealthConnectPlugin.java uses).
export const EXERCISE_BY_TYPE = {
  running: '0685',              // run
  running_treadmill: '2197',    // run on treadmill
  walking: '2258',              // walking
  hiking: '2258',
  biking: '5214',               // riding outdoor bicycle
  biking_stationary: '2138',    // stationary bike run v. 3
}

// Phones and watches write auto-detected walks, several a day. A walk or a hike comes in only
// from this long; runs and rides (treadmill and stationary bike too) always do.
export const MIN_WALK_MS = 20 * 60 * 1000
const WALK_TYPES = new Set(['walking', 'hiking'])

const own = rec => {
  const pkg = String(rec?.packageName || '')
  return OWN_PACKAGES.some(p => pkg === p || pkg.startsWith(p + '.'))
    || String(rec?.clientRecordId || '').startsWith('opengym-w-')
}

// One run, two records: a watch app and Strava both write it, or it was also logged by hand or
// in a WOD. Two spans are the same session when they overlap by at least half the shorter one.
const SAME_SESSION = 0.5
const spanOf = (start, end) => (start > 0 && end > start ? [start, end] : null)
const sameSession = ([s1, e1], [s2, e2]) =>
  Math.min(e1, e2) - Math.max(s1, s2) >= SAME_SESSION * Math.min(e1 - s1, e2 - s2)
const hasCardio = w => (w?.entries || []).some(e => (e?.sets || []).some(set => set?.done === true && modeForSet(set, e?.target || {}) === 'cardio'))

/** The Health Connect ids openGym already knows, in the log or deleted from it (without `hc-`). */
export function knownIds(S) {
  const ids = (S?.workouts || []).map(w => String(w?.id ?? '')).filter(id => id.startsWith('hc-'))
  for (const [id, at] of Object.entries(S?.deleted?.workouts || {})) if (id.startsWith('hc-') && Number(at) > 0) ids.push(id)
  return [...new Set(ids)].map(id => id.slice(3))
}

/**
 * The workouts to add for `records` ({ id, start, end, type, distanceM, clientRecordId,
 * packageName }, as readSessions answers): one cardio row each, minutes and the average speed in
 * km/h when Health Connect knows the distance. Leaves out openGym's own records, ids deleted in
 * openGym, ids already in the log, sessions of another type or without real times, and walks or
 * hikes shorter than MIN_WALK_MS. A session
 * that is the same as one in the log with cardio in it (hand-logged, a WOD's cardio rows, an
 * earlier import), as a record skipped above (a deleted run's copy from a second app stays out
 * with it), or as one already taken from this batch is left out too; the batch is taken with
 * distance first, then longest first, so the better copy is the one kept.
 * `nameOf(entry)` names the workout after its exercise.
 */
export function planImport(records, S, { nameOf = e => e.id } = {}) {
  const have = new Set((S?.workouts || []).map(w => w?.id))
  const deleted = S?.deleted?.workouts || {}
  const taken = (S?.workouts || []).filter(hasCardio).map(w => spanOf(Number(w.start), Number(w.end))).filter(Boolean)
  const fresh = []
  for (const rec of records || []) {
    const span = spanOf(Number(rec?.start), Number(rec?.end))
    if (!rec?.id || !EXERCISE_BY_TYPE[rec?.type] || !span) continue
    if (WALK_TYPES.has(rec.type) && span[1] - span[0] < MIN_WALK_MS) continue
    const id = 'hc-' + rec.id
    if (own(rec) || have.has(id) || Number(deleted[id]) > 0) taken.push(span)
    else fresh.push({ rec, id, span, km: Number(rec.distanceM) / 1000 })
  }
  fresh.sort((a, b) => (b.km > 0) - (a.km > 0) || (b.span[1] - b.span[0]) - (a.span[1] - a.span[0]))
  const out = []
  for (const { rec, id, span, km } of fresh) {
    if (have.has(id) || taken.some(t => sameSession(t, span))) continue
    have.add(id)
    taken.push(span)
    const [start, end] = span
    const hours = (end - start) / 3600000
    const set = { min: Math.max(1, Math.round(hours * 60)), done: true }
    if (km > 0) set.speed = Math.round(km / hours * 10) / 10
    const entry = { id: EXERCISE_BY_TYPE[rec.type], sets: [set], topW: null, target: { mode: 'cardio' } }
    out.push({
      id, d: isoOf(new Date(start)), start, end, routineIds: [], routineId: null,
      name: nameOf(entry), src: 'hc', entries: [entry], prs: [],
    })
  }
  return out.sort((a, b) => a.start - b.start)
}

/** Files `planImport`'s workouts into S in date order. Mutates S; returns how many were added. */
export function addImported(S, records, { nameOf, now = Date.now() } = {}) {
  const add = planImport(records, S, { nameOf })
  for (const w of add) S.workouts = insertChronological(S.workouts || [], stampWorkout(w, now))
  return add.length
}
