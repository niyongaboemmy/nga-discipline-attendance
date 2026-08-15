import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { Printer, ArrowLeft, AlertCircle } from 'lucide-react';

interface AttendanceRecord { id: number; class_name: string; session_date: string; status: string; }
interface DisciplineRecord { id: number; type: 'demerit' | 'merit'; category: string; severity: string | null; points: number; title: string; incident_date: string; status: string; sanction: string; }

const authHeaders = () => ({ Authorization: `Bearer ${localStorage.getItem('sso_token')}` });

export const StudentReport: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [attendance, setAttendance] = useState<AttendanceRecord[]>([]);
  const [discipline, setDiscipline] = useState<DisciplineRecord[]>([]);
  const [conductScore, setConductScore] = useState(100);
  const [studentName, setStudentName] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true); setError(null);
      try {
        const [aRes, dRes] = await Promise.all([
          fetch(`/api/attendance/student/${id}`, { headers: authHeaders() }),
          fetch(`/api/discipline/student/${id}`, { headers: authHeaders() }),
        ]);
        if (!aRes.ok || !dRes.ok) throw new Error('Could not load the student report.');
        const a = await aRes.json();
        const d = await dRes.json();
        if (a.success) setAttendance(a.data);
        if (d.success) { setDiscipline(d.data.records); setConductScore(d.data.conductScore); }
        const nameFrom = a.data?.[0]?.student_name || d.data?.records?.[0]?.student_name;
        if (nameFrom) setStudentName(nameFrom);
      } catch (err) { setError((err as Error).message); }
      finally { setLoading(false); }
    })();
  }, [id]);

  const total = attendance.length;
  const present = attendance.filter((r) => r.status !== 'absent').length;
  const rate = total ? Math.round((present / total) * 100) : 100;
  const merits = discipline.filter((r) => r.type === 'merit');
  const demerits = discipline.filter((r) => r.type === 'demerit');

  return (
    <DashboardLayout>
      <div className="page-header no-print">
        <div>
          <h1 className="page-title">Student Report</h1>
          <p className="page-subtitle">Combined attendance &amp; conduct summary.</p>
        </div>
        <div className="flex gap-2" style={{ marginTop: '6px' }}>
          <button className="btn btn-outline" onClick={() => navigate(-1)}><ArrowLeft size={16} /> Back</button>
          <button className="btn btn-primary" onClick={() => window.print()} disabled={loading || !!error}><Printer size={16} /> Print / Save PDF</button>
        </div>
      </div>

      {loading ? (
        <div style={{ padding: '64px 0' }}><LoadingSpinner /></div>
      ) : error ? (
        <div className="card"><div className="empty-state"><AlertCircle size={28} /><span className="text-sm">{error}</span></div></div>
      ) : (
        <div className="card card-pad print-area">
          {/* Letterhead */}
          <div className="flex items-center justify-between flex-wrap gap-3" style={{ borderBottom: '2px solid var(--border)', paddingBottom: '16px', marginBottom: '20px' }}>
            <div>
              <div className="text-xl font-bold" style={{ fontFamily: 'var(--font-display)' }}>NGA Discipline &amp; Attendance</div>
              <div className="text-sm text-secondary">Student conduct &amp; attendance summary</div>
            </div>
            <div className="text-right text-xs text-secondary">
              <div>Generated {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</div>
            </div>
          </div>

          <div className="flex items-baseline justify-between flex-wrap gap-2 mb-4">
            <div>
              <div className="text-lg font-semibold">{studentName || 'Student'}</div>
              <div className="text-xs text-secondary mono">{id}</div>
            </div>
          </div>

          {/* Headline metrics */}
          <div className="grid grid-stats mb-6" style={{ gap: '12px' }}>
            {[
              ['Attendance rate', `${rate}%`, rate >= 80 ? 'text-success' : 'text-danger'],
              ['Sessions recorded', total, 'text-primary'],
              ['Conduct score', `${conductScore}/100`, conductScore >= 85 ? 'text-success' : conductScore >= 70 ? 'text-warning' : 'text-danger'],
              ['Merits / Demerits', `${merits.length} / ${demerits.length}`, 'text-primary'],
            ].map(([l, v, cls]) => (
              <div key={l as string}>
                <div className={`text-2xl font-bold ${cls}`}>{v as React.ReactNode}</div>
                <div className="text-xs text-secondary">{l as string}</div>
              </div>
            ))}
          </div>

          {/* Conduct records */}
          <span className="section-title">Conduct records</span>
          {discipline.length === 0 ? (
            <p className="text-sm text-secondary mt-2 mb-4">No conduct records.</p>
          ) : (
            <div className="table-wrap mt-2 mb-5">
              <table className="table table--zebra">
                <thead><tr><th>Date</th><th>Type</th><th>Category</th><th>Title</th><th>Points</th><th>Sanction</th></tr></thead>
                <tbody>
                  {discipline.map((r) => (
                    <tr key={r.id}>
                      <td>{r.incident_date}</td>
                      <td className="capitalize">{r.type}</td>
                      <td>{r.category}{r.severity ? ` (${r.severity})` : ''}</td>
                      <td>{r.title}</td>
                      <td>{r.type === 'merit' ? '+' : '−'}{r.points}</td>
                      <td className={r.sanction === 'none' ? 'text-tertiary' : ''}>{r.sanction === 'none' ? '—' : r.sanction}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Recent attendance */}
          <span className="section-title">Recent attendance</span>
          {attendance.length === 0 ? (
            <p className="text-sm text-secondary mt-2">No attendance records.</p>
          ) : (
            <div className="table-wrap mt-2">
              <table className="table table--zebra">
                <thead><tr><th>Date</th><th>Class</th><th>Status</th></tr></thead>
                <tbody>
                  {attendance.slice(0, 20).map((r) => (
                    <tr key={r.id}>
                      <td>{r.session_date}</td>
                      <td>{r.class_name}</td>
                      <td><span className={`badge badge-${r.status}`}>{r.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex justify-between mt-6" style={{ paddingTop: '24px' }}>
            <div className="text-xs text-secondary">Signature: _______________________</div>
            <div className="text-xs text-secondary">Date: _______________</div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
};
