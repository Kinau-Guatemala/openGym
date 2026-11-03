// The box feed, member side (T32): the programs a box publishes as feed.json (T31), read on this
// phone. The feed's address is a setting (S.boxFeed, synced like any other); what it last held is
// cached on this device only (localStorage), never in S, so it works offline and never rides along
// in a sync push.
//
//   feed.json = { v: 1, box: 'Holy Program', updatedAt, programs: [{ date, title, tracks }] }
//
// The feed is somebody else's file on the internet: it is read as untrusted input. Only https,
// a size cap, `v: 1`, and every program through validateWod, the same gate a program read off an
// image passes (api/coach/core/validate.js). A program that fails it is dropped, the rest stay.
// validateWod clears exercise ids, since a parsed program names none; the feed's are the
// publisher's picks, so a feed id that is a catalogue exercise is put back, any other is not.
import { validateWod } from '../../../api/coach/core/validate.js'
import { EXIDX, canonicalExId } from './exercises.js'

export const FEED_VERSION = 1
export const REFRESH_MS = 10 * 60 * 1000
export const MAX_FEED_BYTES = 512 * 1024
const MAX_PROGRAMS = 120
const TIMEOUT_MS = 15000
const CACHE_KEY = 'gym_box_feed_v1'
const ISO = /^\d{4}-\d{2}-\d{2}$/
// A real day: 2026-02-31 matches the pattern, and Date.parse rolls it over to March.
const isDay = d => ISO.test(d) && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d

const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v)
const list = v => (Array.isArray(v) ? v : [])

// T31's lib/box-feed.js feedProgram (its allowlist) runs first once it is merged; until then the
// shape check below stands in, and validateWod is the allowlist that counts.
const feedProgram = p => (isMap(p) && Array.isArray(p.tracks) ? p : null)

/** `text` as an https URL to fetch, or null: anything else, or one carrying a user name or password. */
export function httpsUrl(text) {
  let u
  try { u = new URL(String(text || '').trim()) } catch { return null }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname) return null
  return u.href
}

const catalogueId = id => {
  if (typeof id !== 'string') return null
  const c = canonicalExId(id)
  return Object.hasOwn(EXIDX, c) ? c : null
}

// The feed's exercise ids, back on what validateWod kept. A rest window it drops leaves the other
// blocks in order, matched here by their label and printed text. A movement's id is `m<i>`, its
// index in the feed's block (rests dropped and merged lines keep the first one's); its alts are the
// feed's with a rawName, in order.
const sameText = (v, s, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '') === s
function withExIds(clean, raw) {
  clean.tracks.forEach((tr, ti) => {
    const rawBlocks = list(raw.tracks[ti]?.blocks)
    let at = 0
    for (const b of tr.blocks) {
      while (at < rawBlocks.length && !(sameText(rawBlocks[at].label, b.label, 80) && sameText(rawBlocks[at].raw, b.raw, 1000))) at++
      const rawB = rawBlocks[at++]
      if (!rawB) return
      for (const m of b.movements) {
        const rm = list(rawB.movements)[Number(m.id.slice(1))]
        if (!isMap(rm)) continue
        m.exId = catalogueId(rm.exId)
        const ralts = list(rm.alts).filter(a => a && typeof a.rawName === 'string' && a.rawName.trim())
        m.alts.forEach((a, i) => { a.exId = catalogueId(ralts[i]?.exId) })
      }
    }
  })
  return clean
}

/** One feed program as a program the app can show and copy, or null when it fails a check. */
export function cleanProgram(p) {
  const fed = feedProgram(p)
  // validateWod skips a track that is not an object, which would shift the tracks after it.
  if (!fed || fed.tracks.some(tr => !isMap(tr))) return null
  const r = validateWod({ title: fed.title, tracks: fed.tracks })
  if (!r.ok) return null
  const program = r.proposal.program
  if (!program.tracks.some(tr => tr.blocks.some(b => b.movements.length))) return null
  return { ...withExIds(program, fed), title: program.title || '' }
}

/**
 * A fetched feed, parsed and checked: `{ box, updatedAt, programs: { [date]: program } }`, or null
 * when it is not a v1 box feed. Programs that fail are left out; a date given twice keeps the first.
 */
export function parseFeed(json) {
  if (!isMap(json) || json.v !== FEED_VERSION) return null
  if (typeof json.box !== 'string' || !json.box.trim() || !Array.isArray(json.programs)) return null
  const programs = {}
  for (const p of json.programs.slice(0, MAX_PROGRAMS)) {
    if (!isMap(p) || typeof p.date !== 'string' || !isDay(p.date) || programs[p.date]) continue
    const clean = cleanProgram(p)
    if (clean) programs[p.date] = clean
  }
  const at = typeof json.updatedAt === 'number' ? json.updatedAt : Date.parse(json.updatedAt)
  return { box: json.box.trim().slice(0, 60), updatedAt: Number.isFinite(at) ? at : null, programs }
}

/**
 * The feed at `url`, fetched and parsed: `{ feed }`, or `{ error }` — 'https' (not an https
 * address, or redirected off one), 'network' (unreachable, an HTTP error, too big) or 'invalid'.
 */
export async function fetchFeed(url, fetchImpl = globalThis.fetch) {
  const href = httpsUrl(url)
  if (!href) return { error: 'https' }
  const ctl = typeof AbortController === 'function' ? new AbortController() : null
  const timer = ctl && setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const res = await fetchImpl(href, { cache: 'no-store', credentials: 'omit', signal: ctl?.signal })
    // The app allows mixed content: a redirect to http must not be followed into the app.
    if (res.url && !httpsUrl(res.url)) return { error: 'https' }
    if (!res.ok) return { error: 'network' }
    if (Number(res.headers?.get?.('content-length')) > MAX_FEED_BYTES) return { error: 'network' }
    const text = await res.text()
    if (text.length > MAX_FEED_BYTES) return { error: 'network' }
    let json
    try { json = JSON.parse(text) } catch { return { error: 'invalid' } }
    const feed = parseFeed(json)
    return feed ? { feed } : { error: 'invalid' }
  } catch {
    return { error: 'network' }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/* ---------- the device's copy ---------- */

// { url, at, feed }: the last good feed of `url`, fetched at `at`.
let cache
const listeners = new Set()
const read = () => {
  if (cache === undefined) {
    try { cache = JSON.parse(localStorage.getItem(CACHE_KEY)) } catch { cache = null }
    if (!isMap(cache) || !isMap(cache.feed) || !isMap(cache.feed.programs)) cache = null
  }
  return cache
}
const write = next => {
  cache = next
  try { if (next) localStorage.setItem(CACHE_KEY, JSON.stringify(next)); else localStorage.removeItem(CACHE_KEY) } catch { /* memory still has it */ }
  for (const fn of listeners) fn()
}

export const subscribeBoxFeed = fn => { listeners.add(fn); return () => listeners.delete(fn) }
/** The cached feed of `url`, or null: none yet, or one cached for another address. */
export const cachedFeed = url => { const c = read(); return c && url && c.url === url ? c.feed : null }
/** When the cached feed of `url` was fetched, or null. */
export const cachedAt = url => { const c = read(); return c && url && c.url === url ? c.at : null }

/** `feed` kept as `url`'s, fetched `now` (subscribing hands over the one it checked). */
export const keepFeed = (url, feed, now = Date.now()) => write({ url, at: now, feed })
/** The cache gone (unsubscribing). */
export const clearBoxFeed = () => { tried = {}; write(null) }
/** The cache gone when it is not `url`'s: unsubscribed, or switched, on another device. */
export const forgetOtherFeeds = url => { const c = read(); if (c && c.url !== url) clearBoxFeed() }

// The last attempt per address, good or not, so a feed that is down is not asked every screen.
let tried = {}
/**
 * The feed of `url` fetched again when the last attempt is REFRESH_MS old (or `force`), and cached
 * when good. A failed fetch keeps the cached copy. Resolves to the fetch's result, or null when
 * skipped.
 */
export async function refreshBoxFeed(url, { force = false, now = Date.now(), fetchImpl } = {}) {
  if (!url) return null
  const last = tried[url] ?? cachedAt(url)
  if (!force && last != null && now - last < REFRESH_MS) return null
  tried[url] = now
  const r = await fetchFeed(url, fetchImpl)
  // Not when unsubscribed meanwhile (clearBoxFeed forgets the attempt).
  if (r.feed && tried[url] === now) keepFeed(url, r.feed, now)
  return r
}

/* ---------- the program list ---------- */

/**
 * The box's programs for the list, against the member's own (`own(date)` true when they have one):
 * `{ next: [{ date, program }], earlier: [...] }`, today and tomorrow, then the days before today
 * newest first. A date the member has their own program for is left out: theirs wins.
 */
export function boxRows(feed, own, today, tomorrow) {
  const next = [], earlier = []
  for (const date of Object.keys(feed?.programs || {}).sort()) {
    if (own(date)) continue
    const row = { date, program: feed.programs[date] }
    if (date === today || date === tomorrow) next.push(row)
    else if (date < today) earlier.unshift(row)
  }
  return { next, earlier }
}

/** Test hook: forget the in-memory copy and the attempts. */
export const _reset = () => { cache = undefined; tried = {} }
