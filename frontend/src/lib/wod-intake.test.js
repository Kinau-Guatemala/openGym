import { describe, it, expect, vi } from 'vitest'
import { beginIntake, currentIntake, defaultDayFor, downscale, failureOf, fitSize, fromDataUrl, initShareIntake, isoForChoice, readProgram, readyIntake, setIntakeImage, subscribeIntake, takeIntake, tomorrowISO } from './wod-intake.js'

const share = vi.hoisted(() => ({ cb: null }))
vi.mock('./mobile.js', () => ({ onSharedImage: cb => { share.cb = cb } }))

// A canvas that records what it was asked for and "encodes" the type it was given.
const fakeCanvas = () => {
  const c = {
    drawn: null,
    getContext: () => ({ fillRect() {}, drawImage: (img, x, y, w, h) => { c.drawn = { w, h } } }),
    toDataURL: (type, q) => { c.type = type; c.q = q; return `data:${type};base64,QUJD` },
  }
  return c
}

describe('downscale', () => {
  it('brings the long side to 1600 px and encodes JPEG at q 0.85', async () => {
    for (const [w, h] of [[4000, 3000], [1080, 4096], [1600, 1600]]) {
      const c = fakeCanvas()
      const out = await downscale('x', { load: async () => ({ naturalWidth: w, naturalHeight: h }), canvas: () => c })
      expect(Math.max(c.width, c.height)).toBe(1600)
      expect(c.drawn).toEqual({ w: c.width, h: c.height })
      expect(c.width / c.height).toBeCloseTo(w / h, 2)
      expect(c.type).toBe('image/jpeg')
      expect(c.q).toBe(0.85)
      expect(out).toEqual({ url: 'data:image/jpeg;base64,QUJD', mime: 'image/jpeg', data: 'QUJD' })
    }
  })

  it('never enlarges a small image', async () => {
    const c = fakeCanvas()
    await downscale('x', { load: async () => ({ width: 720, height: 1280 }), canvas: () => c })
    expect([c.width, c.height]).toEqual([720, 1280])
  })

  it('refuses a decompression bomb before drawing it', async () => {
    const canvas = vi.fn(fakeCanvas)
    await expect(downscale('x', { load: async () => ({ naturalWidth: 30000, naturalHeight: 30000 }), canvas })).rejects.toThrow()
    await expect(downscale('x', { load: async () => ({ naturalWidth: 0, naturalHeight: 0 }), canvas })).rejects.toThrow()
    expect(canvas).not.toHaveBeenCalled()
    // a 48 MP phone photo is still fine
    await downscale('x', { load: async () => ({ naturalWidth: 8000, naturalHeight: 6000 }), canvas })
    expect(canvas).toHaveBeenCalledTimes(1)
  })

  it('fitSize keeps both sides at least 1 px', () => {
    expect(fitSize(20000, 1)).toEqual({ w: 1600, h: 1 })
  })
})

it('fromDataUrl splits a data URL and rejects anything else', () => {
  expect(fromDataUrl('data:image/png;base64,AAAA')).toEqual({ url: 'data:image/png;base64,AAAA', mime: 'image/png', data: 'AAAA' })
  expect(fromDataUrl('blob:x')).toBe(null)
})

it('tomorrowISO is the next calendar day', () => {
  expect(tomorrowISO(new Date(2026, 11, 31, 23, 30))).toBe('2027-01-01')
})

// T20: the day an image with no date of its own is asked for. Dates are built in local time
// (new Date(y, m, d, h)), the way the phone's clock reads, never from a 'YYYY-MM-DD' string.
describe('which day an image is for', () => {
  it('highlights today before noon and tomorrow from noon', () => {
    expect(defaultDayFor(new Date(2026, 9, 28, 0, 0))).toBe('today')
    expect(defaultDayFor(new Date(2026, 9, 28, 9, 0))).toBe('today')
    expect(defaultDayFor(new Date(2026, 9, 28, 11, 59, 59))).toBe('today')
    expect(defaultDayFor(new Date(2026, 9, 28, 12, 0))).toBe('tomorrow')
    expect(defaultDayFor(new Date(2026, 9, 28, 18, 0))).toBe('tomorrow')
    expect(defaultDayFor(new Date(2026, 9, 28, 23, 59))).toBe('tomorrow')
  })

  it('turns the choice into the local date, across a month and a year', () => {
    const late = new Date(2026, 9, 31, 23, 30)
    expect(isoForChoice('today', late)).toBe('2026-10-31')
    expect(isoForChoice('tomorrow', late)).toBe('2026-11-01')
    const early = new Date(2026, 11, 31, 0, 15)
    expect(isoForChoice('today', early)).toBe('2026-12-31')
    expect(isoForChoice('tomorrow', early)).toBe('2027-01-01')
    expect(isoForChoice('tomorrow', new Date(2028, 1, 28, 20))).toBe('2028-02-29')
  })

  it('passes a picked date through and refuses anything else', () => {
    expect(isoForChoice('2026-11-03')).toBe('2026-11-03')
    expect(isoForChoice('')).toBe(null)
    expect(isoForChoice(undefined)).toBe(null)
    expect(isoForChoice('next week')).toBe(null)
  })
})

describe('a shared image (initShareIntake)', () => {
  it('asks the day first, and is read for the answer', async () => {
    globalThis.window = { location: { hash: '' } }
    const asks = []
    const unreadable = vi.fn()
    initShareIntake(unreadable, go => asks.push(go), async url => fromDataUrl(url))
    setIntakeImage(null, '2026-01-01')
    const before = currentIntake()
    await share.cb({ mime: 'image/jpeg', data: 'QUJD' })
    // nothing handed over, nowhere gone, until a day is picked
    expect(asks).toHaveLength(1)
    expect(currentIntake()).toBe(before)
    expect(window.location.hash).toBe('')
    asks[0]('2026-10-28')
    expect(currentIntake()).toMatchObject({ date: '2026-10-28', phase: 'pending', image: { data: 'QUJD' } })
    expect(window.location.hash).toBe('#/crossfit/new?shared=1')
    // one that cannot be opened is not asked about
    await share.cb({ error: 'x' })
    expect(asks).toHaveLength(1)
    expect(unreadable).toHaveBeenCalledTimes(1)
    delete globalThis.window
  })
})

/* ---------- the flow, against a scripted server ---------- */

const IMG = { url: 'data:image/jpeg;base64,QUJD', mime: 'image/jpeg', data: 'QUJD' }
const PROGRAM = { title: '', tracks: [{ id: 'full', label: 'Full', kind: 'main', blocks: [{ label: 'WOD', movements: [] }] }] }
const refuse = (code, status = 409) => Object.assign(new Error(code), { status, data: { code } })

// io whose parse() and status() answer from scripts, one entry per call (the last repeats).
function server({ parse = [{ job: { id: 'j1' } }], status = [] } = {}) {
  let p = 0, s = 0, clock = 0
  const io = {
    calls: { parse: [], status: 0, phases: [] },
    parse: async (date, image) => {
      io.calls.parse.push({ date, image })
      const a = parse[Math.min(p++, parse.length - 1)]
      if (a instanceof Error) throw a
      return a
    },
    status: async () => {
      io.calls.status++
      const a = status[Math.min(s++, status.length - 1)]
      if (a instanceof Error) throw a
      return a
    },
    sleep: async ms => { clock += ms },
    now: () => clock,
    alive: () => true,
    onPhase: ph => io.calls.phases.push(ph),
  }
  return io
}

describe('readProgram', () => {
  it('sends the date and the image, and returns the program once it is parsed', async () => {
    const io = server({ status: [
      { job: { id: 'j1' }, parsed: null },
      { job: null, parsed: { jobId: 'j1', program: PROGRAM }, last: { id: 'j1', outcome: 'ready' } },
    ] })
    expect(await readProgram(IMG, '2026-10-23', io)).toEqual({ program: PROGRAM, jobId: 'j1' })
    expect(io.calls.parse).toEqual([{ date: '2026-10-23', image: IMG }])
  })

  it('does not take an older parse still waiting for its ack for this one', async () => {
    const io = server({ status: [
      { job: { id: 'j1' }, parsed: { jobId: 'old', program: PROGRAM } },
      { job: null, parsed: { jobId: 'j1', program: PROGRAM }, last: { id: 'j1', outcome: 'ready' } },
    ] })
    expect((await readProgram(IMG, '2026-10-23', io)).jobId).toBe('j1')
    expect(io.calls.status).toBe(2)
  })

  it('a program with no tracks is "no routine found"', async () => {
    const io = server({ status: [{ job: null, parsed: { jobId: 'j1', program: { tracks: [] } }, last: { id: 'j1', outcome: 'ready' } }] })
    expect(await readProgram(IMG, '2026-10-23', io)).toMatchObject({ failed: 'empty' })
  })

  it('tracks with no block in any are "no routine found" too', async () => {
    const skeleton = { tracks: [{ id: 'full', blocks: [] }, { id: 'evo', blocks: [] }] }
    const io = server({ status: [{ job: null, parsed: { jobId: 'j1', program: skeleton }, last: { id: 'j1', outcome: 'ready' } }] })
    expect(await readProgram(IMG, '2026-10-23', io)).toMatchObject({ failed: 'empty' })
  })

  it.each([['off', 503], ['consent', 403], ['unsupported', 422], ['shared', 409], ['unprivileged', 503]])(
    'a %s refusal goes to the manual screen', async (code, status) => {
      expect(await readProgram(IMG, '2026-10-23', server({ parse: [refuse(code, status)] }))).toEqual({ manual: code })
    })

  it('no session or no pairing is the Coach being off', async () => {
    expect(await readProgram(IMG, 'd', server({ parse: [Object.assign(new Error(), { status: 401, data: { error: 'not signed in' } })] }))).toEqual({ manual: 'off' })
    expect(await readProgram(IMG, 'd', server({ parse: [Object.assign(new Error(), { code: 'not-paired', status: 0 })] }))).toEqual({ manual: 'off' })
  })

  it('cap and an unreachable server are failures to retry', async () => {
    expect(await readProgram(IMG, 'd', server({ parse: [refuse('cap', 429)] }))).toEqual({ failed: 'cap' })
    expect(await readProgram(IMG, 'd', server({ parse: [Object.assign(new Error('x'), { code: 'timeout' })] }))).toEqual({ failed: 'network' })
  })

  it('busy: waits for the running job to end, then asks again', async () => {
    const io = server({
      parse: [refuse('busy'), { job: { id: 'j2' } }],
      status: [
        { job: { id: 'plan' } }, { job: null },                                              // the wait
        { job: null, parsed: { jobId: 'j2', program: PROGRAM }, last: { id: 'j2', outcome: 'ready' } },
      ],
    })
    expect(await readProgram(IMG, 'd', io)).toEqual({ program: PROGRAM, jobId: 'j2' })
    expect(io.calls.parse).toHaveLength(2)
    expect(io.calls.phases).toEqual(['waiting', 'reading'])
  })

  it('a failed job reports its class', async () => {
    const io = server({ status: [{ job: null, parsed: null, last: { id: 'j1', outcome: 'failed', errorClass: 'unusable' } }] })
    expect(await readProgram(IMG, 'd', io)).toEqual({ failed: 'unusable' })
  })

  it('a job that vanished (server restart) is a failure to retry', async () => {
    const io = server({ status: [{ job: null, parsed: null, last: { id: 'someone-else', outcome: 'ready' } }] })
    expect(await readProgram(IMG, 'd', io)).toEqual({ failed: 'restart' })
  })

  it('dropped polls are asked again, and a job that never ends times out', async () => {
    const io = server({ status: [new Error('offline'), { job: { id: 'j1' } }] })
    expect(await readProgram(IMG, 'd', io)).toEqual({ failed: 'timeout' })
    expect(io.calls.status).toBeGreaterThan(10)
  })

  it('stops when a newer image replaced it', async () => {
    const io = server({ status: [{ job: { id: 'j1' } }] })
    io.alive = () => false
    expect(await readProgram(IMG, 'd', io)).toEqual({ cancelled: true })
    expect(io.calls.status).toBe(0)
  })
})

describe('the run', () => {
  it('starts once however often it is begun, and is taken once', async () => {
    const unsub = subscribeIntake(() => {})
    setIntakeImage(IMG, '2026-10-23')
    const io = server({ status: [{ job: null, parsed: { jobId: 'j1', program: PROGRAM }, last: { id: 'j1', outcome: 'ready' } }] })
    beginIntake(io)
    beginIntake(io)   // StrictMode's second effect
    await vi.waitFor(() => expect(currentIntake().phase).toBe('done'))
    expect(io.calls.parse).toHaveLength(1)
    expect(currentIntake().result).toEqual({ program: PROGRAM, jobId: 'j1' })
    expect(takeIntake()).toMatchObject({ date: '2026-10-23', image: IMG })
    expect(takeIntake()).toBe(null)
    unsub()
  })

  it('finishes with nobody watching, and keeps the program to offer later', async () => {
    setIntakeImage(IMG, '2026-10-24')   // no subscriber: the person went back mid-read
    const io = server({ status: [
      { job: { id: 'j1' }, parsed: null },
      { job: null, parsed: { jobId: 'j1', program: PROGRAM }, last: { id: 'j1', outcome: 'ready' } },
    ] })
    beginIntake(io)
    expect(readyIntake(currentIntake())).toBe(null)   // still reading
    await vi.waitFor(() => expect(currentIntake().phase).toBe('done'))
    expect(io.calls.status).toBe(2)
    expect(readyIntake(currentIntake())).toMatchObject({ date: '2026-10-24', result: { program: PROGRAM, jobId: 'j1' } })
    expect(failureOf(currentIntake())).toBe(null)
    takeIntake()
    expect(readyIntake(currentIntake())).toBe(null)   // opened once, offered no more
  })

  it('failureOf: a cancelled run is a failure, never still reading', () => {
    expect(failureOf({ phase: 'done', result: { cancelled: true } })).toBe('internal')
    expect(failureOf({ phase: 'done', result: { failed: 'empty' } })).toBe('empty')
    expect(failureOf({ phase: 'done', result: { program: PROGRAM } })).toBe(null)
    expect(failureOf({ phase: 'reading', result: null })).toBe(null)
    expect(readyIntake({ phase: 'done', result: { failed: 'cap' } })).toBe(null)
  })

  it('a newer image replaces the run, and the older answer is dropped', async () => {
    const unsub = subscribeIntake(() => {})
    setIntakeImage(IMG, 'a')
    let release
    const slow = { ...server(), parse: () => new Promise(r => { release = r }) }
    beginIntake(slow)
    setIntakeImage({ ...IMG, data: 'B' }, 'b')
    release({ job: { id: 'old' } })
    await new Promise(r => setTimeout(r, 0))
    expect(currentIntake()).toMatchObject({ date: 'b', phase: 'pending' })
    unsub()
  })
})
