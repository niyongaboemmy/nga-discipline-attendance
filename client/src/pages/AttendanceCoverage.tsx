import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiGet, ApiError } from '../api/client';
import { ErrorState } from '../components/common/ErrorState';
import {
  Check, X, Circle, Search, RotateCcw, ChevronRight, CalendarDays, Info, PenLine,
} from 'lucide-react';

interface ClassCoverage {
  classId: string;
  className: string;
  department: string;
  homeroomRecorded: boolean;
  homeroomStudents: number;
  subjectsRecorded: number;
  lastMarkedAt: string | null;
}
interface Overview {
  date: string;
  classes: ClassCoverage[];
  totals: { classes: number; homeroomTaken: number; classesWithAnySubject: number };
}
interface SubjectCoverage {
  id: number; name: string; code: string | null;
  recorded: boolean; students: number; lastMarkedAt: string | null;
}
interface Detail {
  date: string;
  classId: string;
  curriculumKnown: boolean;
  homeroom: { recorded: boolean; students: number; lastMarkedAt: string | null };
  subjects: SubjectCoverage[];
}

interface Props {
  /** Jump into the Record tab with this session pre-selected. */
  onTakeRegister: (opts: { classId: string; subjectId?: number }) => void;
}

const todayISO = () => new Date().toISOString().split('T')[0];
const fmtTime = (iso: string | null) =>
  iso ? new Date(iso.replace(' ', 'T')).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';

/**
 * Status glyphs carry the meaning; colour only reinforces it. A grid that
 * distinguishes taken from missing by red/green alone fails WCAG 1.4.1 and
 * is unreadable for the ~1 in 12 men with a colour vision deficiency.
 */
const StatusDot: React.FC<{ done: boolean; label: string }> = ({ done, label }) => (
  <span className={`cov-dot ${done ? 'is-done' : 'is-missing'}`} title={label} aria-label={label} role="img">
    {done ? <Check size={12} /> : <X size={12} />}
  </span>
);

export const AttendanceCoverage: React.FC<Props> = ({ onTakeRegister }) => {
  const [date, setDate] = useState(todayISO());
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [onlyMissing, setOnlyMissing] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await apiGet<Overview>(`/api/attendance/coverage?date=${date}`);
      setOverview(res.data ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the coverage report.');
    } finally { setLoading(false); }
  }, [date]);

  useEffect(() => { load(); }, [load]);

  // Detail is fetched only for the class you open — the curriculum lookup is
  // a live MIS call per class, so doing it for all of them up front would
  // make the dashboard pay 17 round trips to show one number.
  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    let cancelled = false;
    (async () => {
      setDetailLoading(true);
      try {
        const res = await apiGet<Detail>(`/api/attendance/coverage?date=${date}&classId=${encodeURIComponent(selected)}`);
        if (!cancelled) setDetail(res.data ?? null);
      } catch { if (!cancelled) setDetail(null); }
      finally { if (!cancelled) setDetailLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [selected, date]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (overview?.classes ?? [])
      .filter((c) => !onlyMissing || !c.homeroomRecorded)
      .filter((c) => !q || `${c.className} ${c.department}`.toLowerCase().includes(q))
      // Worst first: nothing recorded at all leads, then partially covered.
      .sort((a, b) => {
        const score = (c: ClassCoverage) => (c.homeroomRecorded ? 1 : 0) + (c.subjectsRecorded > 0 ? 1 : 0);
        return score(a) - score(b) || a.className.localeCompare(b.className);
      });
  }, [overview, search, onlyMissing]);

  const totals = overview?.totals;
  const missing = totals ? totals.classes - totals.homeroomTaken : 0;
  const isToday = date === todayISO();
  const filtering = !!search || onlyMissing;

  return (
    <>
      {/* ---- Controls ---- */}
      <div className="card card-body mb-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="cov-date">
            <CalendarDays className="field-icon" size={15} />
            <input
              className="input"
              type="date"
              value={date}
              max={todayISO()}
              aria-label="Coverage date"
              onChange={(e) => { setDate(e.target.value); setSelected(null); }}
            />
          </div>
          <div className="rp-search" style={{ flex: 1, minWidth: 180 }}>
            <Search className="field-icon" size={15} />
            <input
              className="input"
              placeholder="Find a class group…"
              value={search}
              aria-label="Find a class group"
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <button
            className={`rp-chip${onlyMissing ? ' is-on' : ''}`}
            onClick={() => setOnlyMissing((v) => !v)}
            aria-pressed={onlyMissing}
          >
            Only missing <span className="rp-chip-num">{missing}</span>
          </button>
          <button className="btn btn-outline btn-sm" onClick={load} disabled={loading}>
            <RotateCcw size={14} /> Refresh
          </button>
        </div>
      </div>

      {/* ---- Summary ---- */}
      {totals && (
        <div className="cov-kpis mb-4">
          <div className="cov-kpi">
            <span className="cov-kpi-value">{totals.homeroomTaken}<span className="cov-kpi-of"> / {totals.classes}</span></span>
            <span className="cov-kpi-label">Homeroom registers taken</span>
            <div className="cov-bar" role="img" aria-label={`${totals.homeroomTaken} of ${totals.classes} taken`}>
              <span style={{ width: `${totals.classes ? (totals.homeroomTaken / totals.classes) * 100 : 0}%` }} />
            </div>
          </div>
          <div className={`cov-kpi${missing > 0 ? ' is-alert' : ''}`}>
            <span className="cov-kpi-value">{missing}</span>
            <span className="cov-kpi-label">Class groups with no register</span>
          </div>
          <div className="cov-kpi">
            <span className="cov-kpi-value">{totals.classesWithAnySubject}</span>
            <span className="cov-kpi-label">Have subject attendance</span>
          </div>
        </div>
      )}

      {/* Honest about what this can and can't know. */}
      <p className="cov-note mb-3">
        <Info size={13} />
        <span>
          Measured against each class group’s grade curriculum
          {isToday ? ', for today' : `, for ${date}`}. The synced timetable doesn’t say which
          subjects were scheduled on a given day, so a missing subject means “not recorded”, not
          necessarily “lesson missed”.
        </span>
      </p>

      {loading ? (
        <div className="card card-body flex flex-col gap-2">
          {[0, 1, 2, 3, 4].map((i) => <div key={i} className="rp-skeleton" />)}
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : rows.length === 0 ? (
        <div className="card">
          <div className="empty-state" style={{ padding: '56px 0' }}>
            <Check size={30} className="text-success" />
            <span className="text-sm">
              {onlyMissing && (overview?.classes.length ?? 0) > 0
                ? 'Every class group has a homeroom register for this day.'
                : 'No class groups match these filters.'}
            </span>
            {filtering && (
              <button className="btn btn-outline btn-sm mt-3" onClick={() => { setOnlyMissing(false); setSearch(''); }}>
                <RotateCcw size={14} /> Show all class groups
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="card">
          <ul className="cov-list">
            {rows.map((c) => {
              const open = selected === c.classId;
              return (
                <li key={c.classId} className={`cov-row${open ? ' is-open' : ''}`}>
                  <button
                    className="cov-main"
                    aria-expanded={open}
                    onClick={() => setSelected(open ? null : c.classId)}
                  >
                    <StatusDot
                      done={c.homeroomRecorded}
                      label={c.homeroomRecorded ? 'Homeroom register taken' : 'Homeroom register missing'}
                    />
                    <span className="cov-body">
                      <span className="cov-name">{c.className}</span>
                      <span className="cov-meta">
                        {c.department && <>{c.department} · </>}
                        {c.homeroomRecorded
                          ? `Homeroom taken${c.lastMarkedAt ? ` at ${fmtTime(c.lastMarkedAt)}` : ''} · ${c.homeroomStudents} students`
                          : 'Homeroom not recorded'}
                        {c.subjectsRecorded > 0 && ` · ${c.subjectsRecorded} subject${c.subjectsRecorded === 1 ? '' : 's'} recorded`}
                      </span>
                    </span>
                    <span
                      className={`btn btn-sm cov-take ${c.homeroomRecorded ? 'btn-outline' : 'btn-primary'}`}
                      role="button"
                      tabIndex={0}
                      onClick={(e) => { e.stopPropagation(); onTakeRegister({ classId: c.classId }); }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onTakeRegister({ classId: c.classId }); }
                      }}
                    >
                      <PenLine size={13} /> {c.homeroomRecorded ? 'Edit register' : 'Take register'}
                    </span>
                    <ChevronRight size={15} className={`audit-caret${open ? ' is-open' : ''}`} />
                  </button>

                  {open && (
                    <div className="cov-detail">
                      {detailLoading ? (
                        <div className="flex flex-col gap-2">
                          {[0, 1, 2].map((i) => <div key={i} className="rp-skeleton" style={{ height: 34 }} />)}
                        </div>
                      ) : !detail ? (
                        <p className="text-xs text-secondary">Could not load this class group’s curriculum.</p>
                      ) : !detail.curriculumKnown && detail.subjects.length === 0 ? (
                        <p className="text-xs text-secondary">
                          No subjects are on this class group’s grade curriculum yet — assign some in the MIS
                          and they’ll be tracked here.
                        </p>
                      ) : (
                        <>
                          <div className="cov-progress">
                            <span className="text-xs text-secondary">
                              {detail.subjects.filter((s) => s.recorded).length} of {detail.subjects.length} curriculum
                              subject{detail.subjects.length === 1 ? '' : 's'} recorded
                            </span>
                            <div className="cov-bar">
                              <span style={{
                                width: `${detail.subjects.length
                                  ? (detail.subjects.filter((s) => s.recorded).length / detail.subjects.length) * 100
                                  : 0}%`,
                              }} />
                            </div>
                          </div>
                          <ul className="cov-subjects">
                            {detail.subjects.map((s) => (
                              <li key={s.id} className={`cov-subject${s.recorded ? ' is-done' : ''}`}>
                                <StatusDot done={s.recorded} label={s.recorded ? 'Recorded' : 'Not recorded'} />
                                <span className="cov-subject-name">
                                  {s.name}
                                  {s.code && <span className="cov-subject-code">{s.code}</span>}
                                </span>
                                {s.recorded ? (
                                  <span className="flex items-center gap-2">
                                    <span className="text-xs text-secondary">
                                      {s.students} student{s.students === 1 ? '' : 's'}
                                      {s.lastMarkedAt ? ` · ${fmtTime(s.lastMarkedAt)}` : ''}
                                    </span>
                                    <button
                                      className="btn btn-outline btn-sm"
                                      onClick={() => onTakeRegister({ classId: c.classId, subjectId: s.id })}
                                    >
                                      <PenLine size={12} /> Edit
                                    </button>
                                  </span>
                                ) : (
                                  <button
                                    className="btn btn-outline btn-sm"
                                    onClick={() => onTakeRegister({ classId: c.classId, subjectId: s.id })}
                                  >
                                    <PenLine size={12} /> Record
                                  </button>
                                )}
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </>
  );
};

export const CoverageLegend: React.FC = () => (
  <div className="cov-legend">
    <span><span className="cov-dot is-done"><Check size={11} /></span> Recorded</span>
    <span><span className="cov-dot is-missing"><X size={11} /></span> Not recorded</span>
    <span><Circle size={11} className="text-tertiary" /> Curriculum subject</span>
  </div>
);
