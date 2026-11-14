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
// account has, whatever its date, and the photo it was read from. The parse image is held in
// memory and dropped after the call (coach/jobs.js), for every account but this one: when
// publishing is on, the BOX_FEED_UID account's is also written to DATA_DIR/box-images/<sha256>.<ext>
// (keepBoxImage), and the program read from it comes back tagged `photo: <sha256>`. The tag stays
// on the program through review and save, under whatever date it is saved, and a day's photo is
// its program's `photo`: an untagged program has none. It goes out as archive/<sha256>.<ext>; once
// GitHub has it, the local copy is deleted, and one no program names is deleted after 7 days. A
// photo over 2 MB is left out, and logged. One PUT per changed file, feed.json first and
// archive/index.json last of the writes, so a reader never finds an index entry before its file;
// then a date deleted since loses its files, and a photo no day names any more goes too.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ARCHIVE_INDEX, archiveIndex, archivePrograms, buildFeed, feedUrl, BOX_FEED_DAYS } from './box-feed.js';
import { atomicWrite } from './durable.js';
import { WODS_KEEP_DAYS } from './sync-stamps.js';
import { fetchFor } from './coach/node-fetch.js';

const REPO = /^[\w.-]+\/[\w.-]+$/;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const DEBOUNCE_MS = 30000;
const MAX_WAIT_MS = 300000;
const RETRY_MS = [60000, 300000, 900000];
const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v);
const IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const PHOTO = /^[0-9a-f]{64}$/;
const IMAGE_FILE = /^([0-9a-f]{64})\.(jpg|png|webp)$/;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const LOCAL_KEEP_MS = 7 * 86400000;

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
 * A parse job's image (`{ mime, data: base64 }`) kept as DATA_DIR/box-images/<sha256>.<ext> for the
 * archive, named by its content. Only for the publishing account, and only while publishing is
 * on: the sha256 (the program's `photo`), or null when not kept.
 */
export function keepBoxImage({ env = process.env, dataDir, uid, image }) {
  const cfg = boxFeedConfig(env);
  const ext = IMAGE_EXT[image?.mime];
  if (!cfg || uid !== cfg.uid || !ext || typeof image.data !== 'string') return null;
  const bytes = Buffer.from(image.data, 'base64');
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const dir = path.join(dataDir, 'box-images');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWrite(path.join(dir, `${sha}.${ext}`), bytes, 0o600);
  return sha;
}

const scrubber = token => msg => String(msg || '').split(token).join('***').slice(0, 300);
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
/** The sha git (and the contents API's `sha`) gives a file of these bytes. */
export const blobSha = bytes => crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const sameBlob = (file, sha) => { try { return blobSha(fs.readFileSync(file)) === sha; } catch { return false; } };

/**
 * `content` (a string or bytes) written to `file` on branch main of `repo`, or the file deleted
 * when `content` is null. The current file's sha is read first; when it is already this content's,
 * nothing is written. A 409 (the sha moved) or a 422 (a sha was needed) reads it again and tries
 * once more. Throws an Error whose message names the step and GitHub's answer, never the token.
 */
export async function pushFile({ repo, token, file, content, message, fetch, api = 'https://api.github.com' }) {
  const scrub = scrubber(token);
  const url = `${api}/repos/${repo}/contents/${file}`;
  const headers = ghHeaders(token);
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
    const g = await call('GET', { headers: ghHeaders(token, OBJECT) });
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

// A GET asks for the object form, which carries the sha (and the content up to 1 MB) for any file.
const ghHeaders = (token, accept = 'application/vnd.github+json') => ({
  authorization: `Bearer ${token}`, accept,
  'x-github-api-version': '2022-11-28', 'user-agent': 'opengym-box-feed'
});
const OBJECT = 'application/vnd.github.object+json';

/** The JSON of `file` on branch main of `repo`, or null when there is none. Throws as pushFile. */
// ponytail: the contents API inlines files up to 1 MB; an index past that (some 10,000 days) reads as none.
export async function readJson({ repo, token, file, fetch, api = 'https://api.github.com' }) {
  const scrub = scrubber(token);
  let r;
  try { r = await fetch(`${api}/repos/${repo}/contents/${file}?ref=main`, { headers: ghHeaders(token, OBJECT) }); }
  catch (e) { throw new Error(scrub(`GitHub GET ${file}: ${e?.message || e}`)); }
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(scrub(`GitHub GET ${file} ${r.status}`));
  try { return JSON.parse(Buffer.from((await r.json())?.content || '', 'base64').toString('utf8')); } catch { return null; }
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

  // The photos waiting to go out, by sha256: { file, name } of DATA_DIR/box-images.
  const localImages = () => {
    const out = {};
    let names = [];
    try { names = fs.readdirSync(imagesDir); } catch { /* none kept yet */ }
    for (const name of names) { const m = IMAGE_FILE.exec(name); if (m) out[m[1]] = { file: path.join(imagesDir, name), name }; }
    return out;
  };

  // Every file the repo should hold, in push order: [{ path, hash, content?, local? }], and the
  // index's days to remember (`days`). A file without content is one pushed before whose hash
  // stands (a photo whose local copy is gone, a day that has aged out).
  //
  // S.wods keeps only the last WODS_KEEP_DAYS (pruneWods), so a day missing from it is deleted only
  // inside that window, or when its date holds a stamped clear. A day older than that stays in the
  // archive as it was last pushed, from what the last push remembered of it (saved.days). The
  // window here is 2 days shorter: a phone prunes by its own clock, and one a little ahead of this
  // server, saving just after UTC midnight, has already dropped the day this server's window still
  // holds; that day is aged out, not deleted.
  function plan() {
    const t = now();
    const today = new Date(t).toISOString().slice(0, 10);
    const cutoff = new Date(Date.parse(today + 'T00:00:00Z') - (WODS_KEEP_DAYS - 2) * 86400000).toISOString().slice(0, 10);
    const files = [];
    const feed = buildFeed(wods, { name: cfg.name, today, days: cfg.days, now: t, merged });
    files.push({ path: 'feed.json', hash: sha256(JSON.stringify([feed.box, feed.programs, feed.archive])), content: JSON.stringify(feed, null, 1) + '\n', dates: feed.programs.map(p => p.date) });
    const programs = archivePrograms(wods, merged);
    const local = localImages();
    const pushed = saved.files || {};
    // A day's photo is the one its program names (`photo`, a sha256 the parse tagged it with).
    const photoOf = new Map(), images = new Map();
    for (const { date } of programs) {
      const sha = wods[date].photo;
      if (typeof sha !== 'string' || !PHOTO.test(sha)) continue;
      const l = local[sha];
      const size = l ? fs.statSync(l.file).size : 0;
      if (l && size > MAX_IMAGE_BYTES) log.error(scrub(`box feed: the photo for ${date} is over 2 MB (${size} bytes), left out`));
      let img = null;
      if (l && size <= MAX_IMAGE_BYTES) {
        const bytes = fs.readFileSync(l.file);
        img = { path: 'archive/' + l.name, hash: blobSha(bytes), content: bytes, local: l.file };
      } else {
        const before = Object.keys(pushed).find(p => p.startsWith(`archive/${sha}.`) && IMAGE_FILE.test(p.slice(8)));
        if (before) img = { path: before, hash: pushed[before] };
      }
      if (!img) continue;
      if (!images.has(img.path)) images.set(img.path, img);
      photoOf.set(date, img.path);
    }
    const live = new Set(programs.map(p => p.date));
    const aged = Object.entries(saved.days || {})
      .filter(([d]) => !live.has(d) && d < cutoff && !Object.hasOwn(isMap(wods) ? wods : {}, d));
    for (const [, e] of aged) if (e.photo && !images.has(e.photo)) images.set(e.photo, { path: e.photo, hash: pushed[e.photo] });
    files.push(...images.values());
    for (const [d] of aged) files.push({ path: `archive/${d}.json`, hash: pushed[`archive/${d}.json`] });
    for (const p of programs) {
      const img = photoOf.has(p.date) ? images.get(photoOf.get(p.date)) : null;
      const content = JSON.stringify({ ...p, ...(img ? { image: img.path.slice(8) } : {}) }, null, 1) + '\n';
      files.push({ path: `archive/${p.date}.json`, hash: sha256(content), content });
    }
    const index = archiveIndex(programs, { name: cfg.name, now: t, images: new Set(photoOf.keys()) });
    index.days.push(...aged.map(([date, e]) => ({ date, title: e.title, tracks: e.tracks, image: e.image })));
    index.days.sort((a, b) => (a.date < b.date ? 1 : -1));
    files.push({ path: ARCHIVE_INDEX, hash: sha256(JSON.stringify([index.box, index.days])), content: JSON.stringify(index, null, 1) + '\n' });
    const days = Object.fromEntries([
      ...index.days.filter(d => live.has(d.date)).map(d => [d.date, { title: d.title, tracks: d.tracks, image: d.image, photo: photoOf.get(d.date) || null }]),
      ...aged
    ]);
    return { files, days };
  }

  // No record of the last index (box-feed.json lost, or one from before the archive): the repo's
  // own archive/index.json is the record, so its old days are kept, not taken for deleted.
  async function seed() {
    const index = await readJson({ repo: cfg.repo, token: cfg.token, file: ARCHIVE_INDEX, fetch, api: cfg.api });
    const days = {}, files = { ...(saved.files || {}) };
    for (const d of Array.isArray(index?.days) ? index.days : []) {
      if (!isMap(d) || !ISO.test(String(d.date))) continue;
      days[d.date] = { title: String(d.title || ''), tracks: Array.isArray(d.tracks) ? d.tracks.filter(l => typeof l === 'string') : [], image: d.image === true, photo: null };
      files[`archive/${d.date}.json`] ??= 'seeded';
    }
    saved = { ...saved, days, files };
  }

  // A kept photo no program names (read and never saved, or replaced by a newer read) is deleted
  // once it is 7 days old.
  function sweep(files) {
    const named = new Set(files.filter(f => f.local).map(f => f.local));
    for (const [sha, l] of Object.entries(localImages())) {
      if (named.has(l.file) || Object.values(wods || {}).some(w => w?.photo === sha)) continue;
      try { if (now() - fs.statSync(l.file).mtimeMs > LOCAL_KEEP_MS) fs.rmSync(l.file, { force: true }); } catch { /* gone already */ }
    }
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
    running = true;
    let pushed = saved.files || {};
    try {
      if (!saved.days) await seed();
      const { files, days } = plan();
      sweep(files);
      const hash = sha256(JSON.stringify(files.map(f => [f.path, f.hash])));
      // A photo kept again, the same as the one GitHub has, is only deleted here.
      if (hash === saved.hash && !files.some(f => f.local)) return;
      pushed = { ...(saved.files || {}) };
      const wanted = new Set(files.map(f => f.path));
      const push = (f, content, message) => pushFile({ repo: cfg.repo, token: cfg.token, file: f, content, message, fetch, api: cfg.api });
      let count = 0;
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
        // GitHub has it now, unless a newer parse replaced the file mid-push: that one waits.
        if (f.local && sameBlob(f.local, f.hash)) fs.rmSync(f.local, { force: true });
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
      keep({ hash, files: pushed, days, pushedAt: now(), error: null, errorAt: null });
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
