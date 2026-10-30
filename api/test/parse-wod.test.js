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
    assert.deepEqual(s.parsed.program.tracks.map(t => [t.id, t.kind]), [['full', 'main'], ['running', 'extra'], ['rox', 'extra'], ['conditioning', 'extra'], ['pump', 'extra']]);
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
  // Gemini's adapter has no image part.
  cfg.save({ enabled: true, provider: 'gemini' });
  cfg.saveAuth('gemini', { type: 'apikey', data: cfg.encrypt({ token: 'k' }), connectedAt: new Date().toISOString() });
  const uid = 'u-unsupported';
  writeState(DIR, uid, consented());
  try {
    assert.throws(() => jobs.enqueue(uid, { kind: 'parse-wod', date: DATE, image: { mime: 'image/jpeg', data: IMAGE } }), e => e.code === 'unsupported');
    assert.equal(jobs.capState(uid).used, 0);
  } finally { cfg.saveAuth('gemini', null); cfg.save({ provider: 'fixture' }); }
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

test('validateWod: repeats and rest (T17) are optional, whole and bounded', () => {
  const move = dose => ({ tracks: [{ id: 'full', label: 'Full', kind: 'main', blocks: [{ label: 'WOD', format: 'interval', movements: [{ raw: 'x', rawName: 'run', name: 'run', dose }] }] }] });
  const dose = d => validateWod(move(d)).proposal?.program.tracks[0].blocks[0].movements[0].dose;
  const errs = d => (validateWod(move(d)).errors || []).join();
  assert.deepEqual(dose({ sets: 2, m: 200, restSec: 60 }), { m: 200, sets: 2, restSec: 60 });
  assert.deepEqual(dose({ sets: 50, restSec: 0 }), { sets: 50, restSec: 0 });
  assert.deepEqual(dose({ m: 200 }), { m: 200 }, 'a dose without them is still valid, and gains nothing');
  for (const sets of [0, 51, 1.5, '2']) assert.match(errs({ sets }), /dose\.sets must be a whole number from 1 to 50/, String(sets));
  for (const restSec of [-1, 1801, 30.5]) assert.match(errs({ restSec }), /dose\.restSec must be whole seconds from 0 to 1800/, String(restSec));
  assert.match((validateWod({ tracks: [{ label: 'x', kind: 'main', blocks: [{ label: 'b', format: 'other', movements: [{ rawName: 'x', alts: [{ rawName: 'y', dose: { sets: 99 } }] }] }] }] }).errors || []).join(), /alts\.dose\.sets/);

  // The 2026-10-21 lines in the fixture: the Running Club's repeats and rest, its warm-up's cap,
  // Rox Prep's two sets of max wall balls, and the umbrella TC 40 on each part.
  const program = validateWod(FIXTURE_WOD).proposal.program;
  const track = id => program.tracks.find(t => t.id === id);
  const [warm, wod] = track('running').blocks;
  assert.deepEqual([warm.warmup, warm.capMin, warm.movements.length], [true, 15, 0]);
  assert.deepEqual(wod.movements.map(m => [m.rawName, m.dose]), [['run', { m: 8000, sets: 1, restSec: 180 }], ['run', { m: 200, sets: 2, restSec: 60 }]]);
  assert.deepEqual(track('rox').blocks[0].movements.map(m => [m.rawName, m.dose]), [['wall balls', { sets: 2 }]]);
  assert.ok(track('full').blocks.slice(1).every(b => b.raw.startsWith('TC 40\nMIN ')), 'TC 40 heads each part');
});

test('validateWod: a rest is never a movement — dropped, its seconds on a movement of its own line (T21)', () => {
  const block = movements => ({ tracks: [{ id: 'full', label: 'Full', kind: 'main', blocks: [{ label: 'EMOM 9', format: 'emom', movements }] }] });
  const moves = ms => validateWod(block(ms)).proposal.program.tracks[0].blocks[0].movements.map(m => [m.rawName, m.slot, m.dose]);
  const rest = (rawName, dose) => ({ raw: 'M3 Rest 30 seg + 40 DU', rawName, slot: 'M3', dose });
  const du = (dose = { reps: 40 }) => ({ raw: 'M3 Rest 30 seg + 40 DU', rawName: 'du', slot: 'M3', dose });
  // The slip the 30 Oct image produced: `rest` with dose.sec, then the double unders.
  assert.deepEqual(moves([rest('rest', { sec: 30 }), du()]), [['du', 'M3', { reps: 40, restSec: 30 }]]);
  assert.deepEqual(moves([rest('Descanso', { restSec: 60 }), du()]), [['du', 'M3', { reps: 40, restSec: 60 }]]);
  // The seconds in the name, in each spelling the box or the model might use.
  for (const [name, sec] of [['rest 1 min', 60], ['pausa 30 seg', 30], ['rest 30', 30], ['rest 1:30', 90], ['rest 2 minutes', 120],
    ['rest 90 seconds', 90], ['rest 45 secs', 45], ['descanso 30 segundos', 30], ['descanso 2 minutos', 120], ['rest 1 min cv', 60], ['REST 2 MIN', 120]]) {
    assert.deepEqual(moves([rest(name, {}), du()]), [['du', 'M3', { reps: 40, restSec: sec }]], name);
  }
  assert.deepEqual(moves([rest('rest', { sec: 30 }), du({ reps: 40, restSec: 15 })]), [['du', 'M3', { reps: 40, restSec: 15 }]], 'a rest of its own wins');
  assert.deepEqual(moves([rest('rest', {}), du()]), [['du', 'M3', { reps: 40 }]], 'no seconds, nothing moved');
  // Only to a movement on the rest's own line: the next one there, else the one before it.
  const line = (raw, slot, rawName, dose) => ({ raw, rawName, slot, dose });
  const m2 = 'M2 40 DU + Rest 30 seg', m3 = 'M3 10 Wall Balls';
  assert.deepEqual(moves([line(m2, 'M2', 'du', { reps: 40 }), line(m2, 'M2', 'rest', { sec: 30 }), line(m3, 'M3', 'wall balls', { reps: 10 })]),
    [['du', 'M2', { reps: 40, restSec: 30 }], ['wall balls', 'M3', { reps: 10 }]], 'a rest after its work goes back to it');
  assert.deepEqual(moves([line('Rest 30 seg', 'M2', 'rest', { sec: 30 }), line('40 DU', 'M2', 'du', { reps: 40 }), line(m3, 'M3', 'wall balls', { reps: 10 })]),
    [['du', 'M2', { reps: 40, restSec: 30 }], ['wall balls', 'M3', { reps: 10 }]], 'the same slot is the same line');
  assert.deepEqual(moves([line('Rest 1 min', null, 'rest', { sec: 60 }), line('10 Wall Balls', null, 'wall balls', { reps: 10 })]),
    [['wall balls', null, { reps: 10 }]], 'never to the next line');
  for (const name of ['rest pause squats', 'pausa squats', 'pause bench', 'rest pause push ups', 'rest 30 burpees']) {
    assert.deepEqual(moves([{ rawName: name, dose: { reps: 10 } }]).map(m => m[0]), [name], `${name} stays a movement`);
  }

  // The fixture's EMOM line, as the prompt asks for it, passes as one movement.
  const pump = validateWod(FIXTURE_WOD).proposal.program.tracks.find(t => t.id === 'pump').blocks[0];
  assert.deepEqual(pump.movements.map(m => [m.rawName, m.slot, m.dose]).at(-1), ['du', 'M3', { reps: 40, restSec: 30 }]);
  assert.match(pump.raw, /M3 Rest 30 seg \+ 40 DU/);
});

test('the parse prompt says a rest inside a line or a minute is never a movement (T21)', () => {
  assert.match(PROMPTS['parse-wod'], /`Rest 30 seg`, `Rest 1 min`, `Descanso 30 seg` \*\*inside a line or a minute\*\*.*a rest, never a movement/);
  assert.match(PROMPTS['parse-wod'], /`"M3 Rest 30 seg \+ 40 DU"` → one movement, `rawName: "du"`, `slot: "M3"`, `dose: \{ "reps": 40, "restSec": 30 \}`/);
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

/* ---------- an OpenAI-compatible endpoint: the model, not the provider, decides (T15) ---------- */

async function endpoint(status, body) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      seen.push(JSON.parse(raw || '{}'));
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { seen, base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
const chat = program => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(program) } }] });
const EMPTY = { title: null, tracks: [] };

async function parseThrough(provider, status, body, model = 'gw/some-model') {
  const p = await endpoint(status, body);
  cfg.save({ enabled: true, provider, providerOptions: { [provider]: { baseUrl: p.base } }, models: { [provider]: model } });
  cfg.saveAuth(provider, { type: 'apikey', data: cfg.encrypt({ token: 'sk-test' }), connectedAt: new Date().toISOString() });
  const uid = `u-t15-${provider}-${status}-${p.base.split(':').pop()}`;
  writeState(DIR, uid, consented());
  try {
    const r = await routesFor(uid)('POST /api/coach/parse-wod', parseBody);
    assert.equal(r.status, 202, JSON.stringify(r.body));
    return { s: await settle(uid), seen: p.seen };
  } finally {
    p.close();
    cfg.saveAuth(provider, null);
    cfg.save({ provider: 'fixture' });
  }
}

test('compatible: parse-wod enqueues, the image goes out as a data URL and a program comes back', async () => {
  const { s, seen } = await parseThrough('compatible', 200, chat(FIXTURE_WOD));
  assert.ok(s.parsed, JSON.stringify(s.last));
  assert.equal(s.parsed.program.tracks.length, FIXTURE_WOD.tracks.length);
  assert.deepEqual(seen[0].messages[1].content[0], { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${IMAGE}` } });
});

test('compatible: an empty program is a model that could not see the image, not "no workout"', async () => {
  const { s } = await parseThrough('compatible', 200, chat(EMPTY));
  assert.equal(s.parsed, null);
  assert.equal(s.last.outcome, 'failed');
  assert.equal(s.last.errorClass, 'novision');
});

test('compatible: tracks with no block in any are empty too', async () => {
  const skeleton = { title: null, tracks: [{ id: 'full', label: 'Full Equipment', kind: 'main', blocks: [] }, { id: 'evo', label: 'Evo Equipment', kind: 'main', blocks: [] }] };
  const { s } = await parseThrough('compatible', 200, chat(skeleton));
  assert.equal(s.parsed, null);
  assert.equal(s.last.errorClass, 'novision');
});

test('anthropic and openai: an empty program is still believed', async () => {
  for (const [id, body] of [['openai', chat(EMPTY)], ['anthropic', { content: [{ type: 'text', text: JSON.stringify(EMPTY) }], stop_reason: 'end_turn' }]]) {
    const { s } = await parseThrough(id, 200, body);
    assert.ok(s.parsed, `${id}: ${JSON.stringify(s.last)}`);
    assert.deepEqual(s.parsed.program.tracks, []);
  }
});

test('an endpoint that refuses images answers the vision message; other 4xx stay what they were', async () => {
  for (const [provider, msg] of [
    ['compatible', 'image inputs are not supported by this model'],
    ['compatible', 'No endpoints found that support image input'],
    ['compatible', 'ddgw/gpt-5.6-luna is a text-only model'],
    ['compatible', 'Failed to deserialize the JSON body into the target type: messages[1]: unknown variant `image_url`, expected `text`'],
    ['compatible', 'At most 0 image(s) may be provided in one request.'],
    ['openai', 'Invalid content type. image_url is only supported by certain models.']
  ]) {
    const { s, seen } = await parseThrough(provider, 400, { error: { message: msg } });
    assert.equal(s.last.errorClass, 'novision', msg);
    assert.equal(seen.length, 1, 'a refusal is not retried');
  }
  for (const [status, msg, cls, model] of [[400, 'image too large', 'provider'], [400, 'model not found', 'provider'], [401, 'invalid api key', 'auth'],
    // The model id a gateway puts in front is not the model saying it cannot see.
    [400, 'meta-llama/llama-3.2-11b-vision-instruct: temperature is not supported for this model', 'provider', 'meta-llama/llama-3.2-11b-vision-instruct']]) {
    const { s } = await parseThrough('compatible', status, { error: { message: msg } }, model);
    assert.equal(s.last.errorClass, cls, msg);
  }
});

/* ---------- the Claude provider: the image rides the Agent SDK's streaming input (T16) ---------- */

const claudeMod = await import('../coach/adapters/claude.js');

// A stand-in for the SDK module: records what query() was handed and answers like the runtime.
// `answer` is the list of messages to yield; `throwAfter` mimics query() throwing after an
// is_error result, as the real SDK does.
function stubSdk(answer, { throwAfter = false } = {}) {
  const calls = [];
  claudeMod.setSdkForTest({
    query: ({ prompt, options }) => (async function* () {
      const call = { options, prompt: typeof prompt === 'string' ? prompt : [] };
      if (typeof prompt !== 'string') for await (const m of prompt) call.prompt.push(m);
      // What the job directory holds while the runtime has the image.
      call.jobDirFiles = options.cwd ? filesUnder(options.cwd).map(f => fs.readFileSync(f, 'utf8')) : [];
      calls.push(call);
      yield* answer;
      if (throwAfter) throw new Error('Claude Code returned an error result');
    })()
  });
  return calls;
}
const sdkResult = text => ({ type: 'result', subtype: 'success', is_error: false, result: text, stop_reason: 'end_turn' });

test('claude adapter: images become one streaming-input user message, image blocks first, text last', async () => {
  const calls = stubSdk([sdkResult('{"ok":1}')]);
  try {
    const claude = (await import('../coach/adapters/index.js')).adapterFor('claude');
    const r = await claude.invoke({ prompt: 'read it', images: [{ mime: 'image/png', data: 'AAA' }, { mime: 'image/jpeg', data: 'BBB' }], env: {}, timeoutMs: 5000 });
    assert.equal(r.code, 0);
    const [msg, ...more] = calls[0].prompt;
    assert.equal(more.length, 0, 'exactly one message');
    assert.deepEqual(msg, {
      type: 'user', parent_tool_use_id: null,
      message: { role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBB' } },
        { type: 'text', text: 'read it' }
      ] }
    });
    for (const [k, v] of Object.entries(claudeMod.LOCKDOWN)) assert.deepEqual(calls[0].options[k], v, `LOCKDOWN.${k} still applies`);

    // Without images the prompt is the plain string it always was.
    await claude.invoke({ prompt: 'a plan question', env: {}, timeoutMs: 5000 });
    assert.equal(calls[1].prompt, 'a plan question');
    await claude.invoke({ prompt: 'a plan question', images: [], env: {}, timeoutMs: 5000 });
    assert.equal(calls[2].prompt, 'a plan question');
  } finally { claudeMod.setSdkForTest(undefined); }
});

async function parseWithClaude(answer, opts) {
  const calls = stubSdk(answer, opts);
  cfg.save({ enabled: true, provider: 'claude' });
  cfg.saveAuth('claude', { type: 'apikey', data: cfg.encrypt({ token: 'sk-ant-test' }), connectedAt: new Date().toISOString() });
  const uid = 'u-t16-' + Math.random().toString(36).slice(2);
  writeState(DIR, uid, consented());
  try {
    const r = await routesFor(uid)('POST /api/coach/parse-wod', parseBody);
    assert.equal(r.status, 202, JSON.stringify(r.body));
    return { s: await settle(uid), calls };
  } finally {
    claudeMod.setSdkForTest(undefined);
    cfg.saveAuth('claude', null);
    cfg.save({ provider: 'fixture' });
  }
}

test('claude: parse-wod enqueues, the image reaches the SDK and never the job directory or ./data', async () => {
  const { s, calls } = await parseWithClaude([sdkResult(JSON.stringify(FIXTURE_WOD))]);
  assert.ok(s.parsed, JSON.stringify(s.last));
  assert.equal(s.parsed.program.tracks.length, FIXTURE_WOD.tracks.length);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].prompt[0].message.content[0], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: IMAGE } });
  assert.deepEqual(payloadIn(calls[0].prompt[0].message.content[1].text), { task: 'parse-wod', date: DATE, lang: null });
  assert.ok(calls[0].options.cwd, 'the runtime ran in a job directory');
  for (const body of calls[0].jobDirFiles) assert.ok(!body.includes(IMAGE.slice(0, 200)), 'the job directory holds the image');
  assert.equal(fs.existsSync(calls[0].options.cwd), false, 'the job directory is gone after the parse');
  for (const f of filesUnder(DIR)) assert.ok(!fs.readFileSync(f, 'utf8').includes(IMAGE.slice(0, 200)), `${path.relative(DIR, f)} holds the image`);
});

test('claude: an empty program is believed, "no routine found", not novision', async () => {
  const { s } = await parseWithClaude([sdkResult(JSON.stringify({ title: null, tracks: [] }))]);
  assert.ok(s.parsed, JSON.stringify(s.last));
  assert.deepEqual(s.parsed.program.tracks, []);
});

test('claude: an API error refusing the image is novision, and its text never carries the image', async () => {
  const refusal = { type: 'result', subtype: 'success', is_error: true, api_error_status: 400, result: `API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"image inputs are not supported (${IMAGE})"}}` };
  const { s } = await parseWithClaude([refusal], { throwAfter: true });
  assert.equal(s.last.errorClass, 'novision');
  // The failure detail is logged for the admin card; the image is not in it, nor anywhere on disk.
  // 60 characters: the logged detail is cut at 300, so a longer probe could miss a leak.
  for (const f of filesUnder(DIR)) assert.ok(!fs.readFileSync(f, 'utf8').includes(IMAGE.slice(0, 60)), `${path.relative(DIR, f)} holds the image`);
  // Another API error keeps its old meaning; the runtime's "Not logged in" is an auth failure.
  const other = await parseWithClaude([{ type: 'result', subtype: 'success', is_error: true, api_error_status: 400, result: 'API Error: 400 prompt is too long' }], { throwAfter: true });
  assert.equal(other.s.last.errorClass, 'provider');
  const login = await parseWithClaude([{ type: 'result', subtype: 'success', is_error: true, api_error_status: null, result: 'Not logged in · Please run /login' }], { throwAfter: true });
  assert.equal(login.s.last.errorClass, 'auth');
});

test('claude adapter: a non-success result names its errors, cut and without the image', async () => {
  stubSdk([{ type: 'result', subtype: 'error_during_execution', is_error: true, stop_reason: null, errors: ['stream closed', 'bad ' + IMAGE] }], { throwAfter: true });
  try {
    const r = await (await import('../coach/adapters/index.js')).adapterFor('claude').invoke({ prompt: 'p', images: [{ mime: 'image/jpeg', data: IMAGE }], env: {}, timeoutMs: 5000 });
    assert.equal(r.code, 1);
    assert.ok(r.stderr.startsWith('the Agent SDK stopped: error_during_execution: stream closed; bad '), r.stderr.slice(0, 120));
    assert.ok(r.stderr.length < 1100, 'cut');
    assert.ok(!r.stderr.includes(IMAGE.slice(0, 60)), 'no image bytes');
  } finally { claudeMod.setSdkForTest(undefined); }
});

test('claude adapter: an error text that quotes the image has it cut out', async () => {
  stubSdk([{ type: 'result', subtype: 'success', is_error: true, api_error_status: 400, result: 'bad ' + IMAGE }], { throwAfter: true });
  try {
    const r = await (await import('../coach/adapters/index.js')).adapterFor('claude').invoke({ prompt: 'p', images: [{ mime: 'image/jpeg', data: IMAGE }], env: {}, timeoutMs: 5000 });
    assert.equal(r.code, 1);
    assert.equal(r.stderr, '400 bad [image]');
  } finally { claudeMod.setSdkForTest(undefined); }
});

test('the parse prompt keeps the T17 boundaries: sets × reps on a lift, a rounds heading, a warm-up-only duration', () => {
  const p = PROMPTS['parse-wod'];
  assert.match(p, /`3x12 Copas`, `5x5 Back Squat` \| on a lift, `NxR` is sets × reps: `dose: \{ "sets": 3, "reps": 12 \}`/);
  assert.match(p, /`3 Rondas de:` \| a line of its own over the movements: the block's `rounds: 5`.*Never also `dose\.sets`/);
  assert.match(p, /`2 Rondas de 400 m Run` → `\{ "sets": 2, "m": 400 \}`/);
  assert.match(p, /Only a warm-up: .*`Easy 20 min` in a running track → `rawName: "run"`, `dose: \{ "sec": 1200 \}`/);
});
