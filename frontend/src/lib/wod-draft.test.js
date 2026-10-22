import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { prepareDraft, includeOf, applyPick, movementFromText, nextId } from './wod-draft.js'
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

  it('nextId takes the first free number', () => {
    expect(nextId([{ id: 'b0' }, { id: 'b2' }], 'b')).toBe('b1')
    expect(nextId([], 'm')).toBe('m0')
  })
})
