import React, { useState, useEffect } from 'react';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { AlertTriangle } from 'lucide-react';

interface AttendanceRecord {
  id: number;
  class_name: string;
  session_date: string;
  period: string;
  status: 'present' | 'absent' | 'late' | 'excused';
  notes: string;
}

export const MyAttendance: React.FC = () => {
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/attendance/me', { headers: { Authorization: `Bearer ${localStorage.getItem('sso_token')}` } });
        if (res.ok) { const result = await res.json(); if (result.success) setRecords(result.data); }
      } catch (err) { console.error('Error fetching attendance:', err); }
      finally { setLoading(false); }
    })();
  }, []);

  const total = records.length;
  const present = records.filter((r) => r.status === 'present').length;
  const late = records.filter((r) => r.status === 'late').length;
  const excused = records.filter((r) => r.status === 'excused').length;
  const absent = records.filter((r) => r.status === 'absent').length;
  const rate = total > 0 ? Math.round(((present + late + excused) / total) * 100) : 100;
  const isLow = rate < 80;

  const segs = [
    { n: present, c: 'var(--success)' }, { n: late, c: 'var(--warning)' },
    { n: excused, c: 'var(--info)' }, { n: absent, c: 'var(--danger)' },
  ].filter((s) => s.n > 0);

  return (
    <DashboardLayout>
      <div className="page-header">
        <div>
          <h1 className="page-title">My Attendance</h1>
          <p className="page-subtitle">Your presence across all enrolled classes.</p>
        </div>
        <span className="text-sm text-secondary" style={{ marginTop: '6px' }}>{total} sessions recorded</span>
      </div>

      {loading ? (
        <div style={{ padding: '80px 0' }}><LoadingSpinner /></div>
      ) : (
        <>
          {/* Summary */}
          <div className="card card-pad mb-4">
            <div className="flex items-center justify-between flex-wrap gap-4 mb-4">
              <div className="flex items-end gap-2">
                <span style={{ fontSize: '36px', fontWeight: 700, letterSpacing: '-0.03em', lineHeight: 1, color: isLow ? 'var(--danger)' : 'var(--success)' }}>{rate}%</span>
                <span className="text-secondary text-sm mb-1">presence rate</span>
              </div>
              <span className={`badge ${isLow ? 'badge-danger' : 'badge-success'}`}>{isLow ? 'Below minimum' : 'Good standing'}</span>
            </div>
            {segs.length > 0 && (
              <div className="flex mb-4" style={{ height: '10px', gap: '2px', borderRadius: 'var(--radius-full)', overflow: 'hidden' }}>
                {segs.map((s, i) => <div key={i} style={{ flex: s.n, background: s.c }} />)}
              </div>
            )}
            <div className="grid grid-stats" style={{ gap: '12px' }}>
              {[['Present', present, 'text-success'], ['Late', late, 'text-warning'], ['Excused', excused, 'text-info'], ['Absent', absent, 'text-danger']].map(([l, v, cls]) => (
                <div key={l as string}>
                  <div className={`text-2xl font-bold ${cls}`}>{v as number}</div>
                  <div className="text-xs text-secondary">{l as string}</div>
                </div>
              ))}
            </div>
          </div>

          {isLow && (
            <div className="alert alert-danger mb-4">
              <AlertTriangle size={16} />
              <span>Your presence rate is below the 80% minimum. Please contact your instructor.</span>
            </div>
          )}

          {/* History */}
          <div className="card">
            <div className="card-header"><span className="section-title">Session history</span></div>
            {records.length === 0 ? (
              <div className="empty-state">No attendance records yet.</div>
            ) : (
              <div className="table-wrap">
                <table className="table table--zebra">
                  <thead>
                    <tr><th>Class</th><th>Date</th><th>Period</th><th>Status</th><th>Notes</th></tr>
                  </thead>
                  <tbody>
                    {records.map((r) => (
                      <tr key={r.id}>
                        <td className="font-medium">{r.class_name}</td>
                        <td>{new Date(r.session_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                        <td className="text-secondary">{r.period}</td>
                        <td><span className={`badge badge-${r.status}`}>{r.status}</span></td>
                        <td className={r.notes ? '' : 'text-tertiary'}>{r.notes || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </DashboardLayout>
  );
};
