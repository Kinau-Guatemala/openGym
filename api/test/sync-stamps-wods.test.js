/* The CrossFit maps in PUT /api/data's stamping (sync-stamps.js): S.wods (a program per date) and
   S.exAliases (a movement name's exercise) are stamped maps the app merges per key, so the server
   never stamps them as a whole setting (critique C1), keeps a clear an older app does not know
   about, and prunes programs older than WODS_KEEP_DAYS on every write. The two-device merges on
   top of this are in frontend/src/lib/wods.test.js. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OWN_MERGE, STAMPED_MAPS, WODS_KEEP_DAYS, pruneWods, stampPut } from '../sync-stamps.js';

const clone = v => JSON.parse(JSON.stringify(v));
const T = 1_800_000_000_000;
const NOW = Date.UTC(2026, 9, 24, 12);
const doc = (over = {}) => ({ _ts: T, _rev: 1, unit: 'kg', restSec: 90, workouts: [], routines: [], wods: {}, exAliases: {}, ...over });
const put = (cur, next, opts = {}) => { stampPut(cur, next, { now: NOW, ...opts }); return next; };

test('both maps are merged on their own, never as a setting', () => {
  for (const k of ['wods', 'exAliases']) { assert.ok(OWN_MERGE.has(k)); assert.ok(STAMPED_MAPS.includes(k)); }
  assert.equal(WODS_KEEP_DAYS, 120);
});

test('a writer that does not stamp changing either map gets no edited.wods or edited.exAliases', () => {
  const cur = doc({ wods: { '2026-10-23': { title: 'A', _ts: T + 10 } } });
  const next = clone(cur); delete next._rev;
  next.wods['2026-10-24'] = { title: 'B', _ts: T + 20 };
  next.exAliases = { t2b: { exId: '0099', _ts: T + 20 } };
  next.restSec = 60;
  put(cur, next, { overRead: true });
  assert.equal(next.edited?.wods, undefined);
  assert.equal(next.edited?.exAliases, undefined);
  assert.ok(next.edited?.restSec > 0);   // a plain setting still is
  assert.equal(next._prior?.wods, undefined);
  assert.deepEqual(Object.keys(next.wods).sort(), ['2026-10-23', '2026-10-24']);
});

test('the same date is stored as the writer sent it: the later stamp is not lowered', () => {
  const cur = doc({ wods: { '2026-10-23': { title: 'Old', _ts: T + 10 } } });
  const next = clone(cur); next.wods['2026-10-23'] = { title: 'New', _ts: T + 50 };
  put(cur, next, { overRead: true, stamped: true });
  assert.deepEqual(next.wods['2026-10-23'], { title: 'New', _ts: T + 50 });
});

test('an older app that leaves the maps out keeps the stored ones, clears included', () => {
  const cur = doc({ wods: { '2026-10-23': { _ts: T + 20 }, '2026-10-22': { title: 'A', _ts: T + 5 } }, exAliases: { t2b: { _ts: T + 20 } } });
  const old = clone(cur); delete old.wods; delete old.exAliases; delete old._rev; old.restSec = 60;
  put(cur, old, { overRead: true });
  assert.deepEqual(old.wods, cur.wods);
  assert.deepEqual(old.exAliases, cur.exAliases);
});

test('programs older than 120 days are pruned on every write, by the server\'s clock', () => {
  const sent = () => doc({ wods: { '2026-06-01': { _ts: 1 }, '2026-06-26': { _ts: 2 }, '2026-10-20': { _ts: 3 } } });
  for (const [cur, opts] of [[null, {}], [doc(), { overRead: true }], [doc(), { stamped: true }], [doc(), { overRead: true, stamped: true }]]) {
    assert.deepEqual(Object.keys(put(cur, sent(), opts).wods), ['2026-06-26', '2026-10-20']);
  }
  assert.deepEqual(Object.keys(put(doc(), { ...sent(), resetAt: T + 1 }).wods), ['2026-06-26', '2026-10-20']);
  // a stamp far in the future (a device clock ahead) lifts the stamps, not today
  const ahead = sent(); ahead.wods['2026-10-20']._ts = NOW + 400 * 86400000;
  assert.deepEqual(Object.keys(put(doc(), ahead, { stamped: true }).wods), ['2026-06-26', '2026-10-20']);
  assert.deepEqual(pruneWods({ x: 1, '2026-10-20': 2 }, '2026-10-24'), { '2026-10-20': 2 });
});
