import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { ConfirmDialog } from '../components/common/ConfirmDialog';
import { usePermissions } from '../hooks/usePermissions';
import {
  Save, AlertCircle, CheckCircle2, XCircle, Clock, ShieldCheck, RotateCcw, Undo2, Info,
  LayoutDashboard, PenLine, Users, CalendarDays, Sun, BookOpen, Search, X, Command, Sparkles,
  Pencil, History,
} from 'lucide-react';
import { apiGet, apiPost, ApiError } from '../api/client';
import { SearchableSelect } from '../components/common/SearchableSelect';
import { AttendanceCoverage } from './AttendanceCoverage';
import './MarkAttendance.css';

const fmtWhen = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z'));
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

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
  const [searchParams, setSearchParams] = useSearchParams();
  const { can } = usePermissions();
  // Deep link from Attendance History / Coverage: /attendance/mark?classId=…&date=…&period=…&sessionType=…&subjectId=…
  const qp = React.useRef({
    classId: searchParams.get('classId') || '',
    date: searchParams.get('date') || '',
    period: searchParams.get('period') || '',
    sessionType: (searchParams.get('sessionType') as SessionType) || '',
    subjectId: searchParams.get('subjectId') || '',
  }).current;
  const [classes, setClasses] = useState<ClassData[]>([]);
  const [selectedClass, setSelectedClass] = useState(qp.classId);
  const [students, setStudents] = useState<Student[]>([]);
  const [attendance, setAttendance] = useState<Record<string, AttendanceState>>({});
  const [sessionDate, setSessionDate] = useState(qp.date || new Date().toISOString().split('T')[0]);
  const [period, setPeriod] = useState(qp.period || 'Morning');
  // A.1.1 vs A.1.2: homeroom is the class-group's overall daily attendance;
  // subject requires picking which course session this is.
  const [sessionType, setSessionType] = useState<SessionType>(qp.sessionType === 'subject' ? 'subject' : 'homeroom');
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [loadingSubjects, setLoadingSubjects] = useState(false);
  const [subjectId, setSubjectId] = useState<number | ''>(qp.subjectId ? Number(qp.subjectId) : '');
  const [loadingClasses, setLoadingClasses] = useState(true);
  const [loadingStudents, setLoadingStudents] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // The register already on the server for this exact session, if any — its
  // per-student statuses are loaded so the teacher edits real data instead of
  // blindly re-marking everyone as Present (remediation A2/A3/A11).
  const [existing, setExisting] = useState<
    { count: number; markedByName: string | null; markedByMe: boolean; lastMarkedAt: string | null } | null
  >(null);
  const [serverStatuses, setServerStatuses] = useState<Record<string, { status: Status; notes: string }>>({});
  const [loadingSession, setLoadingSession] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState<null | (() => void)>(null);
  const [dirty, setDirty] = useState(false);
  // Snapshot taken at save time so the confirmation can offer an undo.
  const [undoSnapshot, setUndoSnapshot] = useState<Record<string, AttendanceState> | null>(null);
  // The monitoring view is the default landing: you check what's missing
  // before deciding what to record.
  const [tab, setTab] = useState<'missing' | 'record'>(qp.classId ? 'record' : 'missing');

  // Consume the deep-link params once, then drop them from the URL so a manual
  // class change later isn't "stuck" on the linked session.
  useEffect(() => {
    if (qp.classId || qp.date || qp.period) {
      setSearchParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Badge on the Missing tab, so the outstanding count stays visible while
  // you're recording rather than only on the dashboard you left.
  const [missingCount, setMissingCount] = useState<number | null>(null);
  const [studentQuery, setStudentQuery] = useState('');

  const loadMissingCount = useCallback(async () => {
    if (!can('ATTENDANCE_VIEW_ALL')) return;
    try {
      const res = await apiGet<{ totals: { classes: number; homeroomTaken: number } }>(
        `/api/attendance/coverage?date=${new Date().toISOString().split('T')[0]}`
      );
      const t = res.data?.totals;
      setMissingCount(t ? t.classes - t.homeroomTaken : null);
    } catch { setMissingCount(null); }
  }, [can]);

  useEffect(() => { loadMissingCount(); }, [loadMissingCount]);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiGet<ClassData[]>('/api/mis/classes');
        setClasses(res.data || []);
        if (res.data?.length) setSelectedClass((cur) => cur || res.data![0].id);
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

  // Build the working roster: each student starts from what's already on the
  // server for this session, falling back to Present for anyone not in it.
  const buildRoster = useCallback(
    (list: Student[], fromServer: Record<string, { status: Status; notes: string }>) => {
      const next: Record<string, AttendanceState> = {};
      list.forEach((s) => {
        const seed = fromServer[s.id];
        next[s.id] = {
          studentId: s.id, studentName: s.name,
          status: seed?.status ?? 'present', notes: seed?.notes ?? '',
        };
      });
      setAttendance(next);
    },
    []
  );
  useEffect(() => {
    if (!selectedClass) return;
    (async () => {
      setLoadingStudents(true);
      setMessage(null);
      try {
        const res = await apiGet<Student[]>(`/api/mis/students?class_id=${selectedClass}`);
        setStudents(res.data || []);
      } catch (err) { console.error('Error fetching students:', err); }
      finally { setLoadingStudents(false); }
    })();
  }, [selectedClass]);

  // Rebuild the roster whenever the class roster or the loaded server register
  // changes — this is what makes "edit an existing register" work instead of
  // resetting everyone to Present.
  useEffect(() => {
    if (students.length === 0) return;
    if (loadingSession) return;
    buildRoster(students, serverStatuses);
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [students, serverStatuses, loadingSession]);

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

  // Load the register already on the server for this session — its actual
  // per-student statuses, not just a count — so a re-mark is a real edit
  // (remediation A2/A3). POST /mark upserts, so without this a teacher
  // silently replaced someone else's register with "everyone present".
  useEffect(() => {
    if (!selectedClass || !sessionDate) { setExisting(null); setServerStatuses({}); return; }
    if (sessionType === 'subject' && !subjectId) { setExisting(null); setServerStatuses({}); return; }
    let cancelled = false;
    setLoadingSession(true);
    (async () => {
      try {
        const qs = new URLSearchParams({ classId: selectedClass, date: sessionDate, period, sessionType });
        if (sessionType === 'subject' && subjectId) qs.set('subjectId', String(subjectId));
        const res = await apiGet<{
          exists: boolean; markedByName: string | null; markedByMe: boolean; lastMarkedAt: string | null;
          records: { studentId: string; status: Status; notes: string }[];
        }>(`/api/attendance/session?${qs.toString()}`);
        if (cancelled) return;
        const d = res.data;
        if (d?.exists) {
          setExisting({ count: d.records.length, markedByName: d.markedByName, markedByMe: d.markedByMe, lastMarkedAt: d.lastMarkedAt });
          setServerStatuses(Object.fromEntries(d.records.map((r) => [r.studentId, { status: r.status, notes: r.notes ?? '' }])));
        } else {
          setExisting(null);
          setServerStatuses({});
        }
      } catch { if (!cancelled) { setExisting(null); setServerStatuses({}); } }
      finally { if (!cancelled) setLoadingSession(false); }
    })();
    return () => { cancelled = true; };
  }, [selectedClass, sessionDate, period, sessionType, subjectId]);

  const isEditing = !!existing;
  const changedIds = React.useMemo(() => {
    const s = new Set<string>();
    for (const [id, rec] of Object.entries(attendance)) {
      const srv = serverStatuses[id];
      if (!srv) { if (rec.status !== 'present' || rec.notes) s.add(id); continue; }
      if (srv.status !== rec.status || (srv.notes ?? '') !== (rec.notes ?? '')) s.add(id);
    }
    return s;
  }, [attendance, serverStatuses]);

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
  // `list` is the rows actually on screen — with a search active, "row 3" is
  // the third visible student, not the third in the full roster.
  const onRowKeyDown = (e: React.KeyboardEvent, index: number, list: Student[]) => {
    const idx = ['1', '2', '3', '4'].indexOf(e.key);
    if (idx === -1) return;
    e.preventDefault();
    const student = list[index];
    if (!student) return;
    setStatus(student.id, STATUSES[idx].key);
    const next = document.querySelector<HTMLElement>(`[data-mark-row="${index + 1}"]`);
    next?.focus();
  };

  /** `andContinue`: after saving, either navigate away (the old only option)
   *  or stay on the page with the roster reset for another period — a
   *  teacher marking several periods back-to-back no longer has to
   *  re-select the class from scratch each time. */
  const doSave = async (andContinue: boolean) => {
    setSaving(true); setMessage(null);
    const activeClass = classes.find((c) => c.id === selectedClass);
    const snapshot = attendance;
    try {
      const res = await apiPost<{ inserted: number; updated: number }>('/api/attendance/mark', {
        classId: selectedClass, className: activeClass?.name ?? 'Unknown Class',
        date: sessionDate, period, records: Object.values(attendance),
        sessionType, subjectId: sessionType === 'subject' ? subjectId : null,
      });
      setDirty(false);
      // Adopt what we just saved as the new server baseline, so a follow-up
      // correction diffs against it rather than re-flagging every row.
      setServerStatuses(Object.fromEntries(
        Object.values(attendance).map((a) => [a.studentId, { status: a.status, notes: a.notes }])
      ));
      setExisting({ count: students.length, markedByName: 'you', markedByMe: true, lastMarkedAt: new Date().toISOString() });
      const wasUpdate = (res.data?.updated ?? 0) > 0;
      void snapshot;
      if (andContinue) {
        setUndoSnapshot(null);
        setMessage({
          type: 'success',
          text: `${wasUpdate ? 'Register updated' : `Saved ${students.length} record${students.length === 1 ? '' : 's'}`}. Pick another period or subject to keep going — the class stays selected.`,
        });
      } else {
        setUndoSnapshot(null);
        setMessage({ type: 'success', text: wasUpdate ? 'Register updated successfully.' : 'Attendance recorded successfully.' });
        setTimeout(() => navigate('/dashboard'), 1200);
      }
    } catch (err) {
      setMessage({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Could not reach the server — your marks are still here, try saving again.',
      });
    } finally { setSaving(false); }
  };

  const handleSave = (andContinue: boolean) => {
    if (!selectedClass || !students.length) return;
    if (sessionType === 'subject' && !subjectId) {
      setMessage({ type: 'error', text: 'Select a subject for course attendance.' });
      return;
    }
    // Overwriting a register another teacher took needs an explicit yes
    // (remediation A12).
    if (existing && !existing.markedByMe && existing.markedByName) {
      setConfirmOverwrite(() => () => { setConfirmOverwrite(null); doSave(andContinue); });
      return;
    }
    doSave(andContinue);
  };

  const reloadServerRegister = () => {
    buildRoster(students, serverStatuses);
    setDirty(false);
    setMessage(null);
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

  // Deliberately not useMemo: this sits below the `loadingClasses` early
  // return, so a hook here runs on some renders and not others — which is
  // exactly the "rendered more hooks than during the previous render" crash.
  // Filtering one class roster is far too cheap to be worth memoising.
  const q = studentQuery.trim().toLowerCase();
  const visibleStudents = q
    ? students.filter((s) => s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q))
    : students;

  const className_ = classes.find((c) => c.id === selectedClass)?.name;
  const subjectName = subjects.find((s) => s.id === subjectId)?.name;

  return (
    <DashboardLayout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Attendance</h1>
          <p className="page-subtitle">
            {tab === 'missing'
              ? 'See which registers still need taking, then jump straight in.'
              : isEditing
                ? 'This session already has a register — adjust any status and save to update it.'
                : 'Select a session, then record each student’s status.'}
          </p>
        </div>
      </div>

      <div className="att-tabs mb-4" role="tablist" aria-label="Attendance views">
        <button
          role="tab"
          aria-selected={tab === 'missing'}
          className={`att-tab${tab === 'missing' ? ' is-active' : ''}`}
          onClick={() => { setTab('missing'); loadMissingCount(); }}
        >
          <LayoutDashboard size={15} />
          Missing attendance
          {missingCount != null && missingCount > 0 && (
            <span className="att-tab-badge" aria-label={`${missingCount} outstanding`}>{missingCount}</span>
          )}
        </button>
        <button
          role="tab"
          aria-selected={tab === 'record'}
          className={`att-tab${tab === 'record' ? ' is-active' : ''}`}
          onClick={() => setTab('record')}
        >
          <PenLine size={15} />
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
          <div className="mark-config-head">
            <span className="mark-config-icon"><CalendarDays size={15} /></span>
            <span className="section-title">Session</span>
          </div>
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
          <span className="label">Mark everyone as</span>
          {/* A whole-class shortcut is the common case (nearly everyone is
              present), so it gets colour and equal-width targets rather than
              four wrapping grey chips. */}
          <div className="mark-all mt-2">
            {STATUSES.map((st) => (
              <button
                key={st.key}
                type="button"
                className={`mark-all-btn is-${st.key}`}
                disabled={students.length === 0}
                onClick={() => markAll(st.key)}
              >
                {st.icon}<span>{st.label}</span>
              </button>
            ))}
          </div>

          {isEditing && !message && (
            <div className={`alert mt-4 ${existing!.markedByMe ? 'alert-info' : 'alert-warning'}`}>
              <Pencil size={16} />
              <span>
                Editing an existing register —{' '}
                <strong>{existing!.count}</strong> record{existing!.count === 1 ? '' : 's'}
                {existing!.markedByName
                  ? <>, last marked by <strong>{existing!.markedByMe ? 'you' : existing!.markedByName}</strong></>
                  : null}
                {existing!.lastMarkedAt ? <> {fmtWhen(existing!.lastMarkedAt)}</> : null}.
                {changedIds.size > 0
                  ? <> You've changed <strong>{changedIds.size}</strong>.</>
                  : <> Change a status, then save to update it.</>}
                {changedIds.size > 0 && (
                  <button type="button" className="btn btn-ghost btn-sm ml-2" onClick={reloadServerRegister}>
                    <History size={13} /> Discard changes
                  </button>
                )}
              </span>
            </div>
          )}
          {loadingSession && !isEditing && (
            <p className="text-xs text-secondary mt-3"><Info size={12} /> Checking for an existing register…</p>
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
            <div className="mark-head-main">
              <span className="section-title">
                <Users size={15} /> Students {students.length > 0 && <span className="mark-total">{students.length}</span>}
              </span>
              {/* What you're about to save, spelled out — the session lives in
                  the left panel, and it's easy to record the right register
                  against the wrong day or period. */}
              <div className="mark-session-chips">
                {className_ && <span className="mark-chip"><Users size={11} />{className_}</span>}
                {sessionType === 'subject' && subjectName && (
                  <span className="mark-chip"><BookOpen size={11} />{subjectName}</span>
                )}
                <span className="mark-chip"><CalendarDays size={11} />
                  <time dateTime={sessionDate}>
                    {new Date(sessionDate).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                  </time>
                </span>
                <span className="mark-chip"><Sun size={11} />{period}</span>
              </div>
            </div>
            {students.length > 0 && (
              <div className="mark-head-tools">
                <div className="rp-search mark-search">
                  <Search className="field-icon" size={15} />
                  <input
                    className="input"
                    placeholder="Find a student…"
                    value={studentQuery}
                    aria-label="Find a student"
                    onChange={(e) => setStudentQuery(e.target.value)}
                  />
                  {studentQuery && (
                    <button className="rp-search-clear" onClick={() => setStudentQuery('')} aria-label="Clear search">
                      <X size={13} />
                    </button>
                  )}
                </div>
                <div className="mark-counts" role="status" aria-live="polite">
                  {counts.map((c) => (
                    <span key={c.key} className={`mark-count is-${c.key}${c.n === 0 ? ' is-zero' : ''}`}>
                      {c.icon}<strong>{c.n}</strong>
                      <span className="hide-mobile">{c.label}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* One glance at the shape of the class: the bar is the register. */}
          {students.length > 0 && (
            <div
              className="mark-bar"
              role="img"
              aria-label={counts.map((c) => `${c.n} ${c.label.toLowerCase()}`).join(', ')}
            >
              {counts.filter((c) => c.n > 0).map((c) => (
                <span
                  key={c.key}
                  className={`is-${c.key}`}
                  style={{ width: `${(c.n / students.length) * 100}%` }}
                  title={`${c.n} ${c.label.toLowerCase()}`}
                />
              ))}
            </div>
          )}

          <div className="mark-list-body">
            {loadingStudents ? (
              <div className="flex flex-col gap-2" style={{ padding: '12px 16px' }}>
                {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="rp-skeleton" />)}
              </div>
            ) : students.length === 0 ? (
              <div className="empty-state mark-empty">
                <span className="mark-empty-icon"><Users size={24} /></span>
                <span className="text-sm">No students in this class for the selected academic year.</span>
                <span className="text-xs text-secondary mt-1">
                  Check the year in the top bar, or assign students to this class group in the MIS.
                </span>
                <button className="btn btn-outline btn-sm mt-3" onClick={() => setTab('missing')}>
                  <LayoutDashboard size={14} /> Back to the dashboard
                </button>
              </div>
            ) : visibleStudents.length === 0 ? (
              <div className="empty-state mark-empty">
                <span className="mark-empty-icon"><Search size={22} /></span>
                <span className="text-sm">No student matches “{studentQuery}”.</span>
                <button className="btn btn-outline btn-sm mt-3" onClick={() => setStudentQuery('')}>
                  <X size={14} /> Clear search
                </button>
              </div>
            ) : (
              visibleStudents.map((s, index) => {
                const rec = attendance[s.id];
                const isException = rec && rec.status !== 'present';
                const isChanged = changedIds.has(s.id);
                return (
                  <div
                    key={s.id}
                    className={`mark-row${isException ? ' is-exception' : ''}${isChanged ? ' is-changed' : ''}`}
                    data-mark-row={index}
                    tabIndex={0}
                    onKeyDown={(e) => onRowKeyDown(e, index, visibleStudents)}
                    aria-label={`${s.name}, marked ${rec?.status ?? 'present'}${isChanged ? ', changed' : ''}. Press 1 to 4 to change.`}
                  >
                    <div className="flex items-center gap-3" style={{ minWidth: 0 }}>
                      <div className="avatar avatar-square">{initials(s.name)}</div>
                      <div style={{ minWidth: 0 }}>
                        <div className="text-sm font-semibold truncate">
                          {s.name}
                          {isChanged && <span className="mark-changed-dot" title="Changed since last saved" aria-hidden="true" />}
                        </div>
                        <div className="text-xs text-secondary mono truncate">
                          {isEditing && serverStatuses[s.id]
                            ? <>was {serverStatuses[s.id].status}</>
                            : s.id}
                        </div>
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
              <div className="mark-footer-summary">
                <span className="text-sm">
                  {exceptions.length === 0 ? (
                    <><Sparkles size={13} /> All {students.length} present</>
                  ) : (
                    <>{students.length} students · {exceptions.map((c) => `${c.n} ${c.label.toLowerCase()}`).join(', ')}</>
                  )}
                </span>
                <span className="mark-kbd-hint hide-mobile">
                  <Command size={11} /> Focus a row, then press <kbd>1</kbd>–<kbd>4</kbd>
                </span>
              </div>
              <div className="flex gap-2 flex-wrap">
                <button type="button" className="btn btn-outline" onClick={() => navigate('/dashboard')}>Cancel</button>
                <button
                  type="button"
                  className="btn btn-outline"
                  disabled={saving || !can('ATTENDANCE_MARK') || (isEditing && changedIds.size === 0)}
                  title={can('ATTENDANCE_MARK') ? undefined : "You don't have permission to mark attendance."}
                  onClick={() => handleSave(true)}
                >
                  <RotateCcw size={16} /> {isEditing ? 'Update & mark another' : 'Save & mark another'}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={saving || !can('ATTENDANCE_MARK') || (isEditing && changedIds.size === 0)}
                  title={can('ATTENDANCE_MARK') ? undefined : "You don't have permission to mark attendance."}
                  onClick={() => handleSave(false)}
                >
                  <Save size={16} /> {saving ? 'Saving…' : isEditing ? `Update register${changedIds.size ? ` (${changedIds.size})` : ''}` : 'Save & done'}
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
      )}

      <ConfirmDialog
        open={!!confirmOverwrite}
        title="Overwrite another teacher's register?"
        message={
          existing?.markedByName
            ? `This register was last marked by ${existing.markedByName}. Your changes will replace what they recorded (the previous values are kept in the register's history).`
            : 'Your changes will replace the existing register.'
        }
        confirmLabel="Overwrite"
        danger
        onCancel={() => setConfirmOverwrite(null)}
        onConfirm={() => confirmOverwrite?.()}
      />
    </DashboardLayout>
  );
};
