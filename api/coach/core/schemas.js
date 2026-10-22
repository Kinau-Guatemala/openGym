/* JSON schemas for the three answer shapes, handed to providers that can enforce a schema
 * while decoding (Ollama/llama.cpp grammar sampling, LM Studio, vLLM, OpenAI json_schema).
 *
 * Deliberately flat: no $ref, no anyOf/oneOf, no additionalProperties tricks — llama.cpp's
 * grammar converter has a history of choking on those (ollama#8444, #8063). The schema
 * guarantees *shape* so a small model cannot ramble; validate.js remains the only judge of
 * whether the contents are safe to act on. Fields that may hold any JSON value (`before`,
 * `after`) say so with a type union, which the grammar converter does support.
 */
const ANY = { type: ['number', 'string', 'boolean', 'object', 'array', 'null'] };
const STR = { type: 'string' };
const STRINGS = { type: 'array', items: { type: 'string' } };

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    coach_contract: { type: 'integer' },
    nochange: { type: 'boolean' },
    reading: STR,
    summary: STR,
    evidence: {
      type: 'object',
      properties: { from: STR, to: STR, sessions: { type: 'integer' } }
    },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: STR,
          type: STR,
          target: {
            type: 'object',
            properties: { routineId: STR, exId: STR, weekday: { type: 'integer' } }
          },
          before: ANY,
          after: ANY,
          why: STR
        },
        required: ['type', 'why']
      }
    },
    notes: STRINGS
  },
  required: ['coach_contract']
};

const EX_SCHEMA = {
  type: 'object',
  properties: {
    id: STR, sets: { type: 'integer' }, mode: STR,
    reps: { type: 'integer' }, sec: { type: 'integer' },
    min: { type: 'integer' }, speed: { type: 'number' },
    weight: { type: 'number' }, prog: STR, inc: { type: 'number' },
    repsMin: { type: 'integer' }, repsMax: { type: 'integer' },
    bodyweight: { type: 'boolean' }, side: { type: 'boolean' },
    sg: STR, why: STR, position: { type: 'integer' }
  },
  required: ['id', 'sets']
};

// `week` and `routines[].id` are required, not optional: the week is the only thing that says
// which day trains which routine, and it points at a routine by id. A schema that leaves either
// out lets a small local model answer with routines that have no id and a week naming "r1" —
// grammar-valid, and something validate.js can only ever reject ("the week schedules 0 days but
// 3 were asked for"), through the repair round and out as a failed job.
export const CREATE_SCHEMA = {
  type: 'object',
  properties: {
    coach_contract: { type: 'integer' },
    name: STR,
    summary: STR,
    basedOn: STR,
    week: { type: 'object' },
    // The caps are the validator's own (MAX_ROUTINES, MAX_EX_PER_ROUTINE), stated here as well
    // because "1-7 routines, each 3-12 exercises" in create.md is only a request. A small model
    // that starts repeating itself does not stop at a request: qwen2.5:3b walks the library id by
    // id, three sets of eight apiece, until it hits the output limit — twelve minutes for an
    // answer that arrives cut in half and cannot be parsed. maxItems ends that run at seven
    // routines instead.
    routines: {
      type: 'array',
      maxItems: 7,
      items: {
        type: 'object',
        properties: {
          id: STR, name: STR, emoji: STR, prog: STR, why: STR,
          ex: { type: 'array', maxItems: 20, items: EX_SCHEMA }
        },
        required: ['id', 'name', 'ex']
      }
    },
    customEx: {
      type: 'array',
      items: { type: 'object', properties: { id: STR, n: STR, bp: STR, desc: STR }, required: ['id', 'n'] }
    }
  },
  required: ['coach_contract', 'week', 'routines']
};

export const DEBRIEF_SCHEMA = {
  type: 'object',
  properties: {
    coach_contract: { type: 'integer' },
    summary: STR,
    score: { type: 'integer' },
    highlights: STRINGS,
    watch: STRINGS,
    nextTime: STRINGS
  },
  required: ['coach_contract', 'summary', 'score']
};

// A posted workout read off an image: the program shape of S.wods[date] (docs: CrossFit data
// model §1) minus what only the client knows — `exId` is resolved on the phone, `_ts` and `via`
// are stamped when it is saved. Nullable fields say so with a type union, like ANY above.
const NUM_OR_NULL = { type: ['number', 'null'] };
const STR_OR_NULL = { type: ['string', 'null'] };
const DOSE = {
  type: 'object',
  properties: { reps: { type: 'number' }, repsMax: { type: 'number' }, cal: { type: 'number' }, m: { type: 'number' }, sec: { type: 'number' } }
};
const LOAD = { type: ['object', 'null'], properties: { w: { type: 'number' }, unit: { type: 'string', enum: ['lb', 'kg'] } } };
const MOVEMENT_SCHEMA = {
  type: 'object',
  properties: {
    raw: STR, rawName: STR, name: STR, slot: STR_OR_NULL,
    dose: DOSE, doseFemale: DOSE, perSide: { type: 'boolean' },
    rx: { type: ['object', 'null'], properties: { male: LOAD, female: LOAD } },
    alts: { type: 'array', items: { type: 'object', properties: { rawName: STR, dose: DOSE, doseFemale: DOSE }, required: ['rawName'] } }
  },
  required: ['raw', 'rawName', 'name', 'dose']
};
export const WOD_SCHEMA = {
  type: 'object',
  properties: {
    title: STR_OR_NULL,
    tracks: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          id: STR, label: STR, kind: { type: 'string', enum: ['main', 'extra'] },
          blocks: {
            type: 'array',
            maxItems: 12,
            items: {
              type: 'object',
              properties: {
                label: STR, warmup: { type: 'boolean' },
                format: { type: 'string', enum: ['amrap', 'emom', 'fortime', 'rounds', 'interval', 'strength', 'other'] },
                capMin: NUM_OR_NULL, rounds: { type: ['integer', 'null'] },
                scheme: STR_OR_NULL, benchmark: STR_OR_NULL, raw: STR,
                movements: { type: 'array', maxItems: 20, items: MOVEMENT_SCHEMA }
              },
              required: ['label', 'format', 'movements']
            }
          }
        },
        required: ['label', 'kind', 'blocks']
      }
    }
  },
  required: ['tracks']
};

// Every kind by name. No fallback: a kind missing here gets no schema, and the prompt and the
// validator refuse it before a schema would matter.
export const SCHEMAS = { review: REVIEW_SCHEMA, create: CREATE_SCHEMA, refine: CREATE_SCHEMA, debrief: DEBRIEF_SCHEMA, 'parse-wod': WOD_SCHEMA };
