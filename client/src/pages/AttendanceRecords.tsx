import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { ErrorState } from '../components/common/ErrorState';
import { apiGet, ApiError } from '../api/client';
import { SearchableSelect } from '../components/common/SearchableSelect';
import { Search, Download, Inbox, ChevronLeft, ChevronRight } from 'lucide-react';

interface AttendanceRecord {
  id: number;
  student_id: string;
  student_name: string;
  class_id: string;
  class_name: string;
  session_date: string;
  period: string;
  status: 'present' | 'absent' | 'late' | 'excused';
  notes: string;
  marked_by: string;
}
interface ClassData { id: string; name: string; }

const STATUS_FILTERS = ['all', 'present', 'absent', 'late', 'excused'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];
const PAGE_SIZE = 50;

export const AttendanceRecords: React.FC = () => {
  // Supports deep-linking a student's history, e.g. from StudentReport's
  // "View full history" link (/attendance/records?search=<studentId>).
  const [searchParams] = useSearchParams();
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [classes, setClasses] = useState<ClassData[]>([]);
  const [selectedClass, setSelectedClass] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [search, setSearch] = useState(() => searchParams.get('search') || '');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiGet<ClassData[]>('/api/mis/classes');
        setClasses(res.data || []);
      } catch (err) { console.error('Error fetching classes:', err); }
    })();
  }, []);

  // Reset to the first page whenever the filters change.
  useEffect(() => { setOffset(0); }, [selectedClass, dateFrom, dateTo, search, statusFilter]);

  const fetchRecords = async () => {
    setLoading(true);
    setError(null);
    try {
      const qp = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (selectedClass) qp.append('classId', selectedClass);
      if (dateFrom) qp.append('dateFrom', dateFrom);
      if (dateTo) qp.append('dateTo', dateTo);
      if (search) qp.append('search', search);
      if (statusFilter !== 'all') qp.append('status', statusFilter);
      const res = await apiGet<AttendanceRecord[]>(`/api/attendance/records?${qp.toString()}`);
      setRecords(res.data || []);
      setTotal(res.total ?? res.data?.length ?? 0);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load attendance records.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const t = setTimeout(fetchRecords, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClass, dateFrom, dateTo, search, statusFilter, offset]);

  const visible = records;

  const exportJSON = () => {
    const blob = new Blob([JSON.stringify(visible, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `attendance-${new Date().toISOString().split('T')[0]}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  // Matches the CSV shape DisciplineRecords exports, so "Export" means the
  // same thing (a CSV you can open in a spreadsheet) across both list pages.
  const exportCSV = () => {
    let csv = 'Student Name,Student ID,Class,Date,Period,Status,Notes\n';
    visible.forEach((r) => {
      csv += `"${r.student_name}",${r.student_id},"${r.class_name}",${r.session_date},${r.period},${r.status},"${(r.notes || '').replace(/"/g, '""')}"\n`;
    });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `attendance-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <DashboardLayout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Attendance History</h1>
          <p className="page-subtitle">Search and filter all recorded sessions.</p>
        </div>
      </div>

      {/* Filter bar */}
      <div className="card card-body mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="input-with-icon" style={{ flex: 1, minWidth: '200px' }}>
            <Search className="field-icon" size={16} />
            <input className="input" placeholder="Search student name or ID…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div style={{ minWidth: '150px' }}>
            <SearchableSelect
              value={selectedClass}
              onChange={(v) => setSelectedClass(v)}
              options={[{ value: '', label: 'All classes' }, ...classes.map((c) => ({ value: c.id, label: c.name }))]}
              placeholder="All classes"
              aria-label="Filter by class"
            />
          </div>
          <input className="input" type="date" style={{ width: 'auto' }} value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          <span className="text-secondary text-sm">to</span>
          <input className="input" type="date" style={{ width: 'auto' }} value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          <button className="btn btn-outline" onClick={exportCSV} disabled={!visible.length}>
            <Download size={16} /> Export CSV
          </button>
          <button className="btn btn-outline" onClick={exportJSON} disabled={!visible.length}>
            <Download size={16} /> Export JSON
          </button>
        </div>

        <div className="flex flex-wrap gap-2 mt-3">
          {STATUS_FILTERS.map((s) => (
            <button key={s} className={`chip capitalize${statusFilter === s ? ' is-active' : ''}`} onClick={() => setStatusFilter(s)}>
              {s}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="mb-4"><ErrorState message={error} onRetry={fetchRecords} /></div>}

      {/* Table */}
      <div className="card">
        {loading ? (
          <div style={{ padding: '48px 0' }}><LoadingSpinner /></div>
        ) : visible.length === 0 ? (
          <div className="empty-state"><Inbox size={28} /><span className="text-sm">No matching records found.</span></div>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table table--zebra">
                <thead>
                  <tr><th>Student</th><th>Class</th><th>Date</th><th>Period</th><th>Status</th><th>Notes</th></tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <div className="font-medium">{r.student_name}</div>
                        <div className="text-xs text-secondary mono">{r.student_id}</div>
                      </td>
                      <td>{r.class_name}</td>
                      <td>{new Date(r.session_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                      <td className="text-secondary">{r.period}</td>
                      <td><span className={`badge badge-${r.status}`}>{r.status}</span></td>
                      <td className={r.notes ? '' : 'text-tertiary'}>{r.notes || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card-footer flex items-center justify-between">
              <span className="text-xs text-secondary">
                {total} record{total !== 1 ? 's' : ''} · page {Math.floor(offset / PAGE_SIZE) + 1} of {Math.max(1, Math.ceil(total / PAGE_SIZE))}
              </span>
              {total > PAGE_SIZE && (
                <div className="flex gap-2">
                  <button className="btn btn-outline btn-sm" disabled={offset === 0} onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}><ChevronLeft size={14} /> Prev</button>
                  <button className="btn btn-outline btn-sm" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset((o) => o + PAGE_SIZE)}>Next <ChevronRight size={14} /></button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </DashboardLayout>
  );
};
