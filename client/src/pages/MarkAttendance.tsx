import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { Save, AlertCircle, CheckCircle2, XCircle, Clock, ShieldCheck } from 'lucide-react';
import './MarkAttendance.css';

interface ClassData { id: string; name: string; department: string; }
interface Student { id: string; name: string; email: string; }
type Status = 'present' | 'absent' | 'late' | 'excused';
interface AttendanceState { studentId: string; studentName: string; status: Status; notes: string; }

const STATUSES: { key: Status; label: string; icon: React.ReactNode }[] = [
  { key: 'present', label: 'Present', icon: <CheckCircle2 size={14} /> },
  { key: 'late', label: 'Late', icon: <Clock size={14} /> },
  { key: 'absent', label: 'Absent', icon: <XCircle size={14} /> },
  { key: 'excused', label: 'Excused', icon: <ShieldCheck size={14} /> },
];

const initials = (name: string) => name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2);

export const MarkAttendance: React.FC = () => {
  const navigate = useNavigate();
  const [classes, setClasses] = useState<ClassData[]>([]);
  const [selectedClass, setSelectedClass] = useState('');
  const [students, setStudents] = useState<Student[]>([]);
  const [attendance, setAttendance] = useState<Record<string, AttendanceState>>({});
  const [sessionDate, setSessionDate] = useState(new Date().toISOString().split('T')[0]);
  const [period, setPeriod] = useState('Morning');
  const [loadingClasses, setLoadingClasses] = useState(true);
  const [loadingStudents, setLoadingStudents] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/mis/classes', { headers: { Authorization: `Bearer ${localStorage.getItem('sso_token')}` } });
        if (res.ok) {
          const result = await res.json();
          if (result.success) {
            setClasses(result.data);
            if (result.data.length) setSelectedClass(result.data[0].id);
          }
        }
      } catch (err) { console.error('Error fetching classes:', err); }
      finally { setLoadingClasses(false); }
    })();
  }, []);

  useEffect(() => {
    if (!selectedClass) return;
    (async () => {
      setLoadingStudents(true);
      setMessage(null);
      try {
        const res = await fetch(`/api/mis/students?class_id=${selectedClass}`, { headers: { Authorization: `Bearer ${localStorage.getItem('sso_token')}` } });
        if (res.ok) {
          const result = await res.json();
          if (result.success) {
            setStudents(result.data);
            const initial: Record<string, AttendanceState> = {};
            result.data.forEach((s: Student) => { initial[s.id] = { studentId: s.id, studentName: s.name, status: 'present', notes: '' }; });
            setAttendance(initial);
          }
        }
      } catch (err) { console.error('Error fetching students:', err); }
      finally { setLoadingStudents(false); }
    })();
  }, [selectedClass]);

  const setStatus = (id: string, status: Status) =>
    setAttendance((p) => ({ ...p, [id]: { ...p[id], status } }));
  const setNote = (id: string, notes: string) =>
    setAttendance((p) => ({ ...p, [id]: { ...p[id], notes } }));
  const markAll = (status: Status) =>
    setAttendance((p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { ...v, status }])));

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedClass || !students.length) return;
    setSaving(true); setMessage(null);
    const activeClass = classes.find((c) => c.id === selectedClass);
    try {
      const res = await fetch('/api/attendance/mark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('sso_token')}` },
        body: JSON.stringify({
          classId: selectedClass, className: activeClass?.name ?? 'Unknown Class',
          date: sessionDate, period, records: Object.values(attendance),
        }),
      });
      const result = await res.json();
      if (res.ok && result.success) {
        setMessage({ type: 'success', text: 'Attendance recorded successfully.' });
        setTimeout(() => navigate('/dashboard'), 1200);
      } else {
        setMessage({ type: 'error', text: result.message || 'Failed to submit attendance.' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Network error. Could not reach the server.' });
    } finally { setSaving(false); }
  };

  if (loadingClasses) {
    return <DashboardLayout><div style={{ padding: '80px 0' }}><LoadingSpinner /></div></DashboardLayout>;
  }

  const markedCount = Object.keys(attendance).length;

  return (
    <DashboardLayout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Mark Attendance</h1>
          <p className="page-subtitle">Select a session, then record each student’s status.</p>
        </div>
      </div>

      <div className="mark-grid">
        {/* Left: session config */}
        <aside className="card card-pad mark-config">
          <span className="section-title">Session</span>
          <div className="field mt-4">
            <label className="label">Class</label>
            <select className="select" value={selectedClass} onChange={(e) => setSelectedClass(e.target.value)}>
              {classes.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.department})</option>)}
            </select>
          </div>
          <div className="field mt-3">
            <label className="label">Date</label>
            <input className="input" type="date" value={sessionDate} max={new Date().toISOString().split('T')[0]} onChange={(e) => setSessionDate(e.target.value)} />
          </div>
          <div className="field mt-3">
            <label className="label">Period</label>
            <select className="select" value={period} onChange={(e) => setPeriod(e.target.value)}>
              <option value="Morning">Morning Session</option>
              <option value="Afternoon">Afternoon Session</option>
              <option value="Evening">Evening Session</option>
            </select>
          </div>

          <div className="nav-divider" style={{ margin: '20px 0' }} />
          <span className="label">Mark all as</span>
          <div className="flex flex-wrap gap-2 mt-2">
            <button type="button" className="chip" onClick={() => markAll('present')}>Present</button>
            <button type="button" className="chip" onClick={() => markAll('late')}>Late</button>
            <button type="button" className="chip" onClick={() => markAll('absent')}>Absent</button>
            <button type="button" className="chip" onClick={() => markAll('excused')}>Excused</button>
          </div>

          {message && (
            <div className={`alert mt-4 ${message.type === 'success' ? 'alert-success' : 'alert-danger'}`}>
              <AlertCircle size={16} /> <span>{message.text}</span>
            </div>
          )}
        </aside>

        {/* Right: student list */}
        <section className="card mark-list">
          <div className="card-header">
            <span className="section-title">Students {students.length > 0 && `(${students.length})`}</span>
          </div>

          <div className="mark-list-body">
            {loadingStudents ? (
              <div style={{ padding: '48px 0' }}><LoadingSpinner /></div>
            ) : students.length === 0 ? (
              <div className="empty-state">No students registered for this class.</div>
            ) : (
              students.map((s) => {
                const rec = attendance[s.id];
                return (
                  <div key={s.id} className="mark-row">
                    <div className="flex items-center gap-3" style={{ minWidth: 0 }}>
                      <div className="avatar avatar-square">{initials(s.name)}</div>
                      <div style={{ minWidth: 0 }}>
                        <div className="text-sm font-semibold truncate">{s.name}</div>
                        <div className="text-xs text-secondary mono truncate">{s.id}</div>
                      </div>
                    </div>
                    <div className="segmented mark-segmented">
                      {STATUSES.map((st) => (
                        <button
                          key={st.key}
                          type="button"
                          onClick={() => setStatus(s.id, st.key)}
                          className={`segmented-btn is-${st.key}${rec?.status === st.key ? ' is-active' : ''}`}
                        >
                          {st.icon}<span className="hide-mobile">{st.label}</span>
                        </button>
                      ))}
                    </div>
                    <input
                      className="input mark-note"
                      placeholder="Note…"
                      value={rec?.notes ?? ''}
                      onChange={(e) => setNote(s.id, e.target.value)}
                    />
                  </div>
                );
              })
            )}
          </div>

          {students.length > 0 && (
            <div className="mark-footer">
              <span className="text-sm text-secondary">{markedCount} of {students.length} marked</span>
              <div className="flex gap-2">
                <button type="button" className="btn btn-outline" onClick={() => navigate('/dashboard')}>Cancel</button>
                <button type="button" className="btn btn-primary" disabled={saving} onClick={handleSave}>
                  <Save size={16} /> {saving ? 'Saving…' : 'Save session'}
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </DashboardLayout>
  );
};
