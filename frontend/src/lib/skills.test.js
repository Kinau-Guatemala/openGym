import { describe, it, expect } from 'vitest'
import { SKILLS, skillStats } from './skills.js'
import { EXIDX } from './exercises.js'
import { syncSideAggregate } from './workout-model.js'

const NOW = new Date('2026-10-22T12:00:00').getTime()
const reps = r => ({ w: 0, r, done: true })
const of = (out, key) => out.find(s => s.key === key)

describe('skills', () => {
  it('maps every skill to catalogue exercises that exist', () => {
    for (const sk of SKILLS) for (const id of sk.ids) expect(EXIDX[id], `${sk.key} ${id}`).toBeTruthy()
  })

  it('reads first date, max reps in one row, 4-week volume and Rx-done count', () => {
    const out = skillStats([
      { id: 'a', d: '2026-08-01', entries: [{ id: '3891', sets: [reps(4), reps(6), { ...reps(20), warmup: true }] }] },
      { id: 'wod-2026-10-10', d: '2026-10-10', src: 'wod',
        entries: [{ id: '3891', wodBlock: 'full/b1', noProg: true, sets: [reps(5), reps(5), { w: 0, r: 9, done: false }] }],
        wod: { blocks: [{ ref: 'full/b1', rx: true }] } },
      { id: 'wod-2026-10-15', d: '2026-10-15', src: 'wod',
        entries: [{ id: '3891', wodBlock: 'full/b2', sets: [reps(3)] }],
        wod: { blocks: [{ ref: 'full/b2', rx: false }] } },
    ], NOW)
    expect(of(out, 't2b')).toEqual({ key: 't2b', name: 'Toes-to-bar', ids: ['3891'], exId: '3891', first: '2026-08-01', maxReps: 6, perSide: false, volume: 13, rxDone: 1 })
    expect(of(out, 'du')).toMatchObject({ first: null, maxReps: 0, volume: 0, rxDone: 0 })
  })

  it('counts a per-side row once per side for its max, both sides for volume', () => {
    const side = syncSideAggregate({ sides: { L: { w: 0, r: 7, done: true }, R: { w: 0, r: 8, done: true } } })
    const [hspu] = skillStats([{ d: '2026-10-20', entries: [{ id: '5151', sets: [side, reps(5)] }] }], NOW, [SKILLS.find(s => s.key === 'hspu')])
    expect(hspu).toMatchObject({ maxReps: 8, perSide: true, volume: 20 })
  })

  it('counts an Rx block once, however many of its movements are the skill', () => {
    const [t2b] = skillStats([{ id: 'wod-2026-10-20', d: '2026-10-20', src: 'wod', wod: { blocks: [{ ref: 'full/b1', rx: true }] },
      entries: [{ id: '3891', wodBlock: 'full/b1', sets: [reps(10)] }, { id: '3891', wodBlock: 'full/b1', sets: [reps(8)] }] }], NOW, [SKILLS.find(s => s.key === 't2b')])
    expect(t2b).toMatchObject({ rxDone: 1, volume: 18 })
  })

  it('does not credit Rx to a swapped-in movement', () => {
    const [mu] = skillStats([{ d: '2026-10-20', src: 'wod', wod: { blocks: [{ ref: 'full/b1', rx: true }] },
      entries: [{ id: '0631', wodBlock: 'full/b1', swappedFrom: '5194', sets: [reps(2)] }] }], NOW, [SKILLS.find(s => s.key === 'rmu')])
    expect(mu).toMatchObject({ maxReps: 2, rxDone: 0 })
  })
})
