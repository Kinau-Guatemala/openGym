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
// times pushes once; never later than 5 minutes after the first save not yet published. When it fires, the feed's programs are hashed and compared with the hash of
// the last push (DATA_DIR/box-feed.json): unchanged, nothing goes out. A failed push is retried
// after 1, 5 and 15 minutes, then left for the next save.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildFeed, feedUrl, BOX_FEED_DAYS } from './box-feed.js';
import { atomicWrite } from './durable.js';
import { fetchFor } from './coach/node-fetch.js';

const REPO = /^[\w.-]+\/[\w.-]+$/;
const DEBOUNCE_MS = 30000;
const MAX_WAIT_MS = 300000;
const RETRY_MS = [60000, 300000, 900000];

/** The publishing settings from `env`, or null when any of them is missing (publishing off). */
export function boxFeedConfig(env = process.env) {
  const s = k => String(env[k] || '').trim();
  const uid = s('BOX_FEED_UID'), repo = s('BOX_FEED_REPO'), token = s('BOX_FEED_TOKEN'), name = s('BOX_FEED_NAME');
  if (!uid || !REPO.test(repo) || !token || !name) return null;
  const days = s('BOX_FEED_DAYS') ? Math.floor(Number(s('BOX_FEED_DAYS'))) : NaN;
  const api = (s('BOX_FEED_API') || 'https://api.github.com').replace(/\/+$/, '');
  return { uid, repo, token, name, days: days >= 0 ? days : BOX_FEED_DAYS, api };
}

const scrubber = token => msg => String(msg || '').split(token).join('***').slice(0, 300);

/**
 * `content` written to feed.json on branch main of `repo`. The current file's sha is read first;
 * a 409 (the sha moved) or a 422 (a sha was needed) reads it again and tries once more.
 * Throws an Error whose message names the step and GitHub's answer, never the token.
 */
export async function pushFeed({ repo, token, content, message, fetch, api = 'https://api.github.com' }) {
  const scrub = scrubber(token);
  const url = `${api}/repos/${repo}/contents/feed.json`;
  const headers = {
    authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28', 'user-agent': 'opengym-box-feed'
  };
  const failed = async (step, r) => {
    let why = '';
    try { why = (await r.json())?.message || ''; } catch { /* not JSON */ }
    return new Error(scrub(`GitHub ${step} ${r.status}${why ? ': ' + why : ''}`));
  };
  const call = async (step, init) => {
    try { return await fetch(url + (step === 'GET' ? '?ref=main' : ''), init); }
    catch (e) { throw new Error(scrub(`GitHub ${step}: ${e?.message || e}`)); }
  };
  const body64 = Buffer.from(content).toString('base64');
  for (let attempt = 0; ; attempt++) {
    const g = await call('GET', { headers });
    let sha = null;
    if (g.ok) sha = (await g.json())?.sha || null;
    else if (g.status !== 404) throw await failed('GET', g);
    const p = await call('PUT', {
      method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ message, content: body64, branch: 'main', ...(sha ? { sha } : {}) })
    });
    if (p.ok) return;
    if ((p.status === 409 || p.status === 422) && attempt === 0) continue;
    throw await failed('PUT', p);
  }
}

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
  // { hash, pushedAt, error, errorAt }: what was last pushed, and the last failure since.
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { /* first run */ }
  const keep = next => {
    saved = next;
    try { atomicWrite(file, JSON.stringify(saved)); } catch (e) { log.error('box feed: cannot save its status:', e?.message); }
  };

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
    const feed = buildFeed(wods, { name: cfg.name, today: new Date(now()).toISOString().slice(0, 10), days: cfg.days, now: now(), merged });
    const hash = crypto.createHash('sha256').update(JSON.stringify([feed.box, feed.programs])).digest('hex');
    if (hash === saved.hash) return;
    const dates = feed.programs.map(p => p.date);
    const message = dates.length ? `feed: ${dates[0]}..${dates[dates.length - 1]}` : 'feed: no programs';
    running = true;
    try {
      await pushFeed({ repo: cfg.repo, token: cfg.token, content: JSON.stringify(feed, null, 1) + '\n', message, fetch, api: cfg.api });
      tries = 0;
      keep({ hash, pushedAt: now(), error: null, errorAt: null });
      log.log(`box feed: pushed ${dates.length} programs to ${cfg.repo}`);
    } catch (e) {
      const error = scrub(e?.message || e);
      keep({ ...saved, error, errorAt: now() });
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
