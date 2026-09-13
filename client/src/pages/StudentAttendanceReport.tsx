import React, { useEffect, useMemo, useState } from 'react';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { ErrorState } from '../components/common/ErrorState';
import { useAuth } from '../context/AuthContext';
import { useAcademicPeriod } from '../context/AcademicPeriodContext';
import { ApiError } from '../api/client';
import { attendanceReportApi, type ClassSectionReport, type OwnSubjectSummary } from '../api/attendanceReport';
import { isoDate } from '../utils/time';
import { COMMENT_META, COMMENT_BADGE, rateColor } from '../utils/attendanceComment';
import {
  Printer, Download, TrendingUp, CalendarDays, AlertTriangle, Sun, BookOpen,
  ChevronRight, Users,
} from 'lucide-react';

/**
 * A student's own attendance report. Two views:
 *  - "All Subjects" (the default landing view) — every section side by
 *    side, including ones with nothing recorded yet, plus a comparison
 *    chart. This is what replaces the old chip row, which broke down once
 *    there were more than a handful of subjects.
 *  - A single section's detail (date-by-date register), reached by opening
 *    a row from the list above.
 * Their class is auto-detected server-side (attendanceReport.service.ts's
 * resolveOwnClassId) — there is nothing to pick, and the grid only ever
 * contains their own row. No other student's data reaches this page.
 */

const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00`); x.setDate(x.getDate() + n); return isoDate(x); };
const fmtDate = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const fmtDateLong = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const sectionName = (row: Pick<OwnSubjectSummary, 'kind' | 'subjectName'>) => (row.kind === 'homeroom' ? 'Homeroom' : row.subjectName || 'Unknown subject');

/** Comparison bar chart — only sections with real data are meaningful to
 *  rank against each other; a "no sessions yet" section has nothing to
 *  compare, and a phantom 0-width bar next to a real 0% (real absences)
 *  bar would be indistinguishable and misleading. Those still appear in
 *  the list below, just not here. */
const CompareChart: React.FC<{ rows: OwnSubjectSummary[] }> = ({ rows }) => {
  const withData = useMemo(() => [...rows].filter((r) => r.hasData).sort((a, b) => a.rate - b.rate), [rows]);
  if (withData.length === 0) return null;
  return (
    <div className="ar-chart">
      <div className="ar-chart-legend">
        {(Object.keys(COMMENT_META) as Array<keyof typeof COMMENT_META>).map((k) => (
          <span key={k} className="ar-chart-legend-item" style={{ color: COMMENT_META[k].color }}>
            {COMMENT_META[k].icon} {k}
          </span>
        ))}
      </div>
      <div className="ar-chart-rows">
        {withData.map((r) => (
          <div className="ar-chart-row" key={r.kind === 'homeroom' ? 'homeroom' : r.subjectId} title={`${sectionName(r)}: ${r.rate}% (${r.present} present, ${r.absent} absent, ${r.late} late, ${r.excused} excused)`}>
            <span className="ar-chart-name">{sectionName(r)}</span>
            <div className="ar-chart-track">
              <div className="ar-chart-fill" style={{ width: `${r.rate}%`, background: COMMENT_META[r.comment].color }} />
            </div>
            <span className="ar-chart-value">{r.rate}%</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export const StudentAttendanceReport: React.FC = () => {
  const { user } = useAuth();
  const { selectedYearId, selectedTermId, termsByYear, years } = useAcademicPeriod();
  const yearName = years.find((y) => y.academic_year_id === selectedYearId)?.name;
  const term = selectedYearId != null ? termsByYear[selectedYearId]?.find((t) => t.academic_term_id === selectedTermId) : undefined;

  const [fromDate, setFromDate] = useState(() => addDays(isoDate(), -13));
  const [toDate, setToDate] = useState(() => isoDate());

  // null = "All Subjects" view; set = viewing one section's detail.
  const [selected, setSelected] = useState<OwnSubjectSummary | null>(null);

  const [overview, setOverview] = useState<OwnSubjectSummary[]>([]);
  const [loadingOverview, setLoadingOverview] = useState(true);
  const [report, setReport] = useState<ClassSectionReport | null>(null);
  const [loadingReport, setLoadingReport] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadOverview = React.useCallback(() => {
    setLoadingOverview(true); setError(null);
    attendanceReportApi.myAllSubjects(fromDate || undefined, toDate || undefined)
      .then((r) => setOverview(r.data ?? []))
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

  const useFullTerm = () => {
    if (term?.start_date) setFromDate(term.start_date.slice(0, 10));
    if (term?.end_date) setToDate(term.end_date.slice(0, 10));
  };

  const me = report?.students[0] ?? null;
  const segs = useMemo(() => {
    if (!me) return [];
    return [
      { n: me.present, c: 'var(--success)' },
      { n: me.late, c: 'var(--warning)' },
      { n: me.excused, c: 'var(--info)' },
      { n: me.absent, c: 'var(--danger)' },
    ].filter((s) => s.n > 0);
  }, [me]);

  const overallAtRisk = overview.filter((r) => r.hasData && r.rate < 80).length;
  const trackedCount = overview.filter((r) => r.hasData).length;

  const exportOverviewCSV = () => {
    if (overview.length === 0) return;
    const lines = ['Section,Present,Absent,Late,Excused,Total,Rate (%),Comment'];
    overview.forEach((r) => {
      lines.push([`"${sectionName(r)}"`, r.present, r.absent, r.late, r.excused, r.total, r.hasData ? r.rate : '—', r.hasData ? r.comment : 'No sessions yet'].join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `my-attendance-overview-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const exportDetailCSV = () => {
    if (!report || !me) return;
    const header = ['Date', 'Status'];
    const lines = [header.join(',')];
    report.dateColumns.forEach((d) => lines.push([fmtDate(d), me.marks[d] ?? 'not recorded'].join(',')));
    lines.push('');
    lines.push(`Present,${me.present}`); lines.push(`Absent,${me.absent}`);
    lines.push(`Late,${me.late}`); lines.push(`Excused,${me.excused}`);
    lines.push(`Rate,${me.rate}%`); lines.push(`Comment,${me.comment}`);
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `my-attendance-${sectionName(selected!)}-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const canExport = selected ? !!me : overview.length > 0;
  const canPrint = selected ? !!me : overview.length > 0;

  return (
    <DashboardLayout>
      <div className="page-header no-print">
        <div>
          <h1 className="page-title">Attendance Report</h1>
          <p className="page-subtitle">{selected ? 'Your attendance record for this section.' : 'Every subject, side by side.'}</p>
        </div>
        <div className="flex gap-2" style={{ marginTop: '6px' }}>
          <button className="btn btn-outline" onClick={selected ? exportDetailCSV : exportOverviewCSV} disabled={!canExport}><Download size={16} /> Export CSV</button>
          <button className="btn btn-primary" onClick={() => window.print()} disabled={!canPrint}><Printer size={16} /> Print / Save PDF</button>
        </div>
      </div>

      <div className="card card-pad no-print ar-filterbar">
        <div className="ar-filter-row">
          <div className="ar-filter-field">
            <label className="ar-filter-label">From</label>
            <input type="date" className="input" value={fromDate} onChange={(e) => setFromDate(e.target.value)} max={toDate} />
          </div>
          <div className="ar-filter-field">
            <label className="ar-filter-label">To</label>
            <input type="date" className="input" value={toDate} onChange={(e) => setToDate(e.target.value)} min={fromDate} max={isoDate()} />
          </div>
          {term?.start_date && (
            <button className="btn btn-ghost btn-sm" onClick={useFullTerm} style={{ marginTop: '20px' }}>Full term</button>
          )}
        </div>
      </div>

      {!selected && (
        <div className="no-print">
          <div className="ar-breadcrumb">
            <span className="ar-crumb is-current"><Users size={13} /> All Subjects</span>
          </div>
        </div>
      )}

      {selected && (
        <div className="ar-breadcrumb no-print">
          <button className="ar-crumb" onClick={() => setSelected(null)}><Users size={13} /> All Subjects</button>
          <ChevronRight size={13} className="ar-crumb-sep" />
          <span className="ar-crumb is-current">
            {selected.kind === 'homeroom' ? <Sun size={13} /> : <BookOpen size={13} />} {sectionName(selected)}
          </span>
        </div>
      )}

      {!selected ? (
        loadingOverview ? (
          <div style={{ padding: '48px 0' }}><LoadingSpinner /></div>
        ) : error ? (
          <ErrorState message={error} onRetry={loadOverview} />
        ) : overview.length === 0 ? (
          <div className="empty-state no-print" style={{ marginTop: '16px' }}>
            <CalendarDays size={30} />
            <span className="text-sm">No subjects to show yet.</span>
          </div>
        ) : (
          <>
            <div className="grid grid-3 mb-6 no-print">
              <div className="stat-card" style={{ ['--accent-color' as string]: 'var(--primary)' }}>
                <div className="flex items-center justify-between">
                  <span className="stat-label">Subjects Tracked</span><span className="stat-icon"><BookOpen size={18} /></span>
                </div>
                <div className="stat-value">{trackedCount} / {overview.length}</div>
              </div>
              <div className="stat-card" style={{ ['--accent-color' as string]: overallAtRisk > 0 ? 'var(--danger)' : 'var(--success)' }}>
                <div className="flex items-center justify-between">
                  <span className="stat-label">Below 80%</span><span className="stat-icon"><AlertTriangle size={18} /></span>
                </div>
                <div className="stat-value">{overallAtRisk}</div>
              </div>
              <div className="stat-card" style={{ ['--accent-color' as string]: 'var(--info)' }}>
                <div className="flex items-center justify-between">
                  <span className="stat-label">Date Range</span><span className="stat-icon"><CalendarDays size={18} /></span>
                </div>
                <div className="stat-value" style={{ fontSize: '20px' }}>{fmtDate(fromDate)} – {fmtDate(toDate)}</div>
              </div>
            </div>

            <div className="card card-pad print-area">
              <CompareChart rows={overview} />

              <div className="ar-listgroup">
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
                          <span className="ar-listitem-bar">
                            <span className="ar-listitem-bar-fill" style={{ width: `${r.rate}%`, background: rateColor(r.rate) }} />
                          </span>
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
        <div className="empty-state no-print" style={{ marginTop: '16px' }}>
          <CalendarDays size={30} />
          <span className="text-sm">No attendance recorded for this section in the selected range yet.</span>
        </div>
      ) : (
        <>
          <div className="grid grid-3 mb-6 no-print">
            <div className="stat-card" style={{ ['--accent-color' as string]: COMMENT_META[me.comment].color }}>
              <div className="flex items-center justify-between">
                <span className="stat-label">Attendance Rate</span><span className="stat-icon"><TrendingUp size={18} /></span>
              </div>
              <div className="stat-value" style={{ color: COMMENT_META[me.comment].color }}>{me.rate}%</div>
              <span className={`badge ${COMMENT_BADGE[me.comment]}`} style={{ marginTop: '6px' }}>{me.comment}</span>
            </div>
            <div className="stat-card" style={{ ['--accent-color' as string]: 'var(--primary)' }}>
              <div className="flex items-center justify-between">
                <span className="stat-label">Sessions Recorded</span><span className="stat-icon"><CalendarDays size={18} /></span>
              </div>
              <div className="stat-value">{me.total}</div>
            </div>
            <div className="stat-card" style={{ ['--accent-color' as string]: me.absent > 0 ? 'var(--danger)' : 'var(--success)' }}>
              <div className="flex items-center justify-between">
                <span className="stat-label">Absences</span><span className="stat-icon"><AlertTriangle size={18} /></span>
              </div>
              <div className="stat-value">{me.absent}</div>
            </div>
          </div>

          <div className="card card-pad print-area">
            <div className="ar-letterhead">
              <div>
                <div className="text-xl font-bold" style={{ fontFamily: 'var(--font-display)' }}>Tendo</div>
                <div className="text-sm text-secondary">My attendance record</div>
              </div>
              <div className="text-right text-xs text-secondary">
                <div>Generated {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</div>
                {fromDate && toDate && <div>{fmtDateLong(fromDate)} – {fmtDateLong(toDate)}</div>}
              </div>
            </div>

            <div className="ar-meta-grid">
              <div><span className="text-xs text-secondary">Academic Year</span><div className="font-medium">{yearName || '—'}</div></div>
              <div><span className="text-xs text-secondary">Term</span><div className="font-medium">{term?.name || '—'}</div></div>
              <div><span className="text-xs text-secondary">Student</span><div className="font-medium">{user?.name || '—'}</div></div>
              <div><span className="text-xs text-secondary">Class</span><div className="font-medium">{report.className}</div></div>
              <div><span className="text-xs text-secondary">Subject</span><div className="font-medium">{report.sessionType === 'homeroom' ? 'Homeroom' : (report.subjectName || 'Unknown subject')}</div></div>
            </div>

            {segs.length > 0 && (
              <div className="flex mb-4" style={{ height: '10px', gap: '2px', borderRadius: 'var(--radius-full)', overflow: 'hidden' }}>
                {segs.map((s, i) => <div key={i} style={{ flex: s.n, background: s.c }} title={`${s.n}`} />)}
              </div>
            )}

            <div className="table-wrap ar-grid-wrap" style={{ maxHeight: 'none' }}>
              <table className="table table--zebra ar-grid">
                <thead>
                  <tr>
                    <th className="ar-sticky-col">Date</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {report.dateColumns.map((d) => {
                    const status = me.marks[d];
                    return (
                      <tr key={d}>
                        <td className="ar-sticky-col">{fmtDate(d)}</td>
                        <td>{status ? <span className={`badge badge-${status}`}>{status[0].toUpperCase() + status.slice(1)}</span> : <span className="text-tertiary">Not recorded</span>}</td>
                      </tr>
                    );
                  })}
                  {report.dateColumns.length === 0 && (
                    <tr><td colSpan={2} className="text-center text-secondary">No sessions in this range.</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="flex justify-between mt-6 text-xs text-secondary" style={{ paddingTop: '24px' }}>
              <span>Present, late and excused all count towards your rate — only an unexcused absence counts against it.</span>
              <span>Generated on {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span>
            </div>
          </div>
        </>
      )}
    </DashboardLayout>
  );
};

export default StudentAttendanceReport;
