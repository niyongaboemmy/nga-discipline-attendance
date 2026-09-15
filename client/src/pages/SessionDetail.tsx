import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, BookOpen, Sun, Clock, MapPin, User, Users, CalendarDays, Hash,
  CheckCircle2, AlertTriangle, CircleDashed, PenLine, Eye, ExternalLink, FileText,
} from 'lucide-react';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { ErrorState } from '../components/common/ErrorState';
import { StatusChip } from '../components/attendance/StatusChip';
import { usePermissions } from '../hooks/usePermissions';
import { useAuth } from '../context/AuthContext';
import { apiGet, ApiError } from '../api/client';
import { getScheduleDay, findSession, type CalendarSession, type AttStatus } from '../api/schedule';
import { isoDate, clock, fmtWhen } from '../utils/time';
import { newExcuseLink, getMyAbsences, type Absence } from '../api/excuses';
import { ExcuseStatusBadge } from '../components/excuses/ExcuseStatusBadge';

/**
 * One lesson (or morning check), on one day, in full — the "simple page of
 * more detail" reached by clicking any session on the Attendance Calendar.
 * Read-only: it shows what the calendar's compact cards can't (room,
 * teacher, who marked it and when, the per-student list) and hands off to
 * the register page for anything that changes data.
 *
 * Reads the same day payload the calendar does, so what it shows always
 * agrees with the calendar; the per-student list comes from the register
 * endpoint and is only fetched (and only shown) for users who can mark.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const nowMin = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); };
const longDate = (d: string) =>
  new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

type Phase = 'recorded' | 'overdue' | 'now' | 'upcoming';

/** Same rule the calendar uses: "missing" only becomes "overdue" once the
 *  lesson's window has actually closed. */
function phaseOf(s: CalendarSession, date: string): Phase {
  if (s.status === 'recorded') return 'recorded';
  const today = isoDate();
  if (date < today) return 'overdue';
  if (date > today) return 'upcoming';
  const start = toMin(s.startTime);
  const end = toMin(s.endTime || s.startTime) || start + 40;
  const now = nowMin();
  if (now > end) return 'overdue';
  if (now >= start) return 'now';
  return 'upcoming';
}

const PHASE_META: Record<Phase, { label: string; icon: React.ReactNode; cls: string }> = {
  recorded: { label: 'Register taken', icon: <CheckCircle2 size={15} />, cls: 'is-recorded' },
  overdue: { label: 'Register overdue', icon: <AlertTriangle size={15} />, cls: 'is-overdue' },
  now: { label: 'In progress', icon: <Clock size={15} />, cls: 'is-now' },
  upcoming: { label: 'Upcoming', icon: <CircleDashed size={15} />, cls: 'is-upcoming' },
};

interface RegisterRow { studentId: string; studentName: string; status: AttStatus; notes: string }
interface RegisterPayload {
  exists: boolean;
  markedByName: string | null;
  markedByMe: boolean;
  lastMarkedAt: string | null;
  records: RegisterRow[];
}

/** The register endpoint keys a session by its period label, which only the
 *  server knows how to derive from a start time — so lift it from the deep
 *  link the server already built for this session. */
const periodFromDeepLink = (link: string) => new URLSearchParams(link.split('?')[1] || '').get('period') || 'Morning';

/** Pre-filled "new excuse" link for this exact session. */
const excuseLinkFor = (s: CalendarSession, date: string) => newExcuseLink({
  date, classId: s.classId, className: s.className, sessionType: s.kind,
  period: periodFromDeepLink(s.deepLink), subjectId: s.subjectId, subjectName: s.subjectName,
});

export const SessionDetail: React.FC = () => {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { can } = usePermissions();
  const { user } = useAuth();
  const canMark = can('ATTENDANCE_MARK');
  const isStudent = user?.role === 'student';

  const query = useMemo(() => ({
    date: params.get('date') || '',
    classId: params.get('classId') || '',
    sessionType: params.get('sessionType') || 'subject',
    subjectId: params.get('subjectId') ? Number(params.get('subjectId')) : null,
    start: params.get('start'),
  }), [params]);
  const validQuery = DATE_RE.test(query.date) && query.classId !== '' && (query.sessionType === 'homeroom' || query.sessionType === 'subject');

  const [session, setSession] = useState<CalendarSession | null>(null);
  // A student's absence for this session, with the excuse already filed for
  // it (if any) — so the page offers "submit an excuse" or "see your excuse",
  // never a duplicate.
  const [absence, setAbsence] = useState<Absence | null>(null);
  const [register, setRegister] = useState<RegisterPayload | null>(null);
  const [registerError, setRegisterError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    if (!validQuery) { setLoading(false); return; }
    setLoading(true); setError(null); setNotFound(false); setRegister(null); setRegisterError(false); setAbsence(null);
    try {
      const day = await getScheduleDay(query.date);
      const found = findSession(day.sessions, query);
      if (!found) { setNotFound(true); return; }
      setSession(found);

      if (isStudent && found.ownStatus === 'absent') {
        try {
          const mine = await getMyAbsences();
          setAbsence(mine.find((a) =>
            a.date === query.date && a.sessionType === found.kind && a.classId === found.classId
            && (found.kind !== 'subject' || a.subjectId === found.subjectId)
          ) ?? null);
        } catch {
          // Without the list we simply offer the form; the server still de-duplicates.
        }
      }

      if (canMark) {
        const qs = new URLSearchParams({
          classId: found.classId, date: query.date, sessionType: found.kind, period: periodFromDeepLink(found.deepLink),
          ...(found.kind === 'subject' && found.subjectId != null ? { subjectId: String(found.subjectId) } : {}),
        });
        try {
          const r = await apiGet<RegisterPayload>(`/api/attendance/session?${qs.toString()}`);
          setRegister(r.data ?? null);
        } catch {
          // The session summary is still worth showing without its roster.
          setRegisterError(true);
        }
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this lesson.');
    } finally {
      setLoading(false);
    }
  }, [query, validQuery, canMark, isStudent]);

  useEffect(() => { load(); }, [load]);

  const calendarLink = `/attendance?view=day&date=${validQuery ? query.date : isoDate()}`;
  const backBtn = (
    <Link to={calendarLink} className="btn btn-outline"><ArrowLeft size={16} /> Back to calendar</Link>
  );

  if (!validQuery) {
    return (
      <DashboardLayout>
        <div className="page-header"><div><h1 className="page-title">Lesson</h1></div>{backBtn}</div>
        <ErrorState message="That link is missing the lesson it should open." />
      </DashboardLayout>
    );
  }

  const phase = session ? phaseOf(session, query.date) : null;
  const meta = phase ? PHASE_META[phase] : null;
  const title = session
    ? session.kind === 'homeroom' ? 'Morning check' : session.subjectName || 'Lesson'
    : 'Lesson';
  const stats = session?.stats;

  return (
    <DashboardLayout>
      <div className="page-header">
        <div>
          <h1 className="page-title">{title}</h1>
          <p className="page-subtitle">
            {session ? `${session.className} · ${longDate(query.date)}` : longDate(query.date)}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap" style={{ marginTop: 6 }}>
          {backBtn}
          {session && canMark && (
            <button className="btn btn-primary" onClick={() => navigate(session.deepLink)}>
              <PenLine size={16} /> {session.status === 'recorded' ? 'Update register' : 'Take register'}
            </button>
          )}
          {session && isStudent && session.ownStatus === 'absent' && (
            absence?.excuse ? (
              <Link to={`/excuses/${absence.excuse.id}`} className="btn btn-outline">
                <FileText size={16} /> Your excuse <ExcuseStatusBadge status={absence.excuse.status} />
              </Link>
            ) : (
              <Link to={excuseLinkFor(session, query.date)} className="btn btn-primary">
                <FileText size={16} /> Submit an excuse
              </Link>
            )
          )}
        </div>
      </div>

      {loading ? (
        <div className="cal-skel" style={{ height: 320 }} />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : notFound || !session || !meta ? (
        <div className="cal-empty">
          <CalendarDays size={30} />
          <span className="text-sm">This lesson isn't on the timetable for {longDate(query.date)}.</span>
          <span className="text-xs">It may have moved, or the academic term in the top bar may not match.</span>
        </div>
      ) : (
        <div className="sd">
          {/* Summary: what, when, where, who — and its state at a glance */}
          <section className="sd-hero card" style={{ ['--spine' as string]: session.color || 'var(--subject-fallback)' }}>
            <div className="sd-hero-head">
              <span className="sd-hero-icon">
                {session.kind === 'homeroom' ? <Sun size={18} /> : <BookOpen size={18} />}
              </span>
              <div className="sd-hero-title">
                <div className="sd-hero-name">{title}</div>
                {session.subjectCode && <div className="sd-hero-code">{session.subjectCode}</div>}
              </div>
              <span className={`sd-phase ${meta.cls}`}>{meta.icon} {meta.label}</span>
            </div>

            <dl className="sd-meta">
              <div><dt><CalendarDays size={13} /> Date</dt><dd>{longDate(query.date)}</dd></div>
              <div>
                <dt><Clock size={13} /> Time</dt>
                <dd>{clock(session.startTime)}{session.endTime ? ` – ${clock(session.endTime)}` : ''}</dd>
              </div>
              <div><dt><Users size={13} /> Class</dt><dd>{session.className}</dd></div>
              {session.room && <div><dt><MapPin size={13} /> Room</dt><dd>{session.room}</dd></div>}
              {session.kind === 'subject' && (
                <div>
                  <dt><User size={13} /> Teacher</dt>
                  <dd>{session.isMine && !isStudent ? 'You' : session.teacherName || 'Not assigned'}</dd>
                </div>
              )}
              {session.subjectCode && <div><dt><Hash size={13} /> Code</dt><dd>{session.subjectCode}</dd></div>}
            </dl>

            {phase === 'overdue' && (
              <div className="sd-warning"><AlertTriangle size={14} /> Attendance wasn't taken in time for this lesson.</div>
            )}
          </section>

          {/* A student's own mark is the one number they came for */}
          {isStudent && (
            <section className="card card-pad sd-own">
              <div className="sd-section-title"><Eye size={15} /> Your attendance</div>
              {session.ownStatus ? (
                <StatusChip kind={session.ownStatus} className="sd-own-chip" />
              ) : (
                <span className="sd-own-pending"><CircleDashed size={14} /> Not yet recorded for this lesson.</span>
              )}
              {session.ownStatus === 'absent' && (
                absence?.excuse ? (
                  <div className="sd-own-excuse">
                    <span className="text-sm text-secondary">You’ve explained this absence:</span>
                    <Link to={`/excuses/${absence.excuse.id}`} className="ex-alert-link text-sm">
                      <ExcuseStatusBadge status={absence.excuse.status} /> View request
                    </Link>
                  </div>
                ) : (
                  <div className="sd-own-excuse">
                    <span className="text-sm text-secondary">Were you away for a reason? Explain it and a teacher will review it.</span>
                    <Link to={excuseLinkFor(session, query.date)} className="btn btn-outline btn-sm" style={{ alignSelf: 'flex-start' }}>
                      <FileText size={14} /> Submit an excuse for this absence
                    </Link>
                  </div>
                )
              )}
            </section>
          )}

          {/* Class totals */}
          {!isStudent && (
            <section>
              <div className="sd-section-title"><Users size={15} /> Class attendance</div>
              {session.status === 'recorded' && stats ? (
                <div className="sd-stats">
                  <div className="stat-card" style={{ ['--accent-color' as string]: 'var(--status-present)' }}>
                    <div className="stat-value">{stats.present}</div><div className="stat-label">Present</div>
                  </div>
                  <div className="stat-card" style={{ ['--accent-color' as string]: 'var(--status-absent)' }}>
                    <div className="stat-value">{stats.absent}</div><div className="stat-label">Absent</div>
                  </div>
                  <div className="stat-card" style={{ ['--accent-color' as string]: 'var(--status-late)' }}>
                    <div className="stat-value">{stats.late}</div><div className="stat-label">Late</div>
                  </div>
                  <div className="stat-card" style={{ ['--accent-color' as string]: 'var(--status-excused)' }}>
                    <div className="stat-value">{stats.excused}</div><div className="stat-label">Excused</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-value">{stats.total}</div><div className="stat-label">Marked</div>
                  </div>
                </div>
              ) : (
                <div className="card card-pad sd-none">
                  <CircleDashed size={18} />
                  <div>
                    <div className="font-semibold text-sm">No register yet</div>
                    <div className="text-xs text-secondary">
                      {phase === 'upcoming' ? "This lesson hasn't happened yet." : 'Attendance has not been recorded for this lesson.'}
                    </div>
                  </div>
                  {canMark && (
                    <button className="btn btn-primary btn-sm" onClick={() => navigate(session.deepLink)}>
                      <PenLine size={13} /> Take register
                    </button>
                  )}
                </div>
              )}
            </section>
          )}

          {/* Per-student list — only for those who can take the register */}
          {canMark && (
            <section className="card">
              <div className="card-header">
                <div>
                  <div className="sd-section-title" style={{ margin: 0 }}><PenLine size={15} /> Register</div>
                  {register?.exists && (
                    <div className="card-subtitle">
                      Marked by {register.markedByMe ? 'you' : register.markedByName || 'a teacher'}
                      {register.lastMarkedAt ? ` · ${fmtWhen(register.lastMarkedAt)}` : ''}
                    </div>
                  )}
                </div>
                <Link to={session.deepLink} className="btn btn-ghost btn-sm">
                  Open full register <ExternalLink size={13} />
                </Link>
              </div>
              {registerError ? (
                <div className="card-body text-sm text-secondary">Couldn't load the student list for this lesson.</div>
              ) : !register?.exists ? (
                <div className="card-body text-sm text-secondary">No students have been marked for this lesson yet.</div>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr><th>Student</th><th>Status</th><th>Notes</th></tr>
                    </thead>
                    <tbody>
                      {register.records.map((r) => (
                        <tr key={r.studentId}>
                          <td>{r.studentName}</td>
                          <td><StatusChip kind={r.status} /></td>
                          <td className="text-secondary">{r.notes || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </DashboardLayout>
  );
};

export default SessionDetail;
