import React, { useEffect, useMemo, useState } from 'react';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { ErrorState } from '../components/common/ErrorState';
import { SearchableSelect } from '../components/common/SearchableSelect';
import { useAuth } from '../context/AuthContext';
import { useAcademicPeriod } from '../context/AcademicPeriodContext';
import { ApiError } from '../api/client';
import {
  attendanceReportApi, type ReportableClass, type ClassSection, type ClassSectionReport,
} from '../api/attendanceReport';
import { isoDate } from '../utils/time';
import {
  Printer, Download, Users, TrendingUp, AlertTriangle, Search, ArrowUpDown,
  CheckCircle2, ThumbsUp, AlertCircle, XCircle, Sun, BookOpen,
} from 'lucide-react';

/** Excellent/Good/Fair/Poor -> the same semantic tokens used everywhere else
 *  in the app (success/info/warning/danger) rather than a new palette. */
const COMMENT_META: Record<ClassSectionReport['students'][number]['comment'], { color: string; icon: React.ReactNode }> = {
  Excellent: { color: 'var(--success)', icon: <CheckCircle2 size={12} /> },
  Good: { color: 'var(--info)', icon: <ThumbsUp size={12} /> },
  Fair: { color: 'var(--warning)', icon: <AlertCircle size={12} /> },
  Poor: { color: 'var(--danger)', icon: <XCircle size={12} /> },
};
const COMMENT_BADGE: Record<string, string> = { Excellent: 'badge-success', Good: 'badge-info', Fair: 'badge-warning', Poor: 'badge-danger' };

const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00`); x.setDate(x.getDate() + n); return isoDate(x); };
const fmtDate = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const fmtDateLong = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

/** Horizontal bar chart of per-student attendance rate, sorted worst-first so
 *  whoever needs attention is immediately visible. Colored by comment tier
 *  (a status palette, not a categorical one) with an icon+label legend, per
 *  the app's existing StatusChip convention — color never carries meaning alone. */
const RateChart: React.FC<{ students: ClassSectionReport['students'] }> = ({ students }) => {
  const sorted = useMemo(() => [...students].sort((a, b) => a.rate - b.rate), [students]);
  if (sorted.length === 0) return null;
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
        {sorted.map((s) => (
          <div className="ar-chart-row" key={s.studentId} title={`${s.studentName}: ${s.rate}% (${s.present} present, ${s.absent} absent, ${s.late} late, ${s.excused} excused)`}>
            <span className="ar-chart-name">{s.studentName}</span>
            <div className="ar-chart-track">
              <div className="ar-chart-fill" style={{ width: `${s.rate}%`, background: COMMENT_META[s.comment].color }} />
            </div>
            <span className="ar-chart-value">{s.rate}%</span>
          </div>
        ))}
      </div>
    </div>
  );
};

type SortKey = 'name' | 'rate';

export const AttendanceReport: React.FC = () => {
  const { user } = useAuth();
  const { selectedYearId, selectedTermId, termsByYear, years } = useAcademicPeriod();
  const yearName = years.find((y) => y.academic_year_id === selectedYearId)?.name;

  const [classes, setClasses] = useState<ReportableClass[]>([]);
  const [classId, setClassId] = useState('');
  const [sections, setSections] = useState<ClassSection[]>([]);
  const [sectionKey, setSectionKey] = useState<string>('homeroom');

  const term = selectedYearId != null ? termsByYear[selectedYearId]?.find((t) => t.academic_term_id === selectedTermId) : undefined;
  const [fromDate, setFromDate] = useState(() => addDays(isoDate(), -13));
  const [toDate, setToDate] = useState(() => isoDate());

  const [report, setReport] = useState<ClassSectionReport | null>(null);
  const [loadingClasses, setLoadingClasses] = useState(true);
  const [loadingReport, setLoadingReport] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<1 | -1>(1);

  useEffect(() => {
    setLoadingClasses(true);
    attendanceReportApi.classes()
      .then((r) => setClasses(r.data ?? []))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load classes.'))
      .finally(() => setLoadingClasses(false));
  }, []);

  useEffect(() => {
    if (!classId) { setSections([]); return; }
    setSectionKey('homeroom');
    attendanceReportApi.sections(classId)
      .then((r) => setSections(r.data ?? [{ kind: 'homeroom' }]))
      .catch(() => setSections([{ kind: 'homeroom' }]));
  }, [classId]);

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

  const useFullTerm = () => {
    if (term?.start_date) setFromDate(term.start_date.slice(0, 10));
    if (term?.end_date) setToDate(term.end_date.slice(0, 10));
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

  const totals = useMemo(() => {
    if (!report) return null;
    return report.students.reduce(
      (acc, s) => ({
        present: acc.present + s.present, absent: acc.absent + s.absent,
        late: acc.late + s.late, excused: acc.excused + s.excused,
        atRisk: acc.atRisk + (s.rate < 80 ? 1 : 0),
      }),
      { present: 0, absent: 0, late: 0, excused: 0, atRisk: 0 }
    );
  }, [report]);

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

  return (
    <DashboardLayout>
      <div className="page-header no-print">
        <div>
          <h1 className="page-title">Attendance Report</h1>
          <p className="page-subtitle">Class register, grouped by subject — grade, print, or export.</p>
        </div>
        <div className="flex gap-2" style={{ marginTop: '6px' }}>
          <button className="btn btn-outline" onClick={exportCSV} disabled={!report}><Download size={16} /> Export CSV</button>
          <button className="btn btn-primary" onClick={() => window.print()} disabled={!report}><Printer size={16} /> Print / Save PDF</button>
        </div>
      </div>

      <div className="card card-pad no-print ar-filterbar">
        <div className="ar-filter-row">
          <div className="ar-filter-field">
            <label className="ar-filter-label">Class</label>
            <SearchableSelect
              options={classOptions}
              value={classId}
              onChange={setClassId}
              placeholder={loadingClasses ? 'Loading classes…' : 'Select a class…'}
              disabled={loadingClasses}
              aria-label="Class"
            />
          </div>
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

        {sections.length > 0 && (
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

      {loadingReport ? (
        <div style={{ padding: '48px 0' }}><LoadingSpinner /></div>
      ) : error ? (
        <ErrorState message={error} onRetry={loadReport} />
      ) : !report ? (
        <div className="empty-state no-print" style={{ marginTop: '16px' }}>
          {classId ? 'No attendance recorded for this class/section in the selected range.' : 'Pick a class to build its attendance report.'}
        </div>
      ) : (
        <>
          <div className="grid grid-3 mb-6 no-print">
            <div className="stat-card" style={{ ['--accent-color' as string]: 'var(--primary)' }}>
              <div className="flex items-center justify-between">
                <span className="stat-label">Class Average</span><span className="stat-icon"><TrendingUp size={18} /></span>
              </div>
              <div className="stat-value">{report.classAverageRate}%</div>
            </div>
            <div className="stat-card" style={{ ['--accent-color' as string]: 'var(--info)' }}>
              <div className="flex items-center justify-between">
                <span className="stat-label">Students Tracked</span><span className="stat-icon"><Users size={18} /></span>
              </div>
              <div className="stat-value">{report.students.length}</div>
            </div>
            <div className="stat-card" style={{ ['--accent-color' as string]: 'var(--danger)' }}>
              <div className="flex items-center justify-between">
                <span className="stat-label">Below 80% (at risk)</span><span className="stat-icon"><AlertTriangle size={18} /></span>
              </div>
              <div className="stat-value">{totals?.atRisk ?? 0}</div>
            </div>
          </div>

          <div className="card card-pad print-area">
            {/* Letterhead */}
            <div className="ar-letterhead">
              <div>
                <div className="text-xl font-bold" style={{ fontFamily: 'var(--font-display)' }}>Tendo</div>
                <div className="text-sm text-secondary">Class attendance record</div>
              </div>
              <div className="text-right text-xs text-secondary">
                <div>Generated {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</div>
                {fromDate && toDate && <div>{fmtDateLong(fromDate)} – {fmtDateLong(toDate)}</div>}
              </div>
            </div>

            <div className="ar-meta-grid">
              <div><span className="text-xs text-secondary">Academic Year</span><div className="font-medium">{yearName || '—'}</div></div>
              <div><span className="text-xs text-secondary">Term</span><div className="font-medium">{term?.name || '—'}</div></div>
              <div><span className="text-xs text-secondary">Class</span><div className="font-medium">{report.className}</div></div>
              <div><span className="text-xs text-secondary">Subject</span><div className="font-medium">{report.subjectName || 'Homeroom'}</div></div>
              <div><span className="text-xs text-secondary">Teacher</span><div className="font-medium">{report.teacherName || '—'}</div></div>
            </div>

            <RateChart students={report.students} />

            <div className="flex items-center gap-2 mb-2 no-print">
              <div className="ar-search">
                <Search size={13} />
                <input
                  type="text" placeholder="Search students…" value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
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
                          ? 'No attendance recorded for this class/section in the selected date range.'
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
      )}
    </DashboardLayout>
  );
};

export default AttendanceReport;
