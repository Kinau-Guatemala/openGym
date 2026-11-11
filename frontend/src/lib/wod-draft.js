// The program editor's working copy (views/CrossFitEdit.jsx): a posted program — parsed from an
// image (coach job parse-wod) or typed in — readied for review, plus the rules the screen and the
// logger (T08) share about which blocks count.
import { norm, rawNameOf, resolveMovement, splitMovement } from './crossfit-resolve.js'
import { mergedAway, mergedInto } from './exercise-merge.js'

const list = v => (Array.isArray(v) ? v : [])
const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v)

/** The first `<prefix><n>` no item in `items` uses as its id. */
export function nextId(items, prefix) {
  const used = new Set(list(items).map(x => x?.id))
  let n = 0
  while (used.has(prefix + n)) n++
  return prefix + n
}

// Every item gets an id unique among its siblings: validateWod assigns them, a hand-built or
// older program may not have them, and the logger keys blocks on `<track>/<block>`.
const withIds = (items, prefix) => {
  const out = []
  for (const x of list(items).filter(isMap)) {
    const id = x.id && !out.some(o => o.id === x.id) ? x.id : nextId(out.concat(list(items)), prefix)
    out.push({ ...x, id })
  }
  return out
}

// A movement's guess and suggestions, gone once its exercise is certain (a pick).
const settled = ({ via, candidates, ...m }) => m

/**
 * `m` (a movement or an alternative) resolved afresh (lib/crossfit-resolve.js): its exercise, and
 * while that is only a best guess or still to choose, `via` ('guess' or null) and the ranked
 * `candidates` the editor offers. A certain exercise carries neither.
 */
export function resolveInto(m, userAliases = {}, S) {
  const r = resolveMovement(m, userAliases, S)
  return { ...settled(m), exId: r.exId, ...(r.candidates.length ? { via: r.via, candidates: r.candidates } : {}) }
}

// One already resolved keeps its exercise; one without, or with only a guess, is resolved again,
// so a pick made since (here or on another device) settles it. One merged away since reads as its
// target (S.exMerged, see liveWod).
// ponytail: saving the draft stores that target, so a day saved while the merge stood keeps it
// after an Undo (views/CrossFit.jsx boxCopy, filling a box movement, is the same). Only that day,
// on an explicit save, as the screen showed it; keep the saved id instead if an Undo must reach it.
const resolved = (m, aliases, S) => (m.exId && m.via !== 'guess' ? { ...m, exId: mergedInto(S, m.exId) } : resolveInto(m, aliases, S))

/**
 * `program` (or nothing, for a hand-entered one) as an editable draft: ids filled, exercises
 * resolved. `S` is read for exercises merged away (resolveMovement).
 */
export function prepareDraft(program, userAliases = {}, S) {
  const p = isMap(program) ? program : {}
  const { _ts, ...rest } = p
  return {
    ...rest,
    title: typeof p.title === 'string' ? p.title : '',
    tracks: withIds(p.tracks, 't').map(tr => ({
      ...tr,
      kind: tr.kind === 'extra' ? 'extra' : 'main',
      blocks: withIds(tr.blocks, 'b').map(b => ({
        ...b,
        // A line that joins two movements is those two (splitMovement), here, where every
        // program meets the catalogue and the user's picks before review.
        movements: withIds(b.movements, 'm').flatMap(m => splitMovement(m, userAliases, S) || [m]).map(m => ({
          ...resolved(m, userAliases, S),
          alts: list(m.alts).filter(isMap).map(a => resolved(a, userAliases, S)),
        })),
      })),
    })),
  }
}

/**
 * Whether a block counts as work done. The include toggle wins once set; until then a warm-up
 * counts only outside a main track (Holy Conditioning's "WARM UP / AMRAP 40" is the workout),
 * unless Settings → CrossFit says warm-ups count everywhere (S.wodWarmup).
 */
export function includeOf(track, block, S) {
  if (typeof block?.include === 'boolean') return block.include
  return !(block?.warmup && track?.kind !== 'extra' && !S?.wodWarmup)
}

/** A movement typed by hand: its alias key comes off the text the way the parser's would. */
export const movementFromText = (raw, id, userAliases = {}, S) => {
  const rawName = rawNameOf(raw)
  return { id, raw, rawName, ...resolveInto({ rawName }, userAliases, S), dose: {}, perSide: false, rx: null, alts: [] }
}

/**
 * `draft` with every movement and alternative printed as `key` (already norm()-ed) set to `exId`,
 * their guesses and suggestions settled: what a pick, or confirming a guess, does.
 */
export function applyPick(draft, key, exId) {
  return eachMove(draft, m => (norm(m.rawName) === key ? { ...settled(m), exId } : m))
}

// `program` with `fn` applied to every movement and alternative.
const eachMove = (program, fn) => ({
  ...program,
  tracks: list(program?.tracks).map(tr => ({
    ...tr,
    blocks: list(tr?.blocks).map(b => ({
      ...b,
      movements: list(b?.movements).map(m => ({ ...fn(m), alts: list(m?.alts).map(fn) })),
    })),
  })),
})

/**
 * A saved program as it reads now: a movement or alternative whose exercise was merged away
 * (upstream's Merge into…, S.exMerged) names the exercise it went to, so the log screen shows and
 * files it there. Read only, never saved back (S.wods keeps the id it was saved with), so an Undo
 * of the merge brings the original back. `program` itself when nothing was merged.
 */
export function liveWod(S, program) {
  if (!isMap(program) || !mergedAway(S)) return program
  return eachMove(program, m => (isMap(m) && m.exId ? { ...m, exId: mergedInto(S, m.exId) } : m))
}
