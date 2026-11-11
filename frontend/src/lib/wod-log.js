// Logging a posted program after class (the CrossFit module): the tracks and blocks done, a weight
// or reps per movement, any substitute, and each block's score, made into an ordinary workout.
//
// It is a workout logged into the past, filed like any backfilled one (finish-workout.js
// fileBackfill) and never through S.active, which may hold a session still in progress. One per
// day, id `wod-<date>`, so logging the same day again edits it.
//
//   choice = { tracks: ['full', 'pump'], include: { 'full/b0': true } }   include overrides includeOf
//   logged = { start, unit, moves: { '<track>/<block>/<movement>': { exId, w, r, cal, m, sec, min, sets } },
//              blocks: { '<track>/<block>': { score, rx } } }
//
// Weights in `logged` are in S.unit, as everything stored is; `unit` is the one the log screen
// showed them in (kg or lb, picked there), kept as `w.wod.unit` so a re-open shows that one again.
//
// Rows per movement follow the block's format (crossfit-module-plan, training logic §1): metcon
// blocks (EMOM, AMRAP, For time, intervals, ladders) give `noProg` entries, so they never seed a
// prescription, with `wodRir: 5` on their rows as the fatigue fallback for work nothing can
// estimate (recovery.js resolveSetRir); a Pump or strength block logs as plain lifting.
import { buildCompletedWorkout } from './finish-workout.js'
import { backfillEnd, backfillStart } from './backfill.js'
import { isCardio } from './exercises.js'
import { syncSideAggregate } from './workout-model.js'
import { includeOf, liveWod } from './wod-draft.js'
import { mergedInto } from './exercise-merge.js'
import { doseFor, emptyStep, rxFor, rxPrinted, stepRxFor, stepsOf } from './rx.js'
import { convertMoves, convertWeight } from './units.js'
import { t } from './i18n-core.js'

export const WOD_RIR = 5
const METCON = new Set(['emom', 'amrap', 'fortime', 'interval'])
const list = v => (Array.isArray(v) ? v : [])
const pos = v => (Number(v) > 0 ? Number(v) : 0)
// `2x200`, `2 Set de Max`: the times a line is done (dose.sets). A dose without it is done once.
export const setsOf = dose => Math.floor(pos(dose?.sets)) || 1
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
// burpees down a ladder, or a TARGET total of them).
export const isCardioMove = (dose, exId, ladder) => pos(dose.cal) > 0 || pos(dose.m) > 0 || (isCardio(exId) && !pos(dose.reps) && !pos(dose.total) && !ladder)

// A machine down a ladder (21-15-9 Cal Row): the rungs are its calories, or its metres when the
// line prints them so (a run's always are). Burpees, double-unders and the like stay reps per rung.
function ladderMachine(m, exId, dose, block) {
  if (!ladderOf(block?.scheme) || !RATES[exId] || pos(dose.reps) || pos(dose.cal) || pos(dose.m)) return null
  return exId === '0685' || /\b(m|mts?|meters?|metres?|metros?)\b/i.test(m?.raw || '') ? 'm' : 'cal'
}

// `20 DB Reverse Lunge 10/10`: the box prints the total, then each side's share, and the parse keeps
// the total as reps, while a merged R / L line keeps each side's. The reps one side gets of a set of
// `n` the movement's printed dose planned. A partial round's odd leftover gives L the extra one.
export function sideReps(m, n) {
  const r = /\b(\d+)\/\1\b(?![.,]\d)(?!\s*(?:(?:kg|lbs?|cal|mts?)\b|["”]))/i.exec(m?.raw || '')
  return r && pos(m.dose?.reps) === 2 * r[1] ? Math.ceil(n / 2) : n
}
/** `dose` with its reps as each side's, for a per-side movement: what every screen shows. */
export const eachSide = (m, dose) => (m?.perSide && pos(dose?.reps) ? { ...dose, reps: sideReps(m, dose.reps) } : dose)

/** Whether a movement logs as one cardio row in this block (the log screen asks for minutes). */
export const isCardioRow = (m, exId, dose, block) =>
  !!ladderMachine(m, exId, dose, block) || isCardioMove(dose, exId, !!ladderOf(block?.scheme))

// The score a block asks for until another is picked: rounds+reps for an AMRAP, a time for a For
// time, a load for a strength block, none for the rest. The log screen's selector shows it.
export const SCORE_OF = { amrap: 'rounds', fortime: 'time', strength: 'load' }

// A block's format as the review and log screens name it; an unknown one is Other.
export const formatLabel = f => ({
  amrap: 'AMRAP', emom: 'EMOM', fortime: t('For time'), rounds: t('Rounds'),
  interval: t('Intervals'), strength: t('Strength'), other: t('Other'),
})[f] || t('Other')

/**
 * A block's score as saved: of the type the selector shows (the format's default when it was
 * never touched), or `{ type: 'none' }` when no value was entered for it.
 */
export function scoreFor(block, score) {
  const s = { ...(score || {}) }
  if (!s.type) s.type = SCORE_OF[block?.format] || 'none'
  const entered = s.type === 'time' ? pos(s.sec) : s.type === 'rounds' ? pos(s.rounds) || pos(s.reps) : s.type === 'load' ? pos(s.w) : 0
  return entered ? s : { type: 'none' }
}

// What one round of a movement counts towards a rounds+reps score.
const unitsOf = dose => pos(dose.reps) || pos(dose.cal) || 0

// Per movement, the amount of each set: null for the full dose, a number for a ladder's rung or
// the reps a partial round reached. A line done `sets` times (`2 Set de 10`) is that many sets
// per round, here and nowhere else. A movement with steps is one set per step instead, its amount
// the step's own, else the full dose, else the rung at that index; an empty step is the rung, else
// 0, max reps to fill in (a drop set's last), and a drop set (`drop`) is all its steps every round.
// A `TARGET` total is spread over the sets the slot gets in an EMOM (70 over 4: 18, 18, 17, 17), and
// is one set elsewhere. The others plan as before.
function setsPlan(block, doses, score, steps) {
  const rungs = ladderOf(block.scheme)
  return roundsPlan(block, doses, score, rungs).map((p, i) => {
    const d = doses[i]
    if (steps[i]) {
      const one = steps[i].map((s, j) => (emptyStep(s) ? rungs?.[j] ?? 0
        : pos(s.reps) || pos(s.cal) || pos(s.m) || pos(s.sec) || (unitsOf(d) || pos(d.m) || pos(d.sec) ? null : rungs?.[j] ?? null)))
      // A drop set is all its steps in every round; other steps are the whole plan.
      return list(block.movements)[i]?.drop ? p.flatMap(() => one) : one
    }
    const total = !pos(d.reps) && Math.floor(pos(d.total))
    if (!total) return p
    if (block.format !== 'emom') return [total]
    return p.map((_, j) => Math.floor(total / p.length) + (j < total % p.length ? 1 : 0))
  })
}

function roundsPlan(block, doses, score, rungs) {
  if (rungs) return doses.map(d => rungs.flatMap(r => Array(setsOf(d)).fill(unitsOf(d) ? null : r)))
  const full = n => doses.map(d => Array(Math.max(1, n) * setsOf(d)).fill(null))
  const rounds = score?.type === 'rounds' && Number(score.rounds) >= 0 ? Math.floor(Number(score.rounds)) : null
  if (block.format === 'emom') {
    // k slots (M1, M2…) share the minutes; movements without a slot are all done every minute.
    const k = new Set(list(block.movements).map(m => m.slot).filter(Boolean)).size || 1
    const n = Math.floor((pos(block.capMin) || pos(block.rounds) * k || k) / k)
    return full(rounds != null ? Math.min(n, rounds) : n)
  }
  if (rounds == null || !['amrap', 'fortime', 'interval'].includes(block.format)) return full(pos(block.rounds) || 1)
  // Rounds completed, then the leftover reps through the movements in order, set by set.
  let left = pos(score.reps)
  return doses.map(d => {
    const out = Array(rounds * setsOf(d)).fill(null)
    const u = unitsOf(d)
    for (let k = setsOf(d); left > 0 && u && k > 0; k--) { out.push(Math.min(u, left)); left -= u }
    return out
  })
}

// An option the box printed with its own count (`10 Hang Leg raises / 18 Leg raises`): picked, it is
// done at its own dose, not the movement's.
export const optionOf = (m, exId) => (exId && exId !== m.exId ? list(m.alts).find(a => a?.exId === exId && Object.keys(a.dose || {}).length) : null)
/** The dose for S.body of `m` done as `exId`: an option's own when it prints one, else the movement's. */
export const doseOn = (m, exId, S) => doseFor(optionOf(m, exId) || m, S)

/**
 * The rows the chosen part of `program` logs as, before the finish: `{ entries, wod, capMin }`.
 * `entries` are active-session entries carrying `wodBlock` (and `rx`, `swappedFrom`), `wod` is the
 * workout's `{ tracks, blocks }` record, `capMin` the chosen blocks' caps added up. An exercise
 * merged away since the program was saved is logged as the one it went to (liveWod).
 */
export function wodToSession(program0, choice, logged, S) {
  const program = liveWod(S, program0)
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
      const score = scoreFor(block, lb.score)
      const metcon = isMetcon(block)
      const moves = list(block.movements)
      const doses = moves.map(m => {
        const lm = logged?.moves?.[`${ref}/${m.id}`] || {}
        const d = { ...doseOn(m, lm.exId, S) }
        for (const k of ['r', 'cal', 'm', 'sec', 'total']) if (lm[k] != null) d[k === 'r' ? 'reps' : k] = Number(lm[k]) || 0
        return d
      })
      // What was typed for the movement wins over its steps: the typed count or weight is every set's.
      const steps = moves.map(m => {
        const lm = logged?.moves?.[`${ref}/${m.id}`] || {}
        return ['r', 'cal', 'm', 'sec', 'total'].some(k => lm[k] != null) || optionOf(m, lm.exId) ? null : stepsOf(m)
      })
      const plan = setsPlan(block, doses, score, steps)
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
        // Rx vs lifted compares the heaviest set with entry.rx, so steps carry their heaviest step's.
        const top = stepsOf(m)?.reduce((a, s) => ((stepRxFor(s, m, S)?.w || 0) > (stepRxFor(a, m, S)?.w || 0) ? s : a))
        const rx = asPrinted ? (top && rxPrinted(top, S)) || rxPrinted(m, S) : null
        if (rx) entry.rx = rx
        const w0 = lm.w != null ? pos(lm.w) : (asPrinted ? rxFor(m, S)?.w || 0 : 0)
        const stepW = steps[i] && lm.w == null && asPrinted ? steps[i].map(s => stepRxFor(s, m, S)?.w || 0) : null
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
          amounts.forEach((a, j) => {
            const n = a ?? (pos(dose.reps) || pos(dose.sec))
            const w = stepW?.[j % stepW.length] ?? w0
            // Typed reps, or an option's own count, are each side's already.
            const side = lm.r != null || optionOf(m, lm.exId) ? n : sideReps(m, n)
            let row = pos(dose.sec) && !pos(dose.reps) ? { mode: 'time', sec: m.perSide ? 2 * n : n, w, done: true }
              : m.perSide ? syncSideAggregate({ sides: { L: { w, r: side, done: true }, R: { w, r: side !== n ? n - side : side, done: true } } })
                : { w, r: n, done: true }
            if (metcon) row = { ...row, wodRir: WOD_RIR }
            entry.sets.push(row)
          })
        }
        if (entry.sets.length) entries.push(entry)
      })
      capMin += pos(block.capMin)
      blocks.push({ ref, format: block.format, score, rx: !!lb.rx, ...(block.benchmark ? { benchmark: block.benchmark } : {}) })
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
  w.wod = { date, ...wod, moves: movesOf(logged), ...(logged?.unit ? { unit: logged.unit } : {}) }
  return { active, w }
}

// What was typed per movement, as sent, so re-opening the day restores it exactly (relogState).
const MOVE_KEYS = ['exId', 'w', 'r', 'cal', 'm', 'sec', 'min', 'sets', 'total']
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
 * The weights typed on the log screen (each movement's weight and rows, a load score) moved from
 * `from` to `to`, on the plate grid of convertWeight. A load score carries its own unit, which a
 * profile's unit change leaves as it is (crossfit-records.js), so it is moved from that one. The
 * rest is kept as it is.
 */
export function loggedIn(logged, from, to) {
  if (!logged) return logged
  const blocks = {}
  for (const [k, lb] of Object.entries(logged.blocks || {})) {
    const su = ['kg', 'lb'].includes(lb?.score?.unit) ? lb.score.unit : from
    blocks[k] = lb?.score?.w != null ? { ...lb, score: { ...lb.score, w: convertWeight(lb.score.w, su, to), unit: to } } : lb
  }
  return { ...logged, moves: convertMoves(logged.moves, from, to), blocks }
}

/**
 * The log screen's starting state for a day already logged as `w`, so saving again edits what
 * was logged rather than the program's printed doses: `{ tracks, include, logged, unit }`. A log
 * that kept what was typed (`w.wod.moves`) comes back as typed; an older one is read off its rows.
 * The weights come back in the unit the log was typed in (`w.wod.unit`, else `profileUnit`, the
 * one they are stored in), which is `unit`. A swap to an exercise merged away since comes back as
 * the one it went to (S.exMerged; `program` is already read through liveWod).
 */
export function relogState(program, w, profileUnit, S) {
  const blocks = {}, include = {}
  // A block saved without a score opens on its format's default again, not on "none".
  for (const b of list(w?.wod?.blocks)) blocks[b.ref] = { ...(b.score?.type && b.score.type !== 'none' ? { score: b.score } : {}), rx: !!b.rx }
  const tracks = list(w?.wod?.tracks)
  for (const tr of list(program?.tracks)) {
    if (!tracks.includes(tr.id)) continue
    for (const b of list(tr.blocks)) include[`${tr.id}/${b.id}`] = !!blocks[`${tr.id}/${b.id}`]
  }
  const saved = w?.wod?.moves
  const moves = saved && typeof saved === 'object' ? structuredClone(saved) : movesFromRows(program, w, tracks)
  for (const lm of Object.values(moves)) if (lm?.exId) lm.exId = mergedInto(S, lm.exId)
  const unit = w?.wod?.unit || profileUnit
  return { tracks, include, logged: loggedIn({ moves, blocks }, profileUnit, unit), unit }
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
