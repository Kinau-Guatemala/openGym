// The CrossFit programs (S.wods) and alias picks (S.exAliases) across devices: the helpers, the
// merge on this side, and what the server's PUT (api/sync-stamps.js) does with them. Critique C1:
// before both maps were in OWN_MERGE, stampEdits stamped `edited.wods` as a whole setting and
// applyEdits handed the whole map to one copy — two devices, two dates, one survived.
import { describe, expect, it } from 'vitest'
import * as Server from '../../../api/sync-stamps.js'
import { WODS_KEEP_DAYS, aliasesOf, pruneWods, validWod, withAlias, withWod, wodOf } from './wods.js'
import { mergeStates, stampChange, stampEdits, stampRestore } from './sync-merge.js'

const clone = o => JSON.parse(JSON.stringify(o))
const T = 1_800_000_000_000
const TODAY = '2026-10-24'
const base = (over = {}) => ({
  unit: 'kg', week: {}, dayPlan: {}, workouts: [], routines: [], bodyweight: [], customEx: [], favEx: [],
  exWeights: {}, exNotes: {}, barWeights: {}, equipProfiles: [], gymCards: [], wods: {}, exAliases: {}, _ts: T, ...over,
})
// One change on a copy, stamped the way the store stamps it (useStore update).
const change = (prev, wall, mut) => { const n = clone(prev); mut(n); n._ts = stampChange(prev, n, wall); return n }
const both = (a, b, opts = { today: TODAY }) => [mergeStates(a, b, opts), mergeStates(b, a, opts)]
const prog = title => ({ title, tracks: [{ id: 'full', kind: 'main', blocks: [] }] })

describe('wods helpers', () => {
  it('saves, clears and reads a program by date', () => {
    const m = withWod({}, '2026-10-22', { ...prog('A'), _ts: 1 }, 10)
    expect(m['2026-10-22']).toEqual({ ...prog('A'), _ts: 10 })
    expect(wodOf({ wods: m }, '2026-10-22').title).toBe('A')
    const cleared = withWod(m, '2026-10-22', null, 11)
    expect(cleared['2026-10-22']).toEqual({ _ts: 11 })
    expect(wodOf({ wods: cleared }, '2026-10-22')).toBeNull()
    expect(wodOf({}, '2026-10-22')).toBeNull()
    expect(validWod('2026-10-22', {})).toBe(true)
    for (const [d, p] of [['22-10-2026', {}], ['2026-10-22', null], ['2026-10-22', []], [null, {}]]) expect(validWod(d, p)).toBe(false)
  })

  it('aliases read back as key → exId, cleared ones left out', () => {
    let m = withAlias({}, 'hang cleans', '1234', 5)
    m = withAlias(m, 't2b', '0099', 6)
    m = withAlias(m, 't2b', null, 7)
    expect(m.t2b).toEqual({ _ts: 7 })
    expect(aliasesOf({ exAliases: { ...m, junk: 'x', bad: { exId: 3 } } })).toEqual({ 'hang cleans': '1234' })
    expect(aliasesOf({})).toEqual({})
  })

  it('prunes by date key: the last 120 days and every later date stay, the rest and junk keys go', () => {
    const m = { '2026-06-26': 1, '2026-06-25': 2, '2026-10-24': 3, '2026-12-01': 4, nope: 5, '2026-6-30': 6 }
    expect(WODS_KEEP_DAYS).toBe(120)
    expect(pruneWods(m, TODAY)).toEqual({ '2026-06-26': 1, '2026-10-24': 3, '2026-12-01': 4 })
    expect(pruneWods(null, TODAY)).toEqual({})
  })
})

describe('wods and exAliases across two devices (this side)', () => {
  const shared = base()

  it('are never stamped as a whole setting', () => {
    const phone = change(shared, T + 10, s => { s.wods = withWod(s.wods, '2026-10-23', prog('A'), T + 10); s.exAliases = withAlias(s.exAliases, 't2b', '0099', T + 10) })
    expect(phone.edited?.wods).toBeUndefined()
    expect(phone.edited?.exAliases).toBeUndefined()
    const n = clone(shared); n.wods = { '2026-10-23': { _ts: 1 } }; n.exAliases = { x: { exId: 'y', _ts: 1 } }
    expect(stampEdits(shared, n, T + 20).edited).toBeUndefined()
    const restored = stampRestore(clone(n), [shared], T + 30)
    expect(restored.edited.wods).toBeUndefined()
    expect(restored.edited.exAliases).toBeUndefined()
  })

  it('different dates saved on each device are both kept', () => {
    const phone = change(shared, T + 10, s => { s.wods = withWod(s.wods, '2026-10-23', prog('Phone'), T + 10) })
    const desk = change(shared, T + 20, s => { s.wods = withWod(s.wods, '2026-10-24', prog('Desk'), T + 20) })
    for (const m of both(phone, desk)) {
      expect(Object.keys(m.wods).sort()).toEqual(['2026-10-23', '2026-10-24'])
      expect(m.edited?.wods).toBeUndefined()
    }
  })

  it('the same date keeps the program written last, whichever copy is newer as a whole', () => {
    const phone = change(shared, T + 50, s => { s.wods = withWod(s.wods, '2026-10-23', prog('Later'), T + 50) })
    const desk = change(change(shared, T + 10, s => { s.wods = withWod(s.wods, '2026-10-23', prog('Earlier'), T + 10) }),
      T + 90, s => { s.restSec = 45 })   // newer copy as a whole
    for (const m of both(phone, desk)) {
      expect(wodOf(m, '2026-10-23').title).toBe('Later')
      expect(m.restSec).toBe(45)
    }
  })

  it('a clear beats the older program and is not brought back by the other copy', () => {
    const saved = change(shared, T + 10, s => { s.wods = withWod(s.wods, '2026-10-23', prog('A'), T + 10); s.exAliases = withAlias(s.exAliases, 't2b', '0099', T + 10) })
    const cleared = change(saved, T + 20, s => { s.wods = withWod(s.wods, '2026-10-23', null, T + 20); s.exAliases = withAlias(s.exAliases, 't2b', null, T + 20) })
    const stale = change(saved, T + 90, s => { s.restSec = 30 })   // still holds them, newer as a whole
    for (const m of both(cleared, stale)) {
      expect(wodOf(m, '2026-10-23')).toBeNull()
      expect(aliasesOf(m)).toEqual({})
      // …and merged again with the stale copy, still gone
      for (const again of both(m, stale)) { expect(wodOf(again, '2026-10-23')).toBeNull(); expect(aliasesOf(again)).toEqual({}) }
    }
  })

  it('a program older than 120 days that one copy still has is gone after the merge', () => {
    const old = base({ wods: { '2026-06-01': { ...prog('Old'), _ts: T }, '2026-10-20': { ...prog('Kept'), _ts: T } } })
    const pruned = base({ _ts: T + 5, wods: { '2026-10-20': { ...prog('Kept'), _ts: T } } })
    for (const m of [...both(old, pruned), ...both(old, pruned, { today: TODAY, prefer: 'a' })]) {
      expect(Object.keys(m.wods)).toEqual(['2026-10-20'])
    }
    // the aliases are bounded by names, never pruned
    const al = base({ exAliases: { 'old name': { exId: '1', _ts: 1 } } })
    expect(mergeStates(al, base(), { today: TODAY }).exAliases).toEqual(al.exAliases)
  })
})

describe('the server\'s copy of the rules (api/sync-stamps.js)', () => {
  // Through the PUT: the phone pushed first, the desk's push is a conflict, it merges and pushes.
  const NOW = Date.UTC(2026, 9, 24, 12)
  const put = (cur, next, opts) => { Server.stampPut(cur, next, { now: NOW, ...opts }); return next }

  it('different dates from two devices both reach the stored copy, the later one of a date wins', () => {
    const shared = base()
    const phone = change(shared, T + 10, s => { s.wods = withWod(s.wods, '2026-10-23', prog('Phone'), T + 10); s.wods = withWod(s.wods, '2026-10-24', prog('Phone 24'), T + 10) })
    const stored = put(clone(shared), clone(phone), { overRead: true, stamped: true })
    const desk = change(shared, T + 20, s => { s.wods = withWod(s.wods, '2026-10-24', prog('Desk 24'), T + 20) })
    const merged = mergeStates(desk, stored, { today: TODAY })
    const after = put(stored, merged, { overRead: true, stamped: true })
    expect(Object.keys(after.wods).sort()).toEqual(['2026-10-23', '2026-10-24'])
    expect(wodOf(after, '2026-10-24').title).toBe('Desk 24')
    expect(after.edited?.wods).toBeUndefined()
  })

  it('a writer that does not stamp never gets the maps stamped whole, and its date survives the other device\'s merge', () => {
    const cur = base({ _rev: 1, wods: { '2026-10-23': { ...prog('Phone'), _ts: T + 10 } } })
    const api = clone(cur); delete api._rev
    api.wods['2026-10-24'] = { ...prog('Planner'), _ts: T + 20 }
    api.exAliases = { t2b: { exId: '0099', _ts: T + 20 } }
    put(cur, api, { overRead: true })
    expect(api.edited?.wods).toBeUndefined()
    expect(api.edited?.exAliases).toBeUndefined()
    expect(api._prior?.wods).toBeUndefined()
    const phone = change(cur, T + 30, s => { s.wods = withWod(s.wods, '2026-10-25', prog('Phone 25'), T + 30) })
    for (const m of both(phone, api)) expect(Object.keys(m.wods).sort()).toEqual(['2026-10-23', '2026-10-24', '2026-10-25'])
  })

  it('an older app that knows nothing of the maps keeps a clear on record', () => {
    const cur = base({ _rev: 1, wods: { '2026-10-23': { _ts: T + 20 } }, exAliases: { t2b: { _ts: T + 20 } } })
    const old = clone(cur); delete old.wods; delete old.exAliases; delete old._rev; old.restSec = 60
    put(cur, old, { overRead: true })
    expect(old.wods).toEqual(cur.wods)
    expect(old.exAliases).toEqual(cur.exAliases)
    const stale = base({ _ts: T + 99, wods: { '2026-10-23': { ...prog('A'), _ts: T + 10 } }, exAliases: { t2b: { exId: '0099', _ts: T + 10 } } })
    for (const m of both(old, stale)) { expect(wodOf(m, '2026-10-23')).toBeNull(); expect(aliasesOf(m)).toEqual({}) }
  })

  it('a program older than 120 days is pruned in the PUT, whoever writes', () => {
    const doc = () => base({ wods: { '2026-06-01': { _ts: 1 }, '2026-10-20': { _ts: 2 } } })
    for (const [cur, opts] of [[null, {}], [base(), { overRead: true }], [base(), { stamped: true }], [base(), { overRead: true, stamped: true }]]) {
      expect(Object.keys(put(cur && clone(cur), doc(), opts).wods)).toEqual(['2026-10-20'])
    }
    // a reset's write too
    expect(Object.keys(put(base(), { ...doc(), resetAt: T + 1 }, {}).wods)).toEqual(['2026-10-20'])
  })
})
