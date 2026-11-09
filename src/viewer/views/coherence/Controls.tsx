// Coherence view: the toolbar. A switch between the city and the clouds, and
// the report: a button names the job shown (or all of them) and how many jobs
// are mixed; it opens what a job and a way are, then the jobs ranked, least
// coherent within folders (or groups) first, each a bar of its ways. A row
// shows that job and opens its details: its ways, a migration's progress,
// what recent work did, the folders mixing it and the files that differ from
// their folder (a click selects one).
import { useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { actions, store } from '../../store.ts'
import { choice, LISTED, pickConcern, setMode, setPaint } from './choice.ts'
import type { ConcernRow, Report } from './choice.ts'
import { pct } from './model.ts'

/** What an older graph says instead of its jobs. */
export const STALE = 'This graph was analyzed before archrift measured coherence: restart archrift serve (or, on the timeline, take the snapshots again) to measure it.'

const TREND = { converging: '↘ converging', spreading: '↗ spreading', quiet: '· quiet', none: '' }

/** Folder or group, as the report's blocks are. */
const wordsFor = (report: Report) => (report.blockKind === 'group' ? { one: 'group', many: 'groups', Many: 'Groups' } : { one: 'folder', many: 'folders', Many: 'Folders' })

export function Controls() {
  const { picked, mode, paint, report } = useStore(choice)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation() // the Escape closes this, and doesn't also clear the selection
      setOpen(false)
    }
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])
  const shown = report?.concerns.find(c => c.id === picked)
  const mixed = report?.totals.decoherent ?? 0
  return (
    <>
      <div className="coh-modes" role="group" aria-label="Coherence as">
        <button aria-pressed={mode === 'city'} onClick={() => setMode('city')} title="The city, each building colored by the way it does the job">
          City
        </button>
        <button aria-pressed={mode === 'clouds'} onClick={() => setMode('clouds')} title="As in the essay: files as dots pulled together by their dependencies, one cloud per job">
          Clouds
        </button>
      </div>
      {mode === 'clouds' && (
        <div className="coh-modes" role="group" aria-label="Color the dots">
          <button aria-pressed={paint === 'ways'} onClick={() => setPaint('ways')} title="Each dot in the color of the way it does the job: the culprits stand out">
            by way
          </button>
          <button
            aria-pressed={paint === 'groups'}
            onClick={() => setPaint('groups')}
            title={`Each dot in the color of its ${report && wordsFor(report).one}, like the minimap: the lobes stand out, and the files that do the job differently from their ${report && wordsFor(report).one} are ringed`}
          >
            by {report ? wordsFor(report).one : 'group'}
          </button>
        </div>
      )}
      <div className="popover-anchor" ref={ref}>
        <button aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)} title="The jobs the code does, and in how many ways; pick one to color by its ways">
          {shown ? shown.title : 'All jobs'} <span className={`coh-count${mixed ? '' : ' none'}`}>{mixed} mixed</span> ▾
        </button>
        {open && report && <Panel report={report} picked={picked} />}
      </div>
      {shown && (
        <button className="coh-clear" onClick={() => pickConcern(null)} title="Back to all jobs" aria-label="Back to all jobs">
          ×
        </button>
      )}
    </>
  )
}

function Panel({ report, picked }: { report: Report; picked: string | null }) {
  const t = report.totals
  const w = wordsFor(report)
  return (
    <div className="panel popover coh-report" role="dialog" aria-label="Coherence report">
      <div className="coh-head">
        <b>How many ways each job is done</b>
        <p className="coh-intro">
          A <b>job</b> is something code does that has several common solutions: dates, HTTP calls, shared state, test doubles … A <b>way</b> is one of them: a library or a
          pattern. One way per job is coherent; each extra way is one more model to keep in mind, and the code between two ways translates (after the essay{' '}
          <a href="https://maevyn.codes/decoherence" target="_blank" rel="noreferrer">
            Decoherence
          </a>
          ).
        </p>
        <span className="dim">
          <span title={`Some ${w.one} does the job more than one way: the costly kind`}>{t.decoherent} mixed</span> ·{' '}
          <span title={`Several ways, but each ${w.one} keeps to one (a choice per service)`}>
            {t.perBlock} one way per {w.one}
          </span>{' '}
          · <span title="A single way everywhere">{t.coherent} one way</span>
          {t.accepted ? <span title="Several ways on purpose, says the config"> · {t.accepted} accepted</span> : ''}
        </span>
      </div>
      <button className={`coh-row coh-all${picked === null ? ' on' : ''}`} onClick={() => pickConcern(null)}>
        <span className="coh-title">All jobs</span>
        <span className="dim">
          files that do some job differently from their {w.one}: {t.strays.toLocaleString('en-US')} of {t.users.toLocaleString('en-US')}
        </span>
      </button>
      {!report.measured && <p className="coh-stale">{STALE}</p>}
      {report.measured && !report.concerns.length && <p className="dim">No file does a job of the catalog (docs/COHERENCE.md lists them; a config adds its own).</p>}
      {report.concerns.length > 0 && (
        <div className="coh-row coh-columns" aria-hidden>
          <span>job</span>
          <span title="One color per way, as wide as its share of the files; the most common way is blue">ways, by share of files</span>
          <span title={`Share of the job's files that do it the same way as most of their ${w.one}`}>same as {w.one}</span>
          <span title="What the newest fifth of the files did: converging (all kept to their folder's way), spreading (some didn't), quiet (none does the job)">recent files</span>
        </div>
      )}
      <ol className="coh-list">
        {report.concerns.map(c => (
          <li key={c.id}>
            <button className={`coh-row${c.id === picked ? ' on' : ''}${c.kind === 'one' ? ' calm' : ''}`} onClick={() => pickConcern(c.id === picked ? null : c.id)} aria-pressed={c.id === picked}>
              <span className="coh-title">
                {c.title}
                {c.tests && <span className="coh-tag">tests</span>}
                {c.accepted && <span className="coh-tag">accepted</span>}
              </span>
              <Bar row={c} />
              <span className="coh-num" title={`${pct(c.local)} of its files do it the same way as most of their ${w.one} (${pct(c.coherence)} use the most common way overall)`}>
                {c.kind === 'one' ? 'one way' : pct(c.local)}
              </span>
              <span className={`coh-trend ${c.trend}`}>{TREND[c.trend]}</span>
            </button>
            {c.id === picked && <Details row={c} report={report} />}
          </li>
        ))}
      </ol>
      {report.loads.length > 0 && (
        <div className="coh-loads">
          <b>{w.Many} by extra ways to learn</b>
          <span className="dim"> (for each job they mix: its ways beyond the first)</span>
          <div>
            {report.loads.slice(0, 12).map(l => (
              <span key={l.block} className="coh-load">
                {l.block} <b>+{l.load}</b>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** A job's ways as one bar, each as wide as its share of the files. */
function Bar({ row }: { row: ConcernRow }) {
  const total = row.ways.reduce((s, w) => s + w.files, 0)
  return (
    <span className="coh-bar" aria-hidden>
      {row.ways.map(w => (
        <i key={w.id} className={w.legacy ? 'legacy' : undefined} style={{ width: `${(w.files / total) * 100}%`, background: w.color }} title={`${w.label}${w.legacy ? ' (legacy)' : ''}: ${w.files} files`} />
      ))}
    </span>
  )
}

function Details({ row, report }: { row: ConcernRow; report: Report }) {
  const selected = useStore(store, s => s.selected)
  const w = wordsFor(report)
  const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10)
  const kind = { mixed: `mixed inside a ${w.one}`, 'per-block': `one way per ${w.one}`, one: 'one way' }[row.kind]
  return (
    <div className="coh-details">
      <p className="dim">
        {row.about} · {kind}
        {row.kind !== 'one' && ` · ${pct(row.local)} the same way as their ${w.one}, ${pct(row.coherence)} the most common way`}
      </p>
      {row.accepted && <p className="coh-accepted">Accepted: {row.accepted}</p>}
      <ul className="coh-ways">
        {row.ways.map(x => (
          <li key={x.id}>
            <i style={{ background: x.color }} />
            {x.label}
            {x.legacy && <span className="coh-tag">legacy</span>} <span className="dim">{x.files.toLocaleString('en-US')} files{report.since !== undefined && x.recent ? `, ${x.recent} recent` : ''}</span>
          </li>
        ))}
      </ul>
      {row.migration && (
        <p>
          Migration {row.migration.from} → {row.migration.to}: <b>{pct(row.migration.done)}</b> done, {row.migration.left} file{row.migration.left === 1 ? '' : 's'} left
        </p>
      )}
      {row.newest && <p className="dim">Newest way (youngest files): {row.newest}</p>}
      {report.since !== undefined && row.kind !== 'one' && (
        <p className="dim">
          Recent files (first committed after {day(report.since)}): {row.recent ? `${row.recent}, ${row.recentStrays ? `${row.recentStrays} of them differ from their ${w.one}` : `all the same way as their ${w.one}`}` : 'none'}
        </p>
      )}
      {row.links > 0 && row.kind !== 'one' && (
        <p className="dim">
          Transitions: {row.transitions} of {row.links} dependencies between its files join two different ways (drawn as colored arcs or lines)
        </p>
      )}
      {row.mixing.length > 0 && (
        <p>
          Mixed in {row.mixing.length} of {row.blocks} {w.many}: {row.mixing.slice(0, 8).map(b => `${b.block} (${b.ways.join(', ')})`).join('; ')}
          {row.mixing.length > 8 ? ' …' : ''}
        </p>
      )}
      {row.strayFiles.length > 0 && (
        <>
          <p className="dim">
            Doing it differently from their {w.one}: {row.strays.toLocaleString('en-US')} file{row.strays === 1 ? '' : 's'}
            {row.strays > LISTED ? `, the first ${LISTED}` : ''}. In a small {w.one} the majority wins, so a file listed here isn’t necessarily the wrong one.
          </p>
          <ul className="coh-files">
            {row.strayFiles.map(f => (
              <li key={f.id}>
                <button className={f.id === selected ? 'on' : undefined} onClick={() => void actions.select(f.id)} title={f.path}>
                  {f.path.split('/').pop()}
                </button>
                <span className="dim"> {f.ways.join(', ')}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
