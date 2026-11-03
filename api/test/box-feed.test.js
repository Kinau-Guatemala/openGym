import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFeed, feedProgram, feedPrograms, feedUrl } from '../box-feed.js';

const program = (title = 'Holy Conditioning') => ({
  title,
  _ts: 111,
  note: 'mine',                                   // not a program field
  tracks: [{
    id: 't0', label: 'HOLY CONDITIONING', kind: 'main', secret: 1,
    blocks: [{
      id: 'b0', label: 'AMRAP 12', format: 'amrap', capMin: 12, rounds: null, roundsMax: null, everySec: null,
      scheme: null, benchmark: 'Cindy', warmup: false, raw: 'AMRAP 12', include: true,
      logged: { score: '5+3' }, score: 'x',
      movements: [{
        id: 'm0', raw: '5 pull-ups', rawName: 'pull-ups', exId: '0651', via: 'guess', candidates: ['1'],
        dose: { reps: 5, junk: 'x' }, doseFemale: { reps: 4 }, perSide: false, slot: null,
        rx: { male: { w: 95, unit: 'lb', who: 'x' }, female: null },
        steps: [{ reps: 3, rx: { male: { w: 135, unit: 'lb' } }, done: true }],
        alts: [{ rawName: 'ring rows', dose: { reps: 8 }, exId: '9', logged: 1 }],
        logged: { reps: 5 }, pick: '0651'
      }]
    }]
  }]
});

test('feedProgram keeps the allowlisted fields and drops everything else, unknown ones included', () => {
  assert.deepEqual(feedProgram(program()), {
    title: 'Holy Conditioning',
    tracks: [{
      label: 'HOLY CONDITIONING', kind: 'main',
      blocks: [{
        label: 'AMRAP 12', format: 'amrap', capMin: 12, rounds: null, roundsMax: null, everySec: null,
        scheme: null, benchmark: 'Cindy', warmup: false, raw: 'AMRAP 12',
        movements: [{
          raw: '5 pull-ups', rawName: 'pull-ups', exId: '0651',
          dose: { reps: 5 }, doseFemale: { reps: 4 }, rx: { male: { w: 95, unit: 'lb' }, female: null },
          steps: [{ reps: 3, rx: { male: { w: 135, unit: 'lb' } } }],
          perSide: false, slot: null,
          alts: [{ rawName: 'ring rows', exId: '9', dose: { reps: 8 } }]
        }]
      }]
    }]
  });
  assert.equal(feedProgram(null), null);
  assert.deepEqual(feedProgram({ tracks: 'nope', title: { x: 1 } }), { tracks: [] });
});

test('nothing outside the allowlist reaches the feed, at any depth', () => {
  const text = JSON.stringify(buildFeed({ '2026-11-03': program() }, { name: 'Box', today: '2026-11-03', now: 0 }));
  for (const leak of ['note', 'secret', 'include', 'logged', 'score', 'via', 'candidates', 'junk', 'who', 'done', 'pick', '_ts', '"id"']) {
    assert.ok(!text.includes(leak), `${leak} leaked`);
  }
});

test('the window: from today minus days on, future included, oldest first; cleared dates are gone', () => {
  const wods = {
    '2026-10-19': program('too old'),
    '2026-11-10': program('future'),
    '2026-10-20': program('first day in'),
    '2026-11-03': program('today'),
    '2026-11-01': { _ts: 5 },                     // a deleted program
    'junk': program('not a date'),
    '2026-11-02': 'not a program'
  };
  const got = feedPrograms(wods, { today: '2026-11-03', days: 14 });
  assert.deepEqual(got.map(p => [p.date, p.title]), [['2026-10-20', 'first day in'], ['2026-11-03', 'today'], ['2026-11-10', 'future']]);
  assert.deepEqual(feedPrograms(wods, { today: '2026-11-03', days: 0 }).map(p => p.date), ['2026-11-03', '2026-11-10']);
});

test('buildFeed: the document, and an empty one', () => {
  assert.deepEqual(buildFeed({}, { name: 'Holy Program', today: '2026-11-03', now: Date.UTC(2026, 10, 3, 12) }),
    { v: 1, box: 'Holy Program', updatedAt: '2026-11-03T12:00:00.000Z', programs: [] });
  assert.deepEqual(buildFeed(null, { today: '2026-11-03', now: 0 }).programs, []);
  assert.equal(feedUrl('Kinau-Guatemala/holy-wods'), 'https://raw.githubusercontent.com/Kinau-Guatemala/holy-wods/main/feed.json');
});
