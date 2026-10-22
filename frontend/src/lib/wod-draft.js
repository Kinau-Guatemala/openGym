// The program editor's working copy (views/CrossFitEdit.jsx): a posted program — parsed from an
// image (coach job parse-wod) or typed in — readied for review, plus the rules the screen and the
// logger (T08) share about which blocks count.
import { norm, rawNameOf, resolveMovement } from './crossfit-resolve.js'

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

// A movement (or an alternative) without an exercise gets one from the user's picks, the shipped
// table or a clear catalogue hit; one already resolved keeps it.
const resolved = (m, aliases) => (m.exId ? m : { ...m, exId: resolveMovement(m, aliases).exId })

/** `program` (or nothing, for a hand-entered one) as an editable draft: ids filled, exercises resolved. */
export function prepareDraft(program, userAliases = {}) {
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
        movements: withIds(b.movements, 'm').map(m => ({
          ...resolved(m, userAliases),
          alts: list(m.alts).filter(isMap).map(a => resolved(a, userAliases)),
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
export const movementFromText = (raw, id, userAliases = {}) => {
  const rawName = rawNameOf(raw)
  return { id, raw, rawName, exId: resolveMovement({ rawName }, userAliases).exId, dose: {}, perSide: false, rx: null, alts: [] }
}

/** `draft` with every movement and alternative printed as `key` (already norm()-ed) set to `exId`. */
export function applyPick(draft, key, exId) {
  const pick = m => (norm(m.rawName) === key ? { ...m, exId } : m)
  return {
    ...draft,
    tracks: list(draft?.tracks).map(tr => ({
      ...tr,
      blocks: list(tr.blocks).map(b => ({
        ...b,
        movements: list(b.movements).map(m => ({ ...pick(m), alts: list(m.alts).map(pick) })),
      })),
    })),
  }
}
