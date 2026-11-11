/* The gate between a language model's output and someone's training plan.
 *
 * Everything upstream of here is advisory — the prompt asks for a shape, the model usually
 * obliges. This file is where "usually" stops mattering. Nothing reaches a user that has not
 * resolved against the real exercise library, matched the closed list of change types, and
 * stayed inside the two things the Coach is allowed to touch (routines and the week).
 *
 * That closed list is the actual security boundary of the feature. A hostile note in a user's
 * free text can talk the model into saying anything at all; it cannot invent a change type,
 * and a change type that does not exist here does nothing. `parse.js` answers "is there JSON
 * in what the provider said"; this file is the only thing that answers "is it safe to act on".
 *
 * Errors are collected rather than thrown one at a time, because they are fed back to the
 * model verbatim for the one repair round (FR-48) — and a list of six problems produces a
 * better second attempt than the first of them does.
 */
import { libraryHas, libraryName, equipmentAllows, isDumbbellLift } from './library.js';

// A catalogue exercise the person's equipment does not reach, and that was not in the library
// slice they were offered (which already pins what they train). The prompt says "their
// equipment"; a model that names a leverage machine anyway is told so on the repair round
// instead of the plan arriving with a machine they do not own.
// Someone who owns no dumbbells (ctx.noDumbbells) is held to it even with no equipment stated.
const offEquipment = (ctx, id) => libraryHas(id) && !(ctx.offered && ctx.offered.has(id))
  && ((!!ctx.equipment?.length && !equipmentAllows(ctx.equipment, id)) || (ctx.noDumbbells === true && isDumbbellLift(id)));
const OFF_EQUIPMENT = (where, id) => `${where} "${id}" needs equipment the user does not have — use an exercise from the library provided in the payload`;
import { glyphStr } from './glyphs.js';

// The closed list (FR-23 / C3). Adding a member here is a deliberate act with an apply
// implementation on the client to match; there is no default case anywhere.
export const CHANGE_TYPES = [
  'add-exercise', 'remove-exercise', 'swap-exercise',
  'sets', 'reps', 'repsMin', 'repsMax', 'sec', 'cardio',
  'reorder', 'superset',
  'routine-prog', 'exercise-prog', 'inc',
  'add-routine', 'remove-routine', 'rename-routine',
  'week',
  // v1.4.5: how an exercise warms up, and a multi-week programme (frontend lib/programmes.js).
  'warmup', 'programme'
];
export const WARMUP_MODES = ['auto', 'own', 'none'];
const MAX_PROGRAMME_WEEKS = 16;
const MAX_WEEK_TARGETS = 24;
const halfStep = v => Math.round(v * 2) / 2;
const POLICIES = ['off', 'linear', 'greyskull', 'double', 'triple', 'time'];
const MODES = ['reps', 'time', 'cardio'];
const MAX_INC = 50;
// A prescription, not a world record. Anything past this is a model slip or a hostile answer,
// and either way it reaches the plan, the progression engine and a printed line reading "∞ kg".
const MAX_WEIGHT = 1000;
const MAX_SPEED = 60;
// Ids that are object keys downstream (exIdMap/ridMap in plan-share.js). Assigning to them is
// silently ignored and reading them back yields Object.prototype, which persists into state as
// {} — a scheduled day that is forever rest, or an exercise that is forever "Unknown".
const RESERVED_IDS = ['__proto__', 'constructor', 'prototype'];
const safeId = v => isStr(v) && !RESERVED_IDS.includes(v);
const MAX_CHANGES = 25;
const MAX_ROUTINES = 7;
const MAX_EX_PER_ROUTINE = 20;

const isStr = v => typeof v === 'string' && v.trim().length > 0;
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const clampStr = (v, n) => String(v == null ? '' : v).slice(0, n);
// The minutes and pace of a cardio exercise a review adds, in the bounds the 'cardio' change
// holds them to. Without them the app fell back to 20 min at 8 km/h whatever was shown (#640).
const cardioTarget = e => (e.mode !== 'cardio' ? {} : {
  ...(isInt(e.min, 1, 180) ? { min: e.min } : {}),
  ...(isNum(e.speed) && e.speed > 0 && e.speed <= MAX_SPEED ? { speed: e.speed } : {})
});
// Routine icons: an icon key the app knows or a legacy emoji, never free text (#311).
export { ROUTINE_GLYPHS } from './glyphs.js';

/* ---------- the two v1.2.4 flags, enforced rather than merely accepted ----------
   `prompts/common.md` tells the model that unilateral work is prescribed as the total across
   both sides and therefore steps in twos, and that a rep ceiling is what turns "+1 rep
   forever" into "add a set". A prompt that asks is not a guarantee; these are the two rules
   from it that have a single right answer, so they are checked here and the repair round gets
   a chance to fix them. Everything else in that file is coaching judgement and stays advisory. */
// #313: the review prompt now states this rule, and the message names it, the offending id and
// what to do instead — a bare "is already in routine" left a temperature-0 model nothing to
// act on, and it replayed the same answer in its one repair round.
const ALREADY_IN = (where, c, routine) =>
  `${where} (${c.type}) brings in after.id "${(c.after || {}).id}", which is already in routine "${routine.name}" `
  + `(routineId "${routine.id}") — a swap-exercise or add-exercise must bring in an exercise that routine does not have yet. `
  + `Its exercises now are: ${exIdsOf(routine)}. Pick a different library id, or leave this change out`;
const exIdsOf = routine => (routine.ex || []).map(e => `"${e.id}"`).join(', ') || '(none)';
const ODD_PER_SIDE = where =>
  `${where} is a per-side exercise, so reps are the total across both sides and must be an even number`;
const INVERTED_RANGE = where =>
  `${where} sets a rep ceiling below its own floor — repsMax must be at least repsMin`;

/* =============================== created plans =============================== */

/**
 * Validate a creation bundle into something `mergePlan` can consume unchanged.
 * Returns { ok, bundle } or { ok:false, errors }.
 */
export function validatePlan(data, ctx = {}) {
  const errors = [];
  if (!data || typeof data !== 'object') return fail(['the answer was not an object']);
  if (data.nochange) return fail(['a plan was requested but the answer said "no change"']);
  if (!Array.isArray(data.routines) || !data.routines.length) {
    // A review-style change list where a plan was asked for (#471): say what the task wants,
    // so the repair round sends the plan rather than the same list again.
    errors.push(Array.isArray(data.changes)
      ? 'this task needs the complete plan (week and every routine with its ex), not a list of changes — start from refine.previous when revising, apply what was asked, and send the whole plan'
      : 'routines must be a non-empty array');
  }

  // A custom id that shadows a library id is the one case where the screen and the plan
  // disagree: the approval card resolves the id against the catalogue and shows that exercise,
  // while mergePlan remaps it to the model's invention. Whatever was approved is not applied.
  (Array.isArray(data.customEx) ? data.customEx : []).forEach((c, i) => {
    if (c && isStr(c.id) && libraryHas(c.id)) errors.push(`customEx[${i}].id "${c.id}" is already a library exercise id — give your own exercises their own ids`);
  });
  const customEx = (Array.isArray(data.customEx) ? data.customEx : [])
    .filter(c => c && safeId(c.id) && !libraryHas(c.id) && isStr(c.n))
    .slice(0, 20)
    .map(c => ({ id: clampStr(c.id, 40), n: clampStr(c.n, 60), bp: clampStr(c.bp || 'waist', 30), ...(c.desc ? { desc: clampStr(c.desc, 400) } : {}) }));
  // Ids the plan may name: invented in this same answer, or already the user's own.
  const proposedIds = new Set([...customEx.map(c => c.id), ...(ctx.customIds || [])]);

  const routines = [];
  (Array.isArray(data.routines) ? data.routines : []).slice(0, MAX_ROUTINES).forEach((r, ri) => {
    if (!r || typeof r !== 'object') { errors.push(`routines[${ri}] is not an object`); return; }
    if (!isStr(r.name)) errors.push(`routines[${ri}].name is required`);
    if (r.prog != null && !POLICIES.includes(r.prog)) errors.push(`routines[${ri}].prog "${r.prog}" is not one of ${POLICIES.join(', ')}`);
    const ex = [];
    (Array.isArray(r.ex) ? r.ex : []).slice(0, MAX_EX_PER_ROUTINE).forEach((e, ei) => {
      const where = `routines[${ri}].ex[${ei}]`;
      if (!e || !isStr(e.id)) { errors.push(`${where}.id is required`); return; }
      // FR-16: an id that resolves to nothing invalidates the proposal rather than being
      // dropped into a plan that renders blank the first time it is trained.
      if (!libraryHas(e.id) && !proposedIds.has(e.id)) {
        errors.push(`${where}.id "${e.id}" is not in the exercise library and is not one of your own customEx entries — use an id from the library provided in the payload`);
        return;
      }
      if (offEquipment(ctx, e.id)) { errors.push(OFF_EQUIPMENT(`${where}.id`, e.id)); return; }
      const clean = { id: e.id, sets: isInt(e.sets, 1, 10) ? e.sets : 3 };
      const mode = MODES.includes(e.mode) ? e.mode : 'reps';
      const perSide = !!e.side;
      if (mode === 'cardio') {
        // Written out like 'time' below: without it every reader falls back to the catalogue,
        // and a cardio finisher on a non-cardio exercise (kettlebell swings) comes out as reps
        // with no target at all (#640).
        clean.mode = 'cardio';
        clean.min = isInt(e.min, 1, 180) ? e.min : 20;
        clean.speed = isNum(e.speed) && e.speed > 0 && e.speed <= MAX_SPEED ? e.speed : 8;
      } else if (mode === 'time') {
        clean.mode = 'time';
        clean.sec = isInt(e.sec, 5, 3600) ? e.sec : 45;
        if (isNum(e.weight) && e.weight > 0 && e.weight <= MAX_WEIGHT) clean.weight = e.weight;
      } else {
        clean.mode = 'reps';
        clean.reps = isInt(e.reps, 1, 100) ? e.reps : 10;
        if (perSide && clean.reps % 2) { errors.push(ODD_PER_SIDE(`${where}.reps`)); return; }
        if (isNum(e.weight) && e.weight > 0 && e.weight <= MAX_WEIGHT) clean.weight = e.weight;
      }
      if (e.prog != null) {
        if (!POLICIES.includes(e.prog)) errors.push(`${where}.prog "${e.prog}" is not one of ${POLICIES.join(', ')}`);
        else clean.prog = e.prog;
      }
      if (isNum(e.inc) && e.inc > 0 && e.inc <= MAX_INC) clean.inc = e.inc;
      if (isInt(e.repsMin, 1, 100)) clean.repsMin = e.repsMin;
      // The ceiling that makes bodyweight progression terminate (upstream #33): reaching it
      // adds a set and restarts the reps. Without it the Coach can neither see nor prescribe
      // how a push-up is meant to get harder.
      if (isInt(e.repsMax, 1, 100)) clean.repsMax = e.repsMax;
      // Triple progression's set ceiling (frontend/src/lib/progression.js tripleSetsOf).
      if (isInt(e.setsMax, 1, 10)) clean.setsMax = e.setsMax;
      if (clean.repsMax != null && clean.repsMin != null && clean.repsMax < clean.repsMin) {
        errors.push(INVERTED_RANGE(where)); return;
      }
      // Written out only when the plan disagrees with the catalogue, matching plan-share.js —
      // an absent flag means "whatever the exercise says", which is what every plan written
      // before these existed relies on.
      if (e.bodyweight != null) clean.bodyweight = !!e.bodyweight;
      if (perSide) clean.side = true;
      if (isStr(e.sg)) clean.sg = clampStr(e.sg, 20);
      if (isStr(e.why)) clean.why = clampStr(e.why, 400);
      // The same exercise twice in one routine has no honest reading: `reorder` can never be
      // satisfied again (it demands each id once), and every targeted change resolves to
      // whichever copy comes first.
      if (ex.some(x => x.id === clean.id)) {
        errors.push(`${where}.id "${e.id}" appears twice in "${r.name || ri}" — list each exercise once`);
        return;
      }
      ex.push(clean);
    });
    if (!ex.length) errors.push(`routines[${ri}] has no valid exercises`);
    // Two routines answering to one id make the week ambiguous: `known` is a Set, so the day
    // validates while pointing at either of them.
    const rid = safeId(r.id) ? clampStr(r.id, 40) : 'r' + ri;
    if (routines.some(x => x.id === rid)) {
      errors.push(`routines[${ri}].id "${rid}" is already used by another routine in this plan`);
      return;
    }
    routines.push({
      id: rid,
      name: clampStr(r.name || 'Routine', 40),
      emoji: glyphStr(r.emoji),
      ...(POLICIES.includes(r.prog) ? { prog: r.prog } : {}),
      ...(isStr(r.why) ? { why: clampStr(r.why, 400) } : {}),
      ex
    });
  });

  // The week may only point at routines this bundle actually defines.
  const known = new Set(routines.map(r => r.id));
  const week = {};
  Object.entries(data.week || {}).forEach(([d, rid]) => {
    const day = +d;
    if (!isInt(day, 0, 6)) { errors.push(`week key "${d}" is not a weekday number 0-6`); return; }
    if (!known.has(rid)) { errors.push(`week[${d}] points at "${rid}", which is not one of the routines in this plan`); return; }
    week[day] = rid;
  });

  // FR-20: never start someone above what they have actually lifted.
  const caps = new Map((ctx.workingWeights || []).map(w => [w.id, w.best]));
  routines.forEach(r => r.ex.forEach(e => {
    if (e.weight == null) return;
    const cap = caps.get(e.id);
    // No cap for THIS exercise means they have never lifted it, whether or not they have
    // lifted anything else. Either way the number is invented, and create.md already tells the
    // model to omit it: drop it and let the first session set the baseline, like the app does.
    if (cap == null) delete e.weight;
    else if (e.weight > cap) e.weight = cap;
  }));

  // FR-17: honour the number of training days the user asked for.
  const want = ctx.daysPerWeek;
  // An absent week used to slip through: the plan then schedules nothing at all, which is not
  // the number of days anyone asked for either.
  if (isInt(want, 1, 7) && Object.keys(week).length !== want) {
    errors.push(`the week schedules ${Object.keys(week).length} days but ${want} were asked for`);
  }

  if (errors.length) return fail(errors);
  return {
    ok: true,
    bundle: {
      opengym_plan: 1,
      name: clampStr(data.name || 'Coach plan', 40),
      summary: clampStr(data.summary || '', 1200),
      basedOn: clampStr(data.basedOn || '', 400),
      week, routines, customEx
    }
  };
}

/* =============================== review change-sets =============================== */

/**
 * Validate a review answer. Returns { ok, nochange } | { ok, proposal } | { ok:false, errors }.
 * `plan` is the payload's cleaned plan — every target must resolve against it, so a change
 * aimed at a routine that no longer exists never reaches the review screen.
 */
export function validateReview(data, plan, ctx = {}) {
  if (!data || typeof data !== 'object') return fail(['the answer was not an object']);
  if (data.nochange) {
    return { ok: true, nochange: true, reading: clampStr(data.reading || data.summary || '', 1200) };
  }
  const errors = [];
  const routines = new Map((plan?.routines || []).map(r => [r.id, r]));
  // payload.librarySlice offers the model the user's own exercises alongside the catalogue, so
  // rejecting them here made every proposal naming one fail — and burn the single repair round.
  const known = new Set(ctx.customIds || []);
  const knownEx = id => libraryHas(id) || known.has(id);
  const changes = [];
  const seenIds = new Set();
  const list = Array.isArray(data.changes) ? data.changes : null;
  if (!list) return fail(['changes must be an array (or set "nochange": true with a "reading")']);

  // A swap-exercise or add-exercise that brings in an exercise the routine already has (#313)
  // is the one refusal that is dropped rather than fatal when the rest of the answer is sound:
  // like a change that restates the plan, it is self-contained — nothing else in the set can
  // depend on an exercise that never arrives — and costing a whole review over it, when the
  // lifter can simply not be shown it, helps nobody. When it is the only thing proposed, or
  // something else is also wrong, it is reported with the rest so the repair round fixes both.
  // Self-contained is checked, not assumed: another change in the same routine that names the
  // exercise it swapped out or brought in was written with it in mind — "swap 0001 for 0007"
  // next to "remove 0007" means something else once the swap is gone — so then it is fatal.
  const dropped = [];
  const droppedRefs = [];
  const dropDuplicate = (msg, where, c) => {
    errors.push(msg); dropped.push(msg);
    const t = c.target || {};
    droppedRefs.push({ where, rid: t.routineId, ids: [t.exId, (c.after || {}).id].filter(isStr) });
  };

  list.slice(0, MAX_CHANGES).forEach((c, i) => {
    const where = `changes[${i}]`;
    if (!c || typeof c !== 'object') { errors.push(`${where} is not an object`); return; }
    if (!CHANGE_TYPES.includes(c.type)) {
      errors.push(`${where}.type "${c.type}" is not allowed — use one of: ${CHANGE_TYPES.join(', ')}`);
      return;
    }
    if (!isStr(c.why)) { errors.push(`${where}.why is required — every change must cite the evidence behind it`); return; }
    const target = c.target || {};
    const routine = target.routineId ? routines.get(target.routineId) : null;

    // Targets: everything but add-routine, week and programme must name a routine that exists;
    // anything touching an exercise must name one that is actually in it.
    if (!['add-routine', 'week', 'programme'].includes(c.type)) {
      if (!routine) { errors.push(`${where}.target.routineId "${target.routineId}" is not one of the routines in the plan`); return; }
    }
    const needsEx = ['remove-exercise', 'swap-exercise', 'sets', 'reps', 'repsMin', 'repsMax', 'sec', 'cardio', 'exercise-prog', 'inc', 'superset', 'warmup'];
    let planned = null;
    if (needsEx.includes(c.type)) {
      if (!target.exId) { errors.push(`${where}.target.exId is required for type "${c.type}"`); return; }
      planned = (routine.ex || []).find(e => e.id === target.exId) || null;
      if (!planned) {
        errors.push(`${where}.target.exId "${target.exId}" is not in routine "${routine.name}" (routineId "${routine.id}") — `
          + `a change's target.exId must be one of that routine's own exercises: ${exIdsOf(routine)}`); return;
      }
    }

    // Two changes under one id share a checkbox on the review screen: ticking one applies
    // both, and React renders the list on duplicate keys.
    let cid = isStr(c.id) ? clampStr(c.id, 40) : 'c' + i;
    if (seenIds.has(cid)) cid = `${cid}-${i}`;
    seenIds.add(cid);

    const out = {
      id: cid,
      type: c.type,
      target: {
        // Same reason as `evidence` below: this is copied into the synced log. For add-routine
        // and week nothing above ever looks at routineId, so it is otherwise unbounded.
        ...(isStr(target.routineId) ? { routineId: clampStr(target.routineId, 40) } : {}),
        ...(isStr(target.exId) ? { exId: clampStr(target.exId, 40) } : {}),
        ...(isInt(target.weekday, 0, 6) ? { weekday: target.weekday } : {}),
        ...(c.type === 'programme' && isStr(target.programmeId) ? { programmeId: clampStr(target.programmeId, 64) } : {})
      },
      why: clampStr(c.why, 600),
      // The screen had no way to say WHICH routine: "Remove a routine" was the entire card, and
      // approving one is irreversible from that screen. The name is right here; send it.
      ...(routine ? { routineName: clampStr(routine.name || '', 40) } : {}),
      before: currentOf(c.type, routine, planned, plan, target),
      after: c.after ?? null
    };

    // Per-type checks on `after`. `before` is not checked because it is not taken: it is read
    // off the plan above, which is the only copy either side should trust.
    switch (c.type) {
      case 'add-exercise': {
        // The bundle path forbids the same exercise twice in one routine; so must this. A
        // duplicate makes every later reorder unsatisfiable, makes each targeted change resolve
        // to whichever copy comes first, and makes one "drop it" delete both.
        if ((routine.ex || []).some(e => e.id === (c.after || {}).id)) {
          dropDuplicate(ALREADY_IN(where, c, routine), where, c); return;
        }
        const a = c.after || {};
        if (!isStr(a.id) || !knownEx(a.id)) { errors.push(`${where}.after.id must be an exercise id from the library`); return; }
        if (offEquipment(ctx, a.id)) { errors.push(OFF_EQUIPMENT(`${where}.after.id`, a.id)); return; }
        const perSide = !!a.side;
        if (perSide && isInt(a.reps, 1, 100) && a.reps % 2) { errors.push(ODD_PER_SIDE(`${where}.after.reps`)); return; }
        if (isInt(a.repsMax, 1, 100) && isInt(a.repsMin, 1, 100) && a.repsMax < a.repsMin) { errors.push(INVERTED_RANGE(`${where}.after`)); return; }
        out.after = {
          id: a.id, name: libraryName(a.id),
          sets: isInt(a.sets, 1, 10) ? a.sets : 3,
          ...(MODES.includes(a.mode) ? { mode: a.mode } : { mode: 'reps' }),
          ...(isInt(a.reps, 1, 100) ? { reps: a.reps } : {}),
          ...(isInt(a.sec, 5, 3600) ? { sec: a.sec } : {}),
          ...cardioTarget(a),
          ...(isNum(a.weight) && a.weight > 0 && a.weight <= MAX_WEIGHT ? { weight: a.weight } : {}),
          ...(POLICIES.includes(a.prog) ? { prog: a.prog } : {}),
          ...(isInt(a.repsMin, 1, 100) ? { repsMin: a.repsMin } : {}),
          ...(isInt(a.repsMax, 1, 100) ? { repsMax: a.repsMax } : {}),
          ...(isInt(a.setsMax, 1, 10) ? { setsMax: a.setsMax } : {}),
          ...(a.bodyweight != null ? { bodyweight: !!a.bodyweight } : {}),
          ...(perSide ? { side: true } : {}),
          ...(isInt(a.position, 0, MAX_EX_PER_ROUTINE) ? { position: a.position } : {})
        };
        break;
      }
      case 'swap-exercise': {
        // Same rule, minus the exercise being swapped out — replacing A with B when B is
        // already there is a duplicate, not a swap.
        if ((routine.ex || []).some(e => e.id === (c.after || {}).id && e.id !== target.exId)) {
          dropDuplicate(ALREADY_IN(where, c, routine), where, c); return;
        }
        const a = c.after || {};
        if (!isStr(a.id) || !knownEx(a.id)) { errors.push(`${where}.after.id must be an exercise id from the library`); return; }
        if (offEquipment(ctx, a.id)) { errors.push(OFF_EQUIPMENT(`${where}.after.id`, a.id)); return; }
        if (a.id === target.exId) { errors.push(`${where} swaps an exercise for itself`); return; }
        out.after = {
          id: a.id, name: libraryName(a.id),
          ...(isInt(a.sets, 1, 10) ? { sets: a.sets } : {}),
          ...(isInt(a.reps, 1, 100) ? { reps: a.reps } : {}),
          ...(isNum(a.weight) && a.weight > 0 && a.weight <= MAX_WEIGHT ? { weight: a.weight } : {})
        };
        break;
      }
      case 'remove-exercise':
      case 'remove-routine':
        out.after = null;
        break;
      case 'sets': if (!isInt(c.after, 1, 10)) { errors.push(`${where}.after must be a whole number of sets (1-10)`); return; } break;
      case 'reps':
        if (!isInt(c.after, 1, 100)) { errors.push(`${where}.after must be a whole number of reps (1-100)`); return; }
        // The plan is what says whether this exercise is unilateral, so the rule is checked
        // against the plan rather than against whatever the change claims about itself.
        if (planned?.side && c.after % 2) { errors.push(ODD_PER_SIDE(`${where}.after`)); return; }
        break;
      case 'repsMin':
        if (!isInt(c.after, 1, 100)) { errors.push(`${where}.after must be a whole number (1-100)`); return; }
        if (planned?.repsMax != null && c.after > planned.repsMax) { errors.push(INVERTED_RANGE(where)); return; }
        break;
      case 'repsMax':
        if (!isInt(c.after, 1, 100)) { errors.push(`${where}.after must be a whole number (1-100)`); return; }
        if (planned?.repsMin != null && c.after < planned.repsMin) { errors.push(INVERTED_RANGE(where)); return; }
        break;
      case 'sec': if (!isInt(c.after, 5, 3600) ) { errors.push(`${where}.after must be seconds (5-3600)`); return; } break;
      case 'cardio': {
        const a = c.after || {};
        if (!isInt(a.min, 1, 180) && !isNum(a.speed)) { errors.push(`${where}.after must carry min and/or speed`); return; }
        out.after = { ...(isInt(a.min, 1, 180) ? { min: a.min } : {}), ...(isNum(a.speed) && a.speed > 0 && a.speed <= MAX_SPEED ? { speed: a.speed } : {}) };
        break;
      }
      case 'inc': if (!isNum(c.after) || c.after <= 0 || c.after > MAX_INC) { errors.push(`${where}.after must be a positive increment no larger than ${MAX_INC}`); return; } break;
      case 'routine-prog':
      case 'exercise-prog':
        if (!POLICIES.includes(c.after)) { errors.push(`${where}.after must be one of ${POLICIES.join(', ')}`); return; }
        break;
      case 'reorder': {
        const order = Array.isArray(c.after) ? c.after : null;
        if (!order) { errors.push(`${where}.after must be an array of exercise ids in the new order`); return; }
        const have = (routine.ex || []).map(e => e.id);
        // Same ids, each exactly once. Length plus membership is not enough: a list that names
        // one exercise twice and omits another satisfies both, and a reorder is the one change
        // type with nothing to show in the diff column — so it deletes an exercise on apply
        // with no way for the person approving it to see that it would.
        if (order.length !== have.length || new Set(order).size !== order.length || order.some(id => !have.includes(id))) {
          errors.push(`${where}.after must list exactly the ${have.length} exercise ids already in "${routine.name}", each once, reordered`); return;
        }
        out.after = order;
        break;
      }
      case 'superset': {
        const a = c.after || {};
        if (a.link && !isStr(a.with)) { errors.push(`${where}.after.with is required when linking a superset`); return; }
        // Supersetting something with itself resolves to a real exercise and passes the
        // membership check below; the apply path then moves the anchor out from under itself.
        if (a.link && a.with === target.exId) { errors.push(`${where} supersets an exercise with itself`); return; }
        if (a.link && !(routine.ex || []).some(e => e.id === a.with)) { errors.push(`${where}.after.with "${a.with}" is not in routine "${routine.name}"`); return; }
        out.after = { link: !!a.link, ...(a.link ? { with: a.with } : {}) };
        break;
      }
      case 'add-routine': {
        const a = c.after || {};
        if (!isStr(a.name)) { errors.push(`${where}.after.name is required`); return; }
        // FR-16 again, and for the same reason it applies to a created plan: an id that
        // resolves to nothing invalidates the proposal. Filtering it out instead would build
        // the routine the model asked for minus the exercises it could not have, and hand that
        // to someone as if it were what they were shown.
        const listed = Array.isArray(a.ex) ? a.ex : [];
        // By index: find() hands back the entry itself, and a null in the list was falsy enough
        // to pass this check and crash on the next line instead of going back for repair.
        const badAt = listed.findIndex(e => !e || typeof e !== 'object' || !isStr(e.id) || !knownEx(e.id));
        if (badAt >= 0) {
          const bad = listed[badAt];
          errors.push(bad && typeof bad === 'object' && isStr(bad.id)
            ? `${where}.after.ex "${bad.id}" is not in the exercise library — use an id from the library provided in the payload`
            : `${where}.after.ex[${badAt}] is not an exercise — each entry needs an id from the library provided in the payload`);
          return;
        }
        const offEq = listed.find(e => offEquipment(ctx, e.id));
        if (offEq) { errors.push(OFF_EQUIPMENT(`${where}.after.ex`, offEq.id)); return; }
        const ex = listed.slice(0, MAX_EX_PER_ROUTINE);
        if (!ex.length) { errors.push(`${where}.after.ex must list at least one exercise from the library`); return; }
        const odd = ex.find(e => e.side && isInt(e.reps, 1, 100) && e.reps % 2);
        if (odd) { errors.push(ODD_PER_SIDE(`${where}.after.ex "${odd.id}"`)); return; }
        out.after = {
          name: clampStr(a.name, 40), emoji: glyphStr(a.emoji),
          ...(POLICIES.includes(a.prog) ? { prog: a.prog } : {}),
          ex: ex.map(e => ({
            id: e.id, name: libraryName(e.id),
            sets: isInt(e.sets, 1, 10) ? e.sets : 3,
            mode: MODES.includes(e.mode) ? e.mode : 'reps',
            ...(isInt(e.reps, 1, 100) ? { reps: e.reps } : {}),
            ...(isInt(e.sec, 5, 3600) ? { sec: e.sec } : {}),
            ...cardioTarget(e),
            ...(isInt(e.repsMin, 1, 100) ? { repsMin: e.repsMin } : {}),
            ...(isInt(e.repsMax, 1, 100) ? { repsMax: e.repsMax } : {}),
            ...(isInt(e.setsMax, 1, 10) ? { setsMax: e.setsMax } : {}),
            ...(POLICIES.includes(e.prog) ? { prog: e.prog } : {}),
            ...(isNum(e.inc) && e.inc > 0 && e.inc <= MAX_INC ? { inc: e.inc } : {}),
            ...(e.bodyweight != null ? { bodyweight: !!e.bodyweight } : {}),
            ...(e.side ? { side: true } : {})
          }))
        };
        break;
      }
      case 'rename-routine':
        if (!isStr(c.after)) { errors.push(`${where}.after must be the new routine name`); return; }
        out.after = clampStr(c.after, 40);
        break;
      case 'warmup': {
        // How this exercise warms up: Auto (the app ramps by load), a block of its own (shares of
        // the work weight, the bare bar or the body alone), or none. The app does the rounding.
        const a = c.after || {};
        if (!WARMUP_MODES.includes(a.mode)) { errors.push(`${where}.after.mode must be one of ${WARMUP_MODES.join(', ')}`); return; }
        if ((planned.mode || 'reps') !== 'reps') { errors.push(`${where} sets warm-ups on an exercise that is not done in reps — only reps exercises warm up`); return; }
        if (a.mode !== 'own') { out.after = { mode: a.mode }; break; }
        const rows = Array.isArray(a.rows) ? a.rows : [];
        if (!rows.length || rows.length > 5) { errors.push(`${where}.after.rows must list 1-5 warm-up sets when mode is "own"`); return; }
        const clean = [];
        for (let k = 0; k < rows.length; k++) {
          const r = rows[k] || {};
          if (!isInt(r.reps, 1, 30)) { errors.push(`${where}.after.rows[${k}].reps must be a whole number 1-30`); return; }
          if (r.bar === true) { clean.push({ wb: true, r: r.reps }); continue; }
          if (!isNum(r.pct) || r.pct < 0 || r.pct > 95) { errors.push(`${where}.after.rows[${k}].pct must be 0-95 (a share of the work weight; 0 is the body alone) or set "bar": true`); return; }
          const prev = clean[clean.length - 1];
          if (prev && !prev.wb && Math.round(r.pct) <= prev.wp) { errors.push(`${where}.after.rows must climb: each warm-up heavier than the one before`); return; }
          clean.push({ wp: Math.round(r.pct), r: r.reps });
        }
        out.after = { mode: 'own', rows: clean };
        break;
      }
      case 'programme': {
        // A block of weeks over the plan's routines (frontend lib/programmes.js): a new one, or a
        // revision of one the payload lists. The targets name exercises of the plan.
        const a = c.after || {};
        const existing = isStr(target.programmeId) ? (plan?.programmes || []).find(p => p.id === target.programmeId) : null;
        if (isStr(target.programmeId) && !existing) { errors.push(`${where}.target.programmeId "${target.programmeId}" is not one of plan.programmes — leave it out to write a new programme`); return; }
        if (!existing && !isStr(a.name)) { errors.push(`${where}.after.name is required for a new programme`); return; }
        const weeks = Array.isArray(a.weeks) ? a.weeks : [];
        if (!weeks.length || weeks.length > MAX_PROGRAMME_WEEKS) { errors.push(`${where}.after.weeks must list 1-${MAX_PROGRAMME_WEEKS} weeks`); return; }
        const inPlan = new Map([...routines.values()].map(r => [r.id, new Set((r.ex || []).map(e => e.id))]));
        const anywhere = id => [...inPlan.values()].some(set => set.has(id));
        const outWeeks = [];
        for (let k = 0; k < weeks.length; k++) {
          const w = weeks[k] || {};
          const week = {};
          if (w.deload === true) week.deload = true;
          if (w.rpe != null) {
            if (!isNum(w.rpe) || w.rpe < 6 || w.rpe > 10) { errors.push(`${where}.after.weeks[${k}].rpe must be 6-10`); return; }
            week.rpe = halfStep(w.rpe);
          }
          const targets = Array.isArray(w.targets) ? w.targets.slice(0, MAX_WEEK_TARGETS) : [];
          const t = {};
          for (let j = 0; j < targets.length; j++) {
            const x = targets[j] || {};
            const at = `${where}.after.weeks[${k}].targets[${j}]`;
            if (!isStr(x.exId) || !anywhere(x.exId)) { errors.push(`${at}.exId must be an exercise of the plan`); return; }
            if (isStr(x.routineId) && !inPlan.get(x.routineId)?.has(x.exId)) { errors.push(`${at}.routineId must be a routine of the plan that has exercise "${x.exId}"`); return; }
            const pct = isNum(x.pct) && x.pct >= 30 && x.pct <= 110 ? halfStep(x.pct) : null;
            const rpe = isNum(x.rpe) && x.rpe >= 6 && x.rpe <= 10 ? halfStep(x.rpe) : null;
            if (pct == null && rpe == null) { errors.push(`${at} needs pct (30-110, a share of the best estimated 1RM) or rpe (6-10)`); return; }
            t[isStr(x.routineId) ? `${x.routineId}:${x.exId}` : x.exId] = { ...(pct != null ? { pct } : {}), ...(rpe != null ? { rpe } : {}) };
          }
          if (Object.keys(t).length) week.t = t;
          outWeeks.push(week);
        }
        out.after = { ...(isStr(a.name) ? { name: clampStr(a.name, 60) } : existing ? { name: clampStr(existing.name || '', 60) } : {}), weeks: outWeeks };
        out.before = existing ? { name: existing.name || '', weeks: existing.weeks.length } : null;
        break;
      }
      case 'week': {
        if (!isInt(target.weekday, 0, 6)) { errors.push(`${where}.target.weekday must be 0-6`); return; }
        // null/'rest' clears the day; anything else has to be a routine that exists.
        if (c.after != null && c.after !== 'rest' && !routines.has(c.after)) {
          errors.push(`${where}.after must be a routine id from the plan, "rest", or null`); return;
        }
        out.after = c.after ?? null;
        break;
      }
    }
    changes.push(out);
  });

  const namesOf = ch => {
    const a = ch.after && typeof ch.after === 'object' && !Array.isArray(ch.after) ? ch.after : {};
    return [ch.target.exId, a.id, a.with].filter(isStr);
  };
  droppedRefs.forEach(d => {
    const dep = changes.find(ch => ch.target.routineId === d.rid && namesOf(ch).some(id => d.ids.includes(id)));
    if (dep) {
      const id = namesOf(dep).find(x => d.ids.includes(x));
      errors.push(`${d.where} cannot just be left out: change "${dep.id}" (${dep.type}) in the same routine also names exercise "${id}", `
        + `and without ${d.where} it would do something other than what was meant — propose these changes again as one set that holds together`);
    }
  });
  if (errors.length > dropped.length) return fail(errors);
  if (dropped.length && !changes.length) return fail(errors);
  errors.length = 0;
  // Everything above validates one change against the ORIGINAL plan. These are the things that
  // are only wrong in company — each one validates alone, and together they are incoherent or
  // destructive. The user approves a screen, not a change, so the screen has to be coherent.
  const SCALAR = ['sets', 'reps', 'repsMin', 'repsMax', 'sec', 'inc', 'routine-prog', 'exercise-prog', 'rename-routine', 'week'];
  const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const byRoutine = new Map();
  const weekdays = new Set();
  const removedRoutines = new Set();
  const addsPerRoutine = new Map();
  let addedRoutines = 0;
  let programmeChanges = 0;

  // A change whose `after` already equals the plan is dropped rather than refused: one
  // redundant entry should not cost the whole review, and as padding around something
  // destructive it is exactly what should not reach the screen. If they all go, the answer was
  // "no change" and is reported as such below.
  const kept = changes.filter(ch => !(SCALAR.includes(ch.type) && sameValue(ch.before, ch.after))
    // Auto or none on a slot that already says so restates the plan the same way.
    && !(ch.type === 'warmup' && ch.after.mode !== 'own' && ch.before === ch.after.mode));

  // Checked per change above against the plan as it stands; two changes that each bring the
  // same exercise into one routine pass that alone and duplicate it together.
  const incoming = new Map();
  kept.forEach(ch => {
    const rid = ch.target.routineId;
    if (['add-exercise', 'swap-exercise'].includes(ch.type)) {
      const key = rid + '\u0000' + ch.after.id;
      if (incoming.has(key)) {
        errors.push(`changes "${incoming.get(key)}" and "${ch.id}" both bring exercise "${ch.after.id}" into routine "${routines.get(rid)?.name || rid}" — an exercise can appear in a routine only once, so keep one of them`);
      } else incoming.set(key, ch.id);
    }
    if (rid) {
      if (!byRoutine.has(rid)) byRoutine.set(rid, []);
      byRoutine.get(rid).push(ch.type);
    }
    if (ch.type === 'remove-routine') removedRoutines.add(rid);
    if (ch.type === 'add-routine') addedRoutines++;
    if (ch.type === 'programme' && ++programmeChanges === 2) errors.push('only one programme change per review — write or revise one programme at a time');
    if (ch.type === 'add-exercise') addsPerRoutine.set(rid, (addsPerRoutine.get(rid) || 0) + 1);
    if (ch.type === 'week') {
      const d = ch.target.weekday;
      if (weekdays.has(d)) errors.push(`two changes both reschedule weekday ${d} — only one can win`);
      weekdays.add(d);
    }
  });

  byRoutine.forEach((types, rid) => {
    // A reorder is a permutation of the list as it stands. Applied after something that added,
    // removed or replaced an exercise it no longer describes that list, and the client throws
    // mid-apply — which discards the whole approved set and blames the app.
    if (types.includes('reorder') && types.some(t => ['add-exercise', 'remove-exercise', 'swap-exercise'].includes(t))) {
      errors.push(`routine "${routines.get(rid)?.name || rid}" is both reordered and restructured in one review — propose the reorder next time, against the list it will actually have`);
    }
    if (removedRoutines.has(rid) && types.some(t => t !== 'remove-routine')) {
      errors.push(`routine "${routines.get(rid)?.name || rid}" is removed and also changed in the same review`);
    }
  });

  // The bundle path bounds these; the change path did not, so 25 changes could walk past both.
  addsPerRoutine.forEach((n, rid) => {
    const have = (routines.get(rid)?.ex || []).length;
    if (have + n > MAX_EX_PER_ROUTINE) errors.push(`routine "${routines.get(rid)?.name || rid}" would end up with ${have + n} exercises, more than the ${MAX_EX_PER_ROUTINE} allowed`);
  });
  // The cap is on what a review may grow the plan to, not on the plan it was handed. The app has
  // no routine limit of its own, and accepting a created plan adds its routines next to the ones
  // already there (applyCreatedPlan → mergePlan never replaces), so a returning lifter is often
  // past seven before the Coach reviews anything. Counting those refused every answer it could
  // give them, a single swap included, and no repair round could fix it short of deleting
  // routines nobody asked to lose (#471). Past the cap, a review may change and shrink the plan;
  // it still may not leave it any bigger.
  const routinesAfter = routines.size + addedRoutines - removedRoutines.size;
  if (routinesAfter > MAX_ROUTINES && routinesAfter > routines.size) {
    errors.push(`the plan would end up with more than the ${MAX_ROUTINES} routines allowed`);
  }

  if (errors.length) return fail([...errors, ...dropped]);

  // Everything that was proposed turned out to duplicate an exercise or restate the plan. With
  // a duplicate among them this is not an honest "no change" — the summary still describes the
  // swap — so it goes back for repair rather than out as a reading.
  if (!kept.length && dropped.length) return fail(dropped);
  if (!kept.length) {
    // An empty change list and "no changes" are the same outcome; treat it as the latter
    // rather than showing someone an empty proposal screen (FR-25).
    return { ok: true, nochange: true, reading: clampStr(data.summary || data.reading || '', 1200) };
  }
  return {
    ok: true,
    proposal: {
      summary: clampStr(data.summary || '', 1200),
      evidence: {
        // Clamped because this is stored verbatim in the synced coach log, and trim() cannot
        // shrink a single oversized entry — one answer could push a profile permanently over
        // the state-sync limit.
        from: isStr(data.evidence?.from) ? clampStr(data.evidence.from, 40) : null,
        to: isStr(data.evidence?.to) ? clampStr(data.evidence.to, 40) : null,
        sessions: isInt(data.evidence?.sessions, 0, 10000) ? data.evidence.sessions : null
      },
      changes: kept,
      notes: (Array.isArray(data.notes) ? data.notes : []).filter(isStr).slice(0, 6).map(n => clampStr(n, 600))
    }
  };
}

/**
 * What the plan says right now for whatever a change is about — the `before` the client checks
 * for staleness. Read off the plan rather than copied from the answer, because the model's idea
 * of the current value is the one field on a change that nothing else constrains: an object of
 * any size passes through into the proposal and then into the synced Coach log, and a merely
 * mistyped one ("3 sets" where the plan holds 3) makes markStale() disable a change that was
 * perfectly good. The plan is already in scope here, and it is not a matter of opinion.
 *
 * Mirrors `currentValue` in frontend/src/lib/coach.js — structural changes have no single
 * scalar to compare and get null, which that function reads as "nothing to check".
 */
function currentOf(type, routine, planned, plan, target) {
  switch (type) {
    case 'sets': return planned?.sets ?? null;
    case 'reps': return planned?.reps ?? null;
    case 'repsMin': return planned?.repsMin ?? null;
    case 'repsMax': return planned?.repsMax ?? null;
    case 'sec': return planned?.sec ?? null;
    case 'inc': return planned?.inc ?? null;
    case 'exercise-prog': return planned?.prog ?? null;
    case 'routine-prog': return routine?.prog ?? null;
    case 'rename-routine': return routine?.name ?? null;
    case 'week': return plan?.week?.[target?.weekday] ?? null;
    case 'warmup': return planned?.warmup ?? null;
    default: return null;
  }
}

function fail(errors) { return { ok: false, errors }; }

/* =============================== chat answers =============================== */

export const MAX_ANSWER_CHARS = 2000;

/**
 * Validate an answer to a question in the chat: one non-empty string, and nothing to apply — an
 * answer that tries to carry plan changes is refused, the way a debrief's is.
 * Returns { ok, proposal:{ answer } } | { ok:false, errors }.
 */
export function validateAsk(data) {
  if (!data || typeof data !== 'object') return fail(['the answer was not an object']);
  const errors = [];
  if (Array.isArray(data.changes) && data.changes.length) errors.push('an answer carries no plan changes — drop "changes" and say it in "answer"');
  if (!isStr(data.answer) || !data.answer.trim()) errors.push('answer is required — reply to the question in plain text');
  if (errors.length) return fail(errors);
  return { ok: true, proposal: { answer: clampStr(data.answer.trim(), MAX_ANSWER_CHARS) } };
}

/* =============================== workout debriefs =============================== */

const DEBRIEF_LISTS = ['highlights', 'watch', 'nextTime'];
const MAX_DEBRIEF_ITEMS = 5;

/**
 * Validate a debrief — a reading of one session with nothing to apply. Strings and short lists
 * only: the closed list of change types does not apply because a debrief cannot carry a change
 * at all, and one that tries is refused rather than trimmed.
 * Returns { ok, proposal:{ summary, score, highlights, watch, nextTime } } | { ok:false, errors }.
 */
export function validateDebrief(data) {
  if (!data || typeof data !== 'object') return fail(['the answer was not an object']);
  const errors = [];
  if (data.nochange) errors.push('a debrief was requested — "nochange" is not an answer here; read the session and say what you saw');
  if (Array.isArray(data.changes) && data.changes.length) errors.push('a debrief carries no plan changes — drop "changes" and put advice into "nextTime"');
  if (!isStr(data.summary)) errors.push('summary is required — two or three sentences on how the session went');
  let score = null;
  if (typeof data.score === 'number' && Number.isFinite(data.score)) score = Math.max(1, Math.min(10, Math.round(data.score)));
  else errors.push('score must be a whole number from 1 to 10');
  const lists = {};
  DEBRIEF_LISTS.forEach(k => {
    const v = data[k];
    if (v != null && !Array.isArray(v)) { errors.push(`${k} must be an array of short strings`); lists[k] = []; return; }
    lists[k] = (v || []).filter(isStr).map(x => clampStr(x.trim(), 300)).slice(0, MAX_DEBRIEF_ITEMS);
  });
  if (!DEBRIEF_LISTS.some(k => lists[k].length)) errors.push('at least one of highlights, watch or nextTime must have an item');
  if (errors.length) return fail(errors);
  return { ok: true, proposal: { summary: clampStr(data.summary.trim(), 600), score, ...lists } };
}

/* ---------- parse-wod: a posted workout read off an image ----------
   What comes back is a draft for a review screen, not something applied to anything, so the
   job here is shape and bounds: the closed format list, doses that are numbers, a size a phone
   can render, and strings clipped. Every movement has to carry `rawName` — it is the key the
   client resolves an exercise by, and a line without one can never be resolved. Ids are
   assigned here rather than trusted, and `exId` is always null: naming the exercise is the
   client's job (crossfit-resolve.js), against the catalogue and the user's own aliases. An
   image that holds no workout answers `tracks: []`, which is valid and means "nothing found". */
export const WOD_FORMATS = ['amrap', 'emom', 'fortime', 'rounds', 'interval', 'strength', 'other'];
export const MAX_WOD_TRACKS = 6;
export const MAX_WOD_BLOCKS = 12;
export const MAX_WOD_MOVES = 20;
const WOD_DOSE_KEYS = ['reps', 'repsMax', 'cal', 'm', 'sec'];
const MAX_WOD_DOSE = 100000;      // 42195 m is a marathon; anything past this is a misread
const MAX_WOD_LOAD = 1000;
const TRACK_ID = /^[a-z0-9-]{1,24}$/;
const strOrNull = (v, n) => (isStr(v) ? clampStr(v.trim(), n) : null);

function wodDose(v, where, errors, field = 'dose') {
  if (v == null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) { errors.push(`${where}.${field} must be an object like {"reps": 5}`); return {}; }
  const out = {};
  for (const k of WOD_DOSE_KEYS) {
    if (v[k] == null) continue;
    if (!isNum(v[k]) || v[k] < 0 || v[k] > MAX_WOD_DOSE) errors.push(`${where}.${field}.${k} must be a number from 0 to ${MAX_WOD_DOSE}`);
    else out[k] = v[k];
  }
  // `2x200`, `2 Set de Max`: the times the line is done, and the rest between them.
  if (v.sets != null) { if (isInt(v.sets, 1, 50)) out.sets = v.sets; else errors.push(`${where}.${field}.sets must be a whole number from 1 to 50`); }
  if (v.restSec != null) { if (isInt(v.restSec, 0, 1800)) out.restSec = v.restSec; else errors.push(`${where}.${field}.restSec must be whole seconds from 0 to 1800`); }
  // `EMOM 12` / `M3 TARGET 70 HPU`: the reps across all of that slot's minutes, not each minute's.
  if (v.total != null) { if (isInt(v.total, 1, 2000)) out.total = v.total; else errors.push(`${where}.${field}.total must be a whole number from 1 to 2000`); }
  return out;
}

// A dose printed as a male/female split (`20/15 Cal`): same keys and bounds as `dose`, and
// absent unless there is one, so a client reads `doseFemale || dose` the way it reads `rx`.
function wodDoseFemale(v, where, errors) {
  if (v == null) return {};
  const d = wodDose(v, where, errors, 'doseFemale');
  return Object.keys(d).length ? { doseFemale: d } : {};
}

function wodLoad(v, where, errors) {
  if (v == null) return null;
  if (typeof v !== 'object' || !isNum(v.w) || v.w <= 0 || v.w > MAX_WOD_LOAD || !['lb', 'kg'].includes(v.unit)) {
    errors.push(`${where} must be {"w": <number above 0>, "unit": "lb" or "kg"} or null`);
    return null;
  }
  return { w: v.w, unit: v.unit };
}

function wodRx(v, at, errors) {
  if (v == null) return null;
  if (typeof v !== 'object') { errors.push(`${at}.rx must be an object with "male" and "female", or null`); return null; }
  const rx = { male: wodLoad(v.male, `${at}.rx.male`, errors), female: wodLoad(v.female, `${at}.rx.female`, errors) };
  return rx.male || rx.female ? rx : null;
}

// `10-8-6-4-2` / `Jerks 135/95` … `Jerks 225/155`, an EMOM's `M2 12 Lunges 95/65` … `M10 4 Lunges
// 175/115`: one entry per set, its reps / cal / m / sec and its Rx over the movement's for that set.
const WOD_STEP_KEYS = ['reps', 'cal', 'm', 'sec'];
function wodSteps(v, at, errors) {
  if (v == null) return null;
  if (!Array.isArray(v) || v.length < 2 || v.length > 30) { errors.push(`${at}.steps must be an array of 2 to 30 sets, or null`); return null; }
  return v.map((s, j) => {
    const where = `${at}.steps[${j}]`;
    if (!s || typeof s !== 'object' || Array.isArray(s)) { errors.push(`${where} must be an object like {"reps": 10}`); return {}; }
    const out = {};
    for (const k of WOD_STEP_KEYS) {
      if (s[k] == null) continue;
      if (!isNum(s[k]) || s[k] < 0 || s[k] > MAX_WOD_DOSE) errors.push(`${where}.${k} must be a number from 0 to ${MAX_WOD_DOSE}`);
      else out[k] = s[k];
    }
    const rx = wodRx(s.rx, where, errors);
    if (rx) out.rx = rx;
    return out;
  });
}

function wodMovement(m, i, where, errors) {
  const at = `${where}.movements[${i}]`;
  if (!m || typeof m !== 'object') { errors.push(`${at} must be an object`); return null; }
  if (!isStr(m.rawName)) errors.push(`${at}.rawName is required — the movement without its dose or load, e.g. "hang cleans"`);
  if (m.alts != null && !Array.isArray(m.alts)) errors.push(`${at}.alts must be an array`);
  const rx = wodRx(m.rx, at, errors);
  const steps = wodSteps(m.steps, at, errors);
  return {
    id: 'm' + i,
    raw: clampStr(isStr(m.raw) ? m.raw.trim() : m.rawName, 200),
    rawName: clampStr(isStr(m.rawName) ? m.rawName.trim() : '', 80),
    name: clampStr(isStr(m.name) ? m.name.trim() : (isStr(m.rawName) ? m.rawName.trim() : ''), 80),
    slot: strOrNull(m.slot, 8),
    exId: null,
    dose: wodDose(m.dose, at, errors),
    ...wodDoseFemale(m.doseFemale, at, errors),
    perSide: m.perSide === true,
    rx,
    // `15 + 12 + max` / `*Menos peso en cada Drop`: the steps are one set's drops, done back to back
    // every round; without `drop` they are the whole plan (T26's R1 / R2 / R3 loads).
    ...(steps ? { steps, ...(m.drop === true ? { drop: true } : {}) } : {}),
    alts: (Array.isArray(m.alts) ? m.alts : []).filter(a => a && isStr(a.rawName)).slice(0, 5)
      .map(a => ({ exId: null, rawName: clampStr(a.rawName.trim(), 80), dose: wodDose(a.dose, `${at}.alts`, errors), ...wodDoseFemale(a.doseFemale, `${at}.alts`, errors) }))
  };
}

// A rest the model filed as a movement anyway (`M3 Rest 30 seg + 40 DU` read as `rest` and `du`):
// it is dropped, and its seconds go to the restSec of a movement on the same line (same `raw` or
// `slot`) that has none, which is where the prompt asks for them: the next one on that line, else
// the one before it (`M2 40 DU + Rest 30 seg`). Never to another line's movement. The block's
// `raw` still prints it.
const REST_ONLY = /^(?:rest|descanso|pausa)(?:\s+(\d+)(?::(\d{2}))?\s*(seg(?:undos?)?|sec(?:onds?|s)?|s|min(?:utos?|utes?|s)?)?)?(?:\s+cv)?$/i;
function restOf(m) {
  const r = REST_ONLY.exec(m.rawName);
  if (!r) return undefined;
  const named = r[2] != null ? r[1] * 60 + +r[2] : r[1] && (/^min/i.test(r[3] || '') ? r[1] * 60 : +r[1]);
  const sec = Math.round(m.dose.restSec ?? m.dose.sec ?? named);
  return isInt(sec, 0, 1800) ? sec : null;
}
function withoutRests(moves) {
  const rests = moves.map(restOf);
  const work = moves.filter((_, i) => rests[i] === undefined);
  moves.forEach((m, i) => {
    if (rests[i] == null) return;
    const sameLine = n => rests[moves.indexOf(n)] === undefined && (n.raw === m.raw || (m.slot && n.slot === m.slot));
    const to = moves.slice(i + 1).find(sameLine) || moves.slice(0, i).findLast(sameLine);
    if (to && to.dose.restSec == null) to.dose.restSec = rests[i];
  });
  return work;
}

// The model can still print a rising load as one movement per line: the same movement on
// consecutive lines that differs only in its reps / cal / m / sec and Rx (in an EMOM, in its own
// minute: `M2` / `M4` …) is one movement with a step per line, on the first one's slot. An R and an
// L line (perSide), and lines that differ in anything else (alternatives, sets, rest, a women's
// dose), stay as they are.
// ponytail: only adjacent lines; an EMOM printed interleaved (M1 wall balls, M2 lunges 95, M3 wall
// balls, M4 lunges 115) stays per line. Look past other slots if a box prints it that way.
const nameKey = s => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const stepOf = m => ({ ...Object.fromEntries(WOD_STEP_KEYS.filter(k => m.dose[k] != null).map(k => [k, m.dose[k]])), ...(m.rx ? { rx: m.rx } : {}) });
const restKey = m => JSON.stringify([nameKey(m.rawName), Object.entries(m.dose).filter(([k]) => !WOD_STEP_KEYS.includes(k)).sort(),
  m.doseFemale ?? null, m.alts.map(a => [nameKey(a.rawName), a.dose, a.doseFemale ?? null])]);
function withSteps(moves, emom, capMin, rounds) {
  const runs = [];
  for (let i = 0; i < moves.length;) {
    const m = moves[i];
    let j = i + 1;
    const same = n => !n.steps && !n.perSide && restKey(n) === restKey(m) && (emom || n.slot === m.slot);
    if (!m.steps && !m.perSide && nameKey(m.rawName)) while (j < moves.length && j - i < 30 && same(moves[j])) j++;
    const run = moves.slice(i, j);
    if (new Set(run.map(n => JSON.stringify(stepOf(n)))).size > 1) { runs.push(run); i = j; } else { runs.push([m]); i++; }
  }
  // In an EMOM each merged line must be its own minute (M2, M4 … M10): a run stands only when it
  // holds every minute its slot gets, counted the way the log counts them (k slots share the
  // minutes). A rotation whose slots repeat (`EMOM 12` / M1 / M2 3 HC 135 / M3 3 HC 155) keeps
  // one movement per slot.
  for (;;) {
    const out = runs.map(r => (r.length > 1 ? { ...r[0], steps: r.map(stepOf) } : r[0]));
    if (!emom) return out;
    const k = new Set(out.map(m => m.slot).filter(Boolean)).size || 1;
    const n = Math.floor(((capMin > 0 && capMin) || (rounds > 0 && rounds * k) || k) / k);
    const bad = runs.findIndex(r => r.length > 1 && r.length !== n);
    if (bad < 0) return out;
    runs.splice(bad, 1, ...runs[bad].map(m => [m]));
  }
}

// `M3 TARGET 70 HPU` read as 70 reps a minute: it is 70 in total across that slot's minutes.
export function withTarget(m) {
  const r = /\bTARGET\s+(\d+)\b/i.exec(m.raw);
  if (!r || m.dose.reps !== +r[1] || !isInt(+r[1], 1, 2000)) return m;
  const { reps, ...dose } = m.dose;
  return { ...m, dose: { ...dose, total: reps } };
}

// `M3 40 seg max DB OH Hold 20/20` read as a 20/20 kg load: on a timed dose an equal pair with no
// unit is the seconds per side.
export function withTimedSides(m) {
  const r = /\b(\d+)\/\1\b(?!\s*(?:kg|lbs?)\b)/i.exec(m.raw);
  const w = r && +r[1];
  // The pair is the seconds each side (`30 seg … 30/30`) or splits the line's (`40 seg … 20/20`);
  // an equal pair that is neither (`1 min Farmer hold 24/24`) is a load printed without its unit.
  if (!r || !(m.dose.sec > 0) || m.rx?.male?.w !== w || m.rx?.female?.w !== w || (m.dose.sec !== w && m.dose.sec !== 2 * w)) return m;
  return { ...m, perSide: true, rx: null, dose: { ...m.dose, sec: 2 * w === m.dose.sec ? w : m.dose.sec } };
}

// `20 DB Reverse Lunge 10/10` read as 20 reps at a 10/10 load: the total, then the split, is per
// side. Only when the reps are twice the pair, no unit follows it and the line prints no other
// load (`95/65`, `24KG`); a 10/10 the model also read as the Rx is dropped with it.
export function withRepSides(m) {
  const r = /\b(\d+)\/\1\b(?![.,]\d)(?!\s*(?:(?:kg|lbs?|cal|mts?)\b|["”]))/i.exec(m.raw);
  const w = r && +r[1];
  if (!r || m.perSide || m.dose.reps !== 2 * w || /\d\s*(?:kg|lbs?)\b/i.test(m.raw)
    || [...m.raw.matchAll(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/g)].some(p => +p[1] !== +p[2])) return m;
  const asRx = m.rx?.male?.w === w && m.rx?.female?.w === w;
  return { ...m, perSide: true, ...(asRx ? { rx: null } : {}) };
}

// `M2 RX 2 Kips + 2 Hip to Bar + 1 BMU` / `SC 2 kips + 2 knee to chest + 1 pull up` read as six
// movements in one minute: the SC line is the scaled version, so each of its movements becomes the
// `alts` entry, with its own dose, of the Rx movement at the same position. Lines of different
// lengths stay as they are.
const RX_LINE = /^(?:M\d+\s+)?RX\b/i;
const SC_LINE = /^(?:M\d+\s+)?(?:SC|Scaled)\b/i;
export function withScaled(moves) {
  const lineAt = i => { let j = i; while (j < moves.length && moves[j].raw === moves[i].raw && moves[j].slot === moves[i].slot) j++; return moves.slice(i, j); };
  const out = [];
  for (let i = 0; i < moves.length;) {
    const rx = lineAt(i);
    const sc = i + rx.length < moves.length ? lineAt(i + rx.length) : [];
    if (RX_LINE.test(rx[0].raw) && SC_LINE.test(sc[0]?.raw || '') && sc.length === rx.length && sc[0].slot === rx[0].slot) {
      // The same movement and dose in both versions (kips → kips) is no alternative.
      const same = (m, s) => nameKey(m.rawName) === nameKey(s.rawName) && JSON.stringify([m.dose, m.doseFemale]) === JSON.stringify([s.dose, s.doseFemale]);
      rx.forEach((m, k) => out.push(same(m, sc[k]) ? m
        : { ...m, alts: [...m.alts, { exId: null, rawName: sc[k].rawName, dose: sc[k].dose, ...(sc[k].doseFemale ? { doseFemale: sc[k].doseFemale } : {}) }].slice(0, 5) }));
      i += rx.length * 2;
    } else { out.push(...rx); i += rx.length; }
  }
  return out;
}

// `EVERY 3x4`, `EVERY4x3`, `EVERY 1:30 x 8`, `EVERY 2 + :30 x 4`: the period in seconds (a bare
// number is minutes, `:30` seconds, parts added up) and the repeats, or null.
const EVERY_PART = String.raw`(?:\d{1,2}(?::\d{2})?|:\d{2})`;
const EVERY = new RegExp(String.raw`\bevery\s*(${EVERY_PART}(?:\s*\+\s*${EVERY_PART})*)\s*(?:min\s*)?x\s*(\d{1,3})\b`, 'i');
export function everyOf(text) {
  const r = EVERY.exec(text || '');
  if (!r) return null;
  const sec = r[1].split('+').reduce((s, p) => {
    const [m, ss] = p.trim().split(':');
    return s + (+m || 0) * 60 + (+ss || 0);
  }, 0);
  return { sec, times: +r[2] };
}
const PARTNER = /\bpar[tn]n?er\b/i;   // the box prints PARNER
// `3-4 RONDAS` as a heading (not `3-4 Rondas de 400 m Run`, which is that line's sets).
const ROUNDS_RANGE = /(?:^|[\s·])(\d{1,3})\s*-\s*(\d{1,3})\s+(?:rondas?|rounds?)\b(?!\s+(?:de|of)\s+\w)/i;
// A minute window with nothing in it but a rest (`MIN 7-8 TC 1` / `REST`) is not a block. The
// window is the text from its last `MIN a-b` line on, so an umbrella `WOD` / `AMRAP 42` above it
// does not count; with no window line it is the whole text. `REST REMAIN` is not a rest here.
// ponytail: the dropped window's minutes no longer count towards the session; keep them on the
// block before it if session time matters.
const WINDOW_BITS = /\b(?:min\s*\d+\s*-\s*\d+|tc\s*\d+|then)\b|·/gi;
function isRestWindow(text) {
  const lines = (text || '').split('\n');
  const from = Math.max(0, lines.findLastIndex(l => /\bmin\s*\d+\s*-\s*\d+/i.test(l)));
  const rest = lines.slice(from).join(' ').replace(WINDOW_BITS, ' ').replace(/\s+/g, ' ').trim();
  return REST_ONLY.test(rest);
}

function wodBlock(b, i, where, errors) {
  const at = `${where}.blocks[${i}]`;
  if (!b || typeof b !== 'object') { errors.push(`${at} must be an object`); return null; }
  if (!WOD_FORMATS.includes(b.format)) errors.push(`${at}.format must be one of ${WOD_FORMATS.join(', ')}`);
  if (b.capMin != null && (!isNum(b.capMin) || b.capMin < 0 || b.capMin > 600)) errors.push(`${at}.capMin must be minutes from 0 to 600, or null`);
  if (b.rounds != null && !isInt(b.rounds, 0, 100)) errors.push(`${at}.rounds must be a whole number from 0 to 100, or null`);
  if (b.everySec != null && !isInt(b.everySec, 10, 3600)) errors.push(`${at}.everySec must be whole seconds from 10 to 3600, or null`);
  if (b.roundsMax != null && !(isInt(b.rounds, 0, 100) && isInt(b.roundsMax, b.rounds, 100))) errors.push(`${at}.roundsMax must be a whole number from rounds to 100 (and rounds set), or null`);
  if (!Array.isArray(b.movements)) { errors.push(`${at}.movements must be an array`); return null; }
  if (b.movements.length > MAX_WOD_MOVES) errors.push(`${at} has ${b.movements.length} movements — at most ${MAX_WOD_MOVES}`);
  const label = clampStr(isStr(b.label) ? b.label.trim() : '', 80);
  const raw = clampStr(isStr(b.raw) ? b.raw.trim() : '', 1000);
  let { format, capMin = null, rounds = null, everySec = null, roundsMax = null } = b;
  // The model can leave the structure in the text only; what the heading prints is read back here.
  // ponytail: in a partner WOD (`PARNER A WORK / PARNER B REST`) the repeats are shared and each
  // line is a team total, so rounds is left as the model gave it (null logs one set per line, which
  // undercounts an `EVERY4x3` team block); model the partners to log each one's share.
  const every = everySec == null ? everyOf(label) || everyOf(raw) : null;
  const partner = PARTNER.test(label) || PARTNER.test(raw);
  if (every && isInt(every.sec, 10, 3600) && isInt(every.times, 1, 100) && (partner || rounds == null || rounds === every.times)) {
    everySec = every.sec;
    if (!partner) rounds = every.times;
  }
  if (everySec != null && rounds != null && capMin == null && everySec * rounds <= 600 * 60) capMin = Math.round(everySec * rounds / 6) / 10;
  // An EMOM logs by the minute; an EVERY of anything but a minute (`AMRAP 12 / EVERY 3x4` read as
  // an EMOM) logs by the repeat.
  if (everySec != null && (format === 'other' || (format === 'emom' && everySec !== 60))) format = 'interval';
  const range = rounds == null && roundsMax == null ? ROUNDS_RANGE.exec(label) || ROUNDS_RANGE.exec(raw) : null;
  if (range && +range[1] >= 1 && +range[1] < +range[2] && +range[2] <= 100) { rounds = +range[1]; roundsMax = +range[2]; }
  return {
    label,
    warmup: b.warmup === true,
    format,
    capMin,
    rounds,
    everySec,
    roundsMax,
    scheme: strOrNull(b.scheme, 60),
    benchmark: strOrNull(b.benchmark, 40),
    raw,
    movements: withSteps(withScaled(withoutRests(b.movements.slice(0, MAX_WOD_MOVES).map((m, j) => wodMovement(m, j, at, errors)).filter(Boolean))
      .map(m => withRepSides(withTimedSides(withTarget(m))))), format === 'emom', capMin, rounds)
  };
}
const restWindowBlock = b => !b.warmup && !b.movements.length && (isRestWindow(b.raw) || isRestWindow(b.label));

export function validateWod(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fail(['the answer was not an object']);
  if (!Array.isArray(data.tracks)) return fail(['tracks must be an array — use [] when the image holds no workout']);
  const errors = [];
  if (data.tracks.length > MAX_WOD_TRACKS) errors.push(`${data.tracks.length} tracks — at most ${MAX_WOD_TRACKS}`);
  const seen = new Set();
  const tracks = data.tracks.slice(0, MAX_WOD_TRACKS).map((tr, i) => {
    const at = `tracks[${i}]`;
    if (!tr || typeof tr !== 'object') { errors.push(`${at} must be an object`); return null; }
    if (!['main', 'extra'].includes(tr.kind)) errors.push(`${at}.kind must be "main" or "extra"`);
    if (!Array.isArray(tr.blocks)) { errors.push(`${at}.blocks must be an array`); return null; }
    if (tr.blocks.length > MAX_WOD_BLOCKS) errors.push(`${at} has ${tr.blocks.length} blocks — at most ${MAX_WOD_BLOCKS}`);
    const want = isStr(tr.id) ? tr.id.trim().toLowerCase() : '';
    let id = TRACK_ID.test(want) && !seen.has(want) ? want : 't' + i;
    // The fallback can be taken already — a model may name a track `t1` itself.
    for (let n = i + 1; seen.has(id); n++) id = 't' + n;
    seen.add(id);
    return {
      id,
      label: clampStr(isStr(tr.label) ? tr.label.trim() : '', 80),
      kind: tr.kind,
      // Ids after the rest windows are gone, so they stay b0, b1… with no gap.
      blocks: tr.blocks.slice(0, MAX_WOD_BLOCKS).map((b, j) => wodBlock(b, j, at, errors)).filter(b => b && !restWindowBlock(b))
        .map((b, j) => ({ id: 'b' + j, ...b }))
    };
  }).filter(Boolean);
  if (errors.length) return fail(errors);
  return { ok: true, proposal: { program: { title: strOrNull(data.title, 120), tracks } } };
}

/* =============================== the workout in progress =============================== */

// What the Coach may do to the unfinished part of today's session (the `adapt` job). Its own
// closed list, applied by frontend/src/lib/coach-adapt.js one handler per type. None of them can
// reach a set already logged, the routine behind the session, or anything outside it.
export const ADAPT_TYPES = ['swap', 'sets', 'reps', 'weight', 'add', 'skip', 'move', 'rest'];
export const MAX_ADAPT_CHANGES = 6;
const ADAPT_ON_ENTRY = ['swap', 'sets', 'reps', 'weight', 'skip', 'move', 'rest'];

const isWarmRow = s => s && s.warmup === true;
const openWork = en => (en?.sets || []).filter(s => !isWarmRow(s) && !s.done);
const doneWork = en => (en?.sets || []).filter(s => !isWarmRow(s) && s.done);

/**
 * Validate the answer to "Ask the Coach" on an exercise mid-workout against the session it was
 * asked about (`today`, the payload's own copy, each entry with its index `i`).
 * Returns { ok, nochange?, reading?, proposal:{ summary, changes } } | { ok:false, errors }.
 */
export function validateAdapt(data, today, ctx = {}) {
  if (!data || typeof data !== 'object') return fail(['the answer was not an object']);
  if (data.nochange) return { ok: true, nochange: true, reading: clampStr(data.reading || data.summary || '', 600) };
  const entries = Array.isArray(today?.entries) ? today.entries : [];
  if (!entries.length) return fail(['there is no workout running to change']);
  const list = Array.isArray(data.changes) ? data.changes : null;
  if (!list) return fail(['changes must be an array (or set "nochange": true with a "reading")']);
  if (!isStr(data.summary)) return fail(['summary is required: one or two sentences on what you suggest and why']);
  const known = new Set(ctx.customIds || []);
  const knownEx = id => libraryHas(id) || known.has(id);
  const inSession = new Set(entries.map(en => en.id));
  const errors = [];
  const changes = [];
  const touched = new Set();
  list.slice(0, MAX_ADAPT_CHANGES).forEach((c, k) => {
    const where = `changes[${k}]`;
    if (!c || typeof c !== 'object') { errors.push(`${where} is not an object`); return; }
    if (!ADAPT_TYPES.includes(c.type)) { errors.push(`${where}.type "${c.type}" is not allowed — use one of: ${ADAPT_TYPES.join(', ')}`); return; }
    if (!isStr(c.why)) { errors.push(`${where}.why is required — say in plain words why this helps today`); return; }
    const out = { id: 'a' + k, type: c.type, why: clampStr(c.why, 400) };
    let en = null;
    if (ADAPT_ON_ENTRY.includes(c.type)) {
      if (!isInt(c.entry, 0, entries.length - 1)) { errors.push(`${where}.entry must be the index "i" of an exercise in today.entries`); return; }
      en = entries[c.entry];
      if (isStr(c.exId) && c.exId !== en.id) { errors.push(`${where}.exId "${c.exId}" is not today.entries[${c.entry}] — that one is "${en.id}"`); return; }
      if (!openWork(en).length) { errors.push(`${where} changes today.entries[${c.entry}], whose sets are all logged — logged sets are never changed`); return; }
      if (touched.has(c.entry)) { errors.push(`${where} is a second change to today.entries[${c.entry}] — one change per exercise`); return; }
      touched.add(c.entry);
      out.entry = c.entry; out.exId = en.id; out.name = libraryName(en.id);
    }
    // Flat fields rather than one `after` of many shapes: a provider that enforces a strict
    // schema (every object closed) can still write each of them (#804).
    const repsMode = en ? (en.sets || []).some(s => s.r != null) : true;
    switch (c.type) {
      case 'swap': {
        if (!isStr(c.to) || !knownEx(c.to)) { errors.push(`${where}.to must be an exercise id from the library provided in the payload`); return; }
        if (c.to === en.id) { errors.push(`${where} swaps an exercise for itself`); return; }
        if (inSession.has(c.to)) { errors.push(`${where}.to "${c.to}" is already in today's session — pick another`); return; }
        if (offEquipment(ctx, c.to)) { errors.push(OFF_EQUIPMENT(`${where}.to`, c.to)); return; }
        out.to = c.to; out.toName = libraryName(c.to);
        if (isInt(c.reps, 1, 100)) out.reps = c.reps;
        if (isNum(c.weight) && c.weight >= 0 && c.weight <= MAX_WEIGHT) out.weight = c.weight;
        inSession.add(c.to);
        break;
      }
      case 'sets': {
        const left = openWork(en).length;
        if (!isInt(c.sets, 0, 10)) { errors.push(`${where}.sets must be how many sets are left to do, 0-10`); return; }
        if (c.sets === left) { errors.push(`${where}.sets is the number of sets already left — that is no change`); return; }
        out.sets = c.sets; out.before = left;
        break;
      }
      case 'reps':
        if (!repsMode) { errors.push(`${where} sets reps on an exercise that is not done in reps`); return; }
        if (!isInt(c.reps, 1, 100)) { errors.push(`${where}.reps must be a whole number of reps (1-100)`); return; }
        out.reps = c.reps;
        break;
      case 'weight': {
        const pct = isNum(c.pct) ? Math.round(c.pct) : NaN;
        if (!(pct >= -50 && pct <= 10) || pct === 0) { errors.push(`${where}.pct must change the weight of the open sets by -50 to +10 percent`); return; }
        if (!openWork(en).some(x => (x.w || 0) > 0)) { errors.push(`${where} changes the weight of sets that carry none`); return; }
        out.pct = pct;
        break;
      }
      case 'add': {
        if (!isStr(c.to) || !knownEx(c.to)) { errors.push(`${where}.to must be an exercise id from the library provided in the payload`); return; }
        if (inSession.has(c.to)) { errors.push(`${where}.to "${c.to}" is already in today's session`); return; }
        if (offEquipment(ctx, c.to)) { errors.push(OFF_EQUIPMENT(`${where}.to`, c.to)); return; }
        if (c.entry != null && !isInt(c.entry, 0, entries.length - 1)) { errors.push(`${where}.entry, when given, is the index of the exercise the new one follows`); return; }
        out.to = c.to; out.toName = libraryName(c.to);
        out.sets = isInt(c.sets, 1, 6) ? c.sets : 3;
        if (isInt(c.sec, 5, 600)) out.sec = c.sec; else out.reps = isInt(c.reps, 1, 50) ? c.reps : 10;
        if (isNum(c.weight) && c.weight > 0 && c.weight <= MAX_WEIGHT) out.weight = c.weight;
        if (isInt(c.entry, 0, entries.length - 1)) out.entry = c.entry;
        inSession.add(c.to);
        break;
      }
      case 'skip':
        break;
      case 'move':
        if (c.place !== 'next' && c.place !== 'last') { errors.push(`${where}.place must be "next" (do it now) or "last" (do it at the end)`); return; }
        if (doneWork(en).length) { errors.push(`${where} moves an exercise that is already under way — only one not started can move`); return; }
        out.place = c.place;
        break;
      case 'rest':
        if (!isInt(c.rest, 0, 600)) { errors.push(`${where}.rest must be the rest in seconds, 0-600`); return; }
        out.rest = c.rest;
        break;
    }
    changes.push(out);
  });
  if (errors.length) return fail(errors);
  if (!changes.length) return { ok: true, nochange: true, reading: clampStr(data.summary || data.reading || '', 600) };
  return { ok: true, proposal: { summary: clampStr(data.summary, 600), changes } };
}
