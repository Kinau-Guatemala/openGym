import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { blobSha, boxFeedConfig, createBoxFeed, keepBoxImage, pushFeed } from '../box-feed-publish.js';

const TOKEN = 'github_pat_SECRET123';
const ENV = { BOX_FEED_UID: 'diego', BOX_FEED_REPO: 'Kinau-Guatemala/holy-wods', BOX_FEED_TOKEN: TOKEN, BOX_FEED_NAME: 'Holy Program' };
const NOW = Date.UTC(2026, 10, 3, 12);
const wod = title => ({ title, tracks: [{ label: 'A', kind: 'main', blocks: [] }], _ts: 1 });

// A GitHub contents API in memory, one file per path: a file's sha moves on every PUT. `script`
// answers a call first when it returns something, so a test can stage a 409 or an outage.
function fakeGitHub(script = () => null) {
  const calls = [];
  const files = {};
  const res = (status, body) => ({ ok: status < 300, status, json: async () => body });
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    const file = decodeURI(new URL(url).pathname.split('/contents/')[1]);
    calls.push({ url, file, method, body, auth: init.headers?.authorization });
    const staged = script(calls.length, method, body, file);
    if (staged instanceof Error) throw staged;
    if (staged) return staged;
    const have = files[file];
    if (method === 'GET') return have ? res(200, { sha: have.sha }) : res(404, { message: 'Not Found' });
    if ((have?.sha || null) !== (body.sha || null)) return res(409, { message: 'sha does not match' });
    if (method === 'DELETE') { delete files[file]; return res(200, {}); }
    files[file] = { sha: 'sha' + calls.length, bytes: Buffer.from(body.content, 'base64') };
    return res(have ? 200 : 201, {});
  };
  const json = f => (files[f] ? JSON.parse(files[f].bytes.toString()) : null);
  return {
    fetch, calls, res, files, json, feed: () => json('feed.json'),
    puts: (f = 'feed.json') => calls.filter(c => c.method === 'PUT' && (f === '*' || c.file === f)),
    writes: () => calls.filter(c => c.method !== 'GET')
  };
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
    programs: [{ date: '2026-11-03', title: 'two', tracks: [{ label: 'A', kind: 'main', blocks: [] }] }], archive: 'archive/index.json' });
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

test('T35: the owner\'s Merge into… reaches the feed: a merge alone pushes, with the target id', async () => {
  const { feed, timers, gh } = setup();
  const p = { title: 'x', tracks: [{ label: 'A', kind: 'main', blocks: [{ label: 'B', movements: [{ rawName: 'row', exId: '1161' }] }] }], _ts: 1 };
  const exIdOf = () => gh.feed().programs[0].tracks[0].blocks[0].movements[0].exId;
  feed.noteWrite('diego', { wods: { '2026-11-03': p } });
  await timers.fire();
  assert.equal(exIdOf(), '1161');
  feed.noteWrite('diego', { wods: { '2026-11-03': p }, exMerged: { 1161: { into: '2142', _ts: 2 } } });
  await timers.fire();
  assert.equal(gh.puts().length, 2);
  assert.equal(exIdOf(), '2142');
  assert.equal(p.tracks[0].blocks[0].movements[0].exId, '1161');
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
  assert.match(gh.puts()[1].body.sha, /^sha\d+$/);   // the second write names the file it replaces
});

test('the push reads the sha first, and a 409 reads it again and retries once', async () => {
  const gh = fakeGitHub((n, method) => (n === 2 && method === 'PUT' ? gh.res(409, { message: 'is at abc but expected def' }) : null));
  await pushFeed({ repo: 'o/r', token: TOKEN, content: '{}', message: 'm', fetch: gh.fetch });
  assert.deepEqual(gh.calls.map(c => c.method), ['GET', 'PUT', 'GET', 'PUT']);
  assert.ok(gh.feed());
  // A second 409 is a failure, not a loop.
  const stuck = fakeGitHub((n, method) => (method === 'PUT' ? stuck.res(409, { message: 'conflict' }) : null));
  await assert.rejects(pushFeed({ repo: 'o/r', token: TOKEN, content: '{}', message: 'm', fetch: stuck.fetch }), /GitHub PUT feed.json 409: conflict/);
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
  assert.match(s.error, /GitHub GET feed.json: connect failed for Bearer \*\*\*/);
  assert.equal(s.errorAt, NOW);
  for (const text of [...lines, JSON.stringify(s)]) assert.ok(!text.includes(TOKEN), text);
  // A GitHub answer that is an error, with its message, is reported the same way.
  const err = await pushFeed({ repo: 'o/r', token: TOKEN, content: '{}', message: 'm',
    fetch: async () => ({ ok: false, status: 401, json: async () => ({ message: 'Bad credentials ' + TOKEN }) }) }).catch(e => e);
  assert.equal(err.message, 'GitHub GET feed.json 401: Bad credentials ***');
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

/* ---------- T40: the archive ---------- */

const JPEG = Buffer.from('a photo of the whiteboard').toString('base64');
const img = (dataDir, date, ext) => path.join(dataDir, 'box-images', `${date}.${ext}`);

test('keepBoxImage: only the publishing account, only while publishing is on; a newer one replaces any format', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'box-img-'));
  const keep = (over = {}) => keepBoxImage({ env: ENV, dataDir, uid: 'diego', date: '2026-11-03', image: { mime: 'image/jpeg', data: JPEG }, ...over });
  assert.equal(keep({ uid: 'someone-else' }), false);
  assert.equal(keep({ env: { ...ENV, BOX_FEED_TOKEN: '' } }), false);
  assert.equal(keep({ date: '../../etc' }), false);
  assert.equal(keep({ image: { mime: 'image/gif', data: JPEG } }), false);
  assert.ok(!fs.existsSync(path.join(dataDir, 'box-images')));
  assert.equal(keep(), true);
  assert.equal(fs.readFileSync(img(dataDir, '2026-11-03', 'jpg'), 'utf8'), 'a photo of the whiteboard');
  assert.equal(fs.statSync(img(dataDir, '2026-11-03', 'jpg')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dataDir, 'box-images')).mode & 0o777, 0o700);
  assert.equal(keep({ image: { mime: 'image/png', data: JPEG } }), true);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'box-images')), ['2026-11-03.png']);
});

test('the archive: every day, old ones too, with its photo; the index last; an unchanged publish pushes nothing', async () => {
  const { feed, timers, gh, dataDir, make } = setup();
  keepBoxImage({ env: ENV, dataDir, uid: 'diego', date: '2026-09-01', image: { mime: 'image/jpeg', data: JPEG } });
  const wods = { '2026-09-01': wod('long ago'), '2026-11-03': wod('today') };
  feed.noteWrite('diego', { wods });
  await timers.fire();
  // feed.json first, the index last of the writes; the photo before the day that names it.
  assert.deepEqual(gh.writes().map(c => c.file), ['feed.json', 'archive/2026-09-01.jpg', 'archive/2026-09-01.json', 'archive/2026-11-03.json', 'archive/index.json']);
  assert.deepEqual(gh.feed().programs.map(p => p.date), ['2026-11-03']);   // the window is still 14 days
  assert.equal(gh.feed().archive, 'archive/index.json');
  assert.deepEqual(gh.json('archive/2026-09-01.json'), { date: '2026-09-01', title: 'long ago', tracks: [{ label: 'A', kind: 'main', blocks: [] }], image: '2026-09-01.jpg' });
  assert.equal(gh.json('archive/2026-11-03.json').image, undefined);
  assert.deepEqual(gh.json('archive/index.json'), { v: 1, box: 'Holy Program', updatedAt: '2026-11-03T12:00:00.000Z', days: [
    { date: '2026-11-03', title: 'today', tracks: ['A'], image: false },
    { date: '2026-09-01', title: 'long ago', tracks: ['A'], image: true }
  ] });
  assert.equal(gh.files['archive/2026-09-01.jpg'].bytes.toString(), 'a photo of the whiteboard');
  // GitHub has the photo: the local copy is gone, and the archive still names it.
  assert.ok(!fs.existsSync(img(dataDir, '2026-09-01', 'jpg')));
  const n = gh.calls.length;
  feed.noteWrite('diego', { wods });
  await timers.fire();
  make().noteWrite('diego', { wods });   // after a restart too
  await timers.fire();
  assert.equal(gh.calls.length, n, 'an unchanged publish sends nothing at all');
});

test('the archive: a changed photo goes again, a deleted date takes its files, a format change drops the old photo', async () => {
  const { feed, timers, gh, dataDir } = setup();
  const photo = (date, text, mime = 'image/jpeg') => keepBoxImage({ env: ENV, dataDir, uid: 'diego', date, image: { mime, data: Buffer.from(text).toString('base64') } });
  photo('2026-10-01', 'first');
  photo('2026-10-02', 'other');
  const wods = { '2026-10-01': wod('a'), '2026-10-02': wod('b') };
  feed.noteWrite('diego', { wods });
  await timers.fire();
  const before = gh.writes().length;
  photo('2026-10-01', 'read again');
  feed.noteWrite('diego', { wods });
  await timers.fire();
  assert.deepEqual(gh.writes().slice(before).map(c => c.file), ['archive/2026-10-01.jpg']);
  assert.equal(gh.files['archive/2026-10-01.jpg'].bytes.toString(), 'read again');
  // The same photo again: its blob sha is what the repo holds, so it is not sent.
  photo('2026-10-01', 'read again');
  feed.noteWrite('diego', { wods });
  await timers.fire();
  assert.equal(gh.writes().length, before + 1);
  assert.ok(!fs.existsSync(img(dataDir, '2026-10-01', 'jpg')));
  // A png for the day: the jpg goes, after the index has stopped naming it.
  const mid = gh.writes().length;
  photo('2026-10-01', 'png now', 'image/png');
  feed.noteWrite('diego', { wods });
  await timers.fire();
  assert.deepEqual(gh.writes().slice(mid).map(c => [c.method, c.file]), [
    ['PUT', 'archive/2026-10-01.png'], ['PUT', 'archive/2026-10-01.json'], ['DELETE', 'archive/2026-10-01.jpg']
  ]);
  assert.equal(gh.json('archive/2026-10-01.json').image, '2026-10-01.png');
  // Deleting 10-02: the index first, then its day and its photo.
  const end = gh.writes().length;
  feed.noteWrite('diego', { wods: { ...wods, '2026-10-02': { _ts: 9 } } });
  await timers.fire();
  assert.deepEqual(gh.writes().slice(end).map(c => [c.method, c.file]), [
    ['PUT', 'archive/index.json'], ['DELETE', 'archive/2026-10-02.jpg'], ['DELETE', 'archive/2026-10-02.json']
  ]);
  assert.deepEqual(gh.json('archive/index.json').days.map(d => d.date), ['2026-10-01']);
  assert.deepEqual(Object.keys(gh.files).sort(), ['archive/2026-10-01.json', 'archive/2026-10-01.png', 'archive/index.json', 'feed.json']);
});

test('the archive: a photo over 2 MB is left out and logged; the token is in no log, status or error', async () => {
  let down = true;
  const { feed, timers, gh, dataDir, lines } = setup({
    script: (n, method, body, file) => (down && file === 'archive/2026-10-02.json' && method === 'PUT' ? gh.res(500, { message: 'boom ' + TOKEN }) : null)
  });
  fs.mkdirSync(path.join(dataDir, 'box-images'), { recursive: true });
  fs.writeFileSync(img(dataDir, '2026-10-01', 'jpg'), Buffer.alloc(2 * 1024 * 1024 + 1));
  feed.noteWrite('diego', { wods: { '2026-10-01': wod('a'), '2026-10-02': wod('b') } });
  await timers.fire();
  assert.ok(lines.some(l => /photo for 2026-10-01 is over 2 MB/.test(l)), lines.join('\n'));
  assert.ok(!gh.calls.some(c => c.file.endsWith('.jpg')));
  assert.ok(fs.existsSync(img(dataDir, '2026-10-01', 'jpg')), 'not pushed, so not deleted');
  // The failed day stops the run: no index yet. What went out is not sent again on the retry.
  assert.equal(gh.json('archive/index.json'), null);
  assert.match(feed.status().error, /GitHub PUT archive\/2026-10-02.json 500: boom \*\*\*/);
  const sent = gh.puts('*').length;
  down = false;
  await timers.fire();
  assert.deepEqual(gh.puts('*').slice(sent).map(c => c.file), ['archive/2026-10-02.json', 'archive/index.json']);
  assert.equal(gh.json('archive/2026-10-01.json').image, undefined);
  for (const text of [...lines, JSON.stringify(feed.status()), fs.readFileSync(path.join(dataDir, 'box-feed.json'), 'utf8')]) assert.ok(!text.includes(TOKEN), text);
});

test('blobSha is git\'s', () => {
  // `printf 'hello\n' | git hash-object --stdin`
  assert.equal(blobSha(Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
});
