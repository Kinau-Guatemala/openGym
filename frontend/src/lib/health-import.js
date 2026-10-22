// Runs, walks, hikes and rides other apps put in Health Connect (a watch, the phone's own step
// app), filed into the log as one cardio workout each. Nothing here talks to Health Connect:
// lib/health-sync.js reads the sessions through the native plugin (HealthConnectPlugin.java
// readSessions) and hands them here. Each comes in once and stays a workout of its own, `hc-<id>`:
//   - what openGym wrote itself (lib/health-connect.js) is never read back as a second copy;
//   - a run deleted in openGym is not brought back (its removal is on record in S.deleted);
//   - an imported run is never written back to Health Connect (healthRecords skips src 'hc').
import { insertChronological } from './backfill.js'
import { stampWorkout } from './sync-merge.js'
import { isoOf } from './format.js'

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

const own = rec => {
  const pkg = String(rec?.packageName || '')
  return OWN_PACKAGES.some(p => pkg === p || pkg.startsWith(p + '.'))
    || String(rec?.clientRecordId || '').startsWith('opengym-w-')
}

/**
 * The workouts to add for `records` ({ id, start, end, type, distanceM, clientRecordId,
 * packageName }, as readSessions answers): one cardio row each, minutes and the average speed in
 * km/h when Health Connect knows the distance. Leaves out openGym's own records, ids deleted in
 * openGym, ids already in the log, and sessions of another type or without real times.
 * `nameOf(entry)` names the workout after its exercise.
 */
export function planImport(records, S, { nameOf = e => e.id } = {}) {
  const have = new Set((S?.workouts || []).map(w => w?.id))
  const deleted = S?.deleted?.workouts || {}
  const out = []
  for (const rec of records || []) {
    const exId = EXERCISE_BY_TYPE[rec?.type]
    const start = Number(rec?.start), end = Number(rec?.end)
    if (!rec?.id || !exId || !(start > 0) || !(end > start) || own(rec)) continue
    const id = 'hc-' + rec.id
    if (have.has(id) || Number(deleted[id]) > 0) continue
    have.add(id)
    const hours = (end - start) / 3600000
    const km = Number(rec.distanceM) / 1000
    const set = { min: Math.max(1, Math.round(hours * 60)), done: true }
    if (km > 0) set.speed = Math.round(km / hours * 10) / 10
    const entry = { id: exId, sets: [set], topW: null, target: { mode: 'cardio' } }
    out.push({
      id, d: isoOf(new Date(start)), start, end, routineIds: [], routineId: null,
      name: nameOf(entry), src: 'hc', entries: [entry], prs: [],
    })
  }
  return out
}

/** Files `planImport`'s workouts into S in date order. Mutates S; returns how many were added. */
export function addImported(S, records, { nameOf, now = Date.now() } = {}) {
  const add = planImport(records, S, { nameOf })
  for (const w of add) S.workouts = insertChronological(S.workouts || [], stampWorkout(w, now))
  return add.length
}
