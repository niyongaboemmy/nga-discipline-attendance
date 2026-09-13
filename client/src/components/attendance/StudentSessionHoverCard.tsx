import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Clock, MapPin, User, Sun, BookOpen, CheckCircle2, XCircle, ShieldCheck, CircleDashed } from 'lucide-react';
import type { CalendarSession, AttStatus } from '../../api/schedule';

export interface StudentHoverTarget {
  session: CalendarSession;
  date: string;
  rect: DOMRect;
}

const STATUS_META: Record<AttStatus, { label: string; icon: React.ReactNode; className: string }> = {
  present: { label: 'Present', icon: <CheckCircle2 size={14} />, className: 'is-present' },
  absent: { label: 'Absent', icon: <XCircle size={14} />, className: 'is-absent' },
  late: { label: 'Late', icon: <Clock size={14} />, className: 'is-late' },
  excused: { label: 'Excused', icon: <ShieldCheck size={14} />, className: 'is-excused' },
};

const dayLabel = (dateStr: string) =>
  new Date(`${dateStr}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

/**
 * The week view's cards truncate a long subject name to fit a narrow column
 * — hovering (or focusing, for keyboard users) reveals the rest: full name,
 * full time range, room, teacher, and status. Read-only, no action — this
 * calendar has nothing for a student to do here, just to see. Portaled to
 * <body> so it isn't clipped by any card's overflow, and positioned from the
 * trigger's live rect, flipping/clamping to stay on-screen.
 */
export const StudentSessionHoverCard: React.FC<{
  target: StudentHoverTarget;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}> = ({ target, onMouseEnter, onMouseLeave }) => {
  const { session: s, date, rect } = target;
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const w = card.offsetWidth || 280;
    const h = card.offsetHeight || 140;
    const gap = 10;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = rect.right + gap;
    if (left + w > vw - 8) left = rect.left - w - gap;
    if (left < 8) left = Math.min(Math.max(8, rect.left), vw - w - 8);

    let top = rect.top;
    top = Math.min(Math.max(8, top), vh - h - 8);

    setPos({ top, left });
  }, [rect]);

  const statusMeta = s.ownStatus ? STATUS_META[s.ownStatus] : null;

  return createPortal(
    <div
      ref={cardRef}
      className={`ssh-card${pos ? ' is-visible' : ''}`}
      style={{ top: pos?.top ?? rect.top, left: pos?.left ?? rect.right, ['--spine' as string]: s.color || 'var(--subject-fallback)' }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      role="dialog"
      aria-label={`${s.kind === 'homeroom' ? 'Morning check' : s.subjectName} details`}
    >
      <div className="ssh-head">
        <span className="ssh-icon">{s.kind === 'homeroom' ? <Sun size={15} /> : <BookOpen size={15} />}</span>
        <div className="ssh-title-wrap">
          <div className="ssh-title">{s.kind === 'homeroom' ? 'Morning check' : s.subjectName}</div>
          <div className="ssh-day">{dayLabel(date)}</div>
        </div>
      </div>

      <div className="ssh-meta">
        <span><Clock size={12} /> {s.startTime}{s.endTime ? `–${s.endTime}` : ''}</span>
        {s.room && <span><MapPin size={12} /> {s.room}</span>}
        {s.kind === 'subject' && !s.isMine && s.teacherName && <span><User size={12} /> {s.teacherName}</span>}
      </div>

      <div className={`ssh-status ${statusMeta ? statusMeta.className : 'is-pending'}`}>
        {statusMeta ? statusMeta.icon : <CircleDashed size={14} />}
        {statusMeta ? statusMeta.label : 'Not yet recorded'}
      </div>
    </div>,
    document.body
  );
};
