// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CoachChat from './CoachChat.jsx'
import { CONSENT_VERSION } from '../lib/coach.js'   // the consent a fixture grants is the current one, whatever its number
import { settleAwaited } from '../lib/coach-api.js'

// A run that fails before the first status poll. A provider that refuses the connection fails
// the job in milliseconds, so by the time the chat asks for the status the job is already gone
// and the server's last outcome is `failed` / `provider`. The chat used to write a reply only
// when it had seen the job running and then gone, so these runs ended with no reply at all —
// three questions in a row, three silences. The real lib/coach-api.js runs here; only the HTTP
// layer is faked, answering the way the server does.
const mocks = vi.hoisted(() => {
  const state = { S: null, nav: vi.fn(), toast: vi.fn(), openSheet: vi.fn(), server: null }
  state.storeSnapshot = () => ({
    S: state.S, user: { id: 'u1' }, ready: true,
    config: { coach: { enabled: true } }, coachLocal: null,
    update: mut => mut(state.S),
  })
  state.uiSnapshot = () => ({ toast: state.toast, openSheet: state.openSheet })
  return state
})

vi.mock('../store/useStore.js', () => {
  const useStore = selector => selector(mocks.storeSnapshot())
  useStore.getState = mocks.storeSnapshot
  return { useStore }
})
vi.mock('../store/useUI.js', () => {
  const useUI = selector => (selector ? selector(mocks.uiSnapshot()) : mocks.uiSnapshot())
  useUI.getState = mocks.uiSnapshot
  return { useUI }
})
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.nav }))
vi.mock('../sheets.jsx', () => ({ startFlow: vi.fn(), confirmSheet: vi.fn() }))
vi.mock('../coach.css', () => ({}))
// The server: whatever the test puts in mocks.server is the status it answers.
vi.mock('../lib/api.js', () => ({
  IS_APPLE: false, IS_ANDROID: false, BIO: 'biometrics',
  api: vi.fn(async path => {
    const srv = mocks.server
    if (path === '/api/coach/status') return { job: srv.job, pending: null, parsed: srv.parsed || null, cap: { used: 1, limit: 10 }, last: srv.last, maxMessageLen: 1000 }
    return {}
  }),
}))

let root, container

function installDom() {
  document.body.innerHTML = '<div id="root"></div>'
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.getElementById('root')
  root = createRoot(container)
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
const settle = async () => { await act(async () => { await flush() }) }
async function mount() {
  installDom()
  await act(async () => { root.render(React.createElement(CoachChat)) })
  await settle()
}

const state = routines => ({
  unit: 'kg', lang: 'en', customEx: [], workouts: [{ id: 'w1', name: 'Push Day', d: '2026-09-01', entries: [] }], bodyweight: [], exWeights: {},
  dayPlan: {}, routines, week: {},
  coach: {
    consent: { agreedAt: '2026-07-01T00:00:00Z', version: CONSENT_VERSION },
    profile: { goal: 'muscle', experience: 'new', daysPerWeek: 3, sessionMin: 60, preferredDays: [1, 3, 5], equipment: [] },
    log: [], snapshots: [], chat: [{ id: 'c1', role: 'user', kind: 'intake', at: 1 }], timings: []
  },
})
const replies = () => mocks.S.coach.chat.filter(m => m.role === 'coach')
const parseJob = { id: 'p1', kind: 'parse-wod', state: 'running', startedAt: Date.now() }

beforeEach(() => {
  vi.clearAllMocks()
  settleAwaited()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  mocks.S = state([])
})
afterEach(async () => {
  if (root) { await act(async () => { root.unmount() }); root = null }
  container = null
  vi.useRealTimers()
})

// Reading a routine image is a Coach job, and the status poll reports it like any other. The
// chat is a conversation about training, so it must neither type through one nor answer how
// one ended.
describe('a parse-wod job, seen from the chat', () => {
  it('shows no typing bubble and leaves the composer usable while it runs', async () => {
    mocks.server = { job: parseJob, last: null }
    await mount()
    expect(container.textContent).not.toContain('Reading your training')
    expect(container.querySelector('.chat-st').textContent).toBe('here when you need it')
    expect(container.querySelector('.composer textarea').disabled).toBe(false)
  })

  it('writes no reply when it ends, failed or not', async () => {
    mocks.server = { job: parseJob, last: null }
    await mount()
    mocks.server = { job: null, last: { id: 'p1', kind: 'parse-wod', outcome: 'failed', errorClass: 'unusable', at: Date.now() } }
    await act(async () => { await vi.advanceTimersByTimeAsync(61000); await flush() })
    expect(replies()).toHaveLength(0)
  })
})
