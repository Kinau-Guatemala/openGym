/* A spent usage limit (T24): its own error class, and when it lifts.
 *
 * Out of quota, every provider used to read as a generic `provider` failure, so the person was
 * told the instance was misconfigured when it only needed waiting out. The texts below are what
 * each provider actually answers; Claude's is verbatim from the 2 Nov batch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { tempData } from './helpers.mjs';

tempData();
const { attemptOnce } = await import('../coach/core/pipeline.js');
const { quotaResetsAt } = await import('../coach/core/quota.js');
const openai = (await import('../coach/core/adapters/openai.js')).default;

const CLAUDE = '429 You\'ve hit your session limit · resets 10:50pm (UTC)';
const payload = { plan: { routines: [], week: {} } };
const failWith = (stderr, extra = {}) => ({ spawns: false, invoke: async () => ({ code: 1, text: '', stderr, ...extra }) });
const classify = (stderr, opts = {}) => attemptOnce({ adapter: failWith(stderr, opts.extra), cfg: {}, kind: opts.kind || 'review', payload, ...(opts.images ? { invokeOpts: { images: [{ mime: 'image/jpeg', data: 'AAA' }] } } : {}) }, null);

test('the three providers\' 429s are quota, with their words kept for the admin card', async () => {
  for (const stderr of [
    CLAUDE,
    '429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}',
    '429 You exceeded your current quota, please check your plan and billing details. (insufficient_quota)',
    '429 Rate limit reached for gpt-4o (rate_limit_exceeded)',
    '429 Too Many Requests'
  ]) {
    const r = await classify(stderr);
    assert.equal(r.errorClass, 'quota', stderr);
    assert.equal(r.detail, stderr);
  }
});

test('without a status, the limit\'s own words are quota; anything else keeps its class', async () => {
  for (const stderr of ['You\'ve hit your session limit · resets 10:50pm', 'usage limit reached', 'rate_limit_error', 'insufficient_quota', 'Too Many Requests']) {
    assert.equal((await classify(stderr)).errorClass, 'quota', stderr);
  }
  assert.equal((await classify('Not logged in · Please run /login')).errorClass, 'auth');
  assert.equal((await classify('the Agent SDK returned no result')).errorClass, 'provider');
});

test('401/403 stay auth, an image refusal stays novision, a 500 stays provider', async () => {
  assert.equal((await classify('401 invalid x-api-key')).errorClass, 'auth');
  assert.equal((await classify('403 permission denied · rate limit')).errorClass, 'auth', 'the status decides, not the words');
  assert.equal((await classify('400 image inputs are not supported by this model', { images: true, kind: 'parse-wod' })).errorClass, 'novision');
  // A 429 naming images is still a limit: novision needs a 4xx refusing images, and checks first.
  assert.equal((await classify('429 rate limit for image requests', { images: true, kind: 'parse-wod' })).errorClass, 'quota');
  assert.equal((await classify('500 rate limiter unavailable')).errorClass, 'provider');
});

test('an HTTP 429 hands its Retry-After on to the pipeline', async () => {
  const f = async () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '120' }), text: async () => JSON.stringify({ error: { message: 'slow down' } }) });
  const env = { OPENAI_API_KEY: 'sk-oa-1' };
  const r = await attemptOnce({ adapter: openai, cfg: {}, kind: 'review', payload, invokeOpts: { env, fetch: f, retryDelayMs: 0 } }, null);
  assert.equal(r.errorClass, 'quota');
  assert.equal(r.retryAfter, '120');
});

/* ---------- when it lifts ---------- */

const NOW = Date.parse('2026-11-02T18:05:00Z');

test('Claude\'s exact text: 22:50 UTC the same day', () => {
  assert.equal(quotaResetsAt(CLAUDE, NOW), '2026-11-02T22:50:00.000Z');
});

test('am and pm, 12 o\'clock both ways, and no zone printed reads as UTC', () => {
  assert.equal(quotaResetsAt('resets 10:50pm', NOW), '2026-11-02T22:50:00.000Z');
  assert.equal(quotaResetsAt('resets 7pm (UTC)', NOW), '2026-11-02T19:00:00.000Z');
  assert.equal(quotaResetsAt('resets 9:15 AM UTC', NOW), '2026-11-03T09:15:00.000Z');
  assert.equal(quotaResetsAt('resets 12am', NOW), '2026-11-03T00:00:00.000Z');
  assert.equal(quotaResetsAt('resets 12:30pm', NOW), '2026-11-03T12:30:00.000Z');
  assert.equal(quotaResetsAt('resets 21:00', NOW), '2026-11-02T21:00:00.000Z');
  assert.equal(quotaResetsAt('resets 12:30am', NOW), '2026-11-03T00:30:00.000Z');
  assert.equal(quotaResetsAt('resets 22:50 (UTC)', NOW), '2026-11-02T22:50:00.000Z');
  for (const zone of ['UTC', 'GMT', 'Z', '(GMT)', '(Z)', '( UTC )', 'UTC.', '(UTC) · upgrade', 'UTC · upgrade']) {
    assert.equal(quotaResetsAt(`resets 10:50pm ${zone}`, NOW), '2026-11-02T22:50:00.000Z', zone);
  }
  assert.equal(quotaResetsAt('resets 10:50pm (UTC). Upgrade for more', NOW), '2026-11-02T22:50:00.000Z');
});

test('a time already gone today is tomorrow, across the month too', () => {
  assert.equal(quotaResetsAt('resets 6:05pm (UTC)', NOW), '2026-11-03T18:05:00.000Z', 'the very minute counts as gone');
  assert.equal(quotaResetsAt('resets 1:00am (UTC)', Date.parse('2026-11-30T23:30:00Z')), '2026-12-01T01:00:00.000Z');
  assert.equal(quotaResetsAt('resets 11pm', Date.parse('2026-12-31T23:30:00Z')), '2027-01-01T23:00:00.000Z');
});

test('a Retry-After wins, in seconds or as an HTTP date', () => {
  assert.equal(quotaResetsAt('429 slow down', NOW, '120'), '2026-11-02T18:07:00.000Z');
  assert.equal(quotaResetsAt(CLAUDE, NOW, 'Mon, 02 Nov 2026 20:00:00 GMT'), '2026-11-02T20:00:00.000Z');
  assert.equal(quotaResetsAt(CLAUDE, NOW, 'soon'), '2026-11-02T22:50:00.000Z', 'an unreadable header falls back on the text');
});

test('nothing usable is null, never a guess', () => {
  for (const text of [null, '', '429 Too Many Requests', 'resets soon', 'resets 13pm', 'resets 10:75pm', 'resets 25:00', 'resets 10',
    'resets Nov 5 at 10pm', 'resets 10:50pm (America/New_York)', 'garbage ¯\\_(ツ)_/¯',
    // A zone it does not read, bare or in parentheses, and text cut mid-time or mid-zone.
    'resets 10:50pm UTC+2', 'resets 10:50pm GMT-6', 'resets 10:50 PM PT', 'resets 3am EST', 'resets 10:50pm CST · try again',
    '429 You\'ve hit your session limit · resets 10:50p', '429 You\'ve hit your session limit · resets 10:50pm (Ameri']) {
    assert.equal(quotaResetsAt(text, NOW), null, String(text));
  }
  assert.equal(quotaResetsAt('429', NOW, '0'), null, 'a Retry-After of now is not a time to wait for');
});
