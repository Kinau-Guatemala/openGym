/* The fork's movement-name picks moved from S.exAliases to S.wodAliases when upstream took
   exAliases for its own exercise aliases ({ [exId]: [names] }). A phone still on 1.4.1-kinau.N
   keeps sending its picks under the old name and knows nothing of wodAliases: the server moves
   them (sync-stamps.js migrateWodAliases), keeps upstream's arrays, and never loses a pick made
   on a new build. The app's side is in frontend/src/lib/wods.test.js. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';
import { migrateWodAliases, stampPut } from '../sync-stamps.js';

const clone = v => JSON.parse(JSON.stringify(v));
const T = 1_800_000_000_000;

test('a mixed exAliases splits: object entries are picks and move, arrays stay', () => {
  const S = { exAliases: { '1162': ['Zentara lift'], 'hang cleans': { exId: '1234', _ts: T }, row: { _ts: T + 1 }, '0025': [] } };
  assert.equal(migrateWodAliases(S), true);
  assert.deepEqual(S.exAliases, { '1162': ['Zentara lift'], '0025': [] });
  assert.deepEqual(S.wodAliases, { 'hang cleans': { exId: '1234', _ts: T }, row: { _ts: T + 1 } });
});

test('a second run changes nothing', () => {
  const S = { exAliases: { a: ['A'], 'hang cleans': { exId: '1234', _ts: T } } };
  migrateWodAliases(S);
  const once = clone(S);
  assert.equal(migrateWodAliases(S), false);
  assert.deepEqual(S, once);
});

test('a name already in wodAliases keeps the later _ts, and wodAliases on a tie', () => {
  const S = {
    exAliases: { newer: { exId: 'old-build', _ts: T + 5 }, older: { exId: 'old-build', _ts: T }, tie: { exId: 'old-build', _ts: T } },
    wodAliases: { newer: { exId: 'new-build', _ts: T }, older: { exId: 'new-build', _ts: T + 5 }, tie: { exId: 'new-build', _ts: T } }
  };
  migrateWodAliases(S);
  assert.deepEqual(S.wodAliases, {
    newer: { exId: 'old-build', _ts: T + 5 }, older: { exId: 'new-build', _ts: T + 5 }, tie: { exId: 'new-build', _ts: T }
  });
  assert.deepEqual(S.exAliases, {});
});

test('stampPut: an old build\'s push leaves upstream\'s arrays and the new build\'s picks in place', () => {
  const cur = { _ts: T, _rev: 3, exAliases: { '1162': ['Zentara lift'] }, wodAliases: { t2b: { exId: '0099', _ts: T + 20 } }, workouts: [], routines: [] };
  // The old build's own copy: its pick under the old name, no wodAliases, no array (worst case).
  const next = { _ts: T + 40, exAliases: { 'hang cleans': { exId: '1234', _ts: T + 30 } }, workouts: [], routines: [] };
  stampPut(cur, next, { stamped: true, overRead: true, now: T + 50 });
  assert.deepEqual(next.exAliases, { '1162': ['Zentara lift'] });
  assert.deepEqual(next.wodAliases, { t2b: { exId: '0099', _ts: T + 20 }, 'hang cleans': { exId: '1234', _ts: T + 30 } });
  assert.deepEqual(cur.exAliases, { '1162': ['Zentara lift'] }, 'the stored copy is not touched');
});

test('stampPut: a file the old build wrote is read with its picks moved', () => {
  const cur = { _ts: T, _rev: 3, exAliases: { t2b: { exId: '0099', _ts: T + 20 } }, workouts: [], routines: [] };
  const next = { _ts: T + 40, exAliases: { '1162': ['Zentara lift'] }, wodAliases: {}, workouts: [], routines: [] };
  stampPut(cur, next, { stamped: true, overRead: true, now: T + 50 });
  assert.deepEqual(next.wodAliases, { t2b: { exId: '0099', _ts: T + 20 } });
  assert.deepEqual(next.exAliases, { '1162': ['Zentara lift'] });
  assert.deepEqual(cur.exAliases, { t2b: { exId: '0099', _ts: T + 20 } }, 'the stored copy is not touched');
});

/* ---------- the round trip through the real server ---------- */

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');
const UID = 'u_alias_1';
function mintSession(uid) {
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
const headers = { Cookie: `gymsid=${mintSession(UID)}`, 'Content-Type': 'application/json' };

test('PUT /api/data from 1.4.1-kinau.4: CAS holds, the picks move, nothing of the new build is lost', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-alias-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [{ id: UID, name: 'One', created: new Date().toISOString() }], creds: [], subs: [], invites: []
  }));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' }
  });
  let log = '';
  child.stdout.on('data', d => log += d);
  child.stderr.on('data', d => log += d);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${await boundPort(child, () => log)}`;
  const get = async () => (await fetch(`${base}/api/data`, { headers })).json();
  const put = async body => { const r = await fetch(`${base}/api/data`, { method: 'PUT', headers, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

  // The new build writes first: an upstream alias and a pick, each where it belongs now.
  let r = await put({ state: { _ts: T, workouts: [], routines: [], exAliases: { '1162': ['Zentara lift'] }, wodAliases: { t2b: { exId: '0099', _ts: T + 20 } } }, baseRev: 0, stamped: true });
  assert.equal(r.status, 200);
  const { rev } = await get();

  // The old phone pushes over a revision it no longer has: refused, the current copy comes back.
  const old = { _ts: T + 40, workouts: [], routines: [], exAliases: { 'hang cleans': { exId: '1234', _ts: T + 30 } } };
  r = await put({ state: old, baseRev: rev - 1, stamped: true });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body.state.wodAliases, { t2b: { exId: '0099', _ts: T + 20 } });

  // Its merge kept the arrays (a stamped map to it) and left wodAliases out (unknown to it).
  r = await put({ state: { ...old, exAliases: { ...old.exAliases, '1162': ['Zentara lift'] } }, baseRev: rev, stamped: true });
  assert.equal(r.status, 200);
  let S = (await get()).state;
  assert.deepEqual(S.exAliases, { '1162': ['Zentara lift'] });
  assert.deepEqual(S.wodAliases, { t2b: { exId: '0099', _ts: T + 20 }, 'hang cleans': { exId: '1234', _ts: T + 30 } });

  // Its next push again carries its pick under the old name (its own copy still has it there),
  // this time without the array: the array stays, the pick does not move twice.
  r = await put({ state: { ...old, _ts: T + 60 }, baseRev: S._rev, stamped: true });
  assert.equal(r.status, 200);
  S = (await get()).state;
  assert.deepEqual(S.exAliases, { '1162': ['Zentara lift'] });
  assert.deepEqual(S.wodAliases, { t2b: { exId: '0099', _ts: T + 20 }, 'hang cleans': { exId: '1234', _ts: T + 30 } });
});
