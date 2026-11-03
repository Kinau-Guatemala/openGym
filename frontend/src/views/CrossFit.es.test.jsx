// @vitest-environment happy-dom
// T28: every CrossFit screen and state, rendered with the app in Spanish. Each screen's visible
// text, aria-labels, placeholders, titles and alts are collected, and none may hold English: a
// word from NEVER, or a whole string that is an English key the Spanish pack translates. What the
// box printed (a movement's line, a block's label, a benchmark's name) is its own wording and is
// left out. A new screen or state is one more entry in SCREENS.
import React, { act } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { DEF, useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { _setLangState } from '../lib/i18n-core.js'
import es from '../locales/es.js'
import esNames from '../exercise-names/es.js'
import CrossFit, { CrossFitBox, CrossFitEdit, CrossFitSettings, whichDaySheet } from './CrossFit.jsx'
import { _reset as resetBoxFeed, keepFeed, parseFeed } from '../lib/box-subscribe.js'
import CrossFitLog from './CrossFitLog.jsx'
import { beginIntake, currentIntake, setIntakeImage } from '../lib/wod-intake.js'
import Home from './Home.jsx'
import { exerciseHistorySheet } from '../sheets.jsx'

vi.mock('../lib/api.js', async importOriginal => ({ ...await importOriginal(), api: vi.fn(async () => ({})) }))

const clone = v => JSON.parse(JSON.stringify(v))
const IMAGE = { url: 'data:image/jpeg;base64,AAAA', w: 10, h: 10 }

// English that must never show in Spanish (whole words, case as written).
const NEVER = [
  'For time', 'Rounds', 'rounds', 'Every', 'every', 'Intervals', 'Strength', 'Other', 'Sets', 'sets',
  'Include', 'Warm-up', 'Each side', 'each side', 'Pick exercise', 'Weight', 'Score', 'Try again',
  'Track', 'Full Equipment', 'Calories', 'Meters', 'Seconds', 'Minutes', 'Scaled', 'Substitute',
  'Done', 'Delete', 'Save', 'Log', 'Edit', 'Add', 'Back', 'Cancel', 'rest', 'Men', 'Women',
  'fortime', 'amrap', 'emom', 'interval', 'strength', 'other',
]
const NEVER_RE = new RegExp(`(^|[^\\p{L}-])(${NEVER.join('|')})(?=$|[^\\p{L}-])`, 'u')

/* ---------- fixture: one program with a block of every format ---------- */

const mv = (id, raw, rawName, exId, extra = {}) => ({ id, raw, rawName, exId, dose: {}, alts: [], ...extra })
const block = (id, format, movements, extra = {}) => ({ id, label: '', warmup: false, format, capMin: null, rounds: null, scheme: null, benchmark: null, movements, ...extra })
const PROGRAM = {
  title: 'Lunes',
  tracks: [
    { id: 'full', label: '', kind: 'main', blocks: [
      block('b0', 'other', [mv('m0', '3 Rounds 10 Burpees', 'burpees', '1160', { dose: { reps: 10, sets: 3, restSec: 60 } })], { warmup: true }),
      block('b1', 'fortime', [
        mv('m0', '21-15-9 Thrusters 95/65', 'thrusters', '3305', { rx: { male: { w: 95, unit: 'lb' }, female: { w: 65, unit: 'lb' } } }),
        mv('m1', 'Pull-ups', 'pull-ups', '0652', { alts: [{ rawName: 'ring rows', exId: null, candidates: [{ exId: '0043' }, { exId: '0032' }] }] }),
      ], { scheme: '21-15-9', capMin: 10, benchmark: 'Fran' }),
      block('b2', 'amrap', [
        mv('m0', '20 Cal Row', 'row', '1161', { dose: { cal: 20 } }),
        mv('m1', '10 DB Lunges each side', 'db lunges', '0336', { dose: { reps: 10 }, perSide: true }),
        mv('m2', 'Pistols', 'pistols', '0043', { via: 'guess', candidates: [{ exId: '0043' }, { exId: '0054' }] }),
        mv('m3', 'Zorro walk', 'zorro walk', null),
      ], { capMin: 12 }),
      block('b3', 'strength', [
        mv('m0', '10-8-6-4-2 Deadlift 135→225', 'deadlift', '0032', { steps: [{ rx: { male: { w: 135, unit: 'lb' } } }, {}, {}, {}, { rx: { male: { w: 225, unit: 'lb' } } }] }),
      ], { scheme: '10-8-6-4-2' }),
      block('b4', 'emom', [mv('m0', '30 sec Double unders', 'double unders', '3885', { dose: { sec: 30 } })], { rounds: 4, everySec: 90 }),
      block('b5', 'rounds', [mv('m0', '5 Clean and press', 'clean and press', '0028', { dose: { reps: 5 } })], { rounds: 3, roundsMax: 4 }),
      block('b6', 'interval', [mv('m0', '200 m Run', 'run', null, { dose: { m: 200 } })], { rounds: 4, everySec: 180 }),
      block('b7', 'rounds', [mv('m0', 'Max Pull-ups', 'max pull-ups', '0652', { dose: { sets: 2 } })], { rounds: 5 }),
      block('b8', 'other', [mv('m0', 'Partner burpees', 'partner burpees', '1160', { dose: { reps: 10 } })], { everySec: 90 }),
    ] },
    { id: 't1', label: '', kind: 'extra', blocks: [] },
  ],
}
// T32: the box feed, publishing PROGRAM (and an older day) under the box's own name.
const BOX = 'Holy Program'
const FEED_URL = 'https://raw.githubusercontent.com/box/wods/main/feed.json'
// The box's own wording, shown as printed.
const PRINTED = (() => {
  const out = new Set([PROGRAM.title, BOX])
  for (const tr of PROGRAM.tracks) for (const b of tr.blocks) {
    if (b.label) out.add(b.label)
    if (b.benchmark) out.add(b.benchmark)
    if (b.scheme) out.add(b.scheme)
    for (const m of b.movements) { out.add(m.raw); out.add(m.rawName); for (const a of m.alts) out.add(a.rawName) }
  }
  return [...out].sort((a, b) => b.length - a.length)
})()

const TODAY = '2026-10-28', PAST = '2026-10-27', NEXT = '2026-10-29'

// A logged WOD for the records: Fran Rx, a pull-up (a skill), thrusters under their Rx.
function logPast() {
  const ok = useStore.getState().logWod(PAST, { tracks: ['full'], include: { 'full/b0': false } }, {
    moves: { 'full/b1/m0': { w: 30 }, 'full/b1/m1': {}, 'full/b2/m3': { exId: '1160' }, 'full/b6/m0': { exId: '1160' } },
    blocks: { 'full/b1': { score: { type: 'time', sec: 295 }, rx: true }, 'full/b2': { score: { type: 'rounds', rounds: 5, reps: 3 } } },
  })
  expect(ok).toBeTruthy()
}

/* ---------- mounting and collecting ---------- */

let root, host, sheetHost, sheetRoot, toasts = [], unsub
async function mount(entry, el) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root.render(<MemoryRouter initialEntries={[entry]}>
    <Routes>
      <Route path="/crossfit" element={<CrossFit />} />
      <Route path="/crossfit/new" element={<CrossFitEdit />} />
      <Route path="/crossfit/edit/:date" element={<CrossFitEdit />} />
      <Route path="/crossfit/log/:date" element={<CrossFitLog />} />
      <Route path="/crossfit/box/:date" element={<CrossFitBox />} />
      <Route path="/settings" element={el} />
      <Route path="/home" element={<Home />} />
      <Route path="*" element={null} />
    </Routes>
  </MemoryRouter>))
}
// The top sheet, rendered where the test can reach it (the app's sheet host isn't mounted here).
async function sheet() {
  const top = useUI.getState().sheets.at(-1)
  if (!top) throw new Error('no sheet open')
  if (!sheetHost) { sheetHost = document.createElement('div'); document.body.appendChild(sheetHost); sheetRoot = createRoot(sheetHost) }
  await act(async () => sheetRoot.render(top.render(() => useUI.getState().closeSheet(top.id))))
  return sheetHost
}
const click = async el => { if (!el) throw new Error('nothing to click'); await act(async () => el.click()) }
const byText = (el, text) => [...el.querySelectorAll('button')].find(b => b.textContent.trim() === text)
// The screen shows the Spanish for this English key: the state under test is really there.
const shows = (el, key) => expect(el.textContent).toContain(es[key])
const type = async (el, value) => {
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  await act(async () => { set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) })
}
const helpSheet = async () => { await click(host.querySelector(`[aria-label="${es['What the switches do']}"]`)); return sheet() }

function collect(el) {
  const out = []
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  while (walk.nextNode()) { const s = walk.currentNode.nodeValue.trim(); if (s) out.push(s) }
  for (const n of el.querySelectorAll('[aria-label],[placeholder],[title],[alt]')) {
    for (const a of ['aria-label', 'placeholder', 'title', 'alt']) { const v = n.getAttribute(a); if (v) out.push(v) }
  }
  return out
}
// The printed wording is taken out where it stands as its own words, never from inside a word
// ("row" is printed; "Tomorrow" is not).
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const PRINTED_RE = new RegExp(`(^|[^\\p{L}])(${PRINTED.map(esc).join('|')})(?=$|[^\\p{L}])`, 'gu')
const unprinted = s => s.replace(PRINTED_RE, '$1')
// A word of the English keys that no Spanish string or exercise name uses: new English text,
// even one no pack has a key for yet.
const words = s => (s.match(/\p{L}[\p{L}'’]*/gu) || []).map(w => w.toLowerCase())
const ES_WORDS = new Set(['PR', ...Object.values(es), ...Object.values(esNames)].filter(v => typeof v === 'string').flatMap(words))
const EN_ONLY = new Set(Object.keys(es).flatMap(words).filter(w => !ES_WORDS.has(w)))
// Each string that still reads English, with why.
function english(strings) {
  const bad = []
  for (const s0 of strings) {
    const s = unprinted(s0).trim()
    if (!s) continue
    const hit = s.match(NEVER_RE)
    if (hit) bad.push(`${JSON.stringify(s0)} has "${hit[2]}"`)
    else if (typeof es[s] === 'string' && es[s] !== s) bad.push(`${JSON.stringify(s0)} is untranslated`)
    else { const w = words(s).find(x => EN_ONLY.has(x)); if (w) bad.push(`${JSON.stringify(s0)} has the English word "${w}"`) }
  }
  return bad
}

/* ---------- every screen and state ---------- */

const reason = (r, extra = {}) => ({ pathname: '/crossfit/new', state: { image: IMAGE.url, date: NEXT, reason: r, ...extra } })
// An image read for the intake screen, to its end, by a fake server.
const readTo = async (ending, ready = false) => {
  useStore.setState({ ready })
  setIntakeImage(IMAGE, NEXT)
  const io = { sleep: async () => {}, now: () => 0, ...ending }
  await act(async () => { beginIntake(io); for (let i = 0; i < 10; i++) await Promise.resolve() })
  expect(currentIntake().phase).toBe('done')
}
const failWith = code => ({ parse: async () => { throw Object.assign(new Error(code), { data: { code } }) }, status: async () => ({}) })
const lastFailed = (cls, extra = {}) => ({ parse: async () => ({ job: { id: 'j1' } }), status: async () => ({ last: { id: 'j1', errorClass: cls, ...extra } }) })

// Subscribed to a feed with today's program, PAST's (the member has their own) and an older day.
const subscribed = () => {
  const programs = [TODAY, PAST, '2026-10-25'].map(date => ({ date, ...clone(PROGRAM) }))
  keepFeed(FEED_URL, parseFeed({ v: 1, box: BOX, updatedAt: TODAY + 'T06:00:00Z', programs }))
  useStore.setState({ S: { ...useStore.getState().S, boxFeed: FEED_URL } })
}
const settings = () => <CrossFitSettings S={useStore.getState().S} update={fn => useStore.getState().update(fn)} />
const subscribeWith = async (url, answer) => {
  if (answer) fetch.mockImplementation(async () => ({ ok: true, status: 200, url, headers: { get: () => null }, text: async () => JSON.stringify(answer) }))
  await mount('/settings', settings())
  await type(host.querySelector('input'), url)
  await click(byText(host, es.Subscribe))
  for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve() })
}

const SCREENS = {
  'program list, empty': async () => { useStore.setState({ S: { ...clone(DEF) } }); await mount('/crossfit') },
  'program list, with programs, records and an image read': async () => {
    logPast()
    await readTo({ parse: async () => ({ job: { id: 'j1' } }), status: async () => ({ parsed: { jobId: 'j1', program: PROGRAM } }) })
    await mount('/crossfit')
  },
  'benchmark sheet': async () => {
    logPast()
    await mount('/crossfit')
    await click([...host.querySelectorAll('.mrow')].find(r => r.textContent.includes('Fran')))
    return sheet()
  },
  'which day': async () => { await mount('/crossfit'); await act(async () => whichDaySheet(() => {})); return sheet() },
  'which day, another day that has a program': async () => {
    await mount('/crossfit')
    await act(async () => whichDaySheet(() => {}))
    const el = await sheet()
    await click([...el.querySelectorAll('button')].find(b => b.textContent.includes('Otro día')))
    return sheet()
  },
  'editor, a new program': async () => { await mount('/crossfit/new?date=' + NEXT) },
  'editor, a new program saved with no track': async () => {
    await mount('/crossfit/new?date=' + NEXT)
    await click(host.querySelector('[aria-label="¿Eliminar esta pista?"]'))
    const el = await sheet()
    await click(byText(el, 'Eliminar'))
    await click(byText(host, 'Guardar programa'))
  },
  'editor, a read program to review': async () => { await mount({ pathname: '/crossfit/new', state: { draft: PROGRAM, date: NEXT, image: IMAGE.url } }) },
  'editor, the extra track': async () => {
    await mount({ pathname: '/crossfit/new', state: { draft: PROGRAM, date: NEXT } })
    await click(byText(host, 'Pista 2'))
  },
  'editor, a saved program': async () => { await mount('/crossfit/edit/' + PAST) },
  'editor, delete program': async () => { await mount('/crossfit/edit/' + PAST); await click(byText(host, 'Eliminar programa')); return sheet() },
  'editor, discard changes': async () => {
    await mount({ pathname: '/crossfit/new', state: { draft: PROGRAM, date: NEXT } })
    await click(host.querySelector('[data-back]'))
    return sheet()
  },
  // T29: the first block explains Include; the ? sheet lists every switch.
  'editor, the first block explains Include': async () => {
    await mount({ pathname: '/crossfit/new', state: { draft: PROGRAM, date: NEXT } })
    shows(host, 'Whether this block counts when you log the program. You can change it again on the log screen.')
  },
  'editor, the ? sheet': async () => {
    await mount({ pathname: '/crossfit/new', state: { draft: PROGRAM, date: NEXT } })
    const el = await helpSheet()
    for (const k of ['What the switches do', 'Left out of the log in a main track, unless you include it or turn on Count warm-ups in Settings.',
      'The reps are for each side (12/12): each set logs your left and your right, and both count.']) shows(el, k)
    return el
  },
  'block sheet, new': async () => { await mount('/crossfit/new?date=' + NEXT); await click(byText(host, 'Añadir bloque')); return sheet() },
  'block sheet, edit': async () => {
    await mount({ pathname: '/crossfit/new', state: { draft: PROGRAM, date: NEXT } })
    await click(host.querySelector('.card [style*="cursor: pointer"]'))
    return sheet()
  },
  'movement sheet, with steps': async () => {
    await mount({ pathname: '/crossfit/new', state: { draft: PROGRAM, date: NEXT } })
    await click([...host.querySelectorAll('[style*="cursor: pointer"]')].find(d => d.textContent.includes('Deadlift')))
    return sheet()
  },
  'movement sheet, new and empty': async () => {
    await mount({ pathname: '/crossfit/new', state: { draft: PROGRAM, date: NEXT } })
    await click(byText(host, 'Añadir movimiento'))
    const el = await sheet()
    await click(byText(el, 'Listo'))
    return el
  },
  ...Object.fromEntries(['novision', 'provider', 'timeout', 'consent', 'off', 'empty', 'network', 'unsupported', 'internal'].map(r =>
    [`review, image not read: ${r}`, async () => { await mount(reason(r)) }])),
  'review, image not read: quota, with a time': async () => { await mount(reason('quota', { resetsAt: new Date('2026-10-28T22:50:00').toISOString() })) },
  'review, image not read: quota, tomorrow': async () => { await mount(reason('quota', { resetsAt: new Date('2026-10-29T08:00:00').toISOString() })) },
  'review, image not read: quota, no time': async () => { await mount(reason('quota')) },
  'intake, reading': async () => { useStore.setState({ ready: false }); setIntakeImage(IMAGE, NEXT); await mount('/crossfit/new?shared=1') },
  ...Object.fromEntries(['novision', 'provider', 'timeout', 'network', 'restart'].map(c =>
    [`intake, failed: ${c}`, async () => { await readTo(c === 'network' ? failWith(undefined) : c === 'restart' ? { parse: async () => ({ job: { id: 'j1' } }), status: async () => ({ job: null }) } : lastFailed(c)); await mount('/crossfit/new?shared=1') }])),
  'intake, failed: quota, with a time': async () => { await readTo(lastFailed('quota', { resetsAt: new Date('2026-10-28T22:50:00').toISOString() })); await mount('/crossfit/new?shared=1') },
  'intake, failed: quota, no time': async () => { await readTo(lastFailed('quota')); await mount('/crossfit/new?shared=1') },
  'intake, no routine in the image': async () => { await readTo({ parse: async () => ({ job: { id: 'j1' } }), status: async () => ({ parsed: { jobId: 'j1', program: { tracks: [] } } }) }); await mount('/crossfit/new?shared=1') },
  'log, every block and score type': async () => {
    await mount('/crossfit/log/' + PAST)
    // the warm-up is left out until included
    await click(host.querySelector('[aria-label="Incluir"]'))
  },
  'log, every score type on one block': async () => {
    await mount('/crossfit/log/' + PAST)
    const seen = []
    for (const label of ['–', 'Tiempo', 'Rondas', 'Carga']) {
      await click([...host.querySelectorAll('.seg button')].find(b => b.textContent.trim() === label))
      seen.push(...collect(host))
    }
    return seen
  },
  'log, the extra track with a substitute picked and Rx on': async () => {
    await mount('/crossfit/log/' + PAST)
    await click(byText(host, 'Pista 2'))
    for (const sw of host.querySelectorAll('[aria-label="Rx"]')) await click(sw)
    await click(byText(host, 'remo (en máquina de remo)'))
  },
  'log, nothing to log': async () => {
    await mount('/crossfit/log/' + PAST)
    await click(byText(host, 'Pista 1'))
    await click(byText(host, 'Pista 2'))
    await click(byText(host, 'Registrar entrenamiento'))
  },
  'log, saved: the summary': async () => {
    await mount('/crossfit/log/' + PAST)
    await click(byText(host, 'Registrar entrenamiento'))
    return sheet()
  },
  // T29: the first block explains Include, the first included one Rx; the ? sheet lists them.
  'log, the first blocks explain Include and Rx': async () => {
    await mount('/crossfit/log/' + PAST)
    shows(host, 'Off leaves this block out: nothing from it is saved with the workout.')
    shows(host, 'Done as prescribed, no scaling. Benchmarks keep your Rx and scaled bests apart.')
  },
  'log, the ? sheet': async () => {
    await mount('/crossfit/log/' + PAST)
    const el = await helpSheet()
    shows(el, 'Your result: a time, rounds plus extra reps, or a load. Rounds also set how many sets are logged, and a benchmark keeps your best.')
    return el
  },
  // T30: the weights in kg (the profile's), then switched to lb.
  'log, weights in kg': async () => {
    await mount('/crossfit/log/' + PAST)
    shows(host, 'Weight unit')
    expect(host.querySelector('.seg button.on').textContent).toBe('kg')
  },
  'log, weights switched to lb': async () => {
    await mount('/crossfit/log/' + PAST)
    await click(byText(host, 'lb'))
    expect(host.querySelector('.seg button.on').textContent).toBe('lb')
    expect(host.textContent).toContain('Rx 95 lb')
  },
  'log, a profile in lb': async () => {
    useStore.setState({ S: { ...useStore.getState().S, unit: 'lb' } })
    await mount('/crossfit/log/' + PAST)
    expect(host.querySelector('.seg button.on').textContent).toBe('lb')
  },
  'log, already logged': async () => { logPast(); await mount('/crossfit/log/' + PAST) },
  // The CrossFit row on Home, and the Rx line in an exercise's history sheet.
  'home, today has a program': async () => {
    useStore.setState({ S: { ...useStore.getState().S, wods: { [TODAY]: { ...clone(PROGRAM), _ts: 1 } } } })
    await mount('/home')
    const row = [...host.querySelectorAll('.today-row')].find(r => r.textContent.includes(es['Today’s WOD']))
    expect(row).toBeTruthy()
    return row
  },
  'home, no program today': async () => {
    await mount('/home')
    const row = [...host.querySelectorAll('.today-row')].find(r => r.textContent.includes(es['Add today’s WOD']))
    expect(row).toBeTruthy()
    return row
  },
  'exercise sheet, the Rx line': async () => {
    logPast()
    await mount('/crossfit')
    await act(async () => exerciseHistorySheet('3305'))
    const line = (await sheet()).querySelector('[data-rx-line]')
    expect(line).toBeTruthy()
    return line
  },
  'settings, no picks': async () => { await mount('/settings', <CrossFitSettings S={useStore.getState().S} update={() => {}} />) },
  'program list, with the box feed': async () => {
    subscribed()
    await mount('/crossfit')
    shows(host, 'Box version available')
    expect(host.textContent).toContain(es['From {0}'].replace('{0}', BOX))
    expect(host.querySelector('details')).toBeTruthy()
  },
  'box program, read-only': async () => { subscribed(); await mount('/crossfit/box/' + TODAY) },
  'box program, the member has their own that day': async () => {
    subscribed()
    await mount('/crossfit/box/' + PAST)
    shows(host, 'You have your own program for this day. Logging or editing the box version replaces it.')
  },
  'box program, replace your own': async () => {
    subscribed()
    await mount('/crossfit/box/' + PAST)
    await click(byText(host, es.Log))
    return sheet()
  },
  'settings, box feed: an http address': async () => {
    await subscribeWith('http://example.com/feed.json')
    shows(host, 'Only https addresses can be used.')
  },
  'settings, box feed: unreachable': async () => {
    await subscribeWith(FEED_URL)
    shows(host, 'The feed could not be reached. Check the address and your connection.')
  },
  'settings, box feed: not a box feed': async () => {
    await subscribeWith(FEED_URL, { hello: 1 })
    shows(host, 'This address is not a box feed.')
  },
  'settings, box feed: subscribing': async () => {
    await subscribeWith(FEED_URL, { v: 1, box: BOX, programs: [] })
    expect(useStore.getState().S.boxFeed).toBe(FEED_URL)
  },
  'settings, box feed: subscribed': async () => { subscribed(); await mount('/settings', settings()); shows(host, 'Unsubscribe') },
  'settings, with picks': async () => {
    useStore.getState().setAlias('ring rows', '0043')
    await mount('/settings', <CrossFitSettings S={useStore.getState().S} update={() => {}} />)
  },
}

beforeAll(() => _setLangState('es', es, null, esNames, false))
afterAll(() => _setLangState('en', {}, null, null))
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(TODAY + 'T09:00:00'))
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  toasts = []
  unsub = useUI.subscribe(s => { if (s.toastMsg) toasts.push(s.toastMsg) })
  useUI.setState({ sheets: [], toastMsg: '' })
  localStorage.clear(); resetBoxFeed()
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('no network in tests') }))
  useStore.setState({ S: { ...clone(DEF), wods: { [PAST]: { ...clone(PROGRAM), _ts: 1 }, [NEXT]: { ...clone(PROGRAM), _ts: 1 } } }, user: null, ready: true })
})
afterEach(() => {
  unsub()
  if (root) act(() => root.unmount())
  host?.remove()
  if (sheetHost) { act(() => sheetRoot.unmount()); sheetHost.remove(); sheetHost = null }
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('CrossFit in Spanish (T28)', () => {
  for (const [name, show] of Object.entries(SCREENS)) {
    it(name, async () => {
      const shown = await show()
      const strings = [...(Array.isArray(shown) ? shown : collect(shown || host)), ...toasts]
      expect(strings.length).toBeGreaterThan(0)
      expect(english(strings)).toEqual([])
    })
  }

  // The check itself: it catches English, and lets the box's printed wording through.
  it('flags English and passes printed text', () => {
    expect(english(['For time', 'fortime', '5 rounds', 'Pick exercise', 'Pista 1', '3 Rounds 10 Burpees', 'AMRAP', 'Rx'])).toHaveLength(4)
    // a new sentence no pack has, and English around a printed word
    expect(english(['Tap a block to change it', 'Tomorrow', 'The Coach couldn’t run.', 'row', '20 Cal Row'])).toHaveLength(3)
  })
})
