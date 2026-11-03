import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boxFeedConfig, createBoxFeed, pushFeed } from '../box-feed-publish.js';

const TOKEN = 'github_pat_SECRET123';
const ENV = { BOX_FEED_UID: 'diego', BOX_FEED_REPO: 'Kinau-Guatemala/holy-wods', BOX_FEED_TOKEN: TOKEN, BOX_FEED_NAME: 'Holy Program' };
const NOW = Date.UTC(2026, 10, 3, 12);
const wod = title => ({ title, tracks: [{ label: 'A', kind: 'main', blocks: [] }], _ts: 1 });

// A GitHub contents API in memory: the file's sha moves on every PUT. `script` answers a call
// first when it returns something, so a test can stage a 409 or an outage.
function fakeGitHub(script = () => null) {
  const calls = [];
  let file = null;
  const res = (status, body) => ({ ok: status < 300, status, json: async () => body });
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method, body, auth: init.headers?.authorization });
    const staged = script(calls.length, method, body);
    if (staged instanceof Error) throw staged;
    if (staged) return staged;
    if (method === 'GET') return file ? res(200, { sha: file.sha }) : res(404, { message: 'Not Found' });
    if ((file?.sha || null) !== (body.sha || null)) return res(409, { message: 'sha does not match' });
    file = { sha: 'sha' + calls.length, content: Buffer.from(body.content, 'base64').toString() };
    return res(file.sha === 'sha2' ? 201 : 200, {});
  };
  return { fetch, calls, res, feed: () => (file ? JSON.parse(file.content) : null), puts: () => calls.filter(c => c.method === 'PUT') };
}

// Timers a test fires by hand: fire() runs the one pending and waits for its push to settle.
function fakeTimers() {
  let pending = null;
  return {
    setTimer: (fn, ms) => (pending = { fn, ms }),
    clearTimer: t => { if (pending === t) pending = null; },
    get ms() { return pending?.ms ?? null; },
    async fire() { const t = pending; pending = null; if (t) await t.fn(); }
  };
}

function setup({ script, env = ENV, clock = { t: NOW } } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'box-feed-'));
  const gh = fakeGitHub(script);
  const timers = fakeTimers();
  const lines = [];
  const log = { log: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) };
  const make = () => createBoxFeed({ env, dataDir, fetch: gh.fetch, log, now: () => clock.t, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  return { dataDir, gh, timers, lines, make, feed: make() };
}

test('off unless uid, repo, token and name are all set', () => {
  assert.ok(boxFeedConfig(ENV));
  for (const k of Object.keys(ENV)) assert.equal(boxFeedConfig({ ...ENV, [k]: '' }), null, k);
  assert.equal(boxFeedConfig({ ...ENV, BOX_FEED_REPO: 'not a repo' }), null);
  assert.equal(boxFeedConfig(ENV).days, 14);
  assert.equal(boxFeedConfig({ ...ENV, BOX_FEED_DAYS: '7' }).days, 7);
  const { feed, timers, gh } = setup({ env: { ...ENV, BOX_FEED_TOKEN: '' } });
  assert.equal(feed.on, false);
  feed.noteWrite('diego', { wods: { '2026-11-03': wod('x') } });
  assert.equal(timers.ms, null);
  assert.equal(gh.calls.length, 0);
  assert.deepEqual(feed.status(), { on: false });
  assert.equal(feed.forUser('diego'), null);
});

test('only the publishing account, debounced: several saves push once, with the allowlisted feed', async () => {
  const { feed, timers, gh } = setup();
  feed.noteWrite('someone-else', { wods: { '2026-11-03': wod('theirs') } });
  assert.equal(timers.ms, null);
  feed.noteWrite('diego', { wods: { '2026-11-03': wod('one') } });
  feed.noteWrite('diego', { wods: { '2026-11-03': wod('two') } });
  assert.equal(timers.ms, 30000);
  assert.equal(feed.status().pending, true);
  await timers.fire();
  assert.equal(gh.puts().length, 1);
  assert.deepEqual(gh.feed(), { v: 1, box: 'Holy Program', updatedAt: '2026-11-03T12:00:00.000Z',
    programs: [{ date: '2026-11-03', title: 'two', tracks: [{ label: 'A', kind: 'main', blocks: [] }] }] });
  const put = gh.puts()[0];
  assert.equal(put.url, 'https://api.github.com/repos/Kinau-Guatemala/holy-wods/contents/feed.json');
  assert.equal(put.body.branch, 'main');
  assert.equal(put.body.message, 'feed: 2026-11-03..2026-11-03');
  assert.equal(put.auth, 'Bearer ' + TOKEN);
  const s = feed.status();
  assert.equal(s.pushedAt, NOW);
  assert.equal(s.error, null);
  assert.equal(s.pending, false);
  assert.equal(s.url, 'https://raw.githubusercontent.com/Kinau-Guatemala/holy-wods/main/feed.json');
  assert.deepEqual(feed.forUser('diego'), { url: s.url });
  assert.equal(feed.forUser('someone-else'), null);
  assert.ok(!JSON.stringify(s).includes(TOKEN));
});

test('no push when the published slice is unchanged, also after a restart; a delete pushes', async () => {
  const { feed, timers, gh, make } = setup();
  const two = { '2026-11-03': wod('a'), '2026-11-04': wod('b') };
  feed.noteWrite('diego', { wods: two });
  await timers.fire();
  assert.equal(gh.puts().length, 1);
  // A save that changes nothing the feed carries (a logged score, a note) pushes nothing.
  feed.noteWrite('diego', { wods: { ...two, '2026-11-03': { ...two['2026-11-03'], logged: { score: 1 }, _ts: 9 } } });
  await timers.fire();
  assert.equal(gh.puts().length, 1);
  // The hash is on disk: a restarted server does not push the same feed again.
  const again = make();
  again.noteWrite('diego', { wods: two });
  await timers.fire();
  assert.equal(gh.puts().length, 1);
  // Deleting a program (a stamped clear) takes it out of the next feed.
  again.noteWrite('diego', { wods: { ...two, '2026-11-04': { _ts: 10 } } });
  await timers.fire();
  assert.equal(gh.puts().length, 2);
  assert.deepEqual(gh.feed().programs.map(p => p.date), ['2026-11-03']);
  assert.equal(gh.puts()[1].body.sha, 'sha2');   // the second write names the file it replaces
});

test('the push reads the sha first, and a 409 reads it again and retries once', async () => {
  const gh = fakeGitHub((n, method) => (n === 2 && method === 'PUT' ? gh.res(409, { message: 'is at abc but expected def' }) : null));
  await pushFeed({ repo: 'o/r', token: TOKEN, content: '{}', message: 'm', fetch: gh.fetch });
  assert.deepEqual(gh.calls.map(c => c.method), ['GET', 'PUT', 'GET', 'PUT']);
  assert.ok(gh.feed());
  // A second 409 is a failure, not a loop.
  const stuck = fakeGitHub((n, method) => (method === 'PUT' ? stuck.res(409, { message: 'conflict' }) : null));
  await assert.rejects(pushFeed({ repo: 'o/r', token: TOKEN, content: '{}', message: 'm', fetch: stuck.fetch }), /GitHub PUT 409: conflict/);
  assert.equal(stuck.puts().length, 2);
});

test('a failed push is logged and kept without the token, retried with backoff, then left', async () => {
  let down = true;
  const { feed, timers, gh, lines } = setup({
    script: (n, method) => (down ? (method === 'GET'
      ? new Error(`connect failed for Bearer ${TOKEN}`)
      : null) : null)
  });
  feed.noteWrite('diego', { wods: { '2026-11-03': wod('a') } });
  const waits = [];
  for (let i = 0; i < 4; i++) { await timers.fire(); waits.push(timers.ms); }
  assert.deepEqual(waits, [60000, 300000, 900000, null]);   // three retries, then nothing armed
  const s = feed.status();
  assert.match(s.error, /GitHub GET: connect failed for Bearer \*\*\*/);
  assert.equal(s.errorAt, NOW);
  for (const text of [...lines, JSON.stringify(s)]) assert.ok(!text.includes(TOKEN), text);
  // A GitHub answer that is an error, with its message, is reported the same way.
  const err = await pushFeed({ repo: 'o/r', token: TOKEN, content: '{}', message: 'm',
    fetch: async () => ({ ok: false, status: 401, json: async () => ({ message: 'Bad credentials ' + TOKEN }) }) }).catch(e => e);
  assert.equal(err.message, 'GitHub GET 401: Bad credentials ***');
  // The next save tries again, and a success clears the error.
  down = false;
  feed.noteWrite('diego', { wods: { '2026-11-03': wod('a') } });
  await timers.fire();
  assert.equal(gh.puts().length, 1);
  assert.equal(feed.status().error, null);
});

test('the debounce never holds a push back more than 5 minutes after the first unpublished save', async () => {
  const clock = { t: NOW };
  const { feed, timers, gh } = setup({ clock });
  const save = (after, title) => { clock.t = NOW + after; feed.noteWrite('diego', { wods: { '2026-11-03': wod(title) } }); return timers.ms; };
  assert.equal(save(0, 'a'), 30000);
  assert.equal(save(200000, 'b'), 30000);
  assert.equal(save(290000, 'c'), 10000);
  assert.equal(save(320000, 'd'), 0);
  await timers.fire();
  assert.equal(gh.puts().length, 1);
  // Published: the next save starts a fresh 30 s.
  assert.equal(save(330000, 'e'), 30000);
});
