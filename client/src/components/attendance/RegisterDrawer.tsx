import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Save, CheckCircle2, XCircle, Clock, ShieldCheck, Users, MapPin, CalendarDays,
  Sun, BookOpen, Undo2, ExternalLink, Search, History, Pencil, ArrowRight, Command,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPost, ApiError } from '../../api/client';
import type { CalendarSession, AttStatus } from '../../api/schedule';
import { usePermissions } from '../../hooks/usePermissions';
import { useToast } from '../../context/ToastContext';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { fmtWhen } from '../../utils/time';

const STATUSES: { key: AttStatus; label: string; icon: React.ReactNode }[] = [
  { key: 'present', label: 'Present', icon: <CheckCircle2 size={15} /> },
  { key: 'late', label: 'Late', icon: <Clock size={15} /> },
  { key: 'absent', label: 'Absent', icon: <XCircle size={15} /> },
  { key: 'excused', label: 'Excused', icon: <ShieldCheck size={15} /> },
];
const initials = (n: string) => n.split(' ').map((p) => p[0]).join('').toUpperCase().slice(0, 2);

interface Student { id: string; name: string; email: string }
interface Row { studentId: string; studentName: string; status: AttStatus; notes: string }
interface ServerRec { status: AttStatus; notes: string }

export interface DrawerTarget {
  session: CalendarSession;
  date: string;
  /** The next un-recorded session that day, offered after a save. */
  next?: { session: CalendarSession; date: string; label: string } | null;
}

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
  target: DrawerTarget;
  onClose: () => void;
  onSaved: () => void;
  onOpenNext?: (t: DrawerTarget) => void;
}> = ({ target, onClose, onSaved, onOpenNext }) => {
  const { session, date, next } = target;
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = usePermissions();
  const canMark = can('ATTENDANCE_MARK');
  const link = useMemo(() => parseLink(session.deepLink), [session.deepLink]);

  const [students, setStudents] = useState<Student[]>([]);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [server, setServer] = useState<Record<string, ServerRec>>({});
  const [existing, setExisting] = useState<
    { count: number; markedByName: string | null; markedByMe: boolean; lastMarkedAt: string | null } | null
  >(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [savedView, setSavedView] = useState<null | { present: number; absent: number; late: number; excused: number }>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const isEditing = !!existing;

  const load = useCallback(async () => {
    setLoading(true); setError(null); setSavedView(null);
    try {
      const [roster, sess] = await Promise.all([
        apiGet<Student[]>(`/api/mis/students?class_id=${encodeURIComponent(link.classId)}`),
        canMark
          ? apiGet<{
              exists: boolean; markedByName: string | null; markedByMe: boolean; lastMarkedAt: string | null;
              records: { studentId: string; status: AttStatus; notes: string }[];
            }>(
              `/api/attendance/session?${new URLSearchParams({
                classId: link.classId, date: link.date, period: link.period, sessionType: link.sessionType,
                ...(link.subjectId ? { subjectId: String(link.subjectId) } : {}),
              }).toString()}`
            ).catch(() => ({ data: null }))
          : Promise.resolve({ data: null }),
      ]);
      const list = roster.data ?? [];
      const d = sess.data;
      const srv: Record<string, ServerRec> = {};
      for (const r of d?.records ?? []) srv[r.studentId] = { status: r.status, notes: r.notes ?? '' };
      setStudents(list);
      setServer(srv);
      setExisting(
        d?.exists
          ? { count: d.records.length, markedByName: d.markedByName, markedByMe: d.markedByMe, lastMarkedAt: d.lastMarkedAt }
          : null
      );
      setRows(Object.fromEntries(list.map((s) => [s.id, {
        studentId: s.id, studentName: s.name,
        status: srv[s.id]?.status ?? 'present', notes: srv[s.id]?.notes ?? '',
      }])));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the class roster.');
    } finally {
      setLoading(false);
    }
  }, [link, canMark]);

  useEffect(() => { load(); }, [load]);

  // Which rows differ from what's on the server (drives the "you changed N" hint
  // and the save-button state when editing an existing register).
  const changedIds = useMemo(() => {
    const set = new Set<string>();
    for (const [id, r] of Object.entries(rows)) {
      const s = server[id];
      if (!s) { if (r.status !== 'present' || r.notes) set.add(id); continue; }
      if (s.status !== r.status || (s.notes ?? '') !== (r.notes ?? '')) set.add(id);
    }
    return set;
  }, [rows, server]);
  const dirty = changedIds.size > 0;

  const requestClose = useCallback(() => {
    if (dirty && !savedView) setConfirmClose(true);
    else onClose();
  }, [dirty, savedView, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestClose();
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canMark) { e.preventDefault(); attemptSave(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestClose, canMark, rows, existing]);

  const setStatus = (id: string, status: AttStatus) =>
    setRows((p) => ({ ...p, [id]: { ...p[id], status, notes: status === 'present' ? '' : p[id].notes } }));
  const setNote = (id: string, notes: string) => setRows((p) => ({ ...p, [id]: { ...p[id], notes } }));
  const markAll = (status: AttStatus) =>
    setRows((p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { ...v, status, notes: status === 'present' ? '' : v.notes }])));
  const discard = () =>
    setRows(Object.fromEntries(students.map((s) => [s.id, {
      studentId: s.id, studentName: s.name, status: server[s.id]?.status ?? 'present', notes: server[s.id]?.notes ?? '',
    }])));

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? students.filter((s) => s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)) : students;
  }, [students, query]);

  const onRowKey = (e: React.KeyboardEvent, visibleIdx: number) => {
    const n = ['1', '2', '3', '4'].indexOf(e.key);
    if (n === -1) return;
    e.preventDefault();
    const s = visible[visibleIdx];
    if (!s) return;
    setStatus(s.id, STATUSES[n].key);
    (bodyRef.current?.querySelector<HTMLElement>(`[data-row="${visibleIdx + 1}"]`))?.focus();
  };

  const doSave = useCallback(async () => {
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
      const t = STATUSES.reduce((acc, s) => {
        acc[s.key] = Object.values(rows).filter((r) => r.status === s.key).length;
        return acc;
      }, {} as Record<AttStatus, number>);
      onSaved();
      if (next) {
        setSavedView({ present: t.present, absent: t.absent, late: t.late, excused: t.excused });
      } else {
        toast.success('Register saved', `${session.subjectName || 'Homeroom'} · ${session.className}`);
        onClose();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save — your marks are still here, try again.');
    } finally {
      setSaving(false);
    }
  }, [link, rows, session, next, onSaved, onClose, toast]);

  const attemptSave = useCallback(() => {
    if (!students.length) return;
    if (existing && !existing.markedByMe && existing.markedByName) { setConfirmOverwrite(true); return; }
    doSave();
  }, [students.length, existing, doSave]);

  const tally = STATUSES.map((s) => ({ ...s, n: Object.values(rows).filter((r) => r.status === s.key).length }));
  const total = students.length || 1;
  const saveDisabled = saving || loading || !students.length || (isEditing && !dirty);

  return (
    <>
      <div className="drawer-scrim" onClick={requestClose} />
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
          <button className="icon-btn" onClick={requestClose} aria-label="Close"><X size={18} /></button>
        </div>

        {isEditing && !savedView && (
          <div className={`drawer-editbar ${existing!.markedByMe ? 'is-mine' : 'is-other'}`}>
            <Pencil size={14} />
            <span>
              Editing a register of <strong>{existing!.count}</strong>
              {existing!.markedByName ? <>, last marked by <strong>{existing!.markedByMe ? 'you' : existing!.markedByName}</strong></> : null}
              {existing!.lastMarkedAt ? <> {fmtWhen(existing!.lastMarkedAt)}</> : null}.
              {dirty ? <> You’ve changed <strong>{changedIds.size}</strong>.</> : <> Change a status to update it.</>}
            </span>
            {dirty && (
              <button className="btn btn-ghost btn-sm" onClick={discard}>
                <History size={13} /> Discard
              </button>
            )}
          </div>
        )}

        {savedView ? (
          <div className="drawer-saved">
            <div className="drawer-saved-icon"><CheckCircle2 size={26} /></div>
            <div className="drawer-saved-title">Register saved</div>
            <div className="drawer-saved-sub">
              {savedView.present} present
              {savedView.absent ? ` · ${savedView.absent} absent` : ''}
              {savedView.late ? ` · ${savedView.late} late` : ''}
              {savedView.excused ? ` · ${savedView.excused} excused` : ''}
            </div>
            <div className="flex gap-2 mt-3" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
              {next && onOpenNext && (
                <button className="btn btn-primary" onClick={() => onOpenNext({ session: next.session, date: next.date })}>
                  Next: {next.label} <ArrowRight size={15} />
                </button>
              )}
              <button className="btn btn-outline" onClick={onClose}>Done</button>
            </div>
          </div>
        ) : (
          <>
            {canMark && !loading && !error && students.length > 0 && (
              <div className="drawer-toolbar">
                <div className="drawer-search">
                  <Search size={14} className="field-icon" />
                  <input
                    className="input"
                    placeholder="Find a student…"
                    value={query}
                    aria-label="Find a student"
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {query && <button className="drawer-search-clear" onClick={() => setQuery('')} aria-label="Clear"><X size={12} /></button>}
                </div>
                <div className="drawer-markall">
                  <span className="drawer-markall-lbl">All</span>
                  {STATUSES.map((s) => (
                    <button key={s.key} className={`drawer-markall-btn is-${s.key}`} onClick={() => markAll(s.key)} title={`Mark everyone ${s.label.toLowerCase()}`}>
                      {s.icon}<span className="hide-mobile">{s.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="drawer-body" ref={bodyRef}>
              {loading ? (
                <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {[0, 1, 2, 3, 4, 5, 6].map((i) => <div key={i} className="cal-skel" style={{ height: 46 }} />)}
                </div>
              ) : error ? (
                <div className="cal-empty" style={{ margin: 16 }}>
                  <XCircle size={26} />
                  <span className="text-sm">{error}</span>
                  <button className="btn btn-outline btn-sm mt-2" onClick={load}>Try again</button>
                </div>
              ) : students.length === 0 ? (
                <div className="cal-empty" style={{ margin: 16 }}>
                  <Users size={26} />
                  <span className="text-sm">No students in this class for the selected year.</span>
                </div>
              ) : visible.length === 0 ? (
                <div className="cal-empty" style={{ margin: 16 }}>
                  <Search size={22} />
                  <span className="text-sm">No student matches “{query}”.</span>
                  <button className="btn btn-outline btn-sm mt-2" onClick={() => setQuery('')}>Clear search</button>
                </div>
              ) : (
                visible.map((s, idx) => {
                  const r = rows[s.id];
                  const changed = changedIds.has(s.id);
                  const isException = r && r.status !== 'present';
                  return (
                    <div
                      key={s.id}
                      className={`drawer-row${isException ? ' is-exception' : ''}${changed ? ' is-changed' : ''}`}
                      data-row={idx}
                      tabIndex={canMark ? 0 : -1}
                      onKeyDown={(e) => canMark && onRowKey(e, idx)}
                      aria-label={`${s.name}, ${r?.status ?? 'present'}. Press 1–4 to change.`}
                    >
                      <div className="drawer-row-main">
                        <div className="avatar avatar-sm avatar-square">{initials(s.name)}</div>
                        <div className="dr-name">
                          <div className="n">{s.name}{changed && <span className="dr-dot" aria-hidden="true" />}</div>
                          <div className="s mono">
                            {server[s.id] ? `was ${server[s.id].status}` : s.id}
                          </div>
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
                      {isException && (
                        <input
                          className="input drawer-note"
                          placeholder={r?.status === 'late' ? 'Minutes late / reason…' : 'Reason (optional)…'}
                          value={r?.notes ?? ''}
                          aria-label={`Note for ${s.name}`}
                          disabled={!canMark}
                          onChange={(e) => setNote(s.id, e.target.value)}
                        />
                      )}
                    </div>
                  );
                })
              )}
            </div>

            <div className="drawer-foot">
              <div style={{ flex: 1, minWidth: 0 }}>
                {students.length > 0 && (
                  <>
                    <div className="cal-bar" style={{ maxWidth: 240, marginBottom: 6 }}>
                      {tally.filter((t) => t.n > 0).map((t) => (
                        <span key={t.key} className={`is-${t.key}`} style={{ width: `${(t.n / total) * 100}%` }} />
                      ))}
                    </div>
                    <div className="drawer-tally">
                      {tally.map((t) => <span key={t.key} className={t.n === 0 ? 'is-zero' : ''}>{t.n} {t.label.toLowerCase()}</span>)}
                    </div>
                  </>
                )}
              </div>
              <div className="drawer-foot-actions">
                {dirty && !isEditing && (
                  <button className="btn btn-ghost btn-sm" onClick={discard} title="Reset everyone to Present">
                    <Undo2 size={13} /> Reset
                  </button>
                )}
                <button className="btn btn-ghost btn-sm hide-mobile" onClick={() => navigate(session.deepLink)}>
                  <ExternalLink size={13} /> Full page
                </button>
                {canMark && (
                  <button className="btn btn-primary" disabled={saveDisabled} onClick={attemptSave}>
                    <Save size={15} /> {saving ? 'Saving…' : isEditing ? `Update${dirty ? ` (${changedIds.size})` : ''}` : 'Save register'}
                  </button>
                )}
              </div>
              {canMark && students.length > 0 && (
                <div className="drawer-kbd hide-mobile"><Command size={11} /> Focus a row, press <kbd>1</kbd>–<kbd>4</kbd> · <kbd>⌘</kbd><kbd>↵</kbd> to save</div>
              )}
            </div>
          </>
        )}
      </aside>

      <ConfirmDialog
        open={confirmOverwrite}
        title="Overwrite another teacher's register?"
        message={
          existing?.markedByName
            ? `This register was last marked by ${existing.markedByName}. Your changes replace what they recorded (the previous values stay in the register's history).`
            : 'Your changes will replace the existing register.'
        }
        confirmLabel="Overwrite"
        danger
        onCancel={() => setConfirmOverwrite(false)}
        onConfirm={() => { setConfirmOverwrite(false); doSave(); }}
      />
      <ConfirmDialog
        open={confirmClose}
        title="Discard your changes?"
        message="You've made changes to this register that haven't been saved."
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        danger
        onCancel={() => setConfirmClose(false)}
        onConfirm={() => { setConfirmClose(false); onClose(); }}
      />
    </>
  );
};
