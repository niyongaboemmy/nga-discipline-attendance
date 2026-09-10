import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Save, CheckCircle2, XCircle, Clock, ShieldCheck, Users, MapPin, CalendarDays,
  Sun, BookOpen, Undo2, ExternalLink,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPost, ApiError } from '../../api/client';
import type { CalendarSession, AttStatus } from '../../api/schedule';
import { usePermissions } from '../../hooks/usePermissions';

const STATUSES: { key: AttStatus; label: string; icon: React.ReactNode }[] = [
  { key: 'present', label: 'Present', icon: <CheckCircle2 size={15} /> },
  { key: 'late', label: 'Late', icon: <Clock size={15} /> },
  { key: 'absent', label: 'Absent', icon: <XCircle size={15} /> },
  { key: 'excused', label: 'Excused', icon: <ShieldCheck size={15} /> },
];
const initials = (n: string) => n.split(' ').map((p) => p[0]).join('').toUpperCase().slice(0, 2);

interface Student { id: string; name: string; email: string }
interface Row { studentId: string; studentName: string; status: AttStatus; notes: string }

function parseLink(link: string) {
  const q = new URLSearchParams(link.split('?')[1] || '');
  return {
    classId: q.get('classId') || '',
    date: q.get('date') || '',
    period: q.get('period') || 'Morning',
    sessionType: (q.get('sessionType') as 'homeroom' | 'subject') || 'homeroom',
    subjectId: q.get('subjectId') ? Number(q.get('subjectId')) : null,
  };
}

export const RegisterDrawer: React.FC<{
  session: CalendarSession;
  date: string;
  onClose: () => void;
  onSaved: () => void;
}> = ({ session, date, onClose, onSaved }) => {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const canMark = can('ATTENDANCE_MARK');
  const link = useMemo(() => parseLink(session.deepLink), [session.deepLink]);

  const [students, setStudents] = useState<Student[]>([]);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [serverStatuses, setServerStatuses] = useState<Record<string, AttStatus>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setError(null);
      try {
        const [roster, existing] = await Promise.all([
          apiGet<Student[]>(`/api/mis/students?class_id=${encodeURIComponent(link.classId)}`),
          canMark
            ? apiGet<{ records: { studentId: string; status: AttStatus; notes: string }[] }>(
                `/api/attendance/session?${new URLSearchParams({
                  classId: link.classId, date: link.date, period: link.period, sessionType: link.sessionType,
                  ...(link.subjectId ? { subjectId: String(link.subjectId) } : {}),
                }).toString()}`
              ).catch(() => ({ data: { records: [] } }))
            : Promise.resolve({ data: { records: [] } }),
        ]);
        if (cancelled) return;
        const list = roster.data ?? [];
        const srv: Record<string, AttStatus> = {};
        for (const r of existing.data?.records ?? []) srv[r.studentId] = r.status;
        setStudents(list);
        setServerStatuses(srv);
        setRows(Object.fromEntries(list.map((s) => [s.id, {
          studentId: s.id, studentName: s.name, status: srv[s.id] ?? 'present', notes: '',
        }])));
        setDirty(false);
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load the class roster.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [link, canMark]);

  const setStatus = (id: string, status: AttStatus) => {
    setRows((p) => ({ ...p, [id]: { ...p[id], status } }));
    setDirty(true);
  };
  const markAll = (status: AttStatus) => {
    setRows((p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { ...v, status }])));
    setDirty(true);
  };
  const reset = () => {
    setRows(Object.fromEntries(students.map((s) => [s.id, {
      studentId: s.id, studentName: s.name, status: serverStatuses[s.id] ?? 'present', notes: '',
    }])));
    setDirty(false);
  };

  const onRowKey = (e: React.KeyboardEvent, idx: number) => {
    const n = ['1', '2', '3', '4'].indexOf(e.key);
    if (n === -1) return;
    e.preventDefault();
    const s = students[idx];
    if (!s) return;
    setStatus(s.id, STATUSES[n].key);
    (bodyRef.current?.querySelector<HTMLElement>(`[data-row="${idx + 1}"]`))?.focus();
  };

  const save = useCallback(async () => {
    setSaving(true); setError(null);
    try {
      await apiPost('/api/attendance/mark', {
        classId: link.classId,
        className: session.className,
        date: link.date,
        period: link.period,
        sessionType: link.sessionType,
        subjectId: link.sessionType === 'subject' ? link.subjectId : null,
        records: Object.values(rows),
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save — your marks are still here.');
    } finally {
      setSaving(false);
    }
  }, [link, rows, session.className, onSaved, onClose]);

  const tally = STATUSES.map((s) => ({
    ...s, n: Object.values(rows).filter((r) => r.status === s.key).length,
  }));
  const total = students.length || 1;

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`Register — ${session.subjectName || 'Homeroom'} ${session.className}`}
        style={session.color ? ({ ['--spine' as string]: session.color }) : undefined}
      >
        <div className="drawer-head">
          <span className="dh-spine" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="drawer-title">
              {session.kind === 'homeroom'
                ? <><Sun size={16} style={{ verticalAlign: '-3px', color: 'var(--warning)' }} /> Morning check</>
                : <><BookOpen size={16} style={{ verticalAlign: '-3px' }} /> {session.subjectName || 'Lesson'}</>}
            </div>
            <div className="drawer-meta">
              <span><Users size={12} /> {session.className}</span>
              <span><CalendarDays size={12} /> {new Date(date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
              {session.startTime && <span><Clock size={12} /> {session.startTime}{session.endTime ? `–${session.endTime}` : ''}</span>}
              {session.room && <span><MapPin size={12} /> {session.room}</span>}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        {canMark && !loading && !error && (
          <div className="drawer-toolbar">
            <span className="label" style={{ textTransform: 'none' }}>Mark all</span>
            <div className="drawer-markall">
              {STATUSES.map((s) => (
                <button key={s.key} className="drawer-markall-btn" onClick={() => markAll(s.key)}>
                  {s.icon} {s.label}
                </button>
              ))}
            </div>
            {dirty && (
              <button className="btn btn-ghost btn-sm" onClick={reset} style={{ marginLeft: 'auto' }}>
                <Undo2 size={13} /> Reset
              </button>
            )}
          </div>
        )}

        <div className="drawer-body" ref={bodyRef}>
          {loading ? (
            <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="cal-skel" style={{ height: 44 }} />)}
            </div>
          ) : error ? (
            <div className="cal-empty" style={{ margin: 16 }}>
              <XCircle size={26} />
              <span className="text-sm">{error}</span>
            </div>
          ) : students.length === 0 ? (
            <div className="cal-empty" style={{ margin: 16 }}>
              <Users size={26} />
              <span className="text-sm">No students in this class for the selected year.</span>
            </div>
          ) : (
            students.map((s, idx) => {
              const r = rows[s.id];
              const changed = serverStatuses[s.id] && serverStatuses[s.id] !== r?.status;
              return (
                <div
                  key={s.id}
                  className={`drawer-row${r && r.status !== 'present' ? ' is-exception' : ''}`}
                  data-row={idx}
                  tabIndex={canMark ? 0 : -1}
                  onKeyDown={(e) => canMark && onRowKey(e, idx)}
                >
                  <div className="avatar avatar-sm avatar-square">{initials(s.name)}</div>
                  <div className="dr-name">
                    <div className="n">{s.name}{changed && <span style={{ color: 'var(--primary)' }}> •</span>}</div>
                    <div className="s mono">{serverStatuses[s.id] ? `was ${serverStatuses[s.id]}` : s.id}</div>
                  </div>
                  <div className="drawer-seg" role="group" aria-label={`Status for ${s.name}`}>
                    {STATUSES.map((st) => (
                      <button
                        key={st.key}
                        className={`drawer-seg-btn is-${st.key}${r?.status === st.key ? ' is-active' : ''}`}
                        aria-pressed={r?.status === st.key}
                        aria-label={st.label}
                        disabled={!canMark}
                        onClick={() => setStatus(s.id, st.key)}
                      >
                        {st.icon}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="drawer-foot">
          <div style={{ flex: 1, minWidth: 0 }}>
            {students.length > 0 && (
              <>
                <div className="cal-bar" style={{ maxWidth: 220, marginBottom: 6 }}>
                  {tally.filter((t) => t.n > 0).map((t) => (
                    <span key={t.key} className={`is-${t.key}`} style={{ width: `${(t.n / total) * 100}%` }} />
                  ))}
                </div>
                <div className="drawer-tally">
                  {tally.map((t) => <span key={t.key}>{t.n} {t.label.toLowerCase()}</span>)}
                </div>
              </>
            )}
          </div>
          <div className="flex gap-2">
            <button className="btn btn-ghost btn-sm" onClick={() => navigate(session.deepLink)}>
              <ExternalLink size={13} /> Full page
            </button>
            {canMark && (
              <button className="btn btn-primary" disabled={saving || loading || students.length === 0} onClick={save}>
                <Save size={15} /> {saving ? 'Saving…' : session.status === 'recorded' ? 'Update register' : 'Save register'}
              </button>
            )}
          </div>
        </div>
      </aside>
    </>
  );
};
