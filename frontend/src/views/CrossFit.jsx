// CrossFit: the programs a box posts (S.wods, lib/wods.js), one per date it is for.
//
//   #/crossfit             upcoming and recent programs
//   #/crossfit/new         a new program: empty, or a parsed draft handed over in the route's state
//                          ({ draft, date, image }, T05's Share/upload); ?date= picks the day.
//                          { image, date, reason } is the manual path for an image the Coach
//                          could not read: typed by hand, the image beside it.
//   #/crossfit/new?shared=1  an image being read (lib/wod-intake.js), on its way to the above
//   #/crossfit/edit/<date> the program saved for that date
//
// The editor works on a draft (lib/wod-draft.js) and writes nothing until Save. A movement's
// exercise chip opens the exercise picker; the pick is remembered for that printed name
// (S.exAliases), so the same name resolves by itself in every later program. A misspelled name
// arrives as a best guess ("Did you mean?", one tap confirms it) or with suggestions to choose
// from (lib/crossfit-resolve.js); confirming or choosing is a pick like any other.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { exOr } from '../lib/exercises.js'
import { t, exerciseNameFor } from '../lib/i18n.js'
import { fmtDate, fmtNum, todayISO } from '../lib/format.js'
import { wodOf, aliasesOf } from '../lib/wods.js'
import { norm, rawNameOf } from '../lib/crossfit-resolve.js'
import { rxFor, doseFor, fmtDose } from '../lib/rx.js'
import { fmtRest } from '../lib/duration.js'
import { applyPick, includeOf, movementFromText, nextId, prepareDraft, resolveInto } from '../lib/wod-draft.js'
import { tappable, useSheetKeyboard } from '../lib/use-sheet-keyboard.js'
import { exercisePicker, confirmSheet } from '../sheets.jsx'
import { DEMO } from '../lib/demo.js'
import { muscleGap } from '../lib/muscle-gap.js'
import { MUSCLE_NAME } from '../lib/muscles.js'
import { profileBodyweightKg } from '../lib/bodyweight.js'
import { hasConsent } from '../lib/coach.js'
import { JOB_ERRORS, ackParsed, parseStatus, parseWod } from '../lib/coach-api.js'
import { INTAKE_ROUTE, beginIntake, currentIntake, downscale, failureOf, fromDataUrl, readyIntake, setIntakeImage, subscribeIntake, takeIntake, tomorrowISO } from '../lib/wod-intake.js'
import Icon from '../components/Icon.jsx'
import CrossFitRecords from './CrossFitRecords.jsx'
import { Button, NumberField, Row, Section, Segmented, SelectRow, Switch, TextField } from '../components/ui.jsx'

const ui = () => useUI.getState()
const toast = m => ui().toast(m)

const FORMATS = ['amrap', 'emom', 'fortime', 'rounds', 'interval', 'strength', 'other']
const formatLabel = f => ({
  amrap: 'AMRAP', emom: 'EMOM', fortime: t('For time'), rounds: t('Rounds'),
  interval: t('Intervals'), strength: t('Strength'), other: t('Other'),
})[f] || t('Other')
const DOSE_KINDS = ['reps', 'cal', 'm', 'sec']
const doseLabel = k => ({ reps: t('Reps'), cal: t('Calories'), m: t('Meters'), sec: t('Seconds') })[k]

// An icon inside a chip, sitting on the text line (the exercise picker's chips do the same).
const CHIP_ICON = { fontSize: 12, display: 'inline-block', marginInlineEnd: 4, verticalAlign: '-1px' }
const ISO = /^\d{4}-\d{2}-\d{2}$/
export const trackNames = w => (w?.tracks || []).map(tr => tr.label).filter(Boolean).join(' · ')

// Back the way you came when there is a way, else to the list.
const goBack = nav => ((window.history.state?.idx || 0) > 0 ? nav(-1) : nav('/crossfit', { replace: true }))

/* ============================ the list ============================ */

export default function CrossFit() {
  const nav = useNavigate()
  const S = useStore(s => s.S)
  const today = todayISO()
  const dates = Object.keys(S.wods || {}).filter(d => wodOf(S, d))
  const upcoming = dates.filter(d => d >= today).sort()
  const recent = dates.filter(d => d < today).sort().reverse()
  // An image read while the person was elsewhere: the job ran and was charged, so it is offered here.
  const read = readyIntake(useSyncExternalStore(subscribeIntake, currentIntake))
  const row = d => {
    const w = wodOf(S, d)
    return <div key={d} className="item" {...tappable(() => nav('/crossfit/edit/' + d))}>
      <span className="lrow-i" style={{ background: d === today ? 'var(--orange)' : 'var(--surface-3)' }}><Icon name="flame" /></span>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="tt">{w.title || fmtDate(d, true)}</div>
        <div className="ss">{[w.title ? fmtDate(d, true) : null, trackNames(w)].filter(Boolean).join(' · ')}</div>
      </div>
      {d <= today && <Button size="sm" variant="tinted" style={{ width: 'auto', flex: 'none' }}
        onClick={e => { e.stopPropagation(); nav('/crossfit/log/' + d) }}>{t('Log')}</Button>}
      <Icon name="chevronRight" className="chev" />
    </div>
  }
  return <div className="narrow">
    <div className="hdr">
      <button className="iconbtn" onClick={() => nav('/home')} aria-label={t('Home')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginInlineStart: 12 }}><h1>{t('CrossFit')}</h1>
        <div className="sub">{t('The programs your box posts, one per day.')}</div></div>
    </div>
    <div className="row" style={{ gap: 8, marginBottom: 18 }}>
      <Button variant="primary" icon="plus" onClick={() => nav('/crossfit/new')}>{t('New program')}</Button>
      <UploadImage date={tomorrowISO} />
    </div>
    {read && <div className="list" style={{ marginBottom: 18 }}>
      <div className="item" {...tappable(() => { const r = takeIntake(); if (r) openRead(nav, r) })}>
        <span className="lrow-i" style={{ background: 'var(--green)' }}><Icon name="image" /></span>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="tt">{t('Your image was read. Review it')}</div>
          <div className="ss">{fmtDate(read.date, true)}</div>
        </div>
        <Icon name="chevronRight" className="chev" />
      </div>
    </div>}
    <GapLine S={S} onOpen={() => nav('/stats')} />
    {!dates.length && <div className="empty">{t('No programs yet. Add one by hand, or upload the image your box posts.')}</div>}
    {upcoming.length > 0 && <><h4 className="sec">{t('Upcoming')}</h4><div className="list">{upcoming.map(row)}</div></>}
    {recent.length > 0 && <><h4 className="sec">{t('Recent')}</h4><div className="list">{recent.map(row)}</div></>}
    <CrossFitRecords S={S} />
  </div>
}

// T10: one line of the hypertrophy gap (lib/muscle-gap.js), the three muscles furthest below
// the weekly target; the Stats card has the rest.
function GapLine({ S, onOpen }) {
  if (!S.workouts?.length) return null
  const below = muscleGap(S.workouts, Date.now(), { target: S.hypTarget ?? 10, unit: S.unit, bodyweightKg: profileBodyweightKg(S) }).filter(r => r.deficit > 0).slice(0, 3)
  return <div className="muted small" style={{ marginBottom: 14, cursor: 'pointer' }} {...tappable(onOpen)}>
    {below.length
      ? t('Below the weekly target: {0}', below.map(r => `${t(MUSCLE_NAME[r.muscle])} ${fmtNum(Math.round(r.setsPerWeek * 10) / 10)}/${fmtNum(r.target)}`).join(' · '))
      : t('Every muscle is at the weekly target.')}
  </div>
}

// The box's image, picked from the device and read into a program on the intake screen, for
// `date()`, asked when the image is picked: the list reads for tomorrow, a new program for its own day. `ask(go)` may hold the
// read back (the editor asks before dropping unsaved changes); the picked image waits for it.
function UploadImage({ date, ask = go => go(), replace = false }) {
  const nav = useNavigate()
  const file = useRef(null)
  const upload = async e => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    let image = null
    try { image = await downscale(f) } catch { /* below */ }
    if (!image) { toast(t('This image could not be opened.')); return }
    ask(() => { setIntakeImage(image, date()); nav(INTAKE_ROUTE, { replace }) })
  }
  return <>
    <input ref={file} type="file" accept="image/*" hidden onChange={upload} />
    <Button icon="camera" onClick={() => file.current?.click()}>{t('Upload image')}</Button>
  </>
}

/* ============================ the editor ============================ */

// A brand-new hand-entered program starts with the main track, ready for its first block.
const emptyProgram = () => ({ title: '', tracks: [{ id: 'full', label: 'Full Equipment', kind: 'main', blocks: [] }] })

// #/crossfit/new?shared=1 is the image being read; everything else is the editor. Two components,
// so going from one to the other mounts the editor fresh with what the intake handed it.
export function CrossFitEdit() {
  const loc = useLocation()
  return new URLSearchParams(loc.search).get('shared') ? <Intake /> : <Editor />
}

/* ============================ reading an image ============================ */

// A taken run's program into the review screen, and the server's slot cleared.
const openRead = (nav, r, opts) => {
  nav('/crossfit/new', { ...opts, state: { draft: r.result.program, date: r.date, image: r.image.url } })
  ackParsed(r.result.jobId).catch(() => {})
}

// What the person reads for a failure or a refusal (lib/wod-intake.js readProgram).
const intakeErrorText = cls => cls === 'empty' ? t('No routine found in this image.')
  : cls === 'network' ? t('The server cannot be reached')
    : JOB_ERRORS[cls] || JOB_ERRORS.internal

function Intake() {
  const nav = useNavigate()
  const run = useSyncExternalStore(subscribeIntake, currentIntake)
  const ready = useStore(s => s.ready)

  // Typed by hand from here on, with the image beside it and the reason it was not read.
  const manual = (r, reason) => nav('/crossfit/new', { replace: true, state: { image: r.image.url, date: r.date, reason } })

  useEffect(() => {
    // A reload: the image was only ever in memory.
    if (!run) { nav('/crossfit', { replace: true }); return }
    if (run.phase === 'pending' && ready) {
      // Without a Coach on a server there is nobody to ask, and a guest never calls the server.
      const st = useStore.getState()
      if (DEMO || !st.user || !st.config?.coach?.enabled) { if (takeIntake()) manual(run, 'off'); return }
      beginIntake({ parse: parseWod, status: parseStatus })
      return
    }
    const r = run.phase === 'done' && !failureOf(run) && takeIntake()
    if (!r) return
    if (r.result.program) openRead(nav, r, { replace: true })
    else if (r.result.manual) manual(r, r.result.manual)
  }, [run, ready])

  if (!run) return null
  const failed = failureOf(run)
  return <div className="narrow">
    <div className="hdr">
      <button className="iconbtn" onClick={() => goBack(nav)} aria-label={t('Back')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginInlineStart: 12, minWidth: 0 }}>
        <h1>{t('New program')}</h1>
        <div className="sub">{fmtDate(run.date, true)}</div>
      </div>
    </div>
    <div className="card">
      <div className="row" style={{ gap: 10 }}>
        <Icon name={failed ? 'warning' : 'hourglass'} style={{ color: failed ? 'var(--orange)' : 'var(--label-3)' }} />
        <div className="grow" role="status">{failed ? intakeErrorText(failed)
          : run.phase === 'waiting' ? t('The Coach is busy. Reading the image as soon as it is done…')
            : t('Reading the image…')}</div>
      </div>
      {failed && <><div style={{ height: 12 }} />
        <Button variant="primary" icon="repeat" onClick={() => setIntakeImage(run.image, run.date)}>{t('Try again')}</Button></>}
      <div style={{ height: 8 }} />
      <Button icon="pencil" onClick={() => { if (takeIntake()) manual(run, failed || null) }}>{t('Enter manually')}</Button>
    </div>
    <img src={run.image.url} alt={t('Posted image')} style={{ width: '100%', borderRadius: 10 }} />
  </div>
}

/* ============================ the editor ============================ */

function Editor() {
  const nav = useNavigate()
  const loc = useLocation()
  const { date: editDate } = useParams()
  const S = useStore(s => s.S)
  const store = useStore.getState
  const handed = loc.state?.draft || null
  const [date, setDate] = useState(() => editDate || loc.state?.date || new URLSearchParams(loc.search).get('date') || tomorrowISO())
  const [draft, setDraft] = useState(() => prepareDraft(editDate ? wodOf(S, editDate) : (handed || emptyProgram()), S.exAliases))
  const [tab, setTab] = useState(0)
  const [dirty, setDirty] = useState(!!handed)
  // Edited beyond the date: what an upload would throw away (the date goes along with it).
  const [edited, setEdited] = useState(false)
  if (editDate && !wodOf(S, editDate) && !dirty) return <Navigate to="/crossfit" replace />

  // Every change goes through here: a copy, changed, so the sheets' callbacks never hold a stale one.
  const edit = fn => { setDirty(true); setEdited(true); setDraft(d => { const n = structuredClone(d); fn(n); return n }) }
  const ti = Math.min(tab, Math.max(0, draft.tracks.length - 1))
  const track = draft.tracks[ti]

  const discardFirst = go => (dirty
    ? confirmSheet({ title: t('Discard changes?'), message: t('This program has changes you have not saved.'), confirmText: t('Discard'), danger: true, onConfirm: go })
    : go())
  const leave = () => discardFirst(() => goBack(nav))
  const save = () => {
    if (!ISO.test(date)) { toast(t('Pick a date')); return }
    if (!draft.tracks.length) { toast(t('Add a track first')); return }
    const write = () => {
      store().setWod(date, { ...draft, title: draft.title.trim() })
      if (editDate && editDate !== date) store().clearWod(editDate)
      toast(t('Program saved'))
      goBack(nav)
    }
    if (date !== editDate && wodOf(store().S, date)) confirmSheet({
      title: t('Replace the program?'), message: t('{0} already has a program. Saving replaces it.', fmtDate(date, true)),
      confirmText: t('Replace'), danger: true, onConfirm: write,
    })
    else write()
  }
  // The manual path's image, read again: after the go-ahead was given, or a failure that may not
  // repeat. A consent given a moment ago reaches the server first, or the read is refused again.
  const readAgain = () => {
    const go = async () => {
      setIntakeImage(fromDataUrl(loc.state.image), ISO.test(date) ? date : tomorrowISO())
      await store().pushState()
      nav(INTAKE_ROUTE, { replace: true })
    }
    discardFirst(go)
  }
  // A new, empty program can be read off the box's image instead, for the day it is for (T18).
  const canUpload = !editDate && !loc.state?.draft && !loc.state?.image && !draft.tracks.some(tr => tr.blocks.some(b => b.movements.length))
  const remove = () => confirmSheet({
    title: t('Delete this program?'), message: t('The program for {0} goes away on every device.', fmtDate(editDate, true)),
    confirmText: t('Delete'), danger: true,
    // away first: the cleared date would otherwise send this screen to the list on its own
    onConfirm: () => { goBack(nav); store().clearWod(editDate); toast(t('Program deleted')) },
  })

  // An exercise for one movement or alternative: picked, a guess confirmed or a suggestion taken.
  // It is remembered for the printed name and applied to every movement of that name in this
  // program; one with no name keeps it to itself.
  const choose = (where, item, exId) => {
    const key = norm(item.rawName)
    if (key) {
      store().setAlias(key, exId)
      setDirty(true)
      setDraft(d => applyPick(d, key, exId))
    } else edit(d => { const x = at(d, where); x.exId = exId; delete x.via; delete x.candidates })
  }
  const pickExercise = (where, item) => {
    const picker = exercisePicker(ex => { picker.close(); choose(where, item, ex.id) },
      { title: t('Pick exercise'), like: item.exId || undefined })
  }

  const addTrack = () => {
    edit(d => { d.tracks.push({ id: nextId(d.tracks, 't'), label: '', kind: d.tracks.some(x => x.kind === 'main') ? 'extra' : 'main', blocks: [] }) })
    setTab(draft.tracks.length)
  }
  const removeTrack = () => confirmSheet({
    title: t('Delete this track?'), message: t('Its blocks and movements go with it.'), confirmText: t('Delete'), danger: true,
    onConfirm: () => { edit(d => { d.tracks.splice(ti, 1) }); setTab(Math.max(0, ti - 1)) },
  })
  const addBlock = () => {
    const b = { id: nextId(track.blocks, 'b'), label: '', warmup: false, format: 'other', capMin: null, rounds: null, scheme: null, benchmark: null, movements: [] }
    blockSheet(b, saved => edit(d => { d.tracks[ti].blocks.push(saved) }))
  }

  return <div className="narrow">
    <div className="hdr">
      <button className="iconbtn" onClick={leave} aria-label={t('Back')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginInlineStart: 12, minWidth: 0 }}>
        <h1>{editDate ? t('Edit program') : t('New program')}</h1>
        <div className="sub">{ISO.test(date) ? fmtDate(date, true) : ''}</div>
      </div>
    </div>

    {canUpload && <div style={{ marginBottom: 14 }}>
      <UploadImage date={() => (ISO.test(date) ? date : todayISO())} ask={go => (edited ? discardFirst(go) : go())} replace /></div>}

    {loc.state?.reason && <div className="card">
      <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
        <Icon name="info" style={{ color: 'var(--label-3)', marginTop: 2 }} />
        <div className="grow small">{intakeErrorText(loc.state.reason)}</div>
      </div>
      {loc.state.reason === 'consent' && !hasConsent(S) && <><div style={{ height: 10 }} />
        <Button size="sm" onClick={() => nav('/coach/intake?consent=1')}>{t('Give the Coach the go-ahead')}</Button></>}
      {loc.state.reason !== 'off' && <><div style={{ height: 8 }} />
        <Button size="sm" variant="ghost" icon="repeat" onClick={readAgain}>{t('Read the image again')}</Button></>}
    </div>}

    {loc.state?.image && <details className="card" style={{ padding: 12 }} open={!loc.state.draft}>
      <summary className="small muted">{t('Posted image')}</summary>
      <img src={loc.state.image} alt={t('Posted image')} style={{ width: '100%', borderRadius: 10, marginTop: 8 }} />
    </details>}

    <div className="card">
      <div className="measure-form">
        <label className="measure-field"><span>{t('Date')}</span>
          <input className="field" type="date" value={date} onChange={e => { setDate(e.target.value); setDirty(true) }} style={{ background: 'var(--surface-2)' }} /></label>
        <label className="measure-field"><span>{t('Title')}</span>
          <TextField value={draft.title} maxLength={80} placeholder={t('Optional')} style={{ background: 'var(--surface-2)' }}
            onChange={e => { const v = e.target.value; edit(d => { d.title = v }) }} /></label>
      </div>
    </div>

    <div className="chips" style={{ margin: '0 0 10px' }}>
      {draft.tracks.map((tr, i) => <button key={tr.id} className={'chip nocap' + (i === ti ? ' on' : '')} onClick={() => setTab(i)}>{tr.label || t('Track {0}', i + 1)}</button>)}
      <button className="chip nocap" onClick={addTrack} aria-label={t('Add track')}><Icon name="plus" style={CHIP_ICON} />{t('Track')}</button>
    </div>

    {track && <>
      <div className="card">
        <div className="row" style={{ gap: 8 }}>
          <TextField value={track.label} maxLength={40} placeholder={t('Track name')} aria-label={t('Track name')} style={{ background: 'var(--surface-2)' }}
            onChange={e => { const v = e.target.value; edit(d => { d.tracks[ti].label = v }) }} />
          <button className="iconbtn" onClick={removeTrack} aria-label={t('Delete this track?')}><Icon name="trash" /></button>
        </div>
        <div style={{ height: 10 }} />
        <Segmented value={track.kind} onChange={v => edit(d => { d.tracks[ti].kind = v })}
          options={[{ value: 'main', label: t('Main workout') }, { value: 'extra', label: t('Extra') }]} />
      </div>

      {track.blocks.map((b, bi) => <BlockCard key={b.id} S={S} track={track} block={b}
        onEdit={() => blockSheet(b, saved => edit(d => { d.tracks[ti].blocks[bi] = saved }), () => edit(d => { d.tracks[ti].blocks.splice(bi, 1) }))}
        onInclude={v => edit(d => { d.tracks[ti].blocks[bi].include = v })}
        onMovement={mi => movementSheet(b.movements[mi], saved => edit(d => { d.tracks[ti].blocks[bi].movements[mi] = saved }), () => edit(d => { d.tracks[ti].blocks[bi].movements.splice(mi, 1) }))}
        onAddMovement={() => movementSheet(null, saved => edit(d => {
          const ms = d.tracks[ti].blocks[bi].movements
          ms.push({ ...saved, id: nextId(ms, 'm') })
        }))}
        onPick={(mi, ai, item) => pickExercise({ ti, bi, mi, ai }, item)}
        onChoose={(mi, ai, item, exId) => choose({ ti, bi, mi, ai }, item, exId)} />)}
      <Button icon="plus" onClick={addBlock}>{t('Add block')}</Button>
    </>}

    <div style={{ height: 18 }} />
    <Button variant="primary" onClick={save}>{t('Save program')}</Button>
    {editDate && <><div style={{ height: 8 }} /><Button variant="danger" icon="trash" onClick={remove}>{t('Delete program')}</Button></>}
    <div style={{ height: 24 }} />
  </div>
}

// The movement (or its alternative) a picker path points at, inside a draft copy.
const at = (d, { ti, bi, mi, ai }) => {
  const m = d.tracks[ti].blocks[bi].movements[mi]
  return ai == null ? m : m.alts[ai]
}

function BlockCard({ S, track, block, onEdit, onInclude, onMovement, onAddMovement, onPick, onChoose }) {
  const on = includeOf(track, block, S)
  const meta = [
    formatLabel(block.format),
    block.capMin ? t('{0} min', block.capMin) : null,
    block.rounds ? t('{0} rounds', block.rounds) : null,
    block.scheme || null,
    block.benchmark || null,
  ].filter(Boolean).join(' · ')
  return <div className="card" style={on ? undefined : { opacity: 0.62 }}>
    <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
      <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} {...tappable(onEdit)}>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <div style={{ fontWeight: 600, fontSize: 17 }}>{block.label || formatLabel(block.format)}</div>
          {block.warmup && <span className="tag" style={{ whiteSpace: 'nowrap' }}>{t('Warm-up')}</span>}
          <Icon name="pencil" className="dim" style={{ fontSize: 13 }} />
        </div>
        <div className="small muted">{meta}</div>
      </div>
      <label className="small muted" style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        {t('Include')}
        <Switch aria-label={t('Include')} checked={on} onChange={onInclude} />
      </label>
    </div>
    {block.movements.map((m, mi) => <MovementRow key={m.id} S={S} m={m} onEdit={() => onMovement(mi)}
      onPick={(ai, item) => onPick(mi, ai, item)} onChoose={(ai, item, exId) => onChoose(mi, ai, item, exId)} />)}
    <div style={{ marginTop: 6 }}>
      <Button size="sm" variant="ghost" icon="plus" onClick={onAddMovement}>{t('Add movement')}</Button>
    </div>
  </div>
}

// The exercise a movement resolved to, as a chip that opens the picker.
function ExChip({ item, onClick }) {
  // On a card a chip needs the next surface up to show at all.
  return <button className="chip nocap" onClick={onClick}
    style={item.exId ? { background: 'var(--surface-2)' } : { background: 'var(--surface-2)', color: 'var(--orange)', boxShadow: 'inset 0 0 0 1px var(--orange)' }}>
    <Icon name={item.exId ? 'swap' : 'magnifier'} style={CHIP_ICON} />
    {item.exId ? exerciseNameFor(exOr(item.exId)) : (item.rawName || t('Pick exercise'))}
  </button>
}

// A movement's exercise. Certain: the chip that opens the picker. A best guess: marked "Did you
// mean?" (a tap confirms it), the runners-up beside it and the picker's search after them. Nothing
// to go on: the ranked suggestions, then the picker's chip.
function ExChoice({ item, onPick, onChoose }) {
  const others = (item.candidates || []).filter(c => c.exId !== item.exId)
  const option = c => <button key={c.exId} className="chip nocap" style={{ background: 'var(--surface-2)' }}
    onClick={() => onChoose(c.exId)}>{exerciseNameFor(exOr(c.exId))}</button>
  if (item.exId && item.via === 'guess') return <>
    <span className="small" style={{ color: 'var(--orange)' }}>{t('Did you mean?')}</span>
    <button className="chip nocap" onClick={() => onChoose(item.exId)} aria-label={t('Confirm {0}', exerciseNameFor(exOr(item.exId)))}
      style={{ background: 'var(--surface-2)', boxShadow: 'inset 0 0 0 1px var(--orange)' }}>
      <Icon name="check" style={CHIP_ICON} />{exerciseNameFor(exOr(item.exId))}</button>
    {others.slice(0, 2).map(option)}
    <button className="chip nocap" onClick={onPick} aria-label={t('Pick exercise')} style={{ background: 'var(--surface-2)' }}>
      <Icon name="magnifier" style={{ ...CHIP_ICON, marginInlineEnd: 0 }} /></button>
  </>
  if (!item.exId && others.length) return <>
    <span className="small muted">{t('Suggestions')}</span>
    {others.map(option)}
    <ExChip item={item} onClick={onPick} />
  </>
  return <ExChip item={item} onClick={onPick} />
}

function MovementRow({ S, m, onEdit, onPick, onChoose }) {
  const rx = rxFor(m, S)
  const d = doseFor(m, S)
  const dose = fmtDose(d)
  const line = [dose + (dose && m.perSide ? ' ' + t('each side') : ''), d.restSec > 0 ? t('{0} rest', fmtRest(d.restSec)) : null,
    rx ? `${fmtNum(rx.w)} ${rx.unit}` : null].filter(Boolean).join(' · ')
  return <div style={{ borderTop: '0.5px solid var(--sep)', marginTop: 10, paddingTop: 10 }}>
    <div {...tappable(onEdit)} style={{ cursor: 'pointer' }}>
      <div className="row" style={{ gap: 6 }}>
        <div style={{ flex: 1, minWidth: 0 }}>{m.raw || m.rawName}</div>
        <Icon name="pencil" className="dim" style={{ fontSize: 13 }} />
      </div>
      {line && <div className="small muted" style={{ marginTop: 2 }}>{line}{rx && <span className="dim"> · Rx</span>}</div>}
    </div>
    <div className="chips" style={{ margin: '8px 0 0', flexWrap: 'wrap', overflow: 'visible', touchAction: 'auto', alignItems: 'center' }}>
      <ExChoice item={m} onPick={() => onPick(null, m)} onChoose={exId => onChoose(null, m, exId)} />
      {(m.alts || []).map((a, ai) => <span key={ai} className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <span className="small dim">{t('or')}</span>
        <ExChoice item={a} onPick={() => onPick(ai, a)} onChoose={exId => onChoose(ai, a, exId)} />
      </span>)}
    </div>
  </div>
}

/* ============================ sheets ============================ */

const numOrNull = v => (Number(v) > 0 ? Number(v) : null)

function BlockSheet({ block, onSave, onDelete, close }) {
  const [b, setB] = useState(() => ({ ...block }))
  const labelRef = useRef(null)
  const onLabelFocus = useSheetKeyboard(labelRef)
  const set = (k, v) => setB(x => ({ ...x, [k]: v }))
  const done = () => {
    onSave({ ...b, label: b.label.trim(), scheme: (b.scheme || '').trim() || null, benchmark: (b.benchmark || '').trim() || null,
      capMin: numOrNull(b.capMin), rounds: numOrNull(b.rounds) })
    close()
  }
  return <>
    <h3>{onDelete ? t('Edit block') : t('Add block')}</h3>
    <label className="measure-date"><span>{t('Label')}</span>
      <input ref={labelRef} className="field" value={b.label} maxLength={60} placeholder={t('e.g. WOD, EMOM 10, Warm up')} onFocus={onLabelFocus} onChange={e => set('label', e.target.value)} /></label>
    <div className="chips" style={{ margin: '0 0 14px' }}>
      {FORMATS.map(f => <button key={f} className={'chip nocap' + (b.format === f ? ' on' : '')} onClick={() => set('format', f)}>{formatLabel(f)}</button>)}
    </div>
    <div className="measure-form">
      <label className="measure-field"><span>{t('Time cap (min)')}</span>
        <span className="measure-input"><NumberField decimal={false} nullable value={b.capMin} onChange={v => set('capMin', v)} /></span></label>
      <label className="measure-field"><span>{t('Rounds')}</span>
        <span className="measure-input"><NumberField decimal={false} nullable value={b.rounds} onChange={v => set('rounds', v)} /></span></label>
      <label className="measure-field"><span>{t('Rep scheme')}</span>
        <input className="field" value={b.scheme || ''} placeholder="21-15-9" onChange={e => set('scheme', e.target.value)} /></label>
      <label className="measure-field"><span>{t('Benchmark')}</span>
        <input className="field" value={b.benchmark || ''} placeholder="Fran" onChange={e => set('benchmark', e.target.value)} /></label>
    </div>
    <div className="lrow" style={{ padding: '12px 0' }}>
      <span className="lrow-m"><span className="lrow-t">{t('Warm-up')}</span>
        <span className="lrow-s">{t('Left out of the log in a main track unless you include it.')}</span></span>
      <Switch aria-label={t('Warm-up')} checked={!!b.warmup} onChange={v => set('warmup', v)} />
    </div>
    <Button variant="primary" onClick={done}>{t('Done')}</Button>
    {onDelete && <><div style={{ height: 8 }} /><Button variant="danger" icon="trash" onClick={() => { close(); onDelete() }}>{t('Delete block')}</Button></>}
  </>
}
const blockSheet = (block, onSave, onDelete) => ui().openSheet(close => <BlockSheet block={block} onSave={onSave} onDelete={onDelete} close={close} />)

const kindOf = dose => DOSE_KINDS.find(k => Number(dose?.[k]) > 0) || 'reps'

// One movement: the printed line, its dose (and the women's, when the box prints a split), the
// Rx load per sex in the printed unit, per side, and the alternatives' names.
function MovementSheet({ movement, onSave, onDelete, close }) {
  const S = useStore(s => s.S)
  const m0 = movement || { raw: '', rawName: '', exId: null, dose: {}, perSide: false, rx: null, alts: [] }
  const [raw, setRaw] = useState(m0.raw || m0.rawName || '')
  const [kind, setKind] = useState(kindOf(m0.dose))
  const [dose, setDose] = useState(Number(m0.dose?.[kindOf(m0.dose)]) || null)
  const [doseMax, setDoseMax] = useState(Number(m0.dose?.repsMax) || null)
  const [doseF, setDoseF] = useState(Number(m0.doseFemale?.[kindOf(m0.dose)]) || null)
  const [sets, setSets] = useState(Number(m0.dose?.sets) || null)
  const [perSide, setPerSide] = useState(!!m0.perSide)
  const [rxM, setRxM] = useState(Number(m0.rx?.male?.w) || null)
  const [rxF, setRxF] = useState(Number(m0.rx?.female?.w) || null)
  const [rxUnit, setRxUnit] = useState(String(m0.rx?.male?.unit || m0.rx?.female?.unit || 'lb').toLowerCase() === 'kg' ? 'kg' : 'lb')
  const [alts, setAlts] = useState(() => (m0.alts || []).map(a => ({ ...a })))
  const [altText, setAltText] = useState('')
  const rawRef = useRef(null)
  const onRawFocus = useSheetKeyboard(rawRef)

  const done = () => {
    const text = raw.trim()
    if (!text) { toast(t('Type the movement')); return }
    const changed = text !== (m0.raw || m0.rawName || '')
    // A new line is a new name to resolve: the parser's English name no longer describes it.
    const base = !movement ? movementFromText(text, null, S.exAliases)
      : changed ? resolveInto({ ...m0, raw: text, rawName: rawNameOf(text), name: undefined }, S.exAliases)
      : m0
    // The rest printed on the line (`x 1 De pausa`) is shown, not edited here: it rides along.
    const d = { ...(dose ? { [kind]: dose, ...(kind === 'reps' && doseMax > dose ? { repsMax: doseMax } : {}) } : {}),
      ...(sets > 0 ? { sets: Math.min(50, Math.round(sets)) } : {}), ...(m0.dose?.restSec != null ? { restSec: m0.dose.restSec } : {}) }
    const out = { ...base, dose: d, perSide,
      rx: rxM || rxF ? { male: rxM ? { w: rxM, unit: rxUnit } : null, female: rxF ? { w: rxF, unit: rxUnit } : null } : null,
      alts }
    if (doseF && dose) out.doseFemale = { [kind]: doseF }; else delete out.doseFemale
    if (out.name === undefined) delete out.name
    onSave(out)
    close()
  }
  const addAlt = () => {
    const rawName = rawNameOf(altText.trim()) || altText.trim().toLowerCase()
    if (!rawName) return
    setAlts(a => [...a, { ...resolveInto({ rawName }, S.exAliases), dose: {} }])
    setAltText('')
  }
  const field = (label, value, onChange, unit, decimal = true) => <label className="measure-field"><span>{label}</span>
    <span className="measure-input"><NumberField decimal={decimal} nullable value={value} onChange={onChange} />{unit && <i>{unit}</i>}</span></label>

  return <>
    <h3>{movement ? t('Edit movement') : t('Add movement')}</h3>
    <label className="measure-date"><span>{t('As printed')}</span>
      <input ref={rawRef} className="field" value={raw} maxLength={120} placeholder={t('e.g. 5 Hang Cleans 185/135')} onFocus={onRawFocus} onChange={e => setRaw(e.target.value)} /></label>

    <div className="small muted" style={{ margin: '0 2px 6px' }}>{t('Dose')}</div>
    <div className="chips" style={{ margin: '0 0 10px' }}>
      {DOSE_KINDS.map(k => <button key={k} className={'chip nocap' + (kind === k ? ' on' : '')} onClick={() => setKind(k)}>{doseLabel(k)}</button>)}
    </div>
    <div className="measure-form">
      {field(doseLabel(kind), dose, setDose, null, kind === 'm')}
      {kind === 'reps' && field(t('Up to'), doseMax, setDoseMax, null, false)}
      {field(t('Women (if different)'), doseF, setDoseF, null, kind === 'm')}
      {field(t('Sets'), sets, setSets, null, false)}
    </div>
    <div className="lrow" style={{ padding: '12px 0' }}>
      <span className="lrow-m"><span className="lrow-t">{t('Each side')}</span></span>
      <Switch aria-label={t('Each side')} checked={perSide} onChange={setPerSide} />
    </div>

    <div className="row between" style={{ margin: '4px 2px 6px' }}>
      <span className="small muted">{t('Rx load')}</span>
      <Segmented value={rxUnit} onChange={setRxUnit} options={[{ value: 'lb', label: 'lb' }, { value: 'kg', label: 'kg' }]} />
    </div>
    <div className="measure-form">
      {field(t('Men'), rxM, setRxM, rxUnit)}
      {field(t('Women'), rxF, setRxF, rxUnit)}
    </div>

    <div className="small muted" style={{ margin: '16px 2px 6px' }}>{t('Alternatives')}</div>
    {alts.length > 0 && <div className="chips" style={{ flexWrap: 'wrap', overflow: 'visible', touchAction: 'auto', marginBottom: 10 }}>
      {alts.map((a, i) => <button key={i} className="chip nocap" aria-label={t('Remove {0}', a.rawName)}
        onClick={() => setAlts(x => x.filter((_, j) => j !== i))}>{a.rawName} <Icon name="xmark" style={CHIP_ICON} /></button>)}
    </div>}
    <div className="row" style={{ gap: 8, marginBottom: 16 }}>
      <TextField value={altText} maxLength={60} placeholder={t('e.g. Ski')} onChange={e => setAltText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addAlt() }} />
      <Button icon="plus" onClick={addAlt} disabled={!altText.trim()} style={{ flex: '0 0 auto', width: 'auto' }}>{t('Add')}</Button>
    </div>

    <Button variant="primary" onClick={done}>{t('Done')}</Button>
    {onDelete && <><div style={{ height: 8 }} /><Button variant="danger" icon="trash" onClick={() => { close(); onDelete() }}>{t('Delete movement')}</Button></>}
  </>
}
const movementSheet = (movement, onSave, onDelete) => ui().openSheet(close => <MovementSheet movement={movement} onSave={onSave} onDelete={onDelete} close={close} />)

/* ============================ Settings → CrossFit ============================ */

const HYP_TARGETS = [4, 6, 8, 10, 12, 14, 16, 18, 20, 24]

export function CrossFitSettings({ S, update }) {
  const picks = Object.entries(aliasesOf(S)).sort(([a], [b]) => a.localeCompare(b))
  return <>
    <Section title={t('Programs')}>
      <Row icon="flame" iconTint="var(--orange)" title={t('Count warm-ups')}
        subtitle={t('Warm-up blocks in a main track start included. Extra tracks always count theirs.')}>
        <Switch aria-label={t('Count warm-ups')} checked={!!S.wodWarmup} onChange={v => update(s => { s.wodWarmup = v })} />
      </Row>
      <SelectRow icon="target" iconTint="var(--green)" title={t('Hard sets per muscle per week')}
        value={HYP_TARGETS.includes(S.hypTarget) ? S.hypTarget : 10} onChange={v => update(s => { s.hypTarget = v })}
        options={HYP_TARGETS.map(n => ({ value: n, label: String(n) }))} />
    </Section>
    <Section title={t('Exercise picks')} footer={picks.length
      ? t('A movement printed under one of these names gets that exercise. Remove one to pick again next time.')
      : t('None yet. Picking an exercise for a movement in a program adds it here.')}>
      {picks.map(([key, exId]) => <Row key={key} title={key} subtitle={exerciseNameFor(exOr(exId))}>
        <button className="iconbtn" aria-label={t('Remove {0}', key)} onClick={() => useStore.getState().clearAlias(key)}><Icon name="xmark" /></button>
      </Row>)}
    </Section>
  </>
}
