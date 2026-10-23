// #/crossfit/log/<date>: what was done in class, logged against the program posted for that day
// (store logWod, lib/wod-log.js). Pick the tracks and blocks done, a weight or reps per movement,
// a substitute where one was swapped in, and each block's score with its Rx flag. Logging the day
// again opens on what was logged and edits it. A session in progress is never touched.
import { useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { exOr } from '../lib/exercises.js'
import { bestWeightForEntry } from '../lib/history.js'
import { t, exerciseNameFor } from '../lib/i18n.js'
import { fmtDate, fmtNum } from '../lib/format.js'
import { wodOf } from '../lib/wods.js'
import { rxFor, doseFor, fmtDose } from '../lib/rx.js'
import { includeOf } from '../lib/wod-draft.js'
import { isCardioRow, isMetcon, ladderOf, relogState, wodStart } from '../lib/wod-log.js'
import { exercisePicker, FinishSummary } from '../sheets.jsx'
import Icon from '../components/Icon.jsx'
import { Button, NumberField, Segmented, Switch } from '../components/ui.jsx'

const ui = () => useUI.getState()
const list = v => (Array.isArray(v) ? v : [])
const CHIP_ICON = { fontSize: 12, display: 'inline-block', marginInlineEnd: 4, verticalAlign: '-1px' }
const pad = n => String(n).padStart(2, '0')
const hhmm = ms => { const d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()) }
const atTime = (date, time) => { const [h, m] = time.split(':').map(Number); const d = new Date(date + 'T12:00:00'); d.setHours(h || 0, m || 0, 0, 0); return d.getTime() }

// The score a block asks for by default: rounds+reps for an AMRAP, a time for a For time, a load
// for a strength block, nothing for the rest.
const SCORE_OF = { amrap: 'rounds', fortime: 'time', strength: 'load' }

export default function CrossFitLog() {
  const nav = useNavigate()
  const { date } = useParams()
  const S = useStore(s => s.S)
  const program = wodOf(S, date)
  const before = list(S.workouts).find(w => w.id === 'wod-' + date && w.wod)
  const [state, setState] = useState(() => {
    if (program && before) return { ...relogState(program, before), time: hhmm(before.start) }
    const main = list(program?.tracks).find(tr => tr.kind !== 'extra') || list(program?.tracks)[0]
    return { tracks: main ? [main.id] : [], include: {}, logged: { moves: {}, blocks: {} }, time: hhmm(wodStart(date)) }
  })
  if (!program) return <Navigate to="/crossfit" replace />

  const edit = fn => setState(st => { const n = structuredClone(st); fn(n); return n })
  const move = (n, key) => (n.logged.moves[key] ||= {})
  const toggleTrack = id => edit(n => { n.tracks = n.tracks.includes(id) ? n.tracks.filter(x => x !== id) : [...n.tracks, id] })

  const save = () => {
    // A weight left as shown (the Rx, or the last one used) is logged as shown.
    const moves = structuredClone(state.logged.moves)
    for (const tr of program.tracks) for (const b of list(tr.blocks)) for (const m of list(b.movements)) {
      const key = `${tr.id}/${b.id}/${m.id}`
      const lm = moves[key] ||= {}
      if (lm.w == null) { const w = defaultW(S, m, lm.exId || m.exId); if (w != null) lm.w = w }
    }
    const choice = { tracks: state.tracks, include: state.include }
    const out = useStore.getState().logWod(date, choice, { ...state.logged, moves, start: atTime(date, state.time) })
    if (!out) { ui().toast(t('Nothing to log: pick a track and an exercise for each movement')); return }
    nav('/home', { replace: true })
    ui().openSheet(close => <FinishSummary w={out.w} prs={out.prs} close={close} />, { kind: 'center', locked: true })
  }

  return <div className="narrow">
    <div className="hdr">
      <button className="iconbtn" onClick={() => ((window.history.state?.idx || 0) > 0 ? nav(-1) : nav('/crossfit', { replace: true }))} aria-label={t('Back')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginInlineStart: 12, minWidth: 0 }}>
        <h1>{t('Log WOD')}</h1>
        <div className="sub">{[fmtDate(date, true), program.title].filter(Boolean).join(' · ')}</div>
      </div>
    </div>
    {before && <div className="small muted" style={{ margin: '0 2px 10px' }}>{t('Already logged. Saving replaces it.')}</div>}

    <div className="card">
      <div className="measure-form">
        <label className="measure-field"><span>{t('Start time')}</span>
          <input className="field" type="time" value={state.time} onChange={e => { const v = e.target.value; edit(n => { n.time = v || '18:00' }) }} style={{ background: 'var(--surface-2)' }} /></label>
      </div>
    </div>

    <div className="chips" style={{ margin: '0 0 10px', flexWrap: 'wrap', overflow: 'visible', touchAction: 'auto' }}>
      {program.tracks.map((tr, i) => <button key={tr.id} className={'chip nocap' + (state.tracks.includes(tr.id) ? ' on' : '')} onClick={() => toggleTrack(tr.id)}>
        {state.tracks.includes(tr.id) && <Icon name="check" style={CHIP_ICON} />}{tr.label || t('Track {0}', i + 1)}</button>)}
    </div>

    {program.tracks.filter(tr => state.tracks.includes(tr.id)).map(tr => list(tr.blocks).map(b => {
      const ref = `${tr.id}/${b.id}`
      const on = typeof state.include[ref] === 'boolean' ? state.include[ref] : includeOf(tr, b, S)
      return <LogBlock key={ref} S={S} track={tr} block={b} on={on} logged={state.logged}
        onInclude={v => edit(n => { n.include[ref] = v })}
        onBlock={fn => edit(n => { fn(n.logged.blocks[ref] ||= {}) })}
        onMove={(m, fn) => edit(n => { fn(move(n, `${ref}/${m.id}`)) })} />
    }))}

    <div style={{ height: 18 }} />
    <Button variant="primary" icon="check" onClick={save} disabled={!state.tracks.length}>{before ? t('Save log') : t('Log workout')}</Button>
    <div style={{ height: 24 }} />
  </div>
}

// The weight a movement starts at: its Rx when done as printed, else the top set of the last
// time it was logged (a WOD never moves exWeights, as no backfill does), else the kept one.
function defaultW(S, m, exId) {
  if (exId === m.exId) { const rx = rxFor(m, S); if (rx) return rx.w }
  for (let i = list(S.workouts).length - 1; i >= 0; i--) {
    const e = list(S.workouts[i].entries).find(x => x.id === exId)
    if (e) return bestWeightForEntry(e) || null
  }
  return S.exWeights?.[exId]?.w ?? null
}

function LogBlock({ S, track, block, on, logged, onInclude, onBlock, onMove }) {
  const ref = `${track.id}/${block.id}`
  const lb = logged.blocks[ref] || {}
  const score = lb.score || { type: SCORE_OF[block.format] || 'none' }
  const setScore = patch => onBlock(x => { x.score = { ...score, ...patch } })
  const meta = [block.capMin ? t('{0} min', block.capMin) : null, block.rounds ? t('{0} rounds', block.rounds) : null, block.scheme, block.benchmark].filter(Boolean).join(' · ')
  return <div className="card" style={on ? undefined : { opacity: 0.62 }}>
    <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 17 }}>{block.label || block.format}</div>
        {meta && <div className="small muted">{meta}</div>}
      </div>
      <label className="small muted" style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        {t('Include')}<Switch aria-label={t('Include')} checked={on} onChange={onInclude} />
      </label>
    </div>
    {on && <>
      {list(block.movements).map(m => <LogMovement key={m.id} S={S} block={block} m={m} lm={logged.moves[`${ref}/${m.id}`] || {}} onChange={fn => onMove(m, fn)} />)}
      <div style={{ borderTop: '0.5px solid var(--sep)', marginTop: 12, paddingTop: 12 }}>
        <div className="row between" style={{ marginBottom: 8, gap: 8 }}>
          <span className="small muted">{t('Score')}</span>
          <Segmented value={score.type} onChange={v => onBlock(x => { x.score = { type: v } })}
            options={[{ value: 'none', label: '–' }, { value: 'time', label: t('Time') }, { value: 'rounds', label: t('Rounds') }, { value: 'load', label: t('Load') }]} />
        </div>
        {score.type !== 'none' && <div className="measure-form" style={{ marginBottom: 10 }}>
          {score.type === 'time' && <>
            {num(t('Minutes'), score.sec != null ? Math.floor(score.sec / 60) : null, v => setScore({ sec: (v || 0) * 60 + ((score.sec || 0) % 60) }), null, false)}
            {num(t('Seconds'), score.sec != null ? score.sec % 60 : null, v => setScore({ sec: Math.floor((score.sec || 0) / 60) * 60 + Math.min(59, v || 0) }), null, false)}
          </>}
          {score.type === 'rounds' && <>
            {num(t('Rounds'), score.rounds ?? null, v => setScore({ rounds: v }), null, false)}
            {num(t('Extra reps'), score.reps ?? null, v => setScore({ reps: v }), null, false)}
          </>}
          {score.type === 'load' && num(t('Weight'), score.w ?? null, v => setScore({ w: v, unit: S.unit }), S.unit)}
        </div>}
        <div className="lrow" style={{ padding: '4px 0' }}>
          <span className="lrow-m"><span className="lrow-t">Rx</span><span className="lrow-s">{t('Done as prescribed, no scaling.')}</span></span>
          <Switch aria-label="Rx" checked={!!lb.rx} onChange={v => onBlock(x => { x.rx = v })} />
        </div>
      </div>
    </>}
  </div>
}

const num = (label, value, onChange, unit, decimal = true) => <label className="measure-field" key={label}><span>{label}</span>
  <span className="measure-input"><NumberField decimal={decimal} nullable value={value} onChange={onChange} />{unit && <i>{unit}</i>}</span></label>

function LogMovement({ S, block, m, lm, onChange }) {
  const exId = lm.exId || m.exId
  const dose = doseFor(m, S)
  const ladder = ladderOf(block.scheme)
  const printed = [m.exId, ...list(m.alts).map(a => a.exId)].filter(Boolean)
  const swapped = lm.exId && !printed.includes(lm.exId)
  const rx = exId === m.exId ? rxFor(m, S) : null
  const w = lm.w ?? defaultW(S, m, exId)
  const cardio = exId && isCardioRow(m, exId, dose, block)
  const strength = block.format === 'strength' && !isMetcon(block)
  const set = (k, v) => onChange(x => { if (v == null) delete x[k]; else x[k] = v })
  const pick = () => {
    const picker = exercisePicker(ex => { picker.close(); onChange(x => { x.exId = ex.id; delete x.w }) }, { title: t('Substitute'), like: exId || undefined })
  }
  const line = [fmtDose(dose) + (fmtDose(dose) && m.perSide ? ' ' + t('each side') : ''), rx ? `Rx ${fmtNum(rx.w)} ${rx.unit}` : null].filter(Boolean).join(' · ')
  const rows = list(lm.sets).length ? lm.sets : [{ w, r: dose.reps || null }]
  return <div style={{ borderTop: '0.5px solid var(--sep)', marginTop: 10, paddingTop: 10 }}>
    <div className="small" style={{ marginBottom: 6 }}>{m.raw || m.rawName}{line && <span className="muted"> · {line}</span>}</div>
    <div className="chips" style={{ margin: '0 0 8px', flexWrap: 'wrap', overflow: 'visible', touchAction: 'auto', alignItems: 'center' }}>
      {[m.exId, ...list(m.alts).map(a => a.exId)].filter(Boolean).filter((id, i, a) => a.indexOf(id) === i).map(id =>
        <button key={id} className={'chip nocap' + (id === exId ? ' on' : '')} onClick={() => onChange(x => { if (id === m.exId) delete x.exId; else x.exId = id; delete x.w })}>{exerciseNameFor(exOr(id))}</button>)}
      {swapped && <button className="chip nocap on" onClick={pick}>{exerciseNameFor(exOr(exId))}</button>}
      <button className="chip nocap" onClick={pick} style={!exId ? { color: 'var(--orange)', boxShadow: 'inset 0 0 0 1px var(--orange)' } : undefined}>
        <Icon name={exId ? 'swap' : 'magnifier'} style={CHIP_ICON} />{exId ? t('Substitute') : t('Pick exercise')}</button>
    </div>
    {exId && (strength ? <>
      {rows.map((r, i) => <div key={i} className="measure-form" style={{ marginBottom: 8 }}>
        {num(t('Weight'), r.w ?? null, v => onChange(x => { x.sets = rows.map((s, j) => (j === i ? { ...s, w: v } : s)) }), S.unit)}
        {num(t('Reps'), r.r ?? null, v => onChange(x => { x.sets = rows.map((s, j) => (j === i ? { ...s, r: v } : s)) }), null, false)}
      </div>)}
      <Button size="sm" variant="ghost" icon="plus" onClick={() => onChange(x => { x.sets = [...rows, { ...rows[rows.length - 1] }] })}>{t('Add set')}</Button>
    </> : <div className="measure-form">
      {cardio ? <>
        {pos(dose.cal) ? num(t('Calories'), lm.cal ?? dose.cal, v => set('cal', v), null, false)
          : pos(dose.m) ? num(t('Meters'), lm.m ?? dose.m, v => set('m', v), null) : null}
        {num(t('Minutes'), lm.min ?? null, v => set('min', v), null)}
      </> : <>
        {num(t('Weight'), w, v => set('w', v), S.unit)}
        {ladder && !pos(dose.reps) ? <div className="measure-field"><span>{t('Reps')}</span><div className="small muted" style={{ padding: '14px 2px' }}>{ladder.join('-')}</div></div>
          : pos(dose.sec) && !pos(dose.reps) ? num(t('Seconds'), lm.sec ?? dose.sec, v => set('sec', v), null, false)
            : num(m.perSide ? t('Reps each side') : t('Reps'), lm.r ?? (dose.reps || null), v => set('r', v), null, false)}
      </>}
    </div>)}
  </div>
}

const pos = v => (Number(v) > 0 ? Number(v) : 0)
