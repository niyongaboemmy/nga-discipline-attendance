import React, { useEffect, useMemo, useState } from 'react';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { ErrorState } from '../components/common/ErrorState';
import { useAuth } from '../context/AuthContext';
import { useAcademicPeriod } from '../context/AcademicPeriodContext';
import { ApiError } from '../api/client';
import { attendanceReportApi, type ClassSection, type ClassSectionReport } from '../api/attendanceReport';
import { isoDate } from '../utils/time';
import { COMMENT_META, COMMENT_BADGE } from '../utils/attendanceComment';
import {
  Printer, Download, TrendingUp, CalendarDays, AlertTriangle, Sun, BookOpen,
} from 'lucide-react';

/**
 * A student's own attendance report — grouped by subject, exactly like the
 * teacher/admin version, but with nothing to pick: their class is
 * auto-detected server-side (see attendanceReport.service.ts's
 * resolveOwnClassId) and the grid only ever contains their own row. No class
 * dropdown, no other students' data reaches this page at all.
 */

const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00`); x.setDate(x.getDate() + n); return isoDate(x); };
const fmtDate = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const fmtDateLong = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

export const StudentAttendanceReport: React.FC = () => {
  const { user } = useAuth();
  const { selectedYearId, selectedTermId, termsByYear, years } = useAcademicPeriod();
  const yearName = years.find((y) => y.academic_year_id === selectedYearId)?.name;
  const term = selectedYearId != null ? termsByYear[selectedYearId]?.find((t) => t.academic_term_id === selectedTermId) : undefined;

  const [sections, setSections] = useState<ClassSection[]>([]);
  const [sectionKey, setSectionKey] = useState('homeroom');
  const [fromDate, setFromDate] = useState(() => addDays(isoDate(), -13));
  const [toDate, setToDate] = useState(() => isoDate());

  const [report, setReport] = useState<ClassSectionReport | null>(null);
  const [loadingSections, setLoadingSections] = useState(true);
  const [loadingReport, setLoadingReport] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoadingSections(true);
    attendanceReportApi.mySections()
      .then((r) => setSections(r.data ?? [{ kind: 'homeroom' }]))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load your subjects.'))
      .finally(() => setLoadingSections(false));
  }, []);

  const selectedSection = sections.find((s) => (s.kind === 'homeroom' ? 'homeroom' : String(s.subjectId)) === sectionKey);

  const loadReport = React.useCallback(() => {
    if (!selectedSection) return;
    setLoadingReport(true); setError(null);
    attendanceReportApi.myReport({
      sessionType: selectedSection.kind,
      subjectId: selectedSection.kind === 'subject' ? selectedSection.subjectId : undefined,
      from: fromDate || undefined,
      to: toDate || undefined,
    })
      .then((r) => setReport(r.data ?? null))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load your attendance report.'))
      .finally(() => setLoadingReport(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionKey, fromDate, toDate, sections.length]);

  useEffect(() => { loadReport(); }, [loadReport]);

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

  const exportCSV = () => {
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
    link.download = `my-attendance-${report.subjectName || 'homeroom'}-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <DashboardLayout>
      <div className="page-header no-print">
        <div>
          <h1 className="page-title">Attendance Report</h1>
          <p className="page-subtitle">Your attendance record, grouped by subject.</p>
        </div>
        <div className="flex gap-2" style={{ marginTop: '6px' }}>
          <button className="btn btn-outline" onClick={exportCSV} disabled={!me}><Download size={16} /> Export CSV</button>
          <button className="btn btn-primary" onClick={() => window.print()} disabled={!me}><Printer size={16} /> Print / Save PDF</button>
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

        {loadingSections ? null : sections.length > 0 && (
          <div className="ar-subjects">
            {sections.map((sec) => {
              const key = sec.kind === 'homeroom' ? 'homeroom' : String(sec.subjectId);
              return (
                <button
                  key={key}
                  className={`subject-chip${sectionKey === key ? ' is-active' : ''}`}
                  onClick={() => setSectionKey(key)}
                  aria-pressed={sectionKey === key}
                >
                  {sec.kind === 'homeroom' ? <Sun size={12} /> : <BookOpen size={12} />}
                  {sec.kind === 'homeroom' ? 'Homeroom' : sec.subjectName}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {loadingSections || loadingReport ? (
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
              <div><span className="text-xs text-secondary">Subject</span><div className="font-medium">{report.subjectName || 'Homeroom'}</div></div>
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
