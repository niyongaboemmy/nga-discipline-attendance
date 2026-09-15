import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { ErrorState } from '../components/common/ErrorState';
import { useAuth } from '../context/AuthContext';
import { useAcademicPeriod } from '../context/AcademicPeriodContext';
import { apiGet, ApiError } from '../api/client';
import { attendanceReportApi, type ClassSectionReport, type OwnSubjectSummary } from '../api/attendanceReport';
import { isoDate } from '../utils/time';
import { COMMENT_META, COMMENT_BADGE, COMMENT_FILL, rateColor } from '../utils/attendanceComment';
import { STATUS_SERIES, type StatusKey } from '../components/charts/statusSeries';
import { StackedBar } from '../components/charts/StackedBar';
import { TrendLine, type TrendPoint } from '../components/charts/TrendLine';
import { ColumnChart } from '../components/charts/ColumnChart';
import { countsOf, runningRate, emptyCounts, rateOf, type StatusCounts } from '../utils/attendanceAnalytics';
import {
  Printer, Download, TrendingUp, CalendarDays, AlertTriangle, Sun, BookOpen, ChevronRight, Users, Clock, Inbox,
} from 'lucide-react';

/**
 * A student's own attendance report. Two views:
 *  - "All subjects" (the landing view): term-wide analytics — where the
 *    rate has been heading, what the marks were per subject, where the
 *    absences fall — plus every section side by side, including ones with
 *    nothing recorded yet.
 *  - One section's detail (date-by-date register), reached from the list.
 * The class is auto-detected server-side; only the student's own row ever
 * reaches this page. The date range lives in the URL and defaults to the
 * whole term, so the page never opens onto an empty fortnight.
 */

const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00`); x.setDate(x.getDate() + n); return isoDate(x); };
const fmtDate = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const fmtDateLong = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const sectionName = (row: Pick<OwnSubjectSummary, 'kind' | 'subjectName'>) => (row.kind === 'homeroom' ? 'Morning check' : row.subjectName || 'Unknown subject');
const tierOf = (rate: number) => (rate >= 95 ? 'Excellent' : rate >= 85 ? 'Good' : rate >= 75 ? 'Fair' : 'Poor') as keyof typeof COMMENT_META;
const isStatus = (s: string): s is StatusKey => s === 'present' || s === 'late' || s === 'excused' || s === 'absent';

/** `/api/attendance/me` — every marked day this term, homeroom + subjects. */
interface MeDay {
  date: string;
  homeroom: { status: string } | null;
  subjects: Array<{ subjectId: number; subjectName: string; status: string }>;
}

type Preset = '2w' | '30d' | 'term' | 'custom';

export const StudentAttendanceReport: React.FC = () => {
  const { user } = useAuth();
  const { selectedYearId, selectedTermId, termsByYear, years } = useAcademicPeriod();
  const yearName = years.find((y) => y.academic_year_id === selectedYearId)?.name;
  const term = selectedYearId != null ? termsByYear[selectedYearId]?.find((t) => t.academic_term_id === selectedTermId) : undefined;
  const termFrom = term?.start_date?.slice(0, 10);
  const termTo = term?.end_date?.slice(0, 10);
  const termToClamped = termTo && termTo < isoDate() ? termTo : isoDate();

  const [params, setParams] = useSearchParams();
  const fromDate = params.get('from') || termFrom || addDays(isoDate(), -29);
  const toDate = params.get('to') || (termFrom ? termToClamped : isoDate());
  const patch = (next: Record<string, string | null>) => {
    const q = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) { if (v == null || v === '') q.delete(k); else q.set(k, v); }
    setParams(q, { replace: true });
  };
  const preset: Preset =
    fromDate === addDays(isoDate(), -13) && toDate === isoDate() ? '2w'
      : fromDate === addDays(isoDate(), -29) && toDate === isoDate() ? '30d'
        : termFrom && fromDate === termFrom && toDate === termToClamped ? 'term'
          : 'custom';
  const applyPreset = (p: Preset) => {
    if (p === 'term') patch({ from: null, to: null });
    else if (p === '2w') patch({ from: addDays(isoDate(), -13), to: isoDate() });
    else if (p === '30d') patch({ from: addDays(isoDate(), -29), to: isoDate() });
  };

  // null = "All subjects"; set = one section's detail. Mirrored in the URL
  // (?section=homeroom | <subjectId>) so a subject can be linked to directly.
  const [overview, setOverview] = useState<OwnSubjectSummary[]>([]);
  const sectionKey = params.get('section');
  const selected = useMemo<OwnSubjectSummary | null>(() => {
    if (!sectionKey) return null;
    return overview.find((r) => (r.kind === 'homeroom' ? 'homeroom' : String(r.subjectId)) === sectionKey) ?? null;
  }, [overview, sectionKey]);
  const setSelected = (r: OwnSubjectSummary | null) => patch({ section: r ? (r.kind === 'homeroom' ? 'homeroom' : String(r.subjectId)) : null });
  const [days, setDays] = useState<MeDay[]>([]);
  const [loadingOverview, setLoadingOverview] = useState(true);
  const [report, setReport] = useState<ClassSectionReport | null>(null);
  const [loadingReport, setLoadingReport] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadOverview = React.useCallback(() => {
    setLoadingOverview(true); setError(null);
    Promise.all([
      attendanceReportApi.myAllSubjects(fromDate || undefined, toDate || undefined),
      apiGet<{ days: MeDay[] }>('/api/attendance/me').catch(() => ({ data: { days: [] as MeDay[] } })),
    ])
      .then(([ov, me]) => { setOverview(ov.data ?? []); setDays(me.data?.days ?? []); })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load your subjects.'))
      .finally(() => setLoadingOverview(false));
  }, [fromDate, toDate]);
  useEffect(() => { loadOverview(); }, [loadOverview]);

  const loadReport = React.useCallback(() => {
    if (!selected) return;
    setLoadingReport(true); setError(null);
    attendanceReportApi.myReport({
      sessionType: selected.kind,
      subjectId: selected.kind === 'subject' ? selected.subjectId ?? undefined : undefined,
      from: fromDate || undefined,
      to: toDate || undefined,
    })
      .then((r) => setReport(r.data ?? null))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load your attendance report.'))
      .finally(() => setLoadingReport(false));
  }, [selected, fromDate, toDate]);
  useEffect(() => { if (selected) loadReport(); }, [selected, loadReport]);

  // ---- Overview analytics, all derived from what's already loaded ----
  const totals = useMemo<StatusCounts>(() => overview.reduce((t, r) => ({
    present: t.present + r.present, late: t.late + r.late, excused: t.excused + r.excused, absent: t.absent + r.absent,
  }), emptyCounts()), [overview]);
  const totalSessions = totals.present + totals.late + totals.excused + totals.absent;
  const overallRate = rateOf(totals);
  const tier = tierOf(overallRate);
  const tracked = useMemo(() => overview.filter((r) => r.hasData), [overview]);
  const weakest = tracked.length ? [...tracked].sort((a, b) => a.rate - b.rate)[0] : null;

  /** Running rate across every session in the range, in date order, with
   *  the day's own marks in the readout. */
  const termTrend = useMemo<TrendPoint[]>(() => {
    const inRange = days.filter((d) => d.date >= fromDate && d.date <= toDate).sort((a, b) => a.date.localeCompare(b.date));
    const acc = emptyCounts();
    return inRange.map((d) => {
      const dayCounts = emptyCounts();
      const marks = [...(d.homeroom ? [d.homeroom.status] : []), ...d.subjects.map((s) => s.status)];
      for (const m of marks) if (isStatus(m)) { acc[m] += 1; dayCounts[m] += 1; }
      return {
        label: fmtDate(d.date), longLabel: fmtDateLong(d.date), value: rateOf(acc),
        detail: STATUS_SERIES.filter((s) => dayCounts[s.key] > 0).map((s) => ({ label: `${s.label.toLowerCase()} that day`, value: String(dayCounts[s.key]), color: s.color })),
      };
    });
  }, [days, fromDate, toDate]);

  const absencesBySubject = useMemo(() => tracked
    .filter((r) => r.absent > 0)
    .sort((a, b) => b.absent - a.absent)
    .slice(0, 6)
    .map((r) => ({ label: sectionName(r), value: r.absent, color: 'var(--chart-absent)' })), [tracked]);

  // ---- Section detail analytics ----
  const me = report?.students[0] ?? null;
  const detailTrend = useMemo<TrendPoint[]>(() => {
    if (!me || !report) return [];
    return runningRate(me, report.dateColumns).map((p) => {
      const status = STATUS_SERIES.find((x) => x.key === p.status)!;
      return { label: fmtDate(p.date), longLabel: fmtDateLong(p.date), value: p.rate, detail: [{ label: 'that day', value: status.label, color: status.color }] };
    });
  }, [me, report]);

  const download = (name: string, lines: string[]) => {
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = name; link.click();
    URL.revokeObjectURL(url);
  };
  const exportOverviewCSV = () => {
    if (overview.length === 0) return;
    const lines = ['Section,Present,Absent,Late,Excused,Total,Rate (%),Comment'];
    overview.forEach((r) => lines.push([`"${sectionName(r)}"`, r.present, r.absent, r.late, r.excused, r.total, r.hasData ? r.rate : '—', r.hasData ? r.comment : 'No sessions yet'].join(',')));
    download(`my-attendance-overview-${isoDate()}.csv`, lines);
  };
  const exportDetailCSV = () => {
    if (!report || !me) return;
    const lines = ['Date,Status'];
    report.dateColumns.forEach((d) => lines.push([fmtDate(d), me.marks[d] ?? 'not recorded'].join(',')));
    lines.push('', `Present,${me.present}`, `Absent,${me.absent}`, `Late,${me.late}`, `Excused,${me.excused}`, `Rate,${me.rate}%`, `Comment,${me.comment}`);
    download(`my-attendance-${sectionName(selected!)}-${isoDate()}.csv`, lines);
  };
  const canExport = selected ? !!me : overview.length > 0;

  const generatedOn = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  return (
    <DashboardLayout>
      <div className="page-header no-print">
        <div>
          <h1 className="page-title">Attendance Report</h1>
          <p className="page-subtitle">{selected ? `Your register for ${sectionName(selected)}, day by day.` : 'How your term is going — every subject, side by side.'}</p>
        </div>
        <div className="flex gap-2 flex-wrap" style={{ marginTop: '6px' }}>
          <button className="btn btn-outline" onClick={selected ? exportDetailCSV : exportOverviewCSV} disabled={!canExport}><Download size={16} /> Export CSV</button>
          <button className="btn btn-primary" onClick={() => window.print()} disabled={!canExport}><Printer size={16} /> Print / Save PDF</button>
        </div>
      </div>

      {/* ---- Toolbar: where you are, and over which dates ---- */}
      <div className="card ar-toolbar no-print">
        <div className="ar-toolbar-row">
          <div className="ar-breadcrumb" style={{ margin: 0 }}>
            {selected ? (
              <>
                <button className="ar-crumb" onClick={() => setSelected(null)}><Users size={13} /> All subjects</button>
                <ChevronRight size={13} className="ar-crumb-sep" />
                <span className="ar-crumb is-current">
                  {selected.kind === 'homeroom' ? <Sun size={13} /> : <BookOpen size={13} />} {sectionName(selected)}
                </span>
              </>
            ) : (
              <span className="ar-crumb is-current"><Users size={13} /> All subjects</span>
            )}
          </div>
          <div className="ar-range">
            <div className="ar-presets" role="group" aria-label="Date range">
              {([...(termFrom ? [['term', 'Full term']] : []), ['30d', 'Last 30 days'], ['2w', 'Last 2 weeks']] as Array<[Preset, string]>).map(([p, label]) => (
                <button key={p} className={`rp-chip${preset === p ? ' is-on' : ''}`} aria-pressed={preset === p} onClick={() => applyPreset(p)}>{label}</button>
              ))}
            </div>
            <div className="ar-dates">
              <label className="ar-date"><span>From</span><input type="date" className="input" value={fromDate} onChange={(e) => patch({ from: e.target.value })} max={toDate} /></label>
              <label className="ar-date"><span>To</span><input type="date" className="input" value={toDate} onChange={(e) => patch({ to: e.target.value })} min={fromDate} max={isoDate()} /></label>
            </div>
          </div>
        </div>
      </div>

      {!selected ? (
        loadingOverview ? (
          <div style={{ padding: '48px 0' }}><LoadingSpinner /></div>
        ) : error ? (
          <ErrorState message={error} onRetry={loadOverview} />
        ) : overview.length === 0 ? (
          <div className="card empty-state no-print"><CalendarDays size={30} /><span className="text-sm">No subjects to show yet.</span></div>
        ) : (
          <>
            <div className="grid grid-stats mb-6 no-print">
              <div className="stat-card" style={{ ['--accent-color' as string]: COMMENT_FILL[tier] }}>
                <div className="flex items-center justify-between">
                  <span className="stat-icon"><TrendingUp size={18} /></span>
                  {totalSessions > 0 && <span className={`badge ${COMMENT_BADGE[tier]}`}>{COMMENT_META[tier].icon} {tier}</span>}
                </div>
                <div className="stat-value">{totalSessions > 0 ? `${overallRate}%` : '—'}</div>
                <span className="stat-label">Overall attendance</span>
              </div>
              <div className="stat-card" style={{ ['--accent-color' as string]: 'var(--primary)' }}>
                <div className="flex items-center justify-between"><span className="stat-icon"><CalendarDays size={18} /></span><span className="stat-tag">{fmtDate(fromDate)} – {fmtDate(toDate)}</span></div>
                <div className="stat-value">{totalSessions}</div>
                <span className="stat-label">Sessions recorded</span>
              </div>
              <div className="stat-card" style={{ ['--accent-color' as string]: totals.absent > 0 ? 'var(--danger)' : 'var(--success)' }}>
                <div className="flex items-center justify-between"><span className="stat-icon"><AlertTriangle size={18} /></span>{totals.excused > 0 && <span className="stat-tag">{totals.excused} excused</span>}</div>
                <div className="stat-value">{totals.absent}</div>
                <span className="stat-label">Unexcused absences</span>
              </div>
              <div className="stat-card" style={{ ['--accent-color' as string]: totals.late > 0 ? 'var(--warning)' : 'var(--info)' }}>
                <div className="flex items-center justify-between"><span className="stat-icon"><Clock size={18} /></span>{weakest && <span className="stat-tag">Lowest: {sectionName(weakest)}</span>}</div>
                <div className="stat-value">{totals.late}</div>
                <span className="stat-label">Late arrivals</span>
              </div>
            </div>

            <div className="card card-pad print-area">
              <div className="ar-letterhead">
                <div>
                  <div className="text-xl font-bold" style={{ fontFamily: 'var(--font-display)' }}>Tendo</div>
                  <div className="text-sm text-secondary">My attendance — {user?.name}</div>
                </div>
                <div className="text-right text-xs text-secondary">
                  <div>{yearName ? `${yearName} · ` : ''}{term?.name || ''}</div>
                  <div>{fmtDateLong(fromDate)} – {fmtDateLong(toDate)}</div>
                </div>
              </div>

              {totalSessions === 0 ? (
                <div className="empty-state" style={{ padding: '40px 0' }}>
                  <Inbox size={28} />
                  <span className="text-sm">Nothing recorded between {fmtDate(fromDate)} and {fmtDate(toDate)}.</span>
                  <span className="text-xs text-secondary">Widen the date range above — the full term is usually the most useful view.</span>
                </div>
              ) : (
                <div className="ar-analytics">
                  {termTrend.length >= 2 ? (
                    <TrendLine title="Your attendance rate over the term" points={termTrend} valueLabel="Running rate" />
                  ) : (
                    <div className="ch">
                      <div className="ch-head"><span className="ch-title">Your attendance rate over the term</span></div>
                      <p className="text-xs text-secondary">The trend appears once at least two days are recorded in the range.</p>
                    </div>
                  )}
                  <div className="ar-analytics-side">
                    <StackedBar
                      title="What your marks were, by subject"
                      series={STATUS_SERIES}
                      rows={[...tracked].sort((a, b) => a.rate - b.rate).map((r) => ({ label: sectionName(r), values: countsOf(r), endLabel: `${r.rate}%` }))}
                    />
                    {absencesBySubject.length > 0 && (
                      <ColumnChart title="Where the absences are" columns={absencesBySubject} unit="absences" plotHeight={80} />
                    )}
                  </div>
                </div>
              )}

              <div className="ar-grid-head">
                <div>
                  <div className="ch-title">Every subject</div>
                  <div className="text-xs text-secondary">Open one for its day-by-day register.</div>
                </div>
              </div>
              <div className="ar-listgroup" style={{ marginBottom: 0 }}>
                {overview.map((r) => {
                  const key = r.kind === 'homeroom' ? 'homeroom' : String(r.subjectId);
                  return (
                    <button key={key} className={`ar-listitem${!r.hasData ? ' is-empty' : ''}`} onClick={() => setSelected(r)}>
                      <span className="ar-listitem-icon">{r.kind === 'homeroom' ? <Sun size={16} /> : <BookOpen size={16} />}</span>
                      <span className="ar-listitem-main">
                        <span className="ar-listitem-name">{sectionName(r)}</span>
                        <span className="ar-listitem-meta">
                          <span>{r.present} present</span>
                          <span>{r.absent} absent</span>
                          {r.late > 0 && <span>{r.late} late</span>}
                          {r.excused > 0 && <span>{r.excused} excused</span>}
                        </span>
                      </span>
                      {r.hasData ? (
                        <>
                          <span className="ar-listitem-bar"><span className="ar-listitem-bar-fill" style={{ width: `${r.rate}%`, background: rateColor(r.rate) }} /></span>
                          <span className="ar-listitem-rate" style={{ color: rateColor(r.rate) }}>{r.rate}%</span>
                        </>
                      ) : (
                        <span className="ar-listitem-empty-tag">No sessions yet</span>
                      )}
                      <ChevronRight size={16} className="ar-listitem-chevron" />
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        )
      ) : loadingReport ? (
        <div style={{ padding: '48px 0' }}><LoadingSpinner /></div>
      ) : error ? (
        <ErrorState message={error} onRetry={loadReport} />
      ) : !report || !me ? (
        <div className="card empty-state no-print">
          <CalendarDays size={30} />
          <span className="text-sm">No attendance recorded for {sectionName(selected)} between {fmtDate(fromDate)} and {fmtDate(toDate)}.</span>
        </div>
      ) : (
        <>
          <div className="grid grid-stats mb-6 no-print">
            <div className="stat-card" style={{ ['--accent-color' as string]: COMMENT_FILL[me.comment] }}>
              <div className="flex items-center justify-between">
                <span className="stat-icon"><TrendingUp size={18} /></span>
                <span className={`badge ${COMMENT_BADGE[me.comment]}`}>{COMMENT_META[me.comment].icon} {me.comment}</span>
              </div>
              <div className="stat-value">{me.rate}%</div>
              <span className="stat-label">Attendance rate</span>
            </div>
            <div className="stat-card" style={{ ['--accent-color' as string]: 'var(--primary)' }}>
              <div className="flex items-center justify-between"><span className="stat-icon"><CalendarDays size={18} /></span><span className="stat-tag">{fmtDate(fromDate)} – {fmtDate(toDate)}</span></div>
              <div className="stat-value">{me.total}</div>
              <span className="stat-label">Sessions recorded</span>
            </div>
            <div className="stat-card" style={{ ['--accent-color' as string]: me.absent > 0 ? 'var(--danger)' : 'var(--success)' }}>
              <div className="flex items-center justify-between"><span className="stat-icon"><AlertTriangle size={18} /></span>{me.excused > 0 && <span className="stat-tag">{me.excused} excused</span>}</div>
              <div className="stat-value">{me.absent}</div>
              <span className="stat-label">Unexcused absences</span>
            </div>
            <div className="stat-card" style={{ ['--accent-color' as string]: me.late > 0 ? 'var(--warning)' : 'var(--info)' }}>
              <div className="flex items-center justify-between"><span className="stat-icon"><Clock size={18} /></span></div>
              <div className="stat-value">{me.late}</div>
              <span className="stat-label">Late arrivals</span>
            </div>
          </div>

          <div className="card card-pad print-area">
            <div className="ar-letterhead">
              <div>
                <div className="text-xl font-bold" style={{ fontFamily: 'var(--font-display)' }}>Tendo</div>
                <div className="text-sm text-secondary">My attendance — {sectionName(selected)}</div>
              </div>
              <div className="text-right text-xs text-secondary">
                <div>Generated {generatedOn}</div>
                <div>{fmtDateLong(fromDate)} – {fmtDateLong(toDate)}</div>
              </div>
            </div>

            <div className="ar-meta-grid">
              <div><span className="text-xs text-secondary">Academic year</span><div className="font-medium">{yearName || '—'}</div></div>
              <div><span className="text-xs text-secondary">Term</span><div className="font-medium">{term?.name || '—'}</div></div>
              <div><span className="text-xs text-secondary">Student</span><div className="font-medium">{user?.name || '—'}</div></div>
              <div><span className="text-xs text-secondary">Class</span><div className="font-medium">{report.className}</div></div>
              <div><span className="text-xs text-secondary">Register</span><div className="font-medium">{report.sessionType === 'homeroom' ? 'Morning check' : (report.subjectName || 'Unknown subject')}</div></div>
            </div>

            <div className="ar-analytics">
              {detailTrend.length >= 2 ? (
                <TrendLine title="Your attendance rate over the term" points={detailTrend} valueLabel="Running rate" />
              ) : (
                <div className="ch">
                  <div className="ch-head"><span className="ch-title">Your attendance rate over the term</span></div>
                  <p className="text-xs text-secondary">The trend appears once at least two days are recorded in the range.</p>
                </div>
              )}
              <div className="ar-analytics-side">
                <StackedBar title="What your marks were" series={STATUS_SERIES} rows={[{ label: sectionName(selected), values: countsOf(me), endLabel: `${me.rate}%` }]} />
              </div>
            </div>

            <div className="ar-grid-head">
              <div>
                <div className="ch-title">Register</div>
                <div className="text-xs text-secondary">Your mark on each recorded day.</div>
              </div>
            </div>
            <div className="table-wrap ar-grid-wrap" style={{ maxHeight: 'none' }}>
              <table className="table table--zebra ar-grid">
                <thead><tr><th className="ar-sticky-col">Date</th><th style={{ textAlign: 'left' }}>Status</th></tr></thead>
                <tbody>
                  {report.dateColumns.map((d) => {
                    const status = me.marks[d];
                    return (
                      <tr key={d}>
                        <td className="ar-sticky-col">{fmtDateLong(d)}</td>
                        <td style={{ textAlign: 'left' }}>{status ? <span className={`badge badge-${status}`}>{status[0].toUpperCase() + status.slice(1)}</span> : <span className="text-tertiary">Not recorded</span>}</td>
                      </tr>
                    );
                  })}
                  {report.dateColumns.length === 0 && <tr><td colSpan={2} className="text-center text-secondary">No sessions in this range.</td></tr>}
                </tbody>
              </table>
            </div>

            <div className="flex justify-between mt-6 text-xs text-secondary flex-wrap gap-2" style={{ paddingTop: '24px' }}>
              <span>Present, late and excused all count towards your rate — only an unexcused absence counts against it.</span>
              <span>Generated on {generatedOn}</span>
            </div>
          </div>
        </>
      )}
    </DashboardLayout>
  );
};

export default StudentAttendanceReport;
