// The box's archive (T40): every day a box has published, with the photo it was read from, next
// to its feed.json in the same repo (api/box-feed.js, written by api/box-feed-publish.js).
//
//   archive/index.json   { v: 1, box, updatedAt, days: [{ date, title, tracks: [label], image }] }, newest first
//   archive/<date>.json  a feed program, plus `image: '<date>.<ext>'` when it has a photo
//
// Read like the feed (lib/box-subscribe.js): untrusted, https only, size-capped, every program
// through cleanProgram. The index is cached on this device (localStorage, never S) and fetched
// again at most every 10 minutes; a day is fetched when it is opened, and kept in memory.
import { ARCHIVE_INDEX, BOX_FEED_VERSION } from './box-feed.js'
import { REFRESH_MS, MAX_FEED_BYTES, cleanProgram, fetchJson, httpsUrl, isDay } from './box-subscribe.js'

const CACHE_KEY = 'gym_box_archive_v1'
const MAX_DAYS = 5000
const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '')

/** `rel` read against `base` as an https address, or null. */
const resolve = (rel, base) => { try { return httpsUrl(new URL(rel, base).href) } catch { return null } }

/**
 * Where the box history is read from: the subscribed feed's archive when it names one, else the
 * publisher's own (`own`, the feed this account publishes, which has one at the usual place).
 * null when there is none.
 */
export function archiveSource(subscribed, feed, own) {
  if (subscribed && typeof feed?.archive === 'string') return resolve(feed.archive, subscribed)
  return own ? resolve(ARCHIVE_INDEX, own) : null
}

/** A fetched archive/index.json, checked: `{ box, updatedAt, days }`, or null. */
export function parseIndex(json) {
  if (!isMap(json) || json.v !== BOX_FEED_VERSION || !Array.isArray(json.days)) return null
  const seen = new Set(), days = []
  for (const d of json.days.slice(0, MAX_DAYS)) {
    if (!isMap(d) || typeof d.date !== 'string' || !isDay(d.date) || seen.has(d.date)) continue
    seen.add(d.date)
    const tracks = (Array.isArray(d.tracks) ? d.tracks : []).map(l => str(l, 40)).filter(Boolean).slice(0, 8)
    days.push({ date: d.date, title: str(d.title, 120), tracks, image: d.image === true })
  }
  days.sort((a, b) => (a.date < b.date ? 1 : -1))
  const at = Date.parse(json.updatedAt)
  return { box: str(json.box, 60), updatedAt: Number.isFinite(at) ? at : null, days }
}

/**
 * The photo `name` of an archive day as an address to show, or null: it must stay https and on
 * the archive's own host (a raw file of the same repo), whatever the file says.
 */
export function imageUrl(indexUrl, name) {
  if (typeof name !== 'string' || !name || name.length > 200) return null
  const href = resolve(name, indexUrl)
  return href && new URL(href).origin === new URL(indexUrl).origin ? href : null
}

/** A fetched archive/<date>.json, checked: `{ program, image }` (image an address or null), or null. */
export function parseDay(json, date, indexUrl) {
  if (!isMap(json) || json.date !== date) return null
  const program = cleanProgram(json)
  return program ? { program, image: imageUrl(indexUrl, json.image) } : null
}

/* ---------- the device's copy of the index ---------- */

// { url, at, index }: the last good index of `url`, fetched at `at`.
let cache
const listeners = new Set()
const read = () => {
  if (cache === undefined) {
    try { cache = JSON.parse(localStorage.getItem(CACHE_KEY)) } catch { cache = null }
    if (!isMap(cache) || !isMap(cache.index) || !Array.isArray(cache.index.days)) cache = null
  }
  return cache
}
const write = next => {
  cache = next
  try {
    const json = next && JSON.stringify(next)
    if (json && json.length <= MAX_FEED_BYTES) localStorage.setItem(CACHE_KEY, json); else localStorage.removeItem(CACHE_KEY)
  } catch { /* memory still has it */ }
  for (const fn of listeners) fn()
}
export const subscribeArchive = fn => { listeners.add(fn); return () => listeners.delete(fn) }
/** The cached index of `url`, or null. */
export const cachedIndex = url => { const c = read(); return c && url && c.url === url ? c.index : null }

let tried = {}
/**
 * The index at `url` fetched again when the last attempt is REFRESH_MS old (or `force`), and
 * cached when good; a failed fetch keeps the cached copy. Resolves to `{ value }` or `{ error }`,
 * or null when skipped.
 */
export async function refreshArchive(url, { force = false, now = Date.now(), fetchImpl } = {}) {
  if (!url) return null
  const c = read()
  const last = tried[url] ?? (c?.url === url ? c.at : null)
  if (!force && last != null && now - last < REFRESH_MS) return null
  tried[url] = now
  const r = await fetchJson(url, parseIndex, fetchImpl)
  if (r.value) write({ url, at: now, index: r.value })
  return r
}

const days = new Map()
/** The archive day `date` of the index at `indexUrl`: `{ value: { program, image } }` or `{ error }`. */
export async function fetchDay(indexUrl, date, fetchImpl) {
  const url = isDay(date) && resolve(date + '.json', indexUrl)
  if (!url) return { error: 'invalid' }
  if (days.has(url)) return { value: days.get(url) }
  const r = await fetchJson(url, j => parseDay(j, date, indexUrl), fetchImpl)
  if (r.value) days.set(url, r.value)
  return r
}

/** Test hook: forget the in-memory copies and the attempts. */
export const _reset = () => { cache = undefined; tried = {}; days.clear() }
