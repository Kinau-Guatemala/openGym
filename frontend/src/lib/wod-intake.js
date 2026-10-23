// A box's routine image, read into a program (T05): the Android Share target and the CrossFit
// screen's upload both end here.
//
//   image ─ downscale ─ startIntake ─ POST /api/coach/parse-wod ─ poll status ─ parsed
//                                                                     └ the review screen
//
// The run lives here, at module level, not in a view's effect: React's StrictMode runs effects
// twice, and a second effect is a second parse spent against the daily cap. The view subscribes
// (useSyncExternalStore) and only reads. The image stays in memory here and in the editor's
// route state, never on disk: a failed or vanished job is retried from this copy.
import { isoOf } from './format.js'
import { onSharedImage } from './mobile.js'

const LONG_SIDE = 1600
const QUALITY = 0.85
const POLL_MS = 3000
const GIVE_UP_MS = 4 * 60 * 1000   // a parse is one provider call; past this it is not coming
// A small file can declare huge dimensions; decoding 30000×30000 is ~3.6 GB of RGBA and takes the
// WebView down. No posted routine comes near this (a 12 MP phone photo is 12e6).
const MAX_PIXELS = 50e6

/** The day a posted program is for, unless the person says otherwise: the box posts the evening before. */
export const tomorrowISO = (now = new Date()) => { const d = new Date(now); d.setDate(d.getDate() + 1); return isoOf(d) }

/** The size an image of w×h is drawn at: its long side at most `max`, never enlarged. */
export function fitSize(w, h, max = LONG_SIDE) {
  const k = Math.min(1, max / Math.max(w, h, 1))
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) }
}

const loadImage = src => new Promise((resolve, reject) => {
  const img = new Image()
  const url = typeof src === 'string' ? src : URL.createObjectURL(src)
  img.onload = () => { if (url !== src) URL.revokeObjectURL(url); resolve(img) }
  img.onerror = () => { if (url !== src) URL.revokeObjectURL(url); reject(new Error('image')) }
  img.src = url
})

/**
 * A File/Blob or a data URL → the JPEG the server is sent: { url, mime, data }, where `url` is a
 * data URL the editor shows and `data` its base64. WhatsApp's own JPEGs are already small; a
 * camera photo is 4000 px and several MB, which this brings to ~200–400 KB.
 */
export async function downscale(src, { load = loadImage, canvas = () => document.createElement('canvas') } = {}) {
  const img = await load(src)
  const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height
  if (!(w0 * h0 <= MAX_PIXELS)) throw new Error('image too large')
  const { w, h } = fitSize(w0, h0)
  const c = canvas()
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')
  // A transparent PNG would turn black as a JPEG.
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(img, 0, 0, w, h)
  return fromDataUrl(c.toDataURL('image/jpeg', QUALITY))
}

/** A data URL as the parts the request carries. */
export function fromDataUrl(url) {
  const m = /^data:([^;,]+);base64,(.*)$/.exec(String(url || ''))
  return m ? { url, mime: m[1], data: m[2] } : null
}

// Refusals that no retry fixes from here: the program is typed by hand instead, the image beside it.
const MANUAL = ['off', 'consent', 'unsupported', 'shared', 'unprivileged']

const classOf = e => {
  const code = e?.data?.code
  if (code) return code
  if (e?.status === 401 || e?.code === 'not-paired') return 'off'
  return 'network'
}

/**
 * One read of `image` for `date`. Resolves to exactly one of
 *   { program, jobId }  — a program with at least one block
 *   { manual: cls }     — the Coach can't read it here (off, no consent, provider): type it in
 *   { failed: cls }     — this try failed ('empty' = no routine in the image): retry or type it
 *   { cancelled: true } — a newer image replaced it
 * `io` is { parse(date, image), status(), sleep(ms), now(), alive(), onPhase(phase) }.
 */
export async function readProgram(image, date, io) {
  const deadline = io.now() + GIVE_UP_MS
  let job = null
  // Single-flight: a plan job running for this profile answers `busy`. Wait it out, then ask again.
  while (!job) {
    try {
      job = (await io.parse(date, image))?.job
      if (!job?.id) return { failed: 'internal' }
    } catch (e) {
      const cls = classOf(e)
      if (MANUAL.includes(cls)) return { manual: cls }
      if (cls !== 'busy') return { failed: cls }
      io.onPhase('waiting')
      if (!await idle(io, deadline)) return io.alive() ? { failed: 'timeout' } : { cancelled: true }
    }
  }
  io.onPhase('reading')
  for (;;) {
    await io.sleep(POLL_MS)
    if (!io.alive()) return { cancelled: true }
    let s = null
    try { s = await io.status() } catch { /* a dropped poll: the next one asks again */ }
    if (s) {
      if (s.parsed?.jobId === job.id) {
        // A skeleton (tracks, no block in any) is no routine either.
        return s.parsed.program?.tracks?.some(t => t.blocks?.length) ? { program: s.parsed.program, jobId: job.id } : { failed: 'empty', jobId: job.id }
      }
      if (s.last?.id === job.id) return { failed: s.last.errorClass || 'unusable' }
      // Neither running nor ended: the server restarted and the in-memory job went with it.
      if (s.job?.id !== job.id) return { failed: 'restart' }
    }
    if (io.now() > deadline) return { failed: 'timeout' }
  }
}

// Polls until the profile's running job is over. False when the wait ran out or was abandoned.
async function idle(io, deadline) {
  for (;;) {
    await io.sleep(POLL_MS)
    if (!io.alive() || io.now() > deadline) return false
    try { if (!(await io.status())?.job) return true } catch { /* ask again */ }
  }
}

/* ---------- the one run in flight ---------- */

// { id, image, date, phase: 'pending'|'starting'|'waiting'|'reading'|'done', result }
let run = null
let seq = 0
const watchers = new Set()
const emit = patch => { run = { ...run, ...patch }; watchers.forEach(fn => fn()) }

export const currentIntake = () => run
export function subscribeIntake(fn) {
  watchers.add(fn)
  return () => watchers.delete(fn)
}

/**
 * Hands over an image (from downscale) to be read for `date`, replacing any run before it. Nothing
 * is sent yet: a phone opened cold by a Share has not restored its pairing at this point, so the
 * screen starts it (beginIntake) once the app is ready.
 */
export function setIntakeImage(image, date) {
  run = { id: ++seq, image, date, phase: 'pending', result: null }
  watchers.forEach(fn => fn())
}

/**
 * Starts the handed-over run, once: a second call (StrictMode's second effect) finds it started.
 * It polls to its own end (at most GIVE_UP_MS) whether or not a screen watches: the server job runs
 * and is charged either way, so a program read while the person was elsewhere is kept here and
 * offered from the CrossFit list (readyIntake) instead of being read, and paid for, again.
 */
export function beginIntake(io) {
  if (run?.phase !== 'pending') return
  const { id, image, date } = run
  const mine = () => run?.id === id
  emit({ phase: 'starting' })
  readProgram(image, date, {
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    now: () => Date.now(),
    ...io,
    alive: mine,
    onPhase: phase => { if (mine()) emit({ phase }) },
  }).catch(() => ({ failed: 'internal' }))
    .then(result => { if (mine()) emit({ phase: 'done', result }) })
}

/**
 * The run, once: the first caller acts on it (opens the editor), a second one (StrictMode's
 * second effect, a late poll) gets null. Its image stays here for a retry.
 */
export function takeIntake() {
  if (!run || run.taken) return null
  run.taken = true
  return run
}

/** How a finished run ended badly, or null: a `cancelled` one counts as a failure, never as still reading. */
export function failureOf(r) {
  if (r?.phase !== 'done') return null
  return r.result?.failed || (r.result?.cancelled ? 'internal' : null)
}

/** A run whose program was read and not yet opened in the editor (the person left while it read). */
export const readyIntake = r => (r?.phase === 'done' && r.result?.program && !r.taken ? r : null)

/* ---------- Share → openGym (Android) ---------- */

export const INTAKE_ROUTE = '/crossfit/new?shared=1'

/**
 * Once, at start-up: an image shared to the app becomes a run and opens the intake screen.
 * `unreadable()` is called for one that could not be opened.
 */
export function initShareIntake(unreadable) {
  onSharedImage(async ev => {
    let image = null
    try { if (!ev?.error) image = await downscale(`data:${ev.mime};base64,${ev.data}`) } catch { /* below */ }
    if (!image) { unreadable(); return }
    setIntakeImage(image, tomorrowISO())
    // The hash, not the router: a cold start delivers the image before the router is up.
    // Already there (a second share), the screen picks the new run up by itself.
    window.location.hash = '#' + INTAKE_ROUTE
  })
}
