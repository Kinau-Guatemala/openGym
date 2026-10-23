/* The write tools' changes, as pure functions: each takes the profile's state and the tool's
   arguments and returns `{ state, diff, result }` (a new state, the input untouched; the change as
   readable lines; what the caller needs back, such as a new id). The tools run one on the state
   they read, show the diff for a dry run, and hand the same function to source.write() otherwise,
   which may run it a second time on a newer state after a conflict.

   Nothing here stamps: the HTTP source PUTs without `stamped`, so the server stamps the change
   against the stored copy (api/sync-stamps.js stampPut, overRead). Only a new workout takes its
   own stamp, as the app's backfill does (fileBackfill → stampWorkout): the server stamps new
   routines, not new workouts. */
import { EXIDX, canonicalExId, exOr } from '../../frontend/src/lib/exercises.js'
import { defaultConfig, modeOf, cleanupSg, exLine } from '../../frontend/src/lib/history.js'
import { uid } from '../../frontend/src/lib/format.js'
import { POLICIES } from '../../frontend/src/lib/progression.js'
import { buildCompletedWorkout, fileBackfill } from '../../frontend/src/lib/finish-workout.js'
import { backfillStart } from '../../frontend/src/lib/backfill.js'

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
// lib/glyphs.js DEFAULT_GLYPH; that module imports a .jsx and can't load under node.
const DEFAULT_GLYPH = 'figureStrength'

const fail = (code, message) => Object.assign(new Error(message), { code })
const list = v => (Array.isArray(v) ? v : [])

// An id the profile can train: the catalogue, or one of its own custom exercises. Catalogue ids
// that were merged into another resolve to it, as the app does.
function exerciseId(raw, S) {
  const id = canonicalExId(String(raw))
  if (EXIDX[id] || list(S.customEx).some(c => c?.id === id)) return id
  return null
}
const nameOf = (id, S) => list(S.customEx).find(c => c?.id === id)?.n || exOr(id).n

function checkIds(items, S) {
  const bad = items.map(x => x.id).filter(id => !exerciseId(id, S))
  if (bad.length) throw fail('EINVAL', `not exercise ids in the catalogue or this profile's custom exercises: ${bad.join(', ')}. Use ids from get_wods, get_routine or get_workout`)
}

// One planned exercise: the app's defaults for the id (RoutineEdit adds `{ id, ...defaultConfig }`),
// then what was asked for, each field only in the mode it belongs to.
function planned(item, S, base = null) {
  const id = exerciseId(item.id, S)
  const cfg = base ? { ...base, id } : { id, ...defaultConfig(id) }
  const mode = modeOf(cfg)
  if (item.sets != null) cfg.sets = item.sets
  if (mode === 'reps') {
    if (item.reps != null) cfg.reps = item.reps
    // A range stays a range when only its top moves ("raise the top to 15"): it goes when a new
    // bottom is given, or when the new top is no longer above the bottom.
    if (item.reps_min != null) { if (item.reps_min < cfg.reps) cfg.repsMin = item.reps_min; else delete cfg.repsMin }
    else if (cfg.repsMin != null && cfg.repsMin >= cfg.reps) delete cfg.repsMin
    if (item.weight != null) cfg.weight = item.weight
  }
  if (mode === 'time') {
    if (item.sec != null) cfg.sec = item.sec
    if (item.weight != null) cfg.weight = item.weight
  }
  if (mode === 'cardio' && item.min != null) cfg.min = item.min
  if (item.rest_sec != null) { if (item.rest_sec > 0) cfg.restSec = item.rest_sec; else delete cfg.restSec }
  return cfg
}

const line = (cfg, S) => `${cfg.id} ${nameOf(cfg.id, S)}: ${exLine(cfg, S.unit || 'kg')}${cfg.restSec ? `, rest ${cfg.restSec} s` : ''}`

/** A new routine from catalogue ids. `result.routine_id` is the new routine's id. */
export function createRoutine(S, { name, exercises, progression }) {
  const title = String(name || '').trim()
  if (!title) throw fail('EINVAL', 'a routine needs a name')
  if (!list(exercises).length) throw fail('EINVAL', 'a routine needs at least one exercise')
  checkIds(exercises, S)
  if (progression != null && !POLICIES.includes(progression)) throw fail('EINVAL', `progression must be one of ${POLICIES.join(', ')}`)
  const state = structuredClone(S)
  const r = { id: uid(), name: title, emoji: DEFAULT_GLYPH, ...(progression ? { prog: progression } : {}), ex: exercises.map(x => planned(x, S)) }
  state.routines = [...list(state.routines), r]
  return {
    state,
    diff: [`+ routine "${title}"${progression ? ` (progression: ${progression})` : ''}`, ...r.ex.map(c => `  + ${line(c, S)}`)],
    result: { routine_id: r.id }
  }
}

/**
 * A routine's name and/or exercise list replaced. An exercise that stays keeps everything it had
 * (rest, increment, superset, notes) except what is asked for; a superset left with one member
 * loses its tag.
 */
export function updateRoutine(S, { routine_id, name, exercises }) {
  const state = structuredClone(S)
  const r = list(state.routines).find(x => x?.id === routine_id)
  if (!r) throw fail('ENOENT', `no routine with id ${JSON.stringify(routine_id)}`)
  const diff = [`~ routine "${r.name}"`]
  if (name != null) {
    const title = String(name).trim()
    if (!title) throw fail('EINVAL', 'a routine needs a name')
    if (title !== r.name) diff.push(`  name: "${r.name}" → "${title}"`)
    r.name = title
  }
  if (exercises != null) {
    if (!exercises.length) throw fail('EINVAL', 'a routine needs at least one exercise')
    checkIds(exercises, S)
    const before = list(r.ex)
    const used = new Set()
    const next = exercises.map(x => {
      const id = exerciseId(x.id, S)
      const i = before.findIndex((e, k) => !used.has(k) && e.id === id)
      if (i >= 0) used.add(i)
      return planned(x, S, i >= 0 ? structuredClone(before[i]) : null)
    })
    cleanupSg(next)
    before.forEach((e, k) => { if (!used.has(k)) diff.push(`  - ${line(e, S)}`) })
    next.forEach(c => {
      const old = before.find(e => e.id === c.id)
      if (!old) diff.push(`  + ${line(c, S)}`)
      else if (line(old, S) !== line(c, S)) diff.push(`  ~ ${line(old, S)} → ${exLine(c, S.unit || 'kg')}${c.restSec ? `, rest ${c.restSec} s` : ''}`)
    })
    if (before.map(e => e.id).join() !== next.map(e => e.id).join()) diff.push(`  order: ${next.map(e => e.id).join(', ')}`)
    r.ex = next
  }
  if (diff.length === 1) diff.push('  (no change)')
  return { state, diff, result: { routine_id } }
}

/** A weekday's routines: `replace` them (an empty list makes it a rest day) or `add` to them. */
export function assignWeekday(S, { weekday, routine_ids, mode = 'replace' }) {
  const ids = [...new Set(list(routine_ids))]
  const missing = ids.filter(id => !list(S.routines).some(r => r?.id === id))
  if (missing.length) throw fail('ENOENT', `no routine with id ${missing.map(x => JSON.stringify(x)).join(', ')}`)
  const state = structuredClone(S)
  const week = { ...(state.week && typeof state.week === 'object' ? state.week : {}) }
  const had = [].concat(week[weekday] || [])
  const next = mode === 'add' ? [...new Set([...had, ...ids])] : ids
  if (next.length) week[weekday] = next
  else delete week[weekday]
  state.week = week
  const names = xs => (xs.length ? xs.map(id => list(S.routines).find(r => r?.id === id)?.name || id).join(' + ') : 'rest')
  return {
    state,
    diff: [`${DAY_NAMES[weekday]}: ${names(had)} → ${names(next)}`],
    result: { weekday, routine_ids: next }
  }
}

// One logged row as the app stores it.
function row(set, mode) {
  const n = k => (Number(set[k]) > 0 ? Number(set[k]) : 0)
  if (mode === 'cardio') return { min: n('min'), ...(n('speed') ? { speed: n('speed') } : {}), ...(n('cal') ? { cal: n('cal') } : {}), ...(n('m') ? { m: n('m') } : {}), done: true }
  if (mode === 'time') return { sec: n('sec'), w: n('w'), done: true, ...(set.rir != null ? { rir: set.rir } : {}) }
  return { w: n('w'), r: n('r'), done: true, ...(set.rir != null ? { rir: set.rir } : {}) }
}

/**
 * A finished session logged after the fact, filed the way the app files a backfill
 * (buildCompletedWorkout + fileBackfill: stamped, PR badges against the history before it, in date
 * order). Rows are what was actually done, so they count for progression and effort like any
 * logged session; never metcon-shaped (no wodRir, no noProg).
 */
export function logWorkout(S, { date, start_time, duration_min, name, note, entries }, now = Date.now()) {
  if (!list(entries).length) throw fail('EINVAL', 'a workout needs at least one exercise')
  checkIds(entries, S)
  const isoNow = new Date(now)
  const today = isoNow.getFullYear() + '-' + String(isoNow.getMonth() + 1).padStart(2, '0') + '-' + String(isoNow.getDate()).padStart(2, '0')
  if (date > today) throw fail('EINVAL', `${date} is in the future: only sessions already done can be logged`)
  const minutes = duration_min || 60
  // Today with no time given: it just ended, as the app's own backfill of today assumes.
  const start = (start_time || date !== today) ? backfillStart(date, start_time || '18:00') : now - minutes * 60000
  const end = start + minutes * 60000
  // The app never files a session that hasn't ended (endsInFuture): today at a later hour is not
  // something already done.
  if (end > now) throw fail('EINVAL', 'this session would end later than now: only sessions already done can be logged (give an earlier start_time or a shorter duration)')
  const rows = entries.map(x => {
    const id = exerciseId(x.id, S)
    // Minutes logged make it cardio, a hold makes it timed, whatever the exercise usually is.
    const mode = list(x.sets).some(s => Number(s.min) > 0) ? 'cardio'
      : list(x.sets).some(s => Number(s.sec) > 0 && !(Number(s.r) > 0)) ? 'time'
        : modeOf({ id }) === 'cardio' ? 'cardio' : 'reps'
    const sets = list(x.sets).map(s => row(s, mode))
    // Weight with no reps, a hold of 0 s, 0 minutes: nothing was done, and a 0-rep row with a
    // load reads as a set the app never logs.
    const empty = sets.filter(s => (mode === 'cardio' ? !s.min : mode === 'time' ? !s.sec : !s.r))
    if (!sets.length || empty.length) throw fail('EINVAL', `${id}: ${sets.length ? `${empty.length} set(s) with no work in them (reps, a hold in seconds, or minutes)` : 'no sets'}`)
    return { id, target: { mode, sets: sets.length }, sets }
  })
  const bw = list(S.bodyweight).filter(b => b?.d <= date && b.w > 0).sort((a, b) => String(a.d).localeCompare(String(b.d))).at(-1)?.w || null
  const active = { id: uid(), d: date, start, name: String(name || '').trim() || 'Freestyle', bw, entries: rows, backfill: {} }
  const w = buildCompletedWorkout(active, { end })
  const text = String(note || '').trim()
  if (text) w.note = text
  const state = structuredClone(S)
  state.workouts = list(state.workouts)
  const filed = fileBackfill(state, active, w)
  const unit = S.unit || 'kg'
  const setText = (s, mode) => mode === 'cardio' ? `${s.min} min${s.cal ? ` · ${s.cal} cal` : ''}${s.m ? ` · ${s.m} m` : ''}`
    : mode === 'time' ? `${s.sec} s${s.w ? ` @ ${s.w} ${unit}` : ''}` : `${s.r} @ ${s.w} ${unit}${s.rir != null ? ` (RIR ${s.rir})` : ''}`
  const hhmm = t => { const d = new Date(t); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') }
  return {
    state,
    diff: [
      // "Just finished" moves with the clock; said in words, the diff stays the one approved.
      `+ workout ${date} "${filed.name}" ${start_time || date !== today ? `${hhmm(start)}–${hhmm(end)}` : `just finished, ${minutes} min`}`,
      ...filed.entries.map(e => `  + ${e.id} ${nameOf(e.id, S)}: ${e.sets.map(s => setText(s, e.target?.mode)).join(', ')}`),
      ...(filed.prs?.length ? [`  PRs: ${filed.prs.map(id => nameOf(id, S)).join(', ')}`] : [])
    ],
    result: { workout_id: filed.id, prs: filed.prs || [] }
  }
}
