import React, { useState, useEffect, useMemo } from 'react';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { useAuth } from '../context/AuthContext';
import { usePermissions } from '../hooks/usePermissions';
import { useToast } from '../context/ToastContext';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { ErrorState } from '../components/common/ErrorState';
import { apiGet, apiPost, ApiError } from '../api/client';
import { Clock, Play, Square, Search } from 'lucide-react';

interface StaffLog {
  id: number;
  staff_id: string;
  staff_name: string;
  date: string;
  clock_in: string;
  clock_out: string | null;
  status: 'present' | 'absent' | 'late';
  staff_type: 'teacher' | 'other';
}

const STATUS_FILTERS = ['all', 'present', 'late', 'absent'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

const fmtTime = (t: string | null) =>
  t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';

export const StaffAttendance: React.FC = () => {
  const { user } = useAuth();
  const { can } = usePermissions();
  // Remediation X2: gate the all-staff view on the permission, not a hard-coded
  // role string — a custom role with STAFF_ATTENDANCE_VIEW_ALL couldn't see it.
  const canViewAll = can('STAFF_ATTENDANCE_VIEW_ALL');
  const toast = useToast();
  const [logs, setLogs] = useState<StaffLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [clockStatus, setClockStatus] = useState<{ clockedIn: boolean; clockInTime?: string; clockedOut: boolean } | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const fetchLogs = async () => {
    setLoading(true);
    setError(null);
    try {
      const path = canViewAll ? '/api/staff/attendance' : '/api/staff/attendance/me';
      const res = await apiGet<StaffLog[]>(path);
      const data = res.data || [];
      setLogs(data);
      const todayStr = new Date().toISOString().split('T')[0];
      const todayRecord = data.find((r) => r.date === todayStr && r.staff_id === user?.id);
      setClockStatus(todayRecord
        ? { clockedIn: true, clockInTime: todayRecord.clock_in, clockedOut: !!todayRecord.clock_out }
        : { clockedIn: false, clockedOut: false });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load staff attendance logs.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchLogs(); /* eslint-disable-next-line */ }, [user]);

  const clock = async (path: string) => {
    try {
      await apiPost(path);
      await fetchLogs();
      toast.success(path.includes('clock-in') ? 'Clocked in' : 'Clocked out');
    } catch (err) {
      toast.error('Could not record', err instanceof ApiError ? err.message : 'Network error. Could not reach the server.');
    }
  };

  // Admin's "all staff logs" view is the only admin list page with no
  // filters today — the backend doesn't support server-side query params
  // for this endpoint, so filtering happens client-side over the loaded page.
  const visibleLogs = useMemo(() => {
    return logs.filter((log) => {
      if (statusFilter !== 'all' && log.status !== statusFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!log.staff_name.toLowerCase().includes(q) && !log.staff_id.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [logs, search, statusFilter]);

  return (
    <DashboardLayout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Staff Attendance</h1>
          <p className="page-subtitle">{canViewAll ? 'Review all staff clock-ins and clock-outs.' : 'Clock in for your shift and view your logs.'}</p>
        </div>
      </div>

      {/* Clock widget */}
      {clockStatus && (
        <div className="card card-pad mb-4 flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-3">
            <div className="login-role-icon tone-brand"><Clock size={18} /></div>
            <div>
              <div className="section-title">Shift duty clock</div>
              <p className="text-sm text-secondary mt-1">
                {!clockStatus.clockedIn ? 'Shift not started. Clock in when your duty begins.'
                  : clockStatus.clockedOut ? 'Workday completed. Your logs are recorded.'
                  : `Active shift — clocked in at ${fmtTime(clockStatus.clockInTime!)}`}
              </p>
            </div>
          </div>
          {!clockStatus.clockedIn ? (
            <button className="btn btn-primary" onClick={() => clock('/api/staff/clock-in')} data-track="tendo.staff.clock_in"><Play size={16} /> Clock in</button>
          ) : !clockStatus.clockedOut ? (
            <button className="btn btn-danger" onClick={() => clock('/api/staff/clock-out')} data-track="tendo.staff.clock_out"><Square size={16} /> Clock out</button>
          ) : (
            <span className="badge badge-success">Duty completed today</span>
          )}
        </div>
      )}

      {error && <div className="mb-4"><ErrorState message={error} onRetry={fetchLogs} /></div>}

      {canViewAll && (
        <div className="card card-body mb-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="input-with-icon" style={{ flex: 1, minWidth: '200px' }}>
              <Search className="field-icon" size={16} />
              <input className="input" placeholder="Search staff name or ID…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </div>
          <div className="flex flex-wrap gap-2 mt-3">
            {STATUS_FILTERS.map((s) => (
              <button key={s} className={`chip capitalize${statusFilter === s ? ' is-active' : ''}`} onClick={() => setStatusFilter(s)}>
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Logs */}
      <div className="card">
        <div className="card-header">
          <span className="section-title">{canViewAll ? 'All staff logs' : 'My shift history'}</span>
          {canViewAll && <span className="text-xs text-secondary">{visibleLogs.length} of {logs.length}</span>}
        </div>
        {loading ? (
          <div style={{ padding: '48px 0' }}><LoadingSpinner /></div>
        ) : visibleLogs.length === 0 ? (
          <div className="empty-state">No logs {logs.length ? 'match your filters' : 'recorded yet'}.</div>
        ) : (
          <div className="table-wrap">
            <table className="table table--zebra">
              <thead>
                <tr>
                  {canViewAll && <th>Staff member</th>}
                  <th>Date</th><th>Clock in</th><th>Clock out</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {visibleLogs.map((log) => (
                  <tr key={log.id}>
                    {canViewAll && (
                      <td>
                        <div className="font-medium">{log.staff_name}</div>
                        <div className="text-xs text-secondary mono">{log.staff_id}</div>
                      </td>
                    )}
                    <td className="font-medium">{new Date(log.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                    <td>{fmtTime(log.clock_in)}</td>
                    <td>{fmtTime(log.clock_out)}</td>
                    <td><span className={`badge badge-${log.status}`}>{log.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
};
