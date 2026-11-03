/* A spent usage limit (T24) in the app's words: when it lifts, in this device's own time, with
 * "tomorrow" once that crosses midnight here, and "later" when the provider printed no time.
 * The dates are built in local time, so the same assertions hold under any TZ.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('./demo.js', () => ({ DEMO: false, DEMO_SEEDED: 'gym_demo_seeded_v1', REPO: '' }))
vi.mock('./mobile.js', () => ({ MOBILE: false }))
vi.mock('./api.js', () => ({ api: vi.fn() }))
vi.mock('./coach-demo.js', () => ({}))
vi.mock('./coach-local.js', () => ({ setNotifier: vi.fn() }))
vi.mock('../store/useStore.js', () => ({ useStore: { getState: () => ({ S: { unit: 'kg' }, coachLocal: null }) } }))
vi.mock('../store/useUI.js', () => ({ useUI: { getState: () => ({ toast: vi.fn() }) } }))

const { quotaText, jobErrorText, JOB_ERRORS } = await import('./coach-api.js')

const NOW = new Date(2026, 10, 2, 20, 0).getTime()
const clock = d => d.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit' })
const LATER = 'The AI provider’s usage limit is reached. Try again later.'

describe('quotaText', () => {
  it('names the time when it is later today', () => {
    const at = new Date(2026, 10, 2, 22, 50)
    expect(quotaText(at.toISOString(), NOW)).toBe(`The AI provider’s usage limit is reached. Try again after ${clock(at)}.`)
  })
  it('says tomorrow once it crosses midnight here', () => {
    const at = new Date(2026, 10, 3, 0, 10)
    expect(quotaText(at.toISOString(), NOW)).toBe(`The AI provider’s usage limit is reached. Try again after ${clock(at)} tomorrow.`)
  })
  it('without a time, or with one that is gone or days out, it says later', () => {
    for (const r of [undefined, null, '', 'not a date', new Date(2026, 10, 1, 22, 50).toISOString(), new Date(2026, 10, 6, 9, 0).toISOString()]) {
      expect(quotaText(r, NOW), String(r)).toBe(LATER)
    }
  })
  it('is the line a failed quota job gets, with and without resetsAt', () => {
    const at = new Date(Date.now() + 60000)
    expect(jobErrorText('quota', '429 You’ve hit your session limit', at.toISOString())).toContain(clock(at))
    expect(jobErrorText('quota')).toBe(LATER)
    expect(JOB_ERRORS.quota).toBe(LATER)
  })
})
