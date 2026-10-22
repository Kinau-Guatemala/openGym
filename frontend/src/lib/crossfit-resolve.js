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
import { CATALOGUE, scoredSearch } from './exercises.js'
import { SHIPPED_ALIASES } from './crossfit-aliases.js'

// "crunches" → "crunch", "presses" → "press", "boxes" → "box"; "cleans" → "clean", "lunges" → "lunge".
// The result never ends in a single s, so norm(norm(x)) === norm(x). ("zz", not "z": "sizes" is "size".)
const singular = w => (/(?:ch|sh|x|zz|ss)es$/.test(w) ? w.slice(0, -2)
  : w.length >= 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)

export const norm = text => String(text || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/[´'’`]\s*s\b/g, '').replace(/[´'’`]/g, '')
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ').trim()
  .split(' ').map(singular).join(' ')

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

// { rawName, name } → { exId, via }: the user's own pick for this name, else the shipped table,
// else a clear catalogue search hit on the English name (or the rawName when there is none),
// else { exId: null, via: null }, which the review screen shows as "pick exercise".
// userAliases is S.exAliases: { [norm(rawName)]: { exId, _ts } }, a removed pick being { _ts }.
export function resolveMovement({ rawName, name } = {}, userAliases = {}) {
  const key = norm(rawName)
  const user = key && userAliases?.[key]?.exId
  if (user) return { exId: user, via: 'user' }
  if (key && Object.hasOwn(SHIPPED_ALIASES, key)) return { exId: SHIPPED_ALIASES[key], via: 'shipped' }
  // "pull-up" as two words, the way the search reads the catalogue's names
  const query = String(name || '').replace(/[-‐]/g, ' ').trim() || key
  const top = query && scoredSearch(CATALOGUE, query)[0]
  if (top && clearHit(top.score, query.split(/\s+/).length)) return { exId: top.e.id, via: 'search' }
  return { exId: null, via: null }
}
