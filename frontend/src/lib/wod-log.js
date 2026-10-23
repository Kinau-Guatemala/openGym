// Logging a posted program after class (the CrossFit module): the tracks and blocks done, a weight
// or reps per movement, any substitute, and each block's score, made into an ordinary workout.
//
// It is a workout logged into the past, filed like any backfilled one (finish-workout.js
// fileBackfill) and never through S.active, which may hold a session still in progress. One per
// day, id `wod-<date>`, so logging the same day again edits it.
//
//   choice = { tracks: ['full', 'pump'], include: { 'full/b0': true } }   include overrides includeOf
//   logged = { start, moves: { '<track>/<block>/<movement>': { exId, w, r, cal, m, sec, min, sets } },
//              blocks: { '<track>/<block>': { score, rx } } }
//
// Rows per movement follow the block's format (crossfit-module-plan, training logic §1): metcon
// blocks (EMOM, AMRAP, For time, intervals, ladders) give `noProg` entries, so they never seed a
// prescription, with `wodRir: 5` on their rows as the fatigue fallback for work nothing can
// estimate (recovery.js resolveSetRir); a Pump or strength block logs as plain lifting.
import { buildCompletedWorkout } from './finish-workout.js'
import { backfillEnd, backfillStart } from './backfill.js'
import { isCardio } from './exercises.js'
import { syncSideAggregate } from './workout-model.js'
import { includeOf } from './wod-draft.js'
import { doseFor, rxFor, rxPrinted } from './rx.js'

export const WOD_RIR = 5
const METCON = new Set(['emom', 'amrap', 'fortime', 'interval'])
const list = v => (Array.isArray(v) ? v : [])
const pos = v => (Number(v) > 0 ? Number(v) : 0)
const HOUR = 3600000

/** A ladder scheme ("50-40-30-20-10", "21-15-9") as its rungs, or null. */
export function ladderOf(scheme) {
  const parts = String(scheme || '').trim().split(/\s*[-–,]\s*/)
  return parts.length > 1 && parts.every(p => /^\d+$/.test(p) && +p > 0) ? parts.map(Number) : null
}

export const isMetcon = block => METCON.has(block?.format) || !!ladderOf(block?.scheme)

// ponytail: rough rates for an average adult (row/ski ≈ 15 cal or 250 m a minute, bike ≈ 20 cal,
// run ≈ 5 min per km); the minutes typed on the log screen always win.
const RATES = { '1161': { cal: 15, m: 250 }, '2142': { cal: 15, m: 250 }, '3893': { cal: 20, m: 500 }, '0685': { cal: 12, m: 200 } }
const RATE = { cal: 15, m: 200 }

/** Estimated minutes for `rounds` of a cardio dose on `exId`, or null when nothing says. */
export function cardioMinutes(exId, dose, rounds = 1) {
  const n = pos(rounds) || 1
  const rate = RATES[exId] || RATE
  const min = pos(dose?.cal) ? dose.cal * n / rate.cal
    : pos(dose?.m) ? dose.m * n / rate.m
      : pos(dose?.sec) ? dose.sec * n / 60 : 0
  return min > 0 ? Math.round(min * 10) / 10 : null
}

// A calorie or distance dose is cardio whatever the catalogue says (the ski erg is filed under
// triceps); a catalogue cardio exercise is too, unless it is counted in reps (double-unders, or
// burpees down a ladder).
export const isCardioMove = (dose, exId, ladder) => pos(dose.cal) > 0 || pos(dose.m) > 0 || (isCardio(exId) && !pos(dose.reps) && !ladder)

// A machine down a ladder (21-15-9 Cal Row): the rungs are its calories, or its metres when the
// line prints them so (a run's always are). Burpees, double-unders and the like stay reps per rung.
function ladderMachine(m, exId, dose, block) {
  if (!ladderOf(block?.scheme) || !RATES[exId] || pos(dose.reps) || pos(dose.cal) || pos(dose.m)) return null
  return exId === '0685' || /\b(m|mts?|meters?|metres?|metros?)\b/i.test(m?.raw || '') ? 'm' : 'cal'
}

/** Whether a movement logs as one cardio row in this block (the log screen asks for minutes). */
export const isCardioRow = (m, exId, dose, block) =>
  !!ladderMachine(m, exId, dose, block) || isCardioMove(dose, exId, !!ladderOf(block?.scheme))

// What one round of a movement counts towards a rounds+reps score.
const unitsOf = dose => pos(dose.reps) || pos(dose.cal) || 0

// Per movement, the amount of each set: null for the full dose, a number for a ladder's rung or
// the reps a partial round reached.
function setsPlan(block, doses, score) {
  const rungs = ladderOf(block.scheme)
  if (rungs) return doses.map(d => rungs.map(r => (unitsOf(d) ? null : r)))
  const full = n => doses.map(() => Array(Math.max(1, n)).fill(null))
  const rounds = score?.type === 'rounds' && Number(score.rounds) >= 0 ? Math.floor(Number(score.rounds)) : null
  if (block.format === 'emom') {
    // k slots (M1, M2…) share the minutes; movements without a slot are all done every minute.
    const k = new Set(list(block.movements).map(m => m.slot).filter(Boolean)).size || 1
    const n = Math.floor((pos(block.capMin) || pos(block.rounds) * k || k) / k)
    return full(rounds != null ? Math.min(n, rounds) : n)
  }
  if (rounds == null || !['amrap', 'fortime', 'interval'].includes(block.format)) return full(pos(block.rounds) || 1)
  // Rounds completed, then the leftover reps through the movements in order.
  let left = pos(score.reps)
  return doses.map(d => {
    const out = Array(rounds).fill(null)
    const u = unitsOf(d)
    if (left > 0 && u) { out.push(Math.min(u, left)); left -= u }
    return out
  })
}

/**
 * The rows the chosen part of `program` logs as, before the finish: `{ entries, wod, capMin }`.
 * `entries` are active-session entries carrying `wodBlock` (and `rx`, `swappedFrom`), `wod` is the
 * workout's `{ tracks, blocks }` record, `capMin` the chosen blocks' caps added up.
 */
export function wodToSession(program, choice, logged, S) {
  const chosen = new Set(list(choice?.tracks))
  const entries = [], blocks = []
  let capMin = 0
  for (const track of list(program?.tracks)) {
    if (!chosen.has(track.id)) continue
    for (const block of list(track.blocks)) {
      const ref = `${track.id}/${block.id}`
      const inc = choice?.include?.[ref]
      if (!(typeof inc === 'boolean' ? inc : includeOf(track, block, S))) continue
      const lb = logged?.blocks?.[ref] || {}
      const metcon = isMetcon(block)
      const moves = list(block.movements)
      const doses = moves.map(m => {
        const lm = logged?.moves?.[`${ref}/${m.id}`] || {}
        const d = { ...doseFor(m, S) }
        for (const k of ['r', 'cal', 'm', 'sec']) if (lm[k] != null) d[k === 'r' ? 'reps' : k] = Number(lm[k]) || 0
        return d
      })
      const plan = setsPlan(block, doses, lb.score)
      moves.forEach((m, i) => {
        const lm = logged?.moves?.[`${ref}/${m.id}`] || {}
        const exId = lm.exId || m.exId
        if (!exId) return
        const dose = doses[i]
        const entry = { id: exId, wodBlock: ref, sets: [] }
        if (metcon) entry.noProg = true
        const printed = [m.exId, ...list(m.alts).map(a => a?.exId)].filter(Boolean)
        if (lm.exId && m.exId && !printed.includes(lm.exId)) entry.swappedFrom = m.exId
        const asPrinted = exId === m.exId
        const rx = asPrinted ? rxPrinted(m, S) : null
        if (rx) entry.rx = rx
        const w = lm.w != null ? pos(lm.w) : (asPrinted ? rxFor(m, S)?.w || 0 : 0)
        const amounts = plan[i]
        if (!amounts.length) return
        const machine = ladderMachine(m, exId, dose, block)
        if (machine || isCardioMove(dose, exId, !!ladderOf(block.scheme))) {
          // One row for the whole block: the dose (or a ladder's rungs) added up, with its minutes.
          const kind = machine || (pos(dose.cal) ? 'cal' : pos(dose.m) ? 'm' : null)
          const row = { mode: 'cardio' }
          if (kind) row[kind] = amounts.reduce((sum, a) => sum + (a ?? dose[kind]), 0)
          const est = cardioMinutes(exId, kind ? { [kind]: row[kind] } : dose, kind ? 1 : amounts.length) ?? pos(block.capMin)
          row.min = pos(lm.min) || (pos(block.capMin) ? Math.min(est, block.capMin) : est)
          row.done = true
          entry.sets.push(row)
        } else if (!metcon && list(lm.sets).length) {
          entry.sets = lm.sets.map(s => ({ w: pos(s.w), r: pos(s.r), done: true }))
        } else {
          for (const a of amounts) {
            const n = a ?? (pos(dose.reps) || pos(dose.sec))
            let row = pos(dose.sec) && !pos(dose.reps) ? { mode: 'time', sec: n, w, done: true }
              : m.perSide ? syncSideAggregate({ sides: { L: { w, r: n, done: true }, R: { w, r: n, done: true } } })
                : { w, r: n, done: true }
            if (metcon) row = { ...row, wodRir: WOD_RIR }
            entry.sets.push(row)
          }
        }
        if (entry.sets.length) entries.push(entry)
      })
      capMin += pos(block.capMin)
      blocks.push({ ref, format: block.format, score: lb.score || { type: 'none' }, rx: !!lb.rx, ...(block.benchmark ? { benchmark: block.benchmark } : {}) })
    }
  }
  return { entries, wod: { tracks: [...chosen].filter(id => list(program?.tracks).some(t => t.id === id)), blocks }, capMin }
}

const isoAt = ms => { const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') }

/** When a logged class started by default: 18:00 that day, or an hour ago when it is today. */
export const wodStart = (date, now = Date.now()) => (isoAt(now) === date ? now - HOUR : backfillStart(date, '18:00'))

const KEEP = ['rx', 'wodBlock', 'swappedFrom']

/**
 * The finished workout for logging `program` on `date`: `{ active, w }`, the backfill session it
 * was built from and the record, ready for fileBackfill. Its end is the start plus the chosen
 * blocks' caps (an hour when none is printed), never later than now.
 */
export function buildWodWorkout(S, date, program, choice, logged, now = Date.now()) {
  const { entries, wod, capMin } = wodToSession(program, choice, logged, S)
  const id = 'wod-' + date
  const labels = wod.tracks.map(tid => list(program?.tracks).find(t => t.id === tid)?.label).filter(Boolean)
  const active = {
    id, d: date, start: pos(logged?.start) || wodStart(date, now),
    name: ['WOD', ...labels].join(' · '), bw: null, entries,
    backfill: { durationMin: capMin || 60, replaceId: list(S?.workouts).some(w => w.id === id) ? id : null },
  }
  const w = buildCompletedWorkout(active, { end: Math.min(backfillEnd(active), Math.max(now, active.start + 60000)) })
  // The finish keeps only the fields it knows; the WOD's ride along on the same entries (every one
  // has done work, so none was dropped and the order holds).
  w.entries.forEach((e, i) => { for (const k of KEEP) if (entries[i][k] != null) e[k] = entries[i][k] })
  w.src = 'wod'
  w.wod = { date, ...wod, moves: movesOf(logged) }
  return { active, w }
}

// What was typed per movement, as sent, so re-opening the day restores it exactly (relogState).
const MOVE_KEYS = ['exId', 'w', 'r', 'cal', 'm', 'sec', 'min', 'sets']
function movesOf(logged) {
  const out = {}
  for (const [key, lm] of Object.entries(logged?.moves || {})) {
    if (!lm || typeof lm !== 'object') continue
    const kept = Object.fromEntries(MOVE_KEYS.filter(k => lm[k] != null).map(k => [k, structuredClone(lm[k])]))
    if (Object.keys(kept).length) out[key] = kept
  }
  return out
}

/**
 * The log screen's starting state for a day already logged as `w`, so saving again edits what
 * was logged rather than the program's printed doses: `{ tracks, include, logged }`. A log that
 * kept what was typed (`w.wod.moves`) comes back as typed; an older one is read off its rows.
 */
export function relogState(program, w) {
  const blocks = {}, include = {}
  for (const b of list(w?.wod?.blocks)) blocks[b.ref] = { score: b.score, rx: !!b.rx }
  const tracks = list(w?.wod?.tracks)
  for (const tr of list(program?.tracks)) {
    if (!tracks.includes(tr.id)) continue
    for (const b of list(tr.blocks)) include[`${tr.id}/${b.id}`] = !!blocks[`${tr.id}/${b.id}`]
  }
  const saved = w?.wod?.moves
  const moves = saved && typeof saved === 'object' ? structuredClone(saved) : movesFromRows(program, w, tracks)
  return { tracks, include, logged: { moves, blocks } }
}

// An older log, without the typed values: the exercise, weight, cardio minutes and strength rows
// read back off its entries, matched to the movements by block and exercise.
function movesFromRows(program, w, tracks) {
  const moves = {}
  const used = new Set()
  for (const tr of list(program?.tracks)) for (const b of list(tr.blocks)) {
    const ref = `${tr.id}/${b.id}`
    if (!tracks.includes(tr.id)) continue
    for (const m of list(b.movements)) {
      const ids = [m.exId, ...list(m.alts).map(a => a?.exId)]
      const e = list(w?.entries).find(x => !used.has(x) && x.wodBlock === ref && (ids.includes(x.id) || x.swappedFrom === m.exId))
      if (!e) continue
      used.add(e)
      const s0 = e.sets?.[0] || {}
      const lm = {}
      if (e.id !== m.exId) lm.exId = e.id
      const sw = s0.sides ? s0.sides.L?.w : s0.w
      if (sw != null) lm.w = sw
      if (s0.mode === 'cardio' && s0.min > 0) lm.min = s0.min
      if (b.format === 'strength') lm.sets = e.sets.map(x => ({ w: x.w, r: x.r }))
      moves[`${ref}/${m.id}`] = lm
    }
  }
  return moves
}
