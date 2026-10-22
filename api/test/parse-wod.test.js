/* parse-wod: a routine image read into a program, with nothing but the image and its date
   leaving the server. Driven end to end through the real routes, queue and pipeline; the
   provider is the fixture CLI or a local server speaking Anthropic's or OpenAI's shape, so the
   exact request that would have left can be read back. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { tempData, writeState, sampleState } from './helpers.mjs';

const DIR = tempData();
const cfg = await import('../coach/config.js');
const jobs = await import('../coach/jobs.js');
const { coachRoutes } = await import('../coach/routes.js');
const { validateWod } = await import('../coach/core/validate.js');
const { taskOf } = await import('../coach/core/prompt.js');
const { attemptOnce } = await import('../coach/core/pipeline.js');
const { PROMPTS } = await import('../coach/core/prompts.js');
const { CONSENT_VERSION } = await import('../coach/core/categories.js');
const { anthropicSpec } = await import('../coach/core/adapters/anthropic.js');
const { openaiSpec } = await import('../coach/core/adapters/openai.js');
const { compatibleSpec } = await import('../coach/core/adapters/compatible.js');
const { SYSTEM_PROMPT } = await import('../coach/core/system-prompt.js');
const { forcePrivilegeVerdict } = await import('../coach/adapters/spawn.js');

forcePrivilegeVerdict({ ok: true, dropped: false, why: 'pinned by the test suite' });
const FIXTURE_WOD = JSON.parse(fs.readFileSync(new URL('../coach/fixture-wod.json', import.meta.url), 'utf8'));

// A base64 string nobody else would write, so "is it on disk" is a plain substring search.
const IMAGE = Buffer.from('openGym parse-wod test image '.repeat(200)).toString('base64');
const DATE = '2026-10-22';
const consented = (over = {}) => sampleState({ coach: { consent: { agreedAt: new Date().toISOString(), version: CONSENT_VERSION }, profile: { goal: 'muscle', limitations: 'zz-private-knee-note' } }, ...over });

function routesFor(uid) {
  const routes = coachRoutes({
    json: (res, status, body) => { res.status = status; res.body = body; },
    readBody: async req => req.body || {},
    readSession: () => ({ id: uid }),
    requireAdmin: () => true
  });
  return async (key, body) => { const res = {}; await routes[key]({ body }, res); return res; };
}
async function settle(uid, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const s = jobs.status(uid);
    if (!s.job) return s;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error('job never finished');
}
function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? filesUnder(p) : [p];
  });
}
const parseBody = { date: DATE, mime: 'image/jpeg', image: IMAGE };

/* ---------- the fixture, end to end ---------- */

test('fixture: 202, then status shows a checked program in `parsed`, and the ack clears it', async () => {
  cfg.save({ enabled: true, provider: 'fixture' });
  const uid = 'u-fixture';
  writeState(DIR, uid, consented());
  const pushed = [];
  jobs.setProposalHook((...a) => pushed.push(a));
  try {
    const call = routesFor(uid);
    const r = await call('POST /api/coach/parse-wod', parseBody);
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(jobs.status(uid).job.kind, 'parse-wod');
    const s = await settle(uid);
    assert.equal(s.parsed.jobId, r.body.job.id);
    assert.equal(s.parsed.date, DATE);
    assert.ok(validateWod(s.parsed.program).ok, 'the stored program passes the validator again');
    assert.deepEqual(s.parsed.program.tracks.map(t => [t.id, t.kind]), [['full', 'main'], ['running', 'extra'], ['conditioning', 'extra']]);
    assert.equal(s.parsed.program.tracks[0].blocks[0].warmup, true);
    assert.ok(s.parsed.program.tracks.every(t => t.blocks.every(b => b.movements.every(m => m.exId === null && m.rawName))));
    assert.equal(s.pending, null, 'a read image is never a proposal');
    assert.equal(s.last.kind, 'parse-wod');
    assert.equal(s.last.outcome, 'ready');
    assert.deepEqual(pushed, [], 'no "proposal ready" push for a parse');

    // An ack for some other job leaves it; the right one clears it.
    assert.equal((await call('POST /api/coach/parsed/ack', { jobId: 'not-this-one' })).status, 200);
    assert.ok(jobs.status(uid).parsed);
    await call('POST /api/coach/parsed/ack', { jobId: r.body.job.id });
    assert.equal(jobs.status(uid).parsed, null);
  } finally { jobs.setProposalHook(null); }
});

test('fixture: an answer the validator rejects gets the one repair round', async () => {
  cfg.save({ enabled: true, provider: 'fixture' });
  const uid = 'u-repair';
  writeState(DIR, uid, consented());
  process.env.FIXTURE_MODE = 'invalid-then-valid';
  try {
    jobs.enqueue(uid, { kind: 'parse-wod', date: DATE, image: { mime: 'image/jpeg', data: IMAGE } });
    const s = await settle(uid);
    assert.ok(s.parsed, JSON.stringify(s.last));
  } finally { delete process.env.FIXTURE_MODE; }
});

/* ---------- the route's input checks ---------- */

test('the route refuses a bad date, a mime outside the allowlist and anything that is not bounded base64', async () => {
  cfg.save({ enabled: true, provider: 'fixture' });
  const uid = 'u-input';
  writeState(DIR, uid, consented());
  const call = routesFor(uid);
  for (const bad of [
    { ...parseBody, date: '22/10/2026' },
    { ...parseBody, date: '2026-02-30' },
    { ...parseBody, date: undefined },
    { ...parseBody, mime: 'image/gif' },
    { ...parseBody, mime: 'text/html' },
    { ...parseBody, image: '' },
    { ...parseBody, image: 'not base64 at all!' },
    { ...parseBody, image: 'A'.repeat(4_000_004) }
  ]) {
    const r = await call('POST /api/coach/parse-wod', bad);
    assert.equal(r.status, 400, JSON.stringify(bad).slice(0, 80));
  }
  assert.equal(jobs.status(uid).job, null, 'nothing was queued');
  assert.equal(jobs.capState(uid).used, 0, 'and nothing was spent');
});

/* ---------- consent and providers ---------- */

test('a parse needs consent at the current version; plan jobs keep accepting an older one', async () => {
  cfg.save({ enabled: true, provider: 'fixture' });
  const uid = 'u-oldconsent';
  writeState(DIR, uid, sampleState({ coach: { consent: { agreedAt: new Date().toISOString(), version: CONSENT_VERSION - 1 }, profile: { goal: 'muscle' } } }));
  const r = await routesFor(uid)('POST /api/coach/parse-wod', parseBody);
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'consent');
  jobs.enqueue(uid, { kind: 'review' });
  await settle(uid);
});

test('a provider that cannot read images is refused before anything is spent', () => {
  cfg.save({ enabled: true, provider: 'compatible', providerOptions: { compatible: { baseUrl: 'http://127.0.0.1:9' } }, models: { compatible: 'm' } });
  const uid = 'u-unsupported';
  writeState(DIR, uid, consented());
  try {
    assert.throws(() => jobs.enqueue(uid, { kind: 'parse-wod', date: DATE, image: { mime: 'image/jpeg', data: IMAGE } }), e => e.code === 'unsupported');
    assert.equal(jobs.capState(uid).used, 0);
  } finally { cfg.save({ provider: 'fixture' }); }
});

/* ---------- no kind falls back to a plan ---------- */

test('an unknown kind fails loudly at every switch, and never becomes a plan', async () => {
  cfg.save({ enabled: true, provider: 'fixture' });
  const uid = 'u-madeup';
  writeState(DIR, uid, consented());
  assert.throws(() => jobs.enqueue(uid, { kind: 'made-up' }), e => !(e instanceof jobs.CoachError) && /unknown Coach job kind/.test(e.message));
  assert.equal(jobs.status(uid).job, null);
  assert.equal(jobs.capState(uid).used, 0);
  assert.throws(() => taskOf('made-up', {}), /unknown Coach job kind/);
  assert.throws(() => taskOf(undefined, {}), /unknown Coach job kind/);
  let invoked = false;
  const adapter = { spawns: false, invoke: async () => { invoked = true; return { code: 0, text: '{}' }; } };
  await assert.rejects(attemptOnce({ adapter, cfg: {}, kind: 'made-up', payload: {} }, null), /unknown Coach job kind/);
  assert.equal(invoked, false, 'no provider is called for a kind nobody defined');
});

test('parse-wod gets its own prompt, without the coaching rules', () => {
  assert.equal(taskOf('parse-wod', { task: 'parse-wod' }), 'parse-wod');
  let sent;
  const adapter = { spawns: false, invoke: async o => { sent = o; return { code: 0, text: JSON.stringify(FIXTURE_WOD) }; } };
  return attemptOnce({ adapter, cfg: {}, kind: 'parse-wod', payload: { task: 'parse-wod', date: DATE, lang: null } }, null).then(r => {
    assert.ok(r.ok);
    assert.equal(sent.system, PROMPTS['parse-wod']);
    assert.ok(!sent.system.includes(PROMPTS.common.slice(0, 60)));
    assert.equal(sent.schema.required[0], 'tracks');
  });
});

/* ---------- what actually leaves: a local Anthropic and a local OpenAI ---------- */

async function provider(answer) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, body: JSON.parse(body || '{}') });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(answer(JSON.stringify(FIXTURE_WOD))));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { seen, base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
const payloadIn = text => JSON.parse(/```json\s*([\s\S]*?)```/.exec(text)[1]);
const NEVER = ['plan', 'history', 'window', 'aggregates', 'bodyweight', 'coachProfile', 'profile', 'library', 'session', 'previous', 'cohort', 'userNote', 'conversation', 'meta', 'handle'];

for (const [id, answer, readUser] of [
  ['anthropic', text => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' }), body => {
    const content = body.messages[0].content;
    assert.deepEqual(content[0], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: IMAGE } });
    assert.equal(content[1].type, 'text');
    assert.equal(content.length, 2);
    return content[1].text;
  }],
  ['openai', text => ({ choices: [{ finish_reason: 'stop', message: { content: text } }] }), body => {
    const content = body.messages[1].content;
    assert.deepEqual(content[0], { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${IMAGE}` } });
    assert.equal(content[1].type, 'text');
    assert.equal(content.length, 2);
    return content[1].text;
  }]
]) {
  test(`${id}: only the image, the date and the language leave; a waiting proposal survives; nothing lands on disk`, async () => {
    const p = await provider(answer);
    cfg.save({ enabled: true, provider: id, providerOptions: { [id]: { baseUrl: p.base } } });
    cfg.saveAuth(id, { type: 'apikey', data: cfg.encrypt({ token: 'sk-test' }), connectedAt: new Date().toISOString() });
    const uid = 'u-' + id;
    writeState(DIR, uid, consented());
    // A plan proposal the person has not answered yet: a parse must not touch it.
    const pending = { id: 'p1', kind: 'review', createdAt: Date.now(), expiresAt: Date.now() + 86400000, summary: 'waiting', changes: [] };
    fs.mkdirSync(path.join(DIR, 'coach'), { recursive: true });
    fs.writeFileSync(path.join(DIR, 'coach', uid + '.json'), JSON.stringify({ pending, history: [] }));
    try {
      const r = await routesFor(uid)('POST /api/coach/parse-wod', { ...parseBody, lang: 'es' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      const s = await settle(uid);
      assert.ok(s.parsed, JSON.stringify(s.last));
      assert.deepEqual(s.pending, pending, 'the waiting proposal is untouched');

      assert.equal(p.seen.length, 1);
      const payload = payloadIn(readUser(p.seen[0].body));
      assert.deepEqual(payload, { task: 'parse-wod', date: DATE, lang: 'es' });
      for (const k of NEVER) assert.ok(!(k in payload), `${k} must not leave with a parse`);
      const wire = JSON.stringify(p.seen[0].body);
      for (const leak of ['Full body A', '"0001"', '78.5', 'zz-private-knee-note']) assert.ok(!wire.includes(leak), `${leak} must not leave with a parse`);

      for (const f of filesUnder(DIR)) {
        assert.ok(!fs.readFileSync(f, 'utf8').includes(IMAGE.slice(0, 200)), `${path.relative(DIR, f)} holds the image`);
      }
    } finally {
      p.close();
      cfg.saveAuth(id, null);
      cfg.save({ provider: 'fixture' });
    }
  });
}

/* ---------- the adapters: an image part only when there is an image ---------- */

test('without images the request bodies are byte-identical to before; with them, the documented shapes', () => {
  const sys = JSON.stringify(SYSTEM_PROMPT + '\n\nS').slice(1, -1);
  const bare = JSON.stringify(SYSTEM_PROMPT).slice(1, -1);
  const a = { model: 'm', prompt: 'P', system: 'S', schema: { type: 'object' }, maxTokens: 100 };
  const b = { model: 'm', prompt: 'P', system: null, schema: null, maxTokens: 100 };
  // Captured from main before the image channel existed.
  const before = {
    anthropic: [
      `{"model":"m","max_tokens":100,"system":[{"type":"text","text":"${sys}","cache_control":{"type":"ephemeral"}}],"messages":[{"role":"user","content":"P"}]}`,
      `{"model":"m","max_tokens":100,"system":"${bare}","messages":[{"role":"user","content":"P"}]}`
    ],
    openai: [
      `{"model":"m","messages":[{"role":"system","content":"${sys}"},{"role":"user","content":"P"}],"response_format":{"type":"json_schema","json_schema":{"name":"coach_answer","schema":{"type":"object"}}},"max_completion_tokens":100}`,
      `{"model":"m","messages":[{"role":"system","content":"${bare}"},{"role":"user","content":"P"}],"response_format":{"type":"json_object"},"max_completion_tokens":100}`
    ],
    compatible: [
      `{"model":"m","messages":[{"role":"system","content":"${sys}"},{"role":"user","content":"P"}],"temperature":0,"response_format":{"type":"json_schema","json_schema":{"name":"coach_answer","schema":{"type":"object"}}},"max_tokens":100}`,
      `{"model":"m","messages":[{"role":"system","content":"${bare}"},{"role":"user","content":"P"}],"temperature":0,"response_format":{"type":"json_object"},"max_tokens":100}`
    ]
  };
  for (const [id, spec] of [['anthropic', anthropicSpec], ['openai', openaiSpec], ['compatible', compatibleSpec]]) {
    assert.equal(JSON.stringify(spec.body(a)), before[id][0], id);
    assert.equal(JSON.stringify(spec.body(b)), before[id][1], id);
  }
  const img = [{ mime: 'image/png', data: 'AAAA' }];
  assert.deepEqual(anthropicSpec.body({ ...a, images: img }).messages, [{ role: 'user', content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'text', text: 'P' }
  ] }]);
  assert.deepEqual(openaiSpec.body({ ...a, images: img }).messages[1], { role: 'user', content: [
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }, { type: 'text', text: 'P' }
  ] });
});

/* ---------- the validator ---------- */

test('validateWod: shape, bounds and rawName, with ids assigned and exId always null', () => {
  assert.deepEqual(validateWod({ title: null, tracks: [] }), { ok: true, proposal: { program: { title: null, tracks: [] } } }, 'no workout in the image is a valid answer');
  const ok = validateWod(FIXTURE_WOD);
  assert.ok(ok.ok, JSON.stringify(ok.errors));
  const mv = ok.proposal.program.tracks[0].blocks[1].movements[0];
  assert.deepEqual(mv.alts.map(a => [a.exId, a.rawName]), [[null, 'ski'], [null, 'bike']]);
  assert.equal(mv.id, 'm0');

  const move = over => ({ tracks: [{ id: 'full', label: 'Full', kind: 'main', blocks: [{ label: 'WOD', format: 'amrap', movements: [{ raw: 'x', rawName: 'x', name: 'x', dose: { reps: 5 }, ...over }] }] }] });
  const errs = v => validateWod(v).errors || [];
  assert.match(errs(move({ rawName: '' })).join(), /rawName is required/);
  assert.match(errs(move({ dose: { reps: -1 } })).join(), /dose\.reps/);
  assert.match(errs(move({ rx: { male: { w: 185 } } })).join(), /rx\.male/);
  assert.ok(validateWod(move({ rx: { male: { w: 185, unit: 'lb' }, female: { w: 135, unit: 'lb' } }, exId: 'smuggled' })).ok);
  assert.equal(validateWod(move({ exId: 'smuggled' })).proposal.program.tracks[0].blocks[0].movements[0].exId, null);
  assert.match(errs({ tracks: [{ label: 'x', kind: 'side', blocks: [] }] }).join(), /kind must be/);
  assert.match(errs({ tracks: [{ label: 'x', kind: 'main', blocks: [{ label: 'b', format: 'yoga', movements: [] }] }] }).join(), /format must be/);
  assert.match(errs({ tracks: Array.from({ length: 7 }, () => ({ label: 'x', kind: 'main', blocks: [] })) }).join(), /at most 6/);
  assert.match(errs({ tracks: [{ label: 'x', kind: 'main', blocks: Array.from({ length: 13 }, () => ({ label: 'b', format: 'other', movements: [] })) }] }).join(), /at most 12/);
  assert.match(errs(move({})).join() + errs({ tracks: [{ label: 'x', kind: 'main', blocks: [{ label: 'b', format: 'other', movements: Array.from({ length: 21 }, () => ({ rawName: 'x' })) }] }] }).join(), /at most 20/);
  assert.match(errs({ nope: 1 }).join(), /tracks must be an array/);
  // A sex-split dose rides beside `dose`, on the movement and on each alternative, and only when there is one.
  const only = v => v.proposal.program.tracks[0].blocks[0].movements[0];
  const split = only(validateWod(move({ dose: { cal: 20 }, doseFemale: { cal: 15 }, alts: [{ rawName: 'ski', dose: { cal: 20 }, doseFemale: { cal: 15 } }, { rawName: 'bike', dose: { m: 500 } }] })));
  assert.deepEqual(split.dose, { cal: 20 });
  assert.deepEqual(split.doseFemale, { cal: 15 });
  assert.deepEqual(split.alts[0].doseFemale, { cal: 15 });
  assert.ok(!('doseFemale' in split.alts[1]), 'a per-alternative dose is not a split');
  assert.ok(!('doseFemale' in only(validateWod(move({})))), 'absent unless printed');
  assert.ok(!('doseFemale' in only(validateWod(move({ doseFemale: {} })))), 'an empty split is no split');
  assert.match(errs(move({ doseFemale: { cal: -3 } })).join(), /doseFemale\.cal must be a number/);
  assert.match(errs(move({ doseFemale: 15 })).join(), /doseFemale must be an object/);
  assert.match(errs(move({ alts: [{ rawName: 'ski', doseFemale: { cal: 'x' } }] })).join(), /alts\.doseFemale\.cal/);
  const fixtureRow = ok.proposal.program.tracks[0].blocks[1].movements[0];
  assert.deepEqual([fixtureRow.dose, fixtureRow.doseFemale], [{ cal: 20 }, { cal: 15 }], '20/15 Cal Row/Ski/Bike in the fixture');
  // Track ids stay unique when a fallback id is one the model already used.
  const ids = v => validateWod({ tracks: v.map(id => ({ id, label: 'x', kind: 'main', blocks: [] })) }).proposal.program.tracks.map(t => t.id);
  assert.deepEqual(ids(['t1', 'Full Equipment']), ['t1', 't2']);
  assert.deepEqual(ids(['Full Equipment', 't0', 'full', 'full']), ['t0', 't1', 'full', 't3']);
  const long = validateWod(move({ rawName: 'y'.repeat(500) })).proposal.program.tracks[0].blocks[0].movements[0];
  assert.equal(long.rawName.length, 80, 'strings are clipped');
});

/* ---------- forget ---------- */

test('forgetting a profile clears a read program too', async () => {
  cfg.save({ enabled: true, provider: 'fixture' });
  const uid = 'u-forget';
  writeState(DIR, uid, consented());
  jobs.enqueue(uid, { kind: 'parse-wod', date: DATE, image: { mime: 'image/jpeg', data: IMAGE } });
  assert.ok((await settle(uid)).parsed);
  jobs.clearUser(uid);
  assert.equal(jobs.status(uid).parsed, null);
});
