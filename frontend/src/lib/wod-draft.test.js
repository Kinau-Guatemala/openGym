import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { prepareDraft, includeOf, applyPick, movementFromText, nextId, resolveInto } from './wod-draft.js'
import { norm } from './crossfit-resolve.js'

// The parser's real shape (T04's validated example), before ids are assigned
const fixture = JSON.parse(readFileSync(resolve(__dirname, '../../../api/coach/fixture-wod.json'), 'utf8'))

describe('prepareDraft', () => {
  it('fills ids, keeps the track kinds and resolves what it can', () => {
    const d = prepareDraft(fixture)
    expect(d.title).toBe('Coaches are watching')
    const full = d.tracks.find(t => t.id === 'full')
    expect(full.kind).toBe('main')
    expect(full.blocks.map(b => b.id)).toEqual(full.blocks.map((_, i) => 'b' + i))
    for (const b of full.blocks) expect(new Set(b.movements.map(m => m.id)).size).toBe(b.movements.length)
    // "russian twist" is a clear catalogue hit; "machine" is left to a pick
    const all = d.tracks.flatMap(t => t.blocks.flatMap(b => b.movements))
    expect(all.find(m => m.rawName === 'russian twist').exId).toBeTruthy()
    expect(all.find(m => m.rawName === 'machine').exId).toBeNull()
    // alternatives resolve too (ski → the shipped table)
    const row = all.find(m => m.rawName === 'row')
    expect(row.alts.find(a => a.rawName === 'ski').exId).toBe('2142')
  })

  it('takes the user’s pick over everything, and keeps an exercise already chosen', () => {
    const p = { tracks: [{ id: 'full', kind: 'main', blocks: [{ id: 'b0', movements: [
      { id: 'm0', rawName: 'copas', exId: null },
      { id: 'm1', rawName: 'copas', exId: '0001' },
    ] }] }] }
    const d = prepareDraft(p, { [norm('copas')]: { exId: '9999', _ts: 1 } })
    expect(d.tracks[0].blocks[0].movements.map(m => m.exId)).toEqual(['9999', '0001'])
  })

  it('starts an empty draft from nothing and drops the stored stamp', () => {
    expect(prepareDraft(null)).toEqual({ title: '', tracks: [] })
    expect(prepareDraft({ _ts: 5, title: 'x', tracks: [] })).toEqual({ title: 'x', tracks: [] })
  })

  it('renumbers a duplicate id', () => {
    const d = prepareDraft({ tracks: [{ id: 'a', blocks: [] }, { id: 'a', blocks: [] }] })
    expect(d.tracks.map(t => t.id)).toEqual(['a', 't0'])
  })
})

describe('includeOf', () => {
  const main = { kind: 'main' }, extra = { kind: 'extra' }
  const warm = { warmup: true }
  it('leaves warm-ups out in main tracks only', () => {
    expect(includeOf(main, warm, {})).toBe(false)
    expect(includeOf(main, { warmup: false }, {})).toBe(true)
    // Holy Conditioning's "WARM UP / AMRAP 40" is the workout
    expect(includeOf(extra, warm, {})).toBe(true)
  })
  it('follows the setting, and the toggle wins once set', () => {
    expect(includeOf(main, warm, { wodWarmup: true })).toBe(true)
    expect(includeOf(main, { ...warm, include: true }, {})).toBe(true)
    expect(includeOf(extra, { ...warm, include: false }, {})).toBe(false)
  })
  it('the fixture: Full’s warm-up off, Conditioning’s on', () => {
    const d = prepareDraft(fixture)
    const full = d.tracks.find(t => t.id === 'full')
    expect(includeOf(full, full.blocks[0], {})).toBe(false)
    // the parser flags Conditioning's "WARM UP / AMRAP 40" as a warm-up when the image heads it so
    const cond = d.tracks.find(t => t.label === 'Holy Conditioning')
    expect(includeOf(cond, { ...cond.blocks[0], warmup: true }, {})).toBe(true)
  })
})

describe('picks and hand entry', () => {
  it('applyPick sets every movement and alternative of that name', () => {
    const d = { tracks: [{ blocks: [
      { movements: [{ rawName: 'Copas', exId: null, alts: [] }, { rawName: 'row', exId: 'r', alts: [{ rawName: 'copas', exId: null }] }] },
    ] }] }
    const out = applyPick(d, norm('copas'), '42')
    const ms = out.tracks[0].blocks[0].movements
    expect(ms[0].exId).toBe('42')
    expect(ms[1].exId).toBe('r')
    expect(ms[1].alts[0].exId).toBe('42')
  })

  it('a typed line gets its alias key and resolves through the user’s picks', () => {
    const m = movementFromText('12 Copas 20/15', 'm0', { [norm('copas')]: { exId: '42', _ts: 1 } })
    expect(m.rawName).toBe('copas')
    expect(m.exId).toBe('42')
  })

  it('a misspelling carries its guess, a vague name its suggestions, a known one neither', () => {
    const p = { tracks: [{ blocks: [{ movements: [
      { rawName: 'wal balls', exId: null, alts: [{ rawName: 'machine', exId: null }] },
      { rawName: 'copas', exId: null, alts: [] },
    ] }] }] }
    const [wal, copas] = prepareDraft(p).tracks[0].blocks[0].movements
    expect(wal).toMatchObject({ exId: '2458', via: 'guess' })
    expect(wal.candidates[0]).toMatchObject({ exId: '2458' })
    expect(wal.alts[0]).toMatchObject({ exId: null, via: null })
    expect(wal.alts[0].candidates.length).toBeGreaterThan(0)
    expect(copas.exId).toBe('0430')
    expect('via' in copas || 'candidates' in copas).toBe(false)
  })

  it('a saved guess is resolved again on opening, so a pick made since settles it', () => {
    const saved = { tracks: [{ blocks: [{ movements: [{ rawName: 'wal balls', exId: '2458', via: 'guess', candidates: [{ exId: '2458', score: 0.88 }], alts: [] }] }] }] }
    const m = prepareDraft(saved, { [norm('wal balls')]: { exId: '9999', _ts: 1 } }).tracks[0].blocks[0].movements[0]
    expect(m.exId).toBe('9999')
    expect('via' in m || 'candidates' in m).toBe(false)
  })

  it('confirming a guess (applyPick) settles every movement of that name', () => {
    const d = prepareDraft({ tracks: [{ blocks: [{ movements: [{ rawName: 'wal balls', exId: null, alts: [] }, { rawName: 'Wal Balls', exId: null, alts: [] }] }] }] })
    const out = applyPick(d, norm('wal balls'), '2458').tracks[0].blocks[0].movements
    for (const m of out) {
      expect(m.exId).toBe('2458')
      expect('via' in m || 'candidates' in m).toBe(false)
    }
  })

  it('resolveInto drops a stale guess when the name now resolves for certain', () => {
    const m = resolveInto({ rawName: 'copas', exId: '1', via: 'guess', candidates: [{ exId: '1', score: 0.9 }] })
    expect(m).toEqual({ rawName: 'copas', exId: '0430' })
  })

  it('nextId takes the first free number', () => {
    expect(nextId([{ id: 'b0' }, { id: 'b2' }], 'b')).toBe('b1')
    expect(nextId([], 'm')).toBe('m0')
  })
})
