import React, { useState, useEffect } from 'react';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { Clock, Play, Square } from 'lucide-react';

interface StaffLog {
  id: number;
  staff_id: string;
  staff_name: string;
  date: string;
  clock_in: string;
  clock_out: string | null;
  status: 'present' | 'absent' | 'late';
}

const fmtTime = (t: string | null) =>
  t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';

export const StaffAttendance: React.FC = () => {
  const { user } = useAuth();
  const toast = useToast();
  const [logs, setLogs] = useState<StaffLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [clockStatus, setClockStatus] = useState<{ clockedIn: boolean; clockInTime?: string; clockedOut: boolean } | null>(null);

  const fetchLogs = async () => {
    setLoading(true);
    try {
      const headers = { Authorization: `Bearer ${localStorage.getItem('sso_token')}` };
      const url = user?.role === 'admin' ? '/api/staff/attendance' : '/api/staff/attendance/me';
      const res = await fetch(url, { headers });
      if (res.ok) {
        const result = await res.json();
        if (result.success) {
          setLogs(result.data);
          const todayStr = new Date().toISOString().split('T')[0];
          const todayRecord = result.data.find((r: StaffLog) => r.date === todayStr && r.staff_id === user?.id);
          setClockStatus(todayRecord
            ? { clockedIn: true, clockInTime: todayRecord.clock_in, clockedOut: !!todayRecord.clock_out }
            : { clockedIn: false, clockedOut: false });
        }
      }
    } catch (err) { console.error('Error fetching staff logs:', err); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchLogs(); /* eslint-disable-next-line */ }, [user]);

  const clock = async (path: string) => {
    try {
      const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('sso_token')}` } });
      const result = await res.json();
      if (result.success) {
        await fetchLogs();
        toast.success(path.includes('clock-in') ? 'Clocked in' : 'Clocked out');
      } else {
        toast.error('Could not record', result.message);
      }
    } catch (err) {
      console.error('Clock error:', err);
      toast.error('Network error', 'Could not reach the server.');
    }
  };

  return (
    <DashboardLayout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Staff Attendance</h1>
          <p className="page-subtitle">{user?.role === 'admin' ? 'Review all staff clock-ins and clock-outs.' : 'Clock in for your shift and view your logs.'}</p>
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
            <button className="btn btn-primary" onClick={() => clock('/api/staff/clock-in')}><Play size={16} /> Clock in</button>
          ) : !clockStatus.clockedOut ? (
            <button className="btn btn-danger" onClick={() => clock('/api/staff/clock-out')}><Square size={16} /> Clock out</button>
          ) : (
            <span className="badge badge-success">Duty completed today</span>
          )}
        </div>
      )}

      {/* Logs */}
      <div className="card">
        <div className="card-header">
          <span className="section-title">{user?.role === 'admin' ? 'All staff logs' : 'My shift history'}</span>
        </div>
        {loading ? (
          <div style={{ padding: '48px 0' }}><LoadingSpinner /></div>
        ) : logs.length === 0 ? (
          <div className="empty-state">No logs recorded yet.</div>
        ) : (
          <div className="table-wrap">
            <table className="table table--zebra">
              <thead>
                <tr>
                  {user?.role === 'admin' && <th>Staff member</th>}
                  <th>Date</th><th>Clock in</th><th>Clock out</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id}>
                    {user?.role === 'admin' && (
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
