// CrossFit records on #/crossfit (crossfit-module-plan, training logic §6–8): three cards read off
// the logged WODs, recomputing nothing the app already keeps.
//
//   Benchmarks        best Rx and scaled score per named WOD (lib/crossfit-records.js), and the
//                     lift PRs WODs were filed with, each opening the exercise's own history.
//   Furthest from Rx  the movements done lightest against their Rx over 8 weeks
//                     (lib/rx-history.js); swaps counted apart.
//   Skills            the gymnastics skills (lib/skills.js).
import { useMemo } from 'react'
import { useUI } from '../store/useUI.js'
import { exOr } from '../lib/exercises.js'
import { t, tn, exerciseNameFor } from '../lib/i18n.js'
import { fmtDate, fmtNum } from '../lib/format.js'
import { fmtSec } from '../lib/history.js'
import { benchmarks, wodPrs } from '../lib/crossfit-records.js'
import { furthestFromRx } from '../lib/rx-history.js'
import { skillStats } from '../lib/skills.js'
import { tappable } from '../lib/use-sheet-keyboard.js'
import { exerciseHistorySheet } from '../sheets.jsx'
import Icon from '../components/Icon.jsx'

const SHOWN = 5
const NAME = { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const SUB = { display: 'block', fontWeight: 400 }
const exName = id => exerciseNameFor(exOr(id))

/** A score as the whiteboard writes it: "4:55", "15 + 29", "16 rounds", "100 kg". */
export function fmtScore(score, value, unit) {
  if (score?.type === 'time') return fmtSec(score.sec)
  if (score?.type === 'rounds') return Number(score.reps) > 0 ? `${score.rounds || 0} + ${score.reps}` : t('{0} rounds', score.rounds || 0)
  if (score?.type === 'load') return `${fmtNum(value)} ${unit}`
  return '–'
}

function Line({ name, sub, value, onClick }) {
  return <div className="mrow" style={{ minHeight: 48, alignItems: 'center', cursor: onClick ? 'pointer' : undefined }} {...(onClick ? tappable(onClick) : {})}>
    <span className="nm" style={{ whiteSpace: 'normal', lineHeight: 1.35 }}>
      <span style={NAME}>{name}</span>
      {sub && <span className="small dim" style={SUB}>{sub}</span>}
    </span>
    {value != null && <span className="v">{value}</span>}
  </div>
}

function BenchmarkSheet({ b, unit }) {
  return <>
    <h3 style={{ marginBottom: 2 }}>{b.name}</h3>
    <div className="muted small" style={{ marginBottom: 10 }}>{t('Benchmark')} · {tn('{0} attempt', '{0} attempts', b.history.length)}</div>
    <div className="list">
      {b.history.map(h => <div key={h.wid + h.d} className="item">
        <div className="grow"><div className="tt">{fmtDate(h.d, true)}</div><div className="ss">{h.rx ? 'Rx' : t('Scaled')}</div></div>
        <b className="accent nocap" style={{ whiteSpace: 'nowrap' }}>{fmtScore(h.score, h.value, unit)}</b>
      </div>)}
    </div>
  </>
}

export default function CrossFitRecords({ S }) {
  const unit = S.unit
  const has = useMemo(() => (S.workouts || []).some(w => w?.src === 'wod'), [S.workouts])
  const bench = useMemo(() => benchmarks(S.workouts, unit), [S.workouts, unit])
  const prs = useMemo(() => wodPrs(S.workouts), [S.workouts])
  const far = useMemo(() => furthestFromRx(S.workouts, 8, unit), [S.workouts, unit])
  const skills = useMemo(() => skillStats(S.workouts).filter(s => s.first), [S.workouts])
  if (!has) return null
  const best = (x, label) => x && `${label} ${fmtScore(x.score, x.value, unit)}`
  const open = b => useUI.getState().openSheet(() => <BenchmarkSheet b={b} unit={unit} />)
  return <div data-crossfit-records>
    <h4 className="sec">{t('Records')}</h4>

    <div className="card">
      <h2>{t('Benchmarks')}</h2>
      {bench.length ? bench.slice(0, SHOWN).map(b => <Line key={b.name} name={b.name}
        sub={[best(b.rx, 'Rx'), best(b.scaled, t('Scaled')), t('last') + ' ' + fmtDate(b.last)].filter(Boolean).join(' · ')}
        value={<Icon name="chevronRight" />} onClick={() => open(b)} />)
        : <div className="muted small">{t('No benchmark logged yet. Name one on a block of a program.')}</div>}
      {prs.length > 0 && <>
        <h4 className="sec" style={{ marginTop: 14 }}>{t('Lift PRs from WODs')}</h4>
        {prs.slice(0, SHOWN).map(p => <Line key={p.wid + p.exId} name={<><Icon name="trophy" style={{ fontSize: 13, color: 'var(--yellow)', marginInlineEnd: 4 }} />{exName(p.exId)}</>}
          sub={fmtDate(p.d, true)} value={<Icon name="chevronRight" />} onClick={() => exerciseHistorySheet(p.exId)} />)}
      </>}
    </div>

    <div className="card">
      <h2>{t('Furthest from Rx')} <span className="dim" style={{ textTransform: 'none', letterSpacing: 0 }}>· {t('last 8 weeks')}</span></h2>
      {far.length ? far.slice(0, SHOWN).map(x => <Line key={x.exId} name={exName(x.exId)}
        sub={[x.last && t('{0} of {1} {2}', fmtNum(x.last.used), fmtNum(x.last.rx), unit),
          x.swaps > 0 && t('swapped {0}×', x.swaps)].filter(Boolean).join(' · ')}
        value={x.ratio != null ? Math.round(x.ratio * 100) + '%' : t('Swapped')}
        onClick={() => exerciseHistorySheet(x.exId)} />)
        : <div className="muted small">{t('Everything with a printed load was done at Rx.')}</div>}
    </div>

    <div className="card">
      <h2>{t('Skills')}</h2>
      {skills.length ? skills.map(s => <Line key={s.key} name={t(s.name)}
        sub={[t('since {0}', fmtDate(s.first, true)), tn('{0} rep in 4 weeks', '{0} reps in 4 weeks', s.volume), s.rxDone > 0 && t('{0}× Rx', s.rxDone)].filter(Boolean).join(' · ')}
        value={s.perSide ? t('{0} each side', s.maxReps) : t('max {0}', s.maxReps)}
        onClick={() => exerciseHistorySheet(s.exId)} />)
        : <div className="muted small">{t('No skill movements logged yet: muscle-ups, toes-to-bar, handstand push-ups, double-unders, pull-ups.')}</div>}
    </div>
  </div>
}
