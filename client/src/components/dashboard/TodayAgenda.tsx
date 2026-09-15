import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  CalendarClock, ArrowRight, Sun, BookOpen, MapPin, Clock, CheckCircle2, AlertTriangle, CircleDashed,
  PenLine, ChevronRight, CalendarDays, FileText,
} from 'lucide-react';
import { getScheduleDay, sessionDetailLink, type DayResponse, type CalendarSession } from '../../api/schedule';
import { newExcuseLinkForSession } from '../../api/excuses';
import { StatusChip } from '../attendance/StatusChip';
import { usePermissions } from '../../hooks/usePermissions';
import { useAuth } from '../../context/AuthContext';
import { isoDate, clock } from '../../utils/time';

const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const nowMin = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); };
const todayLabel = () => new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

type Phase = 'done' | 'now' | 'overdue' | 'upcoming';
function phaseOf(s: CalendarSession, now: number): Phase {
  if (s.status === 'recorded') return 'done';
  const start = toMin(s.startTime);
  const end = s.endTime ? toMin(s.endTime) : start + 40;
  if (now >= start && now < end) return 'now';
  if (now >= end) return 'overdue';
  return 'upcoming';
}

/**
 * Today's timetable on the dashboard — the day view of the calendar, boiled
 * down to what matters on a landing page: each lesson in order, whether its
 * register is done, which one is on now, and one click to act. Staff get
 * "take register"; a student sees their own mark and can explain an
 * absence from here. Self-fetching, so a calendar hiccup never takes the
 * rest of the dashboard down with it.
 */
export const TodayAgenda: React.FC = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { can } = usePermissions();
  const canMark = can('ATTENDANCE_MARK');
  const isStudent = user?.role === 'student';

  const [day, setDay] = useState<DayResponse | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [now, setNow] = useState(nowMin());

  useEffect(() => {
    getScheduleDay().then((d) => { setDay(d); setState('ready'); }).catch(() => setState('error'));
    const t = setInterval(() => setNow(nowMin()), 60_000);
    return () => clearInterval(t);
  }, []);

  const sessions = useMemo(() => {
    if (!day) return [];
    // One morning check (the first) plus every lesson, in time order.
    let seenHomeroom = false;
    return day.sessions
      .filter((s) => { if (s.kind !== 'homeroom') return true; if (seenHomeroom) return false; seenHomeroom = true; return true; })
      .sort((a, b) => toMin(a.startTime) - toMin(b.startTime));
  }, [day]);

  const date = isoDate();
  const progress = day?.progress ?? { done: 0, total: 0 };
  const overdue = !isStudent ? sessions.filter((s) => phaseOf(s, now) === 'overdue').length : 0;
  const nextUp = sessions.find((s) => phaseOf(s, now) === 'now') ?? sessions.find((s) => phaseOf(s, now) === 'upcoming');

  return (
    <section className="card ta mb-6">
      <div className="card-header">
        <div className="flex items-center gap-3">
          <span className="section-icon"><CalendarClock size={16} /></span>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="section-title">Today</span>
              {!isStudent && progress.total > 0 && (
                <span className={`count-badge${progress.done === progress.total ? ' is-done' : ''}`}>{progress.done}/{progress.total} registers</span>
              )}
              {overdue > 0 && <span className="ta-overdue-pill"><AlertTriangle size={11} /> {overdue} overdue</span>}
            </div>
            <div className="card-subtitle">{todayLabel()}</div>
          </div>
        </div>
        <Link to="/attendance?view=day" className="btn btn-ghost btn-sm">Open calendar <ArrowRight size={14} /></Link>
      </div>

      {state === 'loading' ? (
        <div className="ta-list">{[0, 1, 2].map((i) => <div key={i} className="rp-skeleton" style={{ height: 52 }} />)}</div>
      ) : state === 'error' ? (
        <div className="empty-state" style={{ padding: '28px 0' }}>
          <CalendarDays size={24} /><span className="text-sm">Couldn’t load today’s timetable.</span>
        </div>
      ) : !day?.timetableAvailable || sessions.length === 0 ? (
        <div className="empty-state" style={{ padding: '28px 0' }}>
          <Sun size={24} />
          <span className="text-sm">{day?.timetableAvailable ? 'Nothing scheduled today.' : 'No timetable for today.'}</span>
          <span className="text-xs text-secondary">Enjoy the quiet — or check the week in the calendar.</span>
        </div>
      ) : (
        <ol className="ta-list">
          {sessions.map((s) => {
            const phase = phaseOf(s, now);
            const detail = sessionDetailLink(s, date);
            const title = s.kind === 'homeroom' ? 'Morning check' : (s.subjectName || 'Lesson');
            const isNext = nextUp === s;
            return (
              <li
                key={`${s.kind}-${s.classId}-${s.subjectId ?? 'hr'}-${s.startTime}`}
                className={`ta-row is-${phase}${isNext ? ' is-next' : ''}`}
                style={{ ['--spine' as string]: s.color || (s.kind === 'homeroom' ? 'var(--warning)' : 'var(--subject-fallback)') }}
                role="link"
                tabIndex={0}
                onClick={() => navigate(detail)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(detail); } }}
                aria-label={`${title} · ${s.className} at ${clock(s.startTime)} — details`}
              >
                <div className="ta-time">
                  <span className="ta-start">{clock(s.startTime)}</span>
                  {s.endTime && <span className="ta-end">{clock(s.endTime)}</span>}
                </div>
                <span className="ta-spine" />
                <div className="ta-body">
                  <div className="ta-title">
                    {s.kind === 'homeroom' ? <Sun size={14} className="ta-icon" /> : <BookOpen size={14} className="ta-icon" />}
                    {title}
                    {phase === 'now' && <span className="ta-now"><Clock size={11} /> Now</span>}
                  </div>
                  <div className="ta-meta">
                    <span>{s.className}</span>
                    {s.room && <span><MapPin size={11} /> {s.room}</span>}
                    {!s.isMine && s.teacherName && !isStudent && <span>{s.teacherName}</span>}
                  </div>
                </div>
                <div className="ta-status" onClick={(e) => e.stopPropagation()}>
                  {isStudent ? (
                    <>
                      {s.ownStatus
                        ? <StatusChip kind={s.ownStatus} />
                        : <span className="ta-pending"><CircleDashed size={13} /> {phase === 'upcoming' || phase === 'now' ? 'Not yet' : 'Not recorded'}</span>}
                      {s.ownStatus === 'absent' && (
                        <Link to={newExcuseLinkForSession(s, date)} className="btn btn-outline btn-sm"><FileText size={13} /> Excuse</Link>
                      )}
                    </>
                  ) : phase === 'done' ? (
                    <>
                      <span className="ta-done"><CheckCircle2 size={13} /> Done</span>
                      {canMark && <button className="btn btn-ghost btn-sm" onClick={() => navigate(s.deepLink)}><PenLine size={13} /> Edit</button>}
                    </>
                  ) : phase === 'overdue' ? (
                    <>
                      <span className="ta-late"><AlertTriangle size={13} /> Overdue</span>
                      {canMark && <button className="btn btn-primary btn-sm" onClick={() => navigate(s.deepLink)}><PenLine size={13} /> Take register</button>}
                    </>
                  ) : canMark && phase === 'now' ? (
                    <button className="btn btn-primary btn-sm" onClick={() => navigate(s.deepLink)}><PenLine size={13} /> Take register</button>
                  ) : (
                    <span className="ta-upcoming">Upcoming</span>
                  )}
                  <ChevronRight size={15} className="ta-chevron" />
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
};
