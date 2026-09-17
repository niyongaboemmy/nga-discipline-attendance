import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { ErrorState } from '../components/common/ErrorState';
import { SearchableSelect } from '../components/common/SearchableSelect';
import { useAuth } from '../context/AuthContext';
import { useAcademicPeriod } from '../context/AcademicPeriodContext';
import { ApiError } from '../api/client';
import {
  attendanceReportApi, type ReportableClass, type ClassSection, type ClassSectionReport,
  type SubjectOverview, type SubjectClassOverview,
} from '../api/attendanceReport';
import { isoDate } from '../utils/time';
import { COMMENT_META, COMMENT_FILL, COMMENT_BADGE, rateColor } from '../utils/attendanceComment';
import { ClassAnalytics } from '../components/charts/ClassAnalytics';
import {
  Printer, Download, Users, TrendingUp, AlertTriangle, Search, ArrowUpDown, CalendarDays, Inbox,
  Sun, BookOpen, LayoutGrid, ChevronRight, GraduationCap, ClipboardList, ChevronDown, ChevronUp, FileBarChart,
} from 'lucide-react';

const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00`); x.setDate(x.getDate() + n); return isoDate(x); };
const fmtDate = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const fmtDateLong = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

const DEFAULT_FROM = () => addDays(isoDate(), -13);
const ATTENTION_ROWS = 8;

/**
 * Per-student attendance rate, worst first. Defaults to the students who
 * need attention — the bottom of the class — rather than every row: with
 * 40 students the full list is a wall, and the register grid below already
 * has everyone. Coloured by comment tier with an icon legend, so colour is
 * never the only signal.
 */
const RateChart: React.FC<{ students: ClassSectionReport['students'] }> = ({ students }) => {
  const [showAll, setShowAll] = useState(false);
  const sorted = useMemo(() => [...students].sort((a, b) => a.rate - b.rate), [students]);
  if (sorted.length === 0) return null;
  const rows = showAll ? sorted : sorted.slice(0, ATTENTION_ROWS);
  const hidden = sorted.length - rows.length;
  return (
    <div className="ar-chart">
      <div className="ar-chart-head">
        <div>
          <div className="ch-title">{showAll ? 'All students, lowest rate first' : 'Students who need attention'}</div>
          <div className="text-xs text-secondary">{showAll ? `${sorted.length} students` : `The ${rows.length} lowest attendance rates in the class`}</div>
        </div>
        <div className="ar-chart-legend">
          {(Object.keys(COMMENT_META) as Array<keyof typeof COMMENT_META>).map((k) => (
            <span key={k} className="ar-chart-legend-item">
              <span className="ch-swatch" style={{ background: COMMENT_FILL[k] }} />{COMMENT_META[k].icon} {k}
            </span>
          ))}
        </div>
      </div>
      <div className="ar-chart-rows">
        {rows.map((s) => (
          <div className="ar-chart-row" key={s.studentId} title={`${s.studentName}: ${s.rate}% (${s.present} present, ${s.absent} absent, ${s.late} late, ${s.excused} excused)`}>
            <span className="ar-chart-name">{s.studentName}</span>
            <div className="ar-chart-track">
              <div className="ar-chart-fill" style={{ width: `${s.rate}%`, background: COMMENT_FILL[s.comment] }} />
            </div>
            <span className="ar-chart-value">{s.rate}%</span>
          </div>
        ))}
      </div>
      {(hidden > 0 || showAll) && (
        <button className="btn btn-ghost btn-sm mt-2 no-print" onClick={() => setShowAll((v) => !v)}>
          {showAll ? <><ChevronUp size={14} /> Show fewer</> : <><ChevronDown size={14} /> Show all {sorted.length} students</>}
        </button>
      )}
    </div>
  );
};

type SortKey = 'name' | 'rate';
type Mode = 'class' | 'subject';
type Preset = '2w' | '30d' | 'term' | 'custom';

export const AttendanceReport: React.FC = () => {
  const { user } = useAuth();
  const { selectedYearId, selectedTermId, termsByYear, years } = useAcademicPeriod();
  const yearName = years.find((y) => y.academic_year_id === selectedYearId)?.name;
  const term = selectedYearId != null ? termsByYear[selectedYearId]?.find((t) => t.academic_term_id === selectedTermId) : undefined;

  // The report's identity lives in the URL (mode, class, register, range)
  // so a report can be linked to — from the dashboard, a notification, a
  // bookmark — and survives a refresh.
  const [params, setParams] = useSearchParams();
  const mode: Mode = params.get('mode') === 'subject' ? 'subject' : 'class';
  const classId = params.get('classId') || '';
  const sectionKey = params.get('section') || 'homeroom';
  const fromDate = params.get('from') || DEFAULT_FROM();
  const toDate = params.get('to') || isoDate();
  const selectedSubjectId = params.get('subjectId') ? Number(params.get('subjectId')) : null;
  const patch = (next: Record<string, string | null>) => {
    const q = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) { if (v == null || v === '') q.delete(k); else q.set(k, v); }
    setParams(q, { replace: true });
  };

  const [classes, setClasses] = useState<ReportableClass[]>([]);
  const [sections, setSections] = useState<ClassSection[]>([]);
  // Set right before picking a class when a subject-mode click already knows
  // which register it wants — otherwise the sections-load effect would reset
  // every newly-picked class back to the morning check.
  const [pendingSectionKey, setPendingSectionKey] = useState<string | null>(null);

  const [subjects, setSubjects] = useState<SubjectOverview[]>([]);
  const [loadingSubjects, setLoadingSubjects] = useState(false);
  const [subjectClasses, setSubjectClasses] = useState<SubjectClassOverview[]>([]);
  const [loadingSubjectClasses, setLoadingSubjectClasses] = useState(false);

  const [report, setReport] = useState<ClassSectionReport | null>(null);
  const [loadingClasses, setLoadingClasses] = useState(true);
  const [loadingReport, setLoadingReport] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<1 | -1>(1);

  const loadClasses = React.useCallback(() => {
    setLoadingClasses(true); setError(null);
    attendanceReportApi.classes()
      .then((r) => setClasses(r.data ?? []))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load classes.'))
      .finally(() => setLoadingClasses(false));
  }, []);
  useEffect(() => { loadClasses(); }, [loadClasses]);

  useEffect(() => {
    if (!classId) { setSections([]); return; }
    const want = pendingSectionKey ?? params.get('section');
    setPendingSectionKey(null);
    attendanceReportApi.sections(classId)
      .then((r) => {
        const secs = r.data ?? [{ kind: 'homeroom' as const }];
        setSections(secs);
        const wantExists = want != null && secs.some((s) => (s.kind === 'homeroom' ? 'homeroom' : String(s.subjectId)) === want);
        patch({ section: wantExists ? want! : 'homeroom' });
      })
      .catch(() => setSections([{ kind: 'homeroom' }]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId]);

  const loadSubjects = React.useCallback(() => {
    setLoadingSubjects(true); setError(null);
    attendanceReportApi.subjects()
      .then((r) => setSubjects(r.data ?? []))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load subjects.'))
      .finally(() => setLoadingSubjects(false));
  }, []);
  useEffect(() => { if (mode === 'subject') loadSubjects(); }, [mode, loadSubjects]);

  const loadSubjectClasses = React.useCallback((subjectId: number, autoOpen: boolean) => {
    setLoadingSubjectClasses(true); setError(null);
    attendanceReportApi.subjectClasses(subjectId)
      .then((r) => {
        const list = r.data ?? [];
        setSubjectClasses(list);
        // Only one class teaches this subject (the common case for a
        // teacher's own subject) — skip the extra click and open it directly.
        if (autoOpen && list.length === 1) {
          setPendingSectionKey(String(subjectId));
          patch({ classId: list[0].classId, section: String(subjectId) });
        }
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load classes for this subject.'))
      .finally(() => setLoadingSubjectClasses(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (mode === 'subject' && selectedSubjectId != null) loadSubjectClasses(selectedSubjectId, false);
    else setSubjectClasses([]);
  }, [mode, selectedSubjectId, loadSubjectClasses]);

  const openSubject = (subjectId: number) => {
    patch({ subjectId: String(subjectId), classId: null, section: null });
    loadSubjectClasses(subjectId, true);
  };
  const openSubjectClass = (targetClassId: string) => {
    if (selectedSubjectId != null) setPendingSectionKey(String(selectedSubjectId));
    patch({ classId: targetClassId, section: selectedSubjectId != null ? String(selectedSubjectId) : null });
  };
  const resetToSubjects = () => { patch({ subjectId: null, classId: null, section: null }); setReport(null); };
  const backToSubjectClasses = () => { patch({ classId: null, section: null }); setReport(null); };
  const switchMode = (next: Mode) => {
    if (next === mode) return;
    patch({ mode: next === 'class' ? null : next, classId: null, section: null, subjectId: null });
    setSections([]); setReport(null); setError(null);
  };

  const selectedSection = sections.find((s) => (s.kind === 'homeroom' ? 'homeroom' : String(s.subjectId)) === sectionKey);

  const loadReport = React.useCallback(() => {
    if (!classId || !selectedSection) { setReport(null); return; }
    setLoadingReport(true); setError(null);
    attendanceReportApi.classReport(classId, {
      sessionType: selectedSection.kind,
      subjectId: selectedSection.kind === 'subject' ? selectedSection.subjectId : undefined,
      from: fromDate || undefined,
      to: toDate || undefined,
    })
      .then((r) => setReport(r.data ?? null))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the attendance report.'))
      .finally(() => setLoadingReport(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId, sectionKey, fromDate, toDate, sections.length]);
  useEffect(() => { loadReport(); }, [loadReport]);

  /** One retry button, wired to whatever step actually failed. */
  const retry = () => {
    setError(null);
    if (mode === 'subject') {
      if (selectedSubjectId == null) loadSubjects();
      else if (!classId) loadSubjectClasses(selectedSubjectId, false);
      else loadReport();
    } else if (!classId) loadClasses();
    else loadReport();
  };

  // ---- Date range presets ----
  const termFrom = term?.start_date?.slice(0, 10);
  const termTo = term?.end_date?.slice(0, 10);
  const termToClamped = termTo && termTo < isoDate() ? termTo : isoDate();
  const preset: Preset =
    fromDate === DEFAULT_FROM() && toDate === isoDate() ? '2w'
      : fromDate === addDays(isoDate(), -29) && toDate === isoDate() ? '30d'
        : termFrom && fromDate === termFrom && toDate === termToClamped ? 'term'
          : 'custom';
  const applyPreset = (p: Preset) => {
    if (p === '2w') patch({ from: null, to: null });
    else if (p === '30d') patch({ from: addDays(isoDate(), -29), to: null });
    else if (p === 'term' && termFrom) patch({ from: termFrom, to: termToClamped === isoDate() ? null : termToClamped });
  };

  const filteredStudents = useMemo(() => {
    if (!report) return [];
    const q = search.trim().toLowerCase();
    const rows = q ? report.students.filter((s) => s.studentName.toLowerCase().includes(q)) : report.students;
    return [...rows].sort((a, b) => {
      const cmp = sortKey === 'name' ? a.studentName.localeCompare(b.studentName) : a.rate - b.rate;
      return cmp * sortDir;
    });
  }, [report, search, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(key); setSortDir(1); }
  };

  // Read the server's threshold rather than hardcoding our own copy of it --
  // ATTENDANCE_WARN_THRESHOLD is admin-configurable via env var, and a
  // client-side constant would silently drift from it.
  const atRiskThreshold = report?.atRiskThreshold ?? 80;
  const atRisk = useMemo(
    () => report?.students.filter((s) => s.rate < atRiskThreshold).length ?? 0,
    [report, atRiskThreshold]
  );

  const exportCSV = () => {
    if (!report) return;
    const header = ['#', 'Student', ...report.dateColumns.map(fmtDate), 'Present', 'Absent', 'Late', 'Excused', 'Rate (%)', 'Comment'];
    const lines = [header.join(',')];
    filteredStudents.forEach((s, i) => {
      const marks = report.dateColumns.map((d) => s.marks[d] ? s.marks[d][0].toUpperCase() : '');
      lines.push([i + 1, `"${s.studentName}"`, ...marks, s.present, s.absent, s.late, s.excused, s.rate, s.comment].join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `attendance-report-${report.className}-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const classOptions = classes.map((c) => ({ value: c.classId, label: c.className }));
  const currentClassName = subjectClasses.find((c) => c.classId === classId)?.className || classes.find((c) => c.classId === classId)?.className;

  return (
    <DashboardLayout>
      <div className="page-header no-print">
        <div>
          <h1 className="page-title">Attendance Report</h1>
          <p className="page-subtitle">A class register by subject and date range — analyse, print, or export.</p>
        </div>
        <div className="flex gap-2 flex-wrap" style={{ marginTop: '6px' }}>
          <button className="btn btn-outline" onClick={exportCSV} disabled={!report}><Download size={16} /> Export CSV</button>
          <button className="btn btn-primary" onClick={() => window.print()} disabled={!report}><Printer size={16} /> Print / Save PDF</button>
        </div>
      </div>

      {/* ---- One compact toolbar row: mode, what to report on, and over
          which dates — all inline so the filter bar stays out of the way
          of the actual report below it. */}
      <div className="card ar-toolbar no-print">
        <div className="ar-toolbar-row">
          <div className="ar-mode-tabs" role="tablist" aria-label="Report mode">
            <button role="tab" aria-selected={mode === 'class'} className={`ar-mode-tab${mode === 'class' ? ' is-active' : ''}`} onClick={() => switchMode('class')}>
              <LayoutGrid size={14} /> By Class
            </button>
            <button role="tab" aria-selected={mode === 'subject'} className={`ar-mode-tab${mode === 'subject' ? ' is-active' : ''}`} onClick={() => switchMode('subject')}>
              <BookOpen size={14} /> By Subject
            </button>
          </div>

          {mode === 'class' && classId && (
            <>
              <div className="ar-picker-inline">
                <span className="ar-filter-label sr-only">Class</span>
                <SearchableSelect
                  options={classOptions}
                  value={classId}
                  onChange={(v) => patch({ classId: v, section: null })}
                  placeholder={loadingClasses ? 'Loading classes…' : 'Select a class…'}
                  disabled={loadingClasses}
                  aria-label="Class"
                />
              </div>
              {sections.length > 0 && (
                <div className="ar-subjects">
                  <span className="ar-filter-label sr-only">Register</span>
                  {sections.map((sec) => {
                    const key = sec.kind === 'homeroom' ? 'homeroom' : String(sec.subjectId);
                    return (
                      <button
                        key={key}
                        className={`subject-chip${sectionKey === key ? ' is-active' : ''}`}
                        onClick={() => patch({ section: key })}
                        aria-pressed={sectionKey === key}
                      >
                        {sec.kind === 'homeroom' ? <Sun size={12} /> : <BookOpen size={12} />}
                        {sec.kind === 'homeroom' ? 'Morning check' : sec.subjectName}
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {mode === 'subject' && (
            <div className="ar-breadcrumb">
              <button className={`ar-crumb${selectedSubjectId == null ? ' is-current' : ''}`} onClick={resetToSubjects}>
                <BookOpen size={13} /> Subjects
              </button>
              {selectedSubjectId != null && (
                <>
                  <ChevronRight size={13} className="ar-crumb-sep" />
                  <button className={`ar-crumb${!classId ? ' is-current' : ''}`} onClick={backToSubjectClasses}>
                    {subjects.find((s) => s.subjectId === selectedSubjectId)?.subjectName || 'Subject'}
                  </button>
                </>
              )}
              {classId && (
                <>
                  <ChevronRight size={13} className="ar-crumb-sep" />
                  <span className="ar-crumb is-current"><GraduationCap size={13} /> {currentClassName}</span>
                </>
              )}
            </div>
          )}

          <div className="ar-range">
            <div className="ar-presets" role="group" aria-label="Date range">
              {([['2w', 'Last 2 weeks'], ['30d', 'Last 30 days'], ...(termFrom ? [['term', 'Full term']] : [])] as Array<[Preset, string]>).map(([p, label]) => (
                <button key={p} className={`rp-chip${preset === p ? ' is-on' : ''}`} aria-pressed={preset === p} onClick={() => applyPreset(p)}>{label}</button>
              ))}
            </div>
            <div className="ar-dates">
              <label className="ar-date">
                <span className="sr-only">From</span>
                <input type="date" className="input" value={fromDate} onChange={(e) => patch({ from: e.target.value })} max={toDate} />
              </label>
              <span className="ar-date-sep" aria-hidden="true">–</span>
              <label className="ar-date">
                <span className="sr-only">To</span>
                <input type="date" className="input" value={toDate} onChange={(e) => patch({ to: e.target.value })} min={fromDate} max={isoDate()} />
              </label>
            </div>
          </div>
        </div>
      </div>

      {/* ---- By Subject: drill-down lists ---- */}
      {mode === 'subject' && !classId && (
        <div className="no-print">
          {error ? (
            <ErrorState message={error} onRetry={retry} />
          ) : selectedSubjectId == null ? (
            loadingSubjects ? (
              <div style={{ padding: '32px 0' }}><LoadingSpinner /></div>
            ) : subjects.length === 0 ? (
              <div className="card empty-state">No subjects to report on this term.</div>
            ) : (
              <div className="ar-listgroup">
                {subjects.map((s) => (
                  <button key={s.subjectId} className="ar-listitem" onClick={() => openSubject(s.subjectId)}>
                    <span className="ar-listitem-icon"><BookOpen size={16} /></span>
                    <span className="ar-listitem-main">
                      <span className="ar-listitem-name">{s.subjectName}</span>
                      <span className="ar-listitem-meta">
                        <span><GraduationCap size={12} /> {s.classCount} class{s.classCount === 1 ? '' : 'es'}</span>
                        <span><Users size={12} /> {s.studentsTracked} students</span>
                        {s.atRiskCount > 0 && <span className="ar-listitem-risk"><AlertTriangle size={12} /> {s.atRiskCount} at risk</span>}
                      </span>
                    </span>
                    <span className="ar-listitem-bar"><span className="ar-listitem-bar-fill" style={{ width: `${s.averageRate}%`, background: rateColor(s.averageRate) }} /></span>
                    <span className="ar-listitem-rate" style={{ color: rateColor(s.averageRate) }}>{s.averageRate}%</span>
                    <ChevronRight size={16} className="ar-listitem-chevron" />
                  </button>
                ))}
              </div>
            )
          ) : loadingSubjectClasses ? (
            <div style={{ padding: '32px 0' }}><LoadingSpinner /></div>
          ) : subjectClasses.length === 0 ? (
            <div className="card empty-state">No classes are teaching this subject this term.</div>
          ) : (
            <div className="ar-listgroup">
              {subjectClasses.map((c) => (
                <button key={c.classId} className="ar-listitem" onClick={() => openSubjectClass(c.classId)}>
                  <span className="ar-listitem-icon"><GraduationCap size={16} /></span>
                  <span className="ar-listitem-main">
                    <span className="ar-listitem-name">{c.className}</span>
                    <span className="ar-listitem-meta">
                      <span><Users size={12} /> {c.studentsTracked} students</span>
                      {c.teacherName && <span><ClipboardList size={12} /> {c.teacherName}</span>}
                    </span>
                  </span>
                  <span className="ar-listitem-bar"><span className="ar-listitem-bar-fill" style={{ width: `${c.averageRate}%`, background: rateColor(c.averageRate) }} /></span>
                  <span className="ar-listitem-rate" style={{ color: rateColor(c.averageRate) }}>{c.averageRate}%</span>
                  <ChevronRight size={16} className="ar-listitem-chevron" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ---- By Class, nothing picked yet: the classes themselves are the picker ---- */}
      {mode === 'class' && !classId && (
        <div className="card ar-landing no-print">
          {error ? (
            <ErrorState message={error} onRetry={retry} />
          ) : loadingClasses ? (
            <div style={{ padding: '32px 0' }}><LoadingSpinner /></div>
          ) : classes.length === 0 ? (
            <div className="empty-state"><Inbox size={26} /><span className="text-sm">No classes to report on this term.</span></div>
          ) : (
            <>
              <div className="ar-landing-head">
                <span className="section-icon"><FileBarChart size={16} /></span>
                <div>
                  <div className="section-title">Pick a class to build its report</div>
                  <div className="card-subtitle">Every register for the class — the morning check and each subject — over the dates above.</div>
                </div>
              </div>
              <div className="ar-class-grid">
                {classes.map((c) => (
                  <button key={c.classId} className="ar-class-tile" onClick={() => patch({ classId: c.classId, section: null })}>
                    <span className="ar-class-tile-icon"><GraduationCap size={18} /></span>
                    <span className="ar-class-tile-name">{c.className}</span>
                    <ChevronRight size={16} className="ar-listitem-chevron" />
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ---- The report ---- */}
      {classId && (
        loadingReport ? (
          <div style={{ padding: '48px 0' }}><LoadingSpinner /></div>
        ) : error ? (
          <ErrorState message={error} onRetry={retry} />
        ) : !report ? (
          <div className="card empty-state no-print"><Inbox size={26} /><span className="text-sm">No attendance recorded for this register in the selected range.</span></div>
        ) : (
          <>
            <div className="grid grid-stats mb-6 no-print">
              <div className="stat-card" style={{ ['--accent-color' as string]: rateColor(report.classAverageRate) }}>
                <div className="flex items-center justify-between">
                  <span className="stat-icon"><TrendingUp size={18} /></span><span className="stat-tag">{fmtDate(fromDate)} – {fmtDate(toDate)}</span>
                </div>
                <div className="stat-value">{report.classAverageRate}%</div>
                <span className="stat-label">Class average</span>
              </div>
              <div className="stat-card" style={{ ['--accent-color' as string]: 'var(--primary)' }}>
                <div className="flex items-center justify-between"><span className="stat-icon"><Users size={18} /></span></div>
                <div className="stat-value">{report.students.length}</div>
                <span className="stat-label">Students tracked</span>
              </div>
              <div className="stat-card" style={{ ['--accent-color' as string]: 'var(--info)' }}>
                <div className="flex items-center justify-between"><span className="stat-icon"><CalendarDays size={18} /></span></div>
                <div className="stat-value">{report.dateColumns.length}</div>
                <span className="stat-label">Days recorded</span>
              </div>
              <div className="stat-card" style={{ ['--accent-color' as string]: atRisk > 0 ? 'var(--danger)' : 'var(--success)' }}>
                <div className="flex items-center justify-between"><span className="stat-icon"><AlertTriangle size={18} /></span><span className="stat-tag">below {atRiskThreshold}%</span></div>
                <div className="stat-value">{atRisk}</div>
                <span className="stat-label">At risk</span>
              </div>
            </div>

            <div className="card card-pad print-area">
              <div className="ar-letterhead">
                <div>
                  <div className="text-xl font-bold" style={{ fontFamily: 'var(--font-display)' }}>Tendo</div>
                  <div className="text-sm text-secondary">Class attendance record</div>
                </div>
                <div className="text-right text-xs text-secondary">
                  <div>Generated {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</div>
                  <div>{fmtDateLong(fromDate)} – {fmtDateLong(toDate)}</div>
                </div>
              </div>

              <div className="ar-meta-grid">
                <div><span className="text-xs text-secondary">Academic year</span><div className="font-medium">{yearName || '—'}</div></div>
                <div><span className="text-xs text-secondary">Term</span><div className="font-medium">{term?.name || '—'}</div></div>
                <div><span className="text-xs text-secondary">Class</span><div className="font-medium">{report.className}</div></div>
                <div><span className="text-xs text-secondary">Register</span><div className="font-medium">{report.subjectName || 'Morning check'}</div></div>
                <div><span className="text-xs text-secondary">Teacher</span><div className="font-medium">{report.teacherName || '—'}</div></div>
              </div>

              <ClassAnalytics report={report} />

              <RateChart students={report.students} />

              <div className="ar-grid-head">
                <div>
                  <div className="ch-title">Register</div>
                  <div className="text-xs text-secondary">One row per student, one column per recorded day.</div>
                </div>
                <div className="ar-search no-print">
                  <Search size={13} />
                  <input type="text" placeholder="Search students…" value={search} onChange={(e) => setSearch(e.target.value)} />
                </div>
              </div>

              <div className="table-wrap ar-grid-wrap">
                <table className="table table--zebra ar-grid">
                  <thead>
                    <tr>
                      <th className="ar-sticky-col">
                        <button className="ar-sort-btn" onClick={() => toggleSort('name')}>Student <ArrowUpDown size={11} /></button>
                      </th>
                      {report.dateColumns.map((d) => <th key={d} className="ar-date-col">{fmtDate(d)}</th>)}
                      <th>P</th><th>A</th><th>L</th><th>E</th>
                      <th><button className="ar-sort-btn" onClick={() => toggleSort('rate')}>Rate <ArrowUpDown size={11} /></button></th>
                      <th>Comment</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredStudents.map((s, i) => (
                      <tr key={s.studentId}>
                        <td className="ar-sticky-col">{i + 1}. {s.studentName}</td>
                        {report.dateColumns.map((d) => {
                          const status = s.marks[d];
                          return (
                            <td key={d} className="ar-mark-cell" title={status ? `${fmtDateLong(d)}: ${status}` : `${fmtDateLong(d)}: not recorded`}>
                              {status ? <span className={`badge badge-${status}`}>{status[0].toUpperCase()}</span> : <span className="text-tertiary">—</span>}
                            </td>
                          );
                        })}
                        <td>{s.present}</td>
                        <td>{s.absent}</td>
                        <td>{s.late}</td>
                        <td>{s.excused}</td>
                        <td className="font-semibold">{s.rate}%</td>
                        <td><span className={`badge ${COMMENT_BADGE[s.comment]}`}>{s.comment}</span></td>
                      </tr>
                    ))}
                    {filteredStudents.length === 0 && (
                      <tr>
                        <td colSpan={report.dateColumns.length + 7} className="text-center text-secondary">
                          {report.students.length === 0
                            ? 'No attendance recorded for this register in the selected date range.'
                            : `No students match "${search}".`}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="flex justify-between mt-6" style={{ paddingTop: '24px' }}>
                <div className="text-xs text-secondary">Prepared and signed by {user?.name || '_______________________'} on {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</div>
                <div className="text-xs text-secondary">Signature: _______________________</div>
              </div>
            </div>
          </>
        )
      )}
    </DashboardLayout>
  );
};

export default AttendanceReport;
