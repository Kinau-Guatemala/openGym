// The box feed's publishing side: after the publishing account saves, its programs go to
// feed.json in a GitHub repo, through the contents API (one GET for the file's sha, one PUT).
// Members read the raw file (frontend: the box feed, T32); this server never serves it.
//
// Configured by env alone, and off unless all four are set:
//   BOX_FEED_UID    the account whose programs are published
//   BOX_FEED_REPO   owner/repo, branch main
//   BOX_FEED_TOKEN  a fine-grained token, Contents read and write on that one repo
//   BOX_FEED_NAME   the box's display name
//   BOX_FEED_DAYS   past days kept (default 14)
//   BOX_FEED_API    the GitHub API base (default https://api.github.com), for the tests' stub
//
// The token goes into an Authorization header and nowhere else: not the state, not the status
// the admin card reads, not a log line or an error (scrub() runs over every message kept).
//
// A save arms a 30 s timer and every later save re-arms it, so a review session that saves five
// times pushes once; never later than 5 minutes after the first save not yet published. When it
// fires, every file is hashed and compared with the hash of its last push (DATA_DIR/box-feed.json):
// unchanged, nothing goes out. A failed push is retried after 1, 5 and 15 minutes, then left for
// the next save.
//
// T40, the archive (box-feed.js): next to feed.json, archive/<date>.json for every program the
// account has, whatever its date, and archive/<date>.<ext> for its photo. The parse image is held
// in memory and dropped after the call (coach/jobs.js), for every account but this one: when
// publishing is on, the BOX_FEED_UID account's is also written to DATA_DIR/box-images/<date>.<ext>
// (keepBoxImage, a newer one for the date replacing it) and goes out with that date's program. Once
// GitHub has it, the local copy is deleted; a photo over 2 MB is left out, and logged. One PUT per
// changed file, feed.json first and archive/index.json last of the writes, so a reader never finds
// an index entry before its file; then a date deleted since loses its files.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ARCHIVE_INDEX, archiveIndex, archivePrograms, buildFeed, feedUrl, BOX_FEED_DAYS } from './box-feed.js';
import { atomicWrite } from './durable.js';
import { fetchFor } from './coach/node-fetch.js';

const REPO = /^[\w.-]+\/[\w.-]+$/;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const DEBOUNCE_MS = 30000;
const MAX_WAIT_MS = 300000;
const RETRY_MS = [60000, 300000, 900000];
const IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const IMAGE_FILE = /^(\d{4}-\d{2}-\d{2})\.(jpg|png|webp)$/;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** The publishing settings from `env`, or null when any of them is missing (publishing off). */
export function boxFeedConfig(env = process.env) {
  const s = k => String(env[k] || '').trim();
  const uid = s('BOX_FEED_UID'), repo = s('BOX_FEED_REPO'), token = s('BOX_FEED_TOKEN'), name = s('BOX_FEED_NAME');
  if (!uid || !REPO.test(repo) || !token || !name) return null;
  const days = s('BOX_FEED_DAYS') ? Math.floor(Number(s('BOX_FEED_DAYS'))) : NaN;
  const api = (s('BOX_FEED_API') || 'https://api.github.com').replace(/\/+$/, '');
  return { uid, repo, token, name, days: days >= 0 ? days : BOX_FEED_DAYS, api };
}

/**
 * A parse job's image (`{ mime, data: base64 }`) kept as DATA_DIR/box-images/<date>.<ext> for the
 * archive, replacing the date's photo in any format. Only for the publishing account, and only
 * while publishing is on; true when kept.
 */
export function keepBoxImage({ env = process.env, dataDir, uid, date, image }) {
  const cfg = boxFeedConfig(env);
  const ext = IMAGE_EXT[image?.mime];
  if (!cfg || uid !== cfg.uid || !ISO.test(String(date)) || !ext || typeof image.data !== 'string') return false;
  const dir = path.join(dataDir, 'box-images');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const e of Object.values(IMAGE_EXT)) if (e !== ext) fs.rmSync(path.join(dir, `${date}.${e}`), { force: true });
  atomicWrite(path.join(dir, `${date}.${ext}`), Buffer.from(image.data, 'base64'), 0o600);
  return true;
}

const scrubber = token => msg => String(msg || '').split(token).join('***').slice(0, 300);
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
/** The sha git (and the contents API's `sha`) gives a file of these bytes. */
export const blobSha = bytes => crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

/**
 * `content` (a string or bytes) written to `file` on branch main of `repo`, or the file deleted
 * when `content` is null. The current file's sha is read first; when it is already this content's,
 * nothing is written. A 409 (the sha moved) or a 422 (a sha was needed) reads it again and tries
 * once more. Throws an Error whose message names the step and GitHub's answer, never the token.
 */
export async function pushFile({ repo, token, file, content, message, fetch, api = 'https://api.github.com' }) {
  const scrub = scrubber(token);
  const url = `${api}/repos/${repo}/contents/${file}`;
  const headers = {
    authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28', 'user-agent': 'opengym-box-feed'
  };
  const failed = async (step, r) => {
    let why = '';
    try { why = (await r.json())?.message || ''; } catch { /* not JSON */ }
    return new Error(scrub(`GitHub ${step} ${file} ${r.status}${why ? ': ' + why : ''}`));
  };
  const call = async (step, init) => {
    try { return await fetch(url + (step === 'GET' ? '?ref=main' : ''), init); }
    catch (e) { throw new Error(scrub(`GitHub ${step} ${file}: ${e?.message || e}`)); }
  };
  const bytes = content == null ? null : Buffer.from(content);
  const mine = bytes && blobSha(bytes);
  for (let attempt = 0; ; attempt++) {
    const g = await call('GET', { headers });
    let sha = null;
    if (g.ok) sha = (await g.json())?.sha || null;
    else if (g.status !== 404) throw await failed('GET', g);
    if (bytes ? sha === mine : !sha) return;
    const step = bytes ? 'PUT' : 'DELETE';
    const p = await call(step, {
      method: step, headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ message, branch: 'main', ...(bytes ? { content: bytes.toString('base64') } : {}), ...(sha ? { sha } : {}) })
    });
    if (p.ok) return;
    if ((p.status === 409 || p.status === 422) && attempt === 0) continue;
    throw await failed(step, p);
  }
}

/** feed.json written (pushFile). */
export const pushFeed = opts => pushFile({ ...opts, file: 'feed.json' });

const OFF = { on: false, noteWrite() {}, status: () => ({ on: false }), forUser: () => null };

/**
 * The publisher. `noteWrite(uid, state)` after every saved document; `status()` for the admin;
 * `forUser(uid)` is `{ url }` for the publishing account and null for everyone else.
 * Everything with a clock or a network is injectable for the tests.
 */
export function createBoxFeed({
  env = process.env, dataDir, fetch = fetchFor(30000), log = console, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, debounceMs = DEBOUNCE_MS, maxWaitMs = MAX_WAIT_MS, retryMs = RETRY_MS
} = {}) {
  const cfg = boxFeedConfig(env);
  if (!cfg) return OFF;
  const scrub = scrubber(cfg.token);
  const url = feedUrl(cfg.repo);
  const file = path.join(dataDir, 'box-feed.json');
  const imagesDir = path.join(dataDir, 'box-images');
  // { hash, files: { [repo path]: hash }, pushedAt, error, errorAt }: what was last pushed, file
  // by file (an image's hash is its blob sha), and the last failure since.
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { /* first run */ }
  const keep = next => {
    saved = next;
    try { atomicWrite(file, JSON.stringify(saved)); } catch (e) { log.error('box feed: cannot save its status:', e?.message); }
  };

  // The photos waiting to go out, by date: { file, name } of DATA_DIR/box-images.
  const localImages = () => {
    const out = {};
    let names = [];
    try { names = fs.readdirSync(imagesDir); } catch { /* none kept yet */ }
    for (const name of names) { const m = IMAGE_FILE.exec(name); if (m) out[m[1]] = { file: path.join(imagesDir, name), name }; }
    return out;
  };

  // Every file the repo should hold, in push order: [{ path, hash, content?, local? }]. A file
  // without content is one pushed before whose hash stands (a photo whose local copy is gone).
  function plan() {
    const t = now();
    const files = [];
    const feed = buildFeed(wods, { name: cfg.name, today: new Date(t).toISOString().slice(0, 10), days: cfg.days, now: t, merged });
    files.push({ path: 'feed.json', hash: sha256(JSON.stringify([feed.box, feed.programs, feed.archive])), content: JSON.stringify(feed, null, 1) + '\n', dates: feed.programs.map(p => p.date) });
    const programs = archivePrograms(wods, merged);
    const local = localImages();
    const pushed = saved.files || {};
    const images = new Map();
    for (const { date } of programs) {
      const l = local[date];
      const size = l ? fs.statSync(l.file).size : 0;
      if (l && size > MAX_IMAGE_BYTES) log.error(scrub(`box feed: the photo for ${date} is over 2 MB (${size} bytes), left out`));
      if (l && size <= MAX_IMAGE_BYTES) {
        const bytes = fs.readFileSync(l.file);
        images.set(date, { path: 'archive/' + l.name, hash: blobSha(bytes), content: bytes, local: l.file });
      } else {
        const before = Object.keys(pushed).find(p => p.startsWith(`archive/${date}.`) && IMAGE_FILE.test(p.slice(8)));
        if (before) images.set(date, { path: before, hash: pushed[before] });
      }
    }
    files.push(...images.values());
    for (const p of programs) {
      const img = images.get(p.date);
      const content = JSON.stringify({ ...p, ...(img ? { image: img.path.slice(8) } : {}) }, null, 1) + '\n';
      files.push({ path: `archive/${p.date}.json`, hash: sha256(content), content });
    }
    const index = archiveIndex(programs, { name: cfg.name, now: t, images: new Set(images.keys()) });
    files.push({ path: ARCHIVE_INDEX, hash: sha256(JSON.stringify([index.box, index.days])), content: JSON.stringify(index, null, 1) + '\n' });
    return files;
  }

  // firstAt: when the oldest save not yet published landed, for the debounce's maximum wait.
  let wods = null, merged = null, timer = null, running = false, tries = 0, firstAt = null;
  const arm = ms => {
    if (timer) clearTimer(timer);
    timer = setTimer(() => run().catch(e => log.error('box feed:', scrub(e?.message || e))), ms);
    timer?.unref?.();
  };

  async function run() {
    timer = null;
    if (running) return arm(debounceMs);           // saved again mid-push: once more after it
    firstAt = null;
    const files = plan();
    const hash = sha256(JSON.stringify(files.map(f => [f.path, f.hash])));
    // A photo kept again, the same as the one GitHub has, is only deleted here.
    if (hash === saved.hash && !files.some(f => f.local)) return;
    const pushed = { ...(saved.files || {}) };
    const wanted = new Set(files.map(f => f.path));
    const push = (f, content, message) => pushFile({ repo: cfg.repo, token: cfg.token, file: f, content, message, fetch, api: cfg.api });
    let count = 0;
    running = true;
    try {
      for (const f of files) {
        if (pushed[f.path] !== f.hash && f.content != null) {
          const dates = f.dates;
          const message = f.path === 'feed.json'
            ? (dates.length ? `feed: ${dates[0]}..${dates[dates.length - 1]}` : 'feed: no programs')
            : `archive: ${f.path.slice(8)}`;
          await push(f.path, f.content, message);
          pushed[f.path] = f.hash;
          count++;
          keep({ ...saved, files: pushed });
        }
        if (f.local) fs.rmSync(f.local, { force: true });   // GitHub has it now
      }
      for (const p of Object.keys(pushed)) {
        if (wanted.has(p)) continue;
        await push(p, null, `archive: remove ${p.slice(8)}`);
        delete pushed[p];
        count++;
        keep({ ...saved, files: pushed });
      }
      tries = 0;
      if (!count && hash === saved.hash) return;
      keep({ hash, files: pushed, pushedAt: now(), error: null, errorAt: null });
      log.log(`box feed: pushed ${count} files to ${cfg.repo}`);
    } catch (e) {
      const error = scrub(e?.message || e);
      keep({ ...saved, files: pushed, error, errorAt: now() });
      log.error('box feed: push failed:', error);
      if (tries < retryMs.length) arm(retryMs[tries++]);
    } finally { running = false; }
  }

  return {
    on: true,
    uid: cfg.uid,
    noteWrite(uid, state) {
      if (uid !== cfg.uid) return;
      wods = state?.wods ?? null;
      merged = state?.exMerged ?? null;
      tries = 0;
      if (firstAt == null) firstAt = now();
      arm(Math.max(0, Math.min(debounceMs, firstAt + maxWaitMs - now())));
    },
    status: () => ({
      on: true, repo: cfg.repo, url, pushedAt: saved.pushedAt || null,
      error: saved.error || null, errorAt: saved.errorAt || null, pending: !!timer || running
    }),
    forUser: uid => (uid === cfg.uid ? { url } : null)
  };
}
