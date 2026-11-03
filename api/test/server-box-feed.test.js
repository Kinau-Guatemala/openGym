/* The box feed through a real server.js: which callers learn about it, who sees its status, and
   that another account's save arms nothing. The publishing account has no state file, so the boot
   check has nothing to push, and BOX_FEED_API points at a port nobody listens on: whatever this
   test does, no request can reach GitHub. Real server.js in a child. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');
const TOKEN = 'github_pat_SERVERTEST';
const PUBLISHER = 'u_box_1', ADMIN = 'u_adm_1', MEMBER = 'u_mem_1';
const URL = 'https://raw.githubusercontent.com/Kinau-Guatemala/holy-wods/main/feed.json';

// Same construction as server.js makeSession(): payload `uid:exp:sv`, HMAC-SHA256 over SECRET.
function mintSession(uid) {
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
const as = uid => ({ Cookie: `gymsid=${mintSession(uid)}`, 'Content-Type': 'application/json', Origin: 'http://localhost:8080' });

async function startServer(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-boxfeed-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  const user = id => ({ id, name: id, created: new Date().toISOString() });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: [user(PUBLISHER), user(ADMIN), user(MEMBER)], creds: [], subs: [], invites: [] }));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost', ADMIN_UIDS: ADMIN,
      BOX_FEED_UID: PUBLISHER, BOX_FEED_REPO: 'Kinau-Guatemala/holy-wods', BOX_FEED_TOKEN: TOKEN, BOX_FEED_NAME: 'Holy Program',
      BOX_FEED_API: 'http://127.0.0.1:9'
    }
  });
  const h = { log: '' };
  child.stdout.on('data', d => h.log += d);
  child.stderr.on('data', d => h.log += d);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const api = `http://127.0.0.1:${await boundPort(child, () => h.log)}`;
  h.call = async (p, headers = {}, init = {}) => { const r = await fetch(api + p, { headers, ...init }); return { status: r.status, body: await r.json() }; };
  return h;
}

test('the box feed: config for the publisher only, status for admins only, only the publisher\'s save arms a push', async t => {
  const h = await startServer(t);

  assert.deepEqual((await h.call('/api/config', as(PUBLISHER))).body.boxFeed, { url: URL });
  for (const headers of [as(MEMBER), as(ADMIN), {}]) assert.ok(!('boxFeed' in (await h.call('/api/config', headers)).body));

  const status = await h.call('/api/admin/box-feed', as(ADMIN));
  assert.equal(status.status, 200);
  assert.deepEqual(status.body, { on: true, repo: 'Kinau-Guatemala/holy-wods', url: URL, pushedAt: null, error: null, errorAt: null, pending: false });
  assert.equal((await h.call('/api/admin/box-feed', as(MEMBER))).status, 403);
  assert.equal((await h.call('/api/admin/box-feed', as(PUBLISHER))).status, 403);
  assert.equal((await h.call('/api/admin/box-feed')).status, 401);

  const put = await h.call('/api/data', as(MEMBER), { method: 'PUT', body: JSON.stringify({ state: { wods: { '2026-11-03': { title: 'mine', tracks: [], _ts: 1 } }, unit: 'kg' } }) });
  assert.equal(put.status, 200);
  assert.equal((await h.call('/api/admin/box-feed', as(ADMIN))).body.pending, false);
  // The publisher's own save does arm one (it would go to the dead BOX_FEED_API in 30 s).
  assert.equal((await h.call('/api/data', as(PUBLISHER), { method: 'PUT', body: JSON.stringify({ state: { wods: {}, unit: 'kg' } }) })).status, 200);
  assert.equal((await h.call('/api/admin/box-feed', as(ADMIN))).body.pending, true);

  assert.ok(!h.log.includes(TOKEN), 'the token is in the server log');
});
