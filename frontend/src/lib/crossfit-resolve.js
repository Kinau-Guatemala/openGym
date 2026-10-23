// Movement names as the box writes them ("5 Hang Cleans 185/135", "12-15 DB´s Skull cruches",
// "15 T2B") resolved to catalogue exercise ids.
//
// rawName: what is left of one movement's printed text once its dose and load are gone. The
// parser (coach job parse-wod) splits a line into movements first: "12 DL + Max Squat Cleans" is
// two movements (each side has its own dose), "DB´s Lateral + Front Fly" is one, "Row/Ski/Bike"
// is one movement with alternatives, "M1"/"R1" is the slot. Then, per movement:
//   - drop a leading slot label ("M1 ", "R3 ");
//   - drop the leading dose, repeatedly: a number, range or pair ("12", "12-15", "20/15",
//     "1x1000") with an optional unit (cal, m, mts, k, km, seg, sec, min, set), or "max";
//   - drop the trailing load and distance, repeatedly: numbers and x/y pairs with an optional unit
//     ("185/135", "24KG/16KG", "12/12", "Run 1.6K", "Ski800"), the partner split "/ 2", the
//     side or pacing marker (R, L, ALT, UNBROKEN), "Parner A";
//   - drop "sincro" anywhere;
//   - lowercase and collapse spaces. Everything else stays as printed, typos and ´s included
//     ("db´s skull cruches", "pull ups estrictos", "easy row").
// rawNameOf below is that rule; crossfit-resolve.test.js holds it to every line of the samples.
//
// The alias key is norm(rawName): no accents, no ´s/'s, punctuation to spaces, & as "and", and
// each word in the singular, so "DB´s Hang Cleans" and "db hang clean" are the same key.
import { CATALOGUE, editDistance, scoredSearch, scoredSimilar } from './exercises.js'
import { SHIPPED_ALIASES } from './crossfit-aliases.js'

// "crunches" → "crunch", "presses" → "press", "boxes" → "box"; "cleans" → "clean", "lunges" → "lunge".
// The result never ends in a single s, so norm(norm(x)) === norm(x). ("zz", not "z": "sizes" is "size".)
const singular = w => (/(?:ch|sh|x|zz|ss)es$/.test(w) ? w.slice(0, -2)
  : w.length >= 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)

// norm without the singular: the guess below compares "skull cruches" with "skull crusher" too.
const plain = text => String(text || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/[´'’`]\s*s\b/g, '').replace(/[´'’`]/g, '')
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ').trim()

export const norm = text => plain(text).split(' ').map(singular).join(' ')

const LEAD = /^(?:[mr]\d+\s+|\d[\d.,/x-]*\s*(?:km|k|mts|mt|m|cal|seg|sec|min|sets?)(?![a-z])|\d[\d.,/x-]*|(?:max|mts|cal)(?![a-z]))\s*/i
const TRAIL = /(?:\s+(?:r|l|alt|unbroken)|\s+parner\s+[a-c]|(?:\s*\/?\s*\d[\d.]*\s*(?:kg|lbs?|km|k|mts|m)?)+)\s*$/i

export function rawNameOf(raw) {
  let s = String(raw || '').replace(/\bsincro\b/gi, ' ').trim()
  for (let prev; prev !== s;) { prev = s; s = s.replace(LEAD, '') }
  for (let prev; prev !== s;) { prev = s; s = s.replace(TRAIL, '') }
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

// A search hit counts on its own only when it is the exercise of that very name: each query word a
// whole word of the name (100 each, see tokenScore in exercises.js) plus the whole-name bonus
// (50, 40 with a typo). "russian twist" is taken; "hang clean" (kettlebell, barbell or dumbbell?),
// "kb goblet lunge" (only a curtsey lunge has those words) and "machine" are left to a pick.
const clearHit = (score, words) => score >= 100 * words + 40

// { rawName, name } → { exId, via, candidates }: the user's own pick for this name, else the shipped
// table, else a clear catalogue search hit on the English name (or the rawName when there is none).
// Those are certain and come with no candidates. Failing all three, the best guess (guessMovement):
// `via: 'guess'` and its exId when one exercise clearly fits, else `exId: null, via: null`, which
// the review screen shows as "choose", with the ranked candidates as suggestions either way.
// userAliases is S.exAliases: { [norm(rawName)]: { exId, _ts } }, a removed pick being { _ts }.
export function resolveMovement({ rawName, name } = {}, userAliases = {}) {
  const key = norm(rawName)
  const user = key && userAliases?.[key]?.exId
  if (user) return { exId: user, via: 'user', candidates: [] }
  if (key && Object.hasOwn(SHIPPED_ALIASES, key)) return { exId: SHIPPED_ALIASES[key], via: 'shipped', candidates: [] }
  // "pull-up" as two words, the way the search reads the catalogue's names
  const query = String(name || '').replace(/[-‐]/g, ' ').trim() || key
  const top = query && scoredSearch(CATALOGUE, query)[0]
  if (top && clearHit(top.score, query.split(/\s+/).length)) return { exId: top.e.id, via: 'search', candidates: [] }
  return guessMovement({ rawName, name })
}

/* ---------------------------- the best guess ---------------------------- */
//
// The box misspells ("Skull cruches", "wal balls", "kettelbell swing"). The catalogue search finds
// the likely exercises (typo-tolerant, gym shorthand, and its "similar" list for a word it cannot
// place), but its scores do not say how sure a hit is: "kb goblet lunges" finds "kettlebell goblet
// curtsey lunge" as strongly as "wal balls" finds "wall ball". So each candidate is scored again,
// 0 to 1, by how close its name is to what was printed, letter by letter with the spaces left out
// (1 - edit distance / length): "walball" is one letter from "wallball", "kettlebellgobletlunge"
// seven from "kettlebellgobletcurtseylunge", "airsquat" none from "air squat".
//   - The name is compared with and without its equipment word, and matching only without it costs
//     ASSUMED_EQUIP when nothing printed says so ("russian twsit" is the russian twist before the
//     dumbbell one; "hang clean" stays a three-way tie, as in the exact tier).
//   - A printed DB/KB/BB that the candidate's equipment contradicts costs EQUIP_COST.
//
// ponytail: thresholds calibrated by hand on the 18 sample programs (crossfit-resolve.test.js):
// every line that resolved before still does, the 19 names left to a pick stay there, and the
// misspelling fixture lands where it should. Retune them there if a real program guesses wrong.
export const GUESS_MIN = 0.82     // the top candidate's fit, at least
export const GUESS_MARGIN = 0.15  // and this far ahead of the runner-up
const ASSUMED_EQUIP = 0.2       // > 1 - GUESS_MIN: an unprinted equipment word alone is never a guess
const EQUIP_COST = 0.3
const MAX_CANDIDATES = 3

const PRINTED_EQUIP = { db: 'dumbbell', dumbbell: 'dumbbell', kb: 'kettlebell', kettlebell: 'kettlebell', bb: 'barbell', barbell: 'barbell' }

// A text spelled both ways (as printed and in the singular), words run together.
const spellings = words => [...new Set([words.join(''), words.map(singular).join('')])]
const similarity = (a, b) => { const n = Math.max(a.length, b.length); return n ? 1 - editDistance(a, b, n) / n : 0 }

function fitOf(printed, e, printedEquip) {
  const names = plain(e.n).split(' ')
  const equipment = new Set([...plain(e.eq).split(' '), 'bodyweight'])
  const bare = names.filter(w => !equipment.has(w))
  const assumed = !printedEquip && bare.length < names.length && e.eq !== 'body weight' ? ASSUMED_EQUIP : 0
  let best = 0
  for (const p of printed) {
    for (const n of spellings(names)) best = Math.max(best, similarity(p, n))
    if (bare.length) for (const n of spellings(bare)) best = Math.max(best, similarity(p, n) - assumed)
  }
  return best
}

/** The guess tier alone: what resolveMovement falls back to when nothing matched exactly. */
export function guessMovement({ rawName, name } = {}) {
  const key = norm(rawName)
  const queries = [...new Set([plain(name), plain(rawName)].filter(Boolean))]
  const want = PRINTED_EQUIP[key.split(' ')[0]]
  const fits = new Map()
  for (const q of queries) {
    const printed = spellings(q.split(' ').map(w => PRINTED_EQUIP[w] || w))
    // In the search's own order, so equally fitting candidates keep its ranking (barbell first).
    const found = [...scoredSearch(CATALOGUE, q).slice(0, 15), ...scoredSimilar(CATALOGUE, q).slice(0, 15)]
    for (const { e } of found) {
      const fit = fitOf(printed, e, want) - (want && !e.eq.includes(want) ? EQUIP_COST : 0)
      if (fit > 0 && fit > (fits.get(e.id) ?? 0)) fits.set(e.id, fit)
    }
  }
  const candidates = [...fits].map(([exId, fit]) => ({ exId, score: Math.round(fit * 100) / 100 }))
    .sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES)
  const [top, next] = candidates
  const sure = top && top.score >= GUESS_MIN && top.score - (next?.score ?? 0) >= GUESS_MARGIN
  return sure ? { exId: top.exId, via: 'guess', candidates } : { exId: null, via: null, candidates }
}
