import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { usePermissions } from '../hooks/usePermissions';
import { Save, AlertCircle, CheckCircle2, XCircle, Clock, ShieldCheck, RotateCcw } from 'lucide-react';
import { apiGet, apiPost, ApiError } from '../api/client';
import { SearchableSelect } from '../components/common/SearchableSelect';
import './MarkAttendance.css';

interface ClassData { id: string; name: string; department: string; }
interface Student { id: string; name: string; email: string; }
interface Subject { id: number; name: string; code: string | null; }
type Status = 'present' | 'absent' | 'late' | 'excused';
type SessionType = 'homeroom' | 'subject';
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
  const { can } = usePermissions();
  const [classes, setClasses] = useState<ClassData[]>([]);
  const [selectedClass, setSelectedClass] = useState('');
  const [students, setStudents] = useState<Student[]>([]);
  const [attendance, setAttendance] = useState<Record<string, AttendanceState>>({});
  const [sessionDate, setSessionDate] = useState(new Date().toISOString().split('T')[0]);
  const [period, setPeriod] = useState('Morning');
  // A.1.1 vs A.1.2: homeroom is the class-group's overall daily attendance;
  // subject requires picking which course session this is.
  const [sessionType, setSessionType] = useState<SessionType>('homeroom');
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [loadingSubjects, setLoadingSubjects] = useState(false);
  const [subjectId, setSubjectId] = useState<number | ''>('');
  const [loadingClasses, setLoadingClasses] = useState(true);
  const [loadingStudents, setLoadingStudents] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiGet<ClassData[]>('/api/mis/classes');
        setClasses(res.data || []);
        if (res.data?.length) setSelectedClass(res.data[0].id);
      } catch (err) { console.error('Error fetching classes:', err); }
      finally { setLoadingClasses(false); }
    })();

  }, []);

  // Subjects are scoped to the selected class group's grade curriculum, so
  // you can't file e.g. "Advanced Database" against a primary class. Falls
  // back to the full cached list only if the MIS can't answer, so the picker
  // is never empty for reasons the user can't see.
  useEffect(() => {
    if (!selectedClass) { setSubjects([]); return; }
    let cancelled = false;
    (async () => {
      setLoadingSubjects(true);
      try {
        const res = await apiGet<Subject[]>(`/api/mis/class-subjects?class_id=${selectedClass}`);
        if (!cancelled) setSubjects(res.data || []);
      } catch (err) {
        console.error('Error fetching class subjects:', err);
        try {
          const all = await apiGet<Subject[]>('/api/academics/subjects');
          if (!cancelled) setSubjects(all.data || []);
        } catch { if (!cancelled) setSubjects([]); }
      } finally {
        if (!cancelled) setLoadingSubjects(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedClass]);

  // Changing class can invalidate an already-picked subject.
  useEffect(() => {
    if (subjectId !== '' && !subjects.some((s) => s.id === subjectId)) setSubjectId('');
  }, [subjects, subjectId]);

  const resetRoster = (list: Student[]) => {
    const initial: Record<string, AttendanceState> = {};
    list.forEach((s) => { initial[s.id] = { studentId: s.id, studentName: s.name, status: 'present', notes: '' }; });
    setAttendance(initial);
  };

  useEffect(() => {
    if (!selectedClass) return;
    (async () => {
      setLoadingStudents(true);
      setMessage(null);
      try {
        const res = await apiGet<Student[]>(`/api/mis/students?class_id=${selectedClass}`);
        setStudents(res.data || []);
        resetRoster(res.data || []);
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

  /** `andContinue`: after saving, either navigate away (the old only option)
   *  or stay on the page with the roster reset for another period — a
   *  teacher marking several periods back-to-back no longer has to
   *  re-select the class from scratch each time. */
  const handleSave = async (andContinue: boolean) => {
    if (!selectedClass || !students.length) return;
    if (sessionType === 'subject' && !subjectId) {
      setMessage({ type: 'error', text: 'Select a subject for course attendance.' });
      return;
    }
    setSaving(true); setMessage(null);
    const activeClass = classes.find((c) => c.id === selectedClass);
    try {
      await apiPost('/api/attendance/mark', {
        classId: selectedClass, className: activeClass?.name ?? 'Unknown Class',
        date: sessionDate, period, records: Object.values(attendance),
        sessionType, subjectId: sessionType === 'subject' ? subjectId : null,
      });
      if (andContinue) {
        setMessage({ type: 'success', text: 'Saved. Roster reset — ready for the next period.' });
        resetRoster(students);
      } else {
        setMessage({ type: 'success', text: 'Attendance recorded successfully.' });
        setTimeout(() => navigate('/dashboard'), 1200);
      }
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof ApiError ? err.message : 'Network error. Could not reach the server.' });
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
            <label className="label">Session type</label>
            <div className="segmented">
              <button
                type="button"
                onClick={() => setSessionType('homeroom')}
                className={`segmented-btn${sessionType === 'homeroom' ? ' is-active' : ''}`}
              >
                Homeroom (overall)
              </button>
              <button
                type="button"
                onClick={() => setSessionType('subject')}
                className={`segmented-btn${sessionType === 'subject' ? ' is-active' : ''}`}
              >
                Subject / course
              </button>
            </div>
          </div>
          {sessionType === 'subject' && (
            <div className="field mt-3">
              <label className="label">Subject</label>
              <SearchableSelect
                aria-label="Subject"
                placeholder="Select a subject…"
                clearable
                value={subjectId === '' ? '' : String(subjectId)}
                onChange={(v) => setSubjectId(v ? Number(v) : '')}
                disabled={loadingSubjects}
                options={subjects.map((s) => ({
                  value: String(s.id),
                  label: s.name,
                  hint: s.code || undefined,
                }))}
              />
              <p className="text-xs text-secondary mt-1">
                {loadingSubjects
                  ? 'Loading this class’s subjects…'
                  : subjects.length === 0
                    ? 'No subjects are on this class group’s curriculum yet — an admin can assign subjects to its grade in the MIS.'
                    : 'Only subjects taught to this class group are listed.'}
              </p>
            </div>
          )}
          <div className="field mt-4">
            <label className="label">Class</label>
            <SearchableSelect
              aria-label="Class"
              placeholder="Select a class…"
              value={selectedClass}
              onChange={(v) => setSelectedClass(v)}
              options={classes.map((c) => ({ value: c.id, label: c.name, hint: c.department }))}
            />
          </div>
          <div className="field mt-3">
            <label className="label">Date</label>
            <input className="input" type="date" value={sessionDate} max={new Date().toISOString().split('T')[0]} onChange={(e) => setSessionDate(e.target.value)} />
          </div>
          <div className="field mt-3">
            <label className="label">Period</label>
            <SearchableSelect
              aria-label="Period"
              value={period}
              onChange={(v) => setPeriod(v)}
              options={[
                { value: 'Morning', label: 'Morning Session' },
                { value: 'Afternoon', label: 'Afternoon Session' },
                { value: 'Evening', label: 'Evening Session' },
              ]}
            />
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
              <div className="flex gap-2 flex-wrap">
                <button type="button" className="btn btn-outline" onClick={() => navigate('/dashboard')}>Cancel</button>
                <button
                  type="button"
                  className="btn btn-outline"
                  disabled={saving || !can('ATTENDANCE_MARK')}
                  title={can('ATTENDANCE_MARK') ? undefined : "You don't have permission to mark attendance."}
                  onClick={() => handleSave(true)}
                >
                  <RotateCcw size={16} /> Save & mark another
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={saving || !can('ATTENDANCE_MARK')}
                  title={can('ATTENDANCE_MARK') ? undefined : "You don't have permission to mark attendance."}
                  onClick={() => handleSave(false)}
                >
                  <Save size={16} /> {saving ? 'Saving…' : 'Save & done'}
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </DashboardLayout>
  );
};
