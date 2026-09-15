import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, Clock, MapPin, User, PenLine, AlertTriangle, CheckCircle2, Eye, ArrowRight } from 'lucide-react';
import type { CalendarSession } from '../../api/schedule';
import { StatusChip } from './StatusChip';

export interface HoverTarget {
  session: CalendarSession;
  date: string;
  rect: DOMRect;
}

const dayLabel = (dateStr: string) =>
  new Date(`${dateStr}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

/**
 * A rich hover preview for a calendar lesson block — the compact week-grid
 * cards don't have room for stats/owner/room, so rather than forcing a click
 * to find out, hovering surfaces it plus a one-click action. Portaled to
 * <body> so it escapes the week grid's `overflow-x: auto` clipping, and
 * positioned from the trigger's live bounding rect, clamped to the viewport.
 */
export const EventHoverCard: React.FC<{
  target: HoverTarget;
  overdue: boolean;
  isNow: boolean;
  canMark: boolean;
  /** Open the register drawer (markers only). */
  onOpen: () => void;
  /** Go to the session detail page. */
  onNavigate: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}> = ({ target, overdue, isNow, canMark, onOpen, onNavigate, onMouseEnter, onMouseLeave }) => {
  const { session: s, date, rect } = target;
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; flip: boolean } | null>(null);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const w = card.offsetWidth || 300;
    const h = card.offsetHeight || 180;
    const gap = 10;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = rect.right + gap;
    let flip = false;
    if (left + w > vw - 8) { left = rect.left - w - gap; flip = true; }
    if (left < 8) left = Math.min(Math.max(8, rect.left), vw - w - 8);

    let top = rect.top + rect.height / 2 - h / 2;
    top = Math.min(Math.max(8, top), vh - h - 8);

    setPos({ top, left, flip });
  }, [rect]);

  const statusLabel = s.status === 'recorded' ? 'Recorded' : overdue ? 'Overdue' : isNow ? 'In progress' : 'Upcoming';
  const statusIcon = s.status === 'recorded'
    ? <CheckCircle2 size={13} />
    : overdue
      ? <AlertTriangle size={13} />
      : <Clock size={13} />;

  return createPortal(
    <div
      ref={cardRef}
      className={`event-hovercard${pos ? ' is-visible' : ''}${overdue ? ' is-overdue' : ''}`}
      style={{
        top: pos?.top ?? rect.top, left: pos?.left ?? rect.right,
        ...(s.color ? { ['--spine' as string]: s.color } : {}),
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      role="dialog"
      aria-label={`${s.subjectName ?? 'Lesson'} details`}
    >
      <div className="ehc-head">
        <span className="ehc-dot" />
        <div className="ehc-title-wrap">
          <div className="ehc-title">{s.subjectName || 'Lesson'}</div>
          <div className="ehc-day">{dayLabel(date)}</div>
        </div>
        <span className={`ehc-status is-${s.status === 'recorded' ? 'recorded' : overdue ? 'overdue' : isNow ? 'now' : 'upcoming'}`}>
          {statusIcon} {statusLabel}
        </span>
      </div>

      <div className="ehc-meta">
        <span><Clock size={12} /> {s.startTime}{s.endTime ? `–${s.endTime}` : ''}</span>
        <span><BookOpen size={12} /> {s.className}</span>
        {s.room && <span><MapPin size={12} /> {s.room}</span>}
        <span className={`ehc-owner${s.isMine ? ' is-me' : ''}`}>
          <User size={12} /> {s.isMine ? 'You' : s.teacherName || 'Another teacher'}
        </span>
      </div>

      {s.status === 'recorded' && s.stats && (
        <div className="ehc-stats">
          <StatusChip kind="present" label={`${s.stats.present}`} />
          {s.stats.absent > 0 && <StatusChip kind="absent" label={`${s.stats.absent}`} />}
          {s.stats.late > 0 && <StatusChip kind="late" label={`${s.stats.late}`} />}
          {s.stats.excused > 0 && <StatusChip kind="excused" label={`${s.stats.excused}`} />}
        </div>
      )}

      {overdue && (
        <div className="ehc-warning"><AlertTriangle size={12} /> Register wasn't taken in time</div>
      )}

      <div className="ehc-actions">
        {canMark && (
          <button className="ehc-btn is-primary" onClick={onOpen}>
            <PenLine size={13} /> {s.status === 'recorded' ? 'Update attendance' : 'Record attendance'}
          </button>
        )}
        <button className="ehc-btn" onClick={onNavigate}>
          <Eye size={13} /> View details <ArrowRight size={12} />
        </button>
      </div>
    </div>,
    document.body
  );
};
