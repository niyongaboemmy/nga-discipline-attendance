import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { usePermissions } from '../hooks/usePermissions';
import { Save, AlertCircle, CheckCircle2, XCircle, Clock, ShieldCheck, RotateCcw, Undo2, Info } from 'lucide-react';
import { apiGet, apiPost, ApiError } from '../api/client';
import { SearchableSelect } from '../components/common/SearchableSelect';
import { AttendanceCoverage } from './AttendanceCoverage';
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
  // Whether this exact session already has marks on the server, so an
  // overwrite is announced rather than silent (POST /mark upserts).
  const [existing, setExisting] = useState<{ count: number; markedByName: string | null; lastMarkedAt: string | null } | null>(null);
  const [dirty, setDirty] = useState(false);
  // Snapshot taken at save time so the confirmation can offer an undo.
  const [undoSnapshot, setUndoSnapshot] = useState<Record<string, AttendanceState> | null>(null);
  // The monitoring view is the default landing: you check what's missing
  // before deciding what to record.
  const [tab, setTab] = useState<'missing' | 'record'>('missing');

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

  const setStatus = (id: string, status: Status) => {
    setAttendance((p) => ({ ...p, [id]: { ...p[id], status } }));
    setDirty(true);
  };
  const setNote = (id: string, notes: string) => {
    setAttendance((p) => ({ ...p, [id]: { ...p[id], notes } }));
    setDirty(true);
  };
  const markAll = (status: Status) => {
    setAttendance((p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { ...v, status }])));
    setDirty(true);
  };

  // Does this session already have marks? POST /mark upserts, so without
  // this the teacher silently replaces someone else's register.
  useEffect(() => {
    if (!selectedClass || !sessionDate) { setExisting(null); return; }
    if (sessionType === 'subject' && !subjectId) { setExisting(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const qs = new URLSearchParams({
          classId: selectedClass, date: sessionDate, period, sessionType,
        });
        if (sessionType === 'subject' && subjectId) qs.set('subjectId', String(subjectId));
        const res = await apiGet<{ exists: boolean; count: number; markedByName: string | null; lastMarkedAt: string | null }>(
          `/api/attendance/session-status?${qs.toString()}`
        );
        if (cancelled) return;
        setExisting(res.data?.exists ? res.data : null);
      } catch { if (!cancelled) setExisting(null); }
    })();
    return () => { cancelled = true; };
  }, [selectedClass, sessionDate, period, sessionType, subjectId]);

  // A half-marked register is easy to lose to a stray navigation.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // Number keys set the focused row's status and advance, so a full register
  // can be taken from the keyboard instead of aiming at four small targets
  // per student — the pattern desktop school MIS have used for years.
  const onRowKeyDown = (e: React.KeyboardEvent, index: number) => {
    const idx = ['1', '2', '3', '4'].indexOf(e.key);
    if (idx === -1) return;
    e.preventDefault();
    const student = students[index];
    if (!student) return;
    setStatus(student.id, STATUSES[idx].key);
    const next = document.querySelector<HTMLElement>(`[data-mark-row="${index + 1}"]`);
    next?.focus();
  };

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
    const snapshot = attendance;
    try {
      await apiPost('/api/attendance/mark', {
        classId: selectedClass, className: activeClass?.name ?? 'Unknown Class',
        date: sessionDate, period, records: Object.values(attendance),
        sessionType, subjectId: sessionType === 'subject' ? subjectId : null,
      });
      setDirty(false);
      setExisting({ count: students.length, markedByName: 'you', lastMarkedAt: new Date().toISOString() });
      if (andContinue) {
        // Keep the marks recoverable: "reset to all present" is destructive
        // if the teacher only meant to save.
        setUndoSnapshot(snapshot);
        setMessage({ type: 'success', text: `Saved ${students.length} record${students.length === 1 ? '' : 's'}. Roster reset for the next period.` });
        resetRoster(students);
      } else {
        setUndoSnapshot(null);
        setMessage({ type: 'success', text: 'Attendance recorded successfully.' });
        setTimeout(() => navigate('/dashboard'), 1200);
      }
    } catch (err) {
      setMessage({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Could not reach the server — your marks are still here, try saving again.',
      });
    } finally { setSaving(false); }
  };

  const restoreSnapshot = () => {
    if (!undoSnapshot) return;
    setAttendance(undoSnapshot);
    setUndoSnapshot(null);
    setMessage(null);
    setDirty(true);
  };

  if (loadingClasses) {
    return <DashboardLayout><div style={{ padding: '80px 0' }}><LoadingSpinner /></div></DashboardLayout>;
  }

  // Every student starts Present, so "n of n marked" was always complete and
  // told the teacher nothing. A breakdown is what they actually verify.
  const counts = STATUSES.map((st) => ({
    ...st,
    n: Object.values(attendance).filter((a) => a.status === st.key).length,
  }));
  const exceptions = counts.filter((c) => c.key !== 'present' && c.n > 0);

  return (
    <DashboardLayout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Attendance</h1>
          <p className="page-subtitle">
            {tab === 'missing'
              ? 'See which registers still need taking, then jump straight in.'
              : 'Select a session, then record each student’s status.'}
          </p>
        </div>
      </div>

      <div className="segmented mb-4" role="tablist" aria-label="Attendance views">
        <button
          role="tab"
          aria-selected={tab === 'missing'}
          className={`segmented-btn${tab === 'missing' ? ' is-active' : ''}`}
          onClick={() => setTab('missing')}
        >
          Missing attendance
        </button>
        <button
          role="tab"
          aria-selected={tab === 'record'}
          className={`segmented-btn${tab === 'record' ? ' is-active' : ''}`}
          onClick={() => setTab('record')}
        >
          Record attendance
        </button>
      </div>

      {tab === 'missing' && (
        <AttendanceCoverage
          onTakeRegister={({ classId, subjectId }) => {
            setSelectedClass(classId);
            if (subjectId != null) { setSessionType('subject'); setSubjectId(subjectId); }
            else { setSessionType('homeroom'); setSubjectId(''); }
            setTab('record');
          }}
        />
      )}

      {tab === 'record' && (
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

          {existing && !message && (
            <div className="alert alert-warning mt-4">
              <Info size={16} />
              <span>
                This session already has <strong>{existing.count}</strong> record
                {existing.count === 1 ? '' : 's'}
                {existing.markedByName ? <> marked by <strong>{existing.markedByName}</strong></> : null}.
                Saving will overwrite them.
              </span>
            </div>
          )}

          {message && (
            <div className={`alert mt-4 ${message.type === 'success' ? 'alert-success' : 'alert-danger'}`}>
              <AlertCircle size={16} />
              <span>{message.text}</span>
              {undoSnapshot && message.type === 'success' && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={restoreSnapshot}>
                  <Undo2 size={14} /> Undo reset
                </button>
              )}
            </div>
          )}
        </aside>

        {/* Right: student list */}
        <section className="card mark-list">
          <div className="card-header mark-head">
            <span className="section-title">
              Students {students.length > 0 && `(${students.length})`}
            </span>
            {students.length > 0 && (
              <div className="mark-counts" role="status" aria-live="polite">
                {counts.map((c) => (
                  <span key={c.key} className={`mark-count is-${c.key}${c.n === 0 ? ' is-zero' : ''}`}>
                    {c.icon}<strong>{c.n}</strong>
                    <span className="hide-mobile">{c.label}</span>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="mark-list-body">
            {loadingStudents ? (
              <div className="flex flex-col gap-2" style={{ padding: '12px 16px' }}>
                {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="rp-skeleton" />)}
              </div>
            ) : students.length === 0 ? (
              <div className="empty-state" style={{ padding: '52px 0' }}>
                <Info size={26} />
                <span className="text-sm">No students in this class for the selected academic year.</span>
                <span className="text-xs text-secondary mt-1">
                  Check the year in the top bar, or assign students to this class group in the MIS.
                </span>
              </div>
            ) : (
              students.map((s, index) => {
                const rec = attendance[s.id];
                const isException = rec && rec.status !== 'present';
                return (
                  <div
                    key={s.id}
                    className={`mark-row${isException ? ' is-exception' : ''}`}
                    data-mark-row={index}
                    tabIndex={0}
                    onKeyDown={(e) => onRowKeyDown(e, index)}
                    aria-label={`${s.name}, marked ${rec?.status ?? 'present'}. Press 1 to 4 to change.`}
                  >
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
                    {isException ? (
                      <input
                        className="input mark-note"
                        placeholder={rec?.status === 'late' ? 'Minutes late / reason…' : 'Reason…'}
                        value={rec?.notes ?? ''}
                        aria-label={`Note for ${s.name}`}
                        onChange={(e) => setNote(s.id, e.target.value)}
                      />
                    ) : (
                      <span className="mark-note-placeholder" aria-hidden="true" />
                    )}
                  </div>
                );
              })
            )}
          </div>

          {students.length > 0 && (
            <div className="mark-footer">
              <span className="text-sm text-secondary">
                {exceptions.length === 0
                  ? `All ${students.length} present`
                  : `${students.length} students · ${exceptions.map((c) => `${c.n} ${c.label.toLowerCase()}`).join(', ')}`}
              </span>
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
      )}
    </DashboardLayout>
  );
};
