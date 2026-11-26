import React from 'react';
import { ArrowUpRight, BellRing, CalendarOff, Clock, DoorOpen, Hourglass, TimerOff, UserCheck, UserX, Users } from 'lucide-react';
import type { Overview } from '../../api/staffClock';

/**
 * The school at this minute, first thing on the dashboard: who should be here now
 * (each person's own hours), who is, who is not, who starts later, who has a day
 * off. Every number opens its list; "not here" can be reminded from there.
 */

import type { NowGroup } from './nowList';

export const NowBoard: React.FC<{ overview: Overview; onOpen: (g: NowGroup) => void }> = ({ overview, onOpen }) => {
  const n = overview.now;
  if (!n) return null;
  const share = n.shouldBeHere ? Math.round((n.here / n.shouldBeHere) * 100) : null;
  const quiet = n.shouldBeHere === 0;
  const tiles: Array<{ g: NowGroup; icon: React.ReactNode; value: number; label: string; tone?: 'warn' | 'bad' | 'on'; hide?: boolean }> = [
    { g: 'here', icon: <UserCheck size={18} />, value: n.here, label: 'here now', tone: 'on' },
    { g: 'notHere', icon: <UserX size={18} />, value: n.notHere, label: 'not here yet', tone: n.notHere ? 'bad' : undefined },
    { g: 'late', icon: <TimerOff size={18} />, value: n.late, label: 'late today', tone: n.late ? 'warn' : undefined },
    { g: 'later', icon: <Hourglass size={18} />, value: n.startsLater, label: 'start later' },
    { g: 'left', icon: <DoorOpen size={18} />, value: n.left + n.leftEarly, label: n.leftEarly ? `left · ${n.leftEarly} early` : 'left' },
    { g: 'missed', icon: <BellRing size={18} />, value: n.missed, label: 'absent today', tone: n.missed ? 'bad' : undefined, hide: n.missed === 0 },
    { g: 'dayOff', icon: <CalendarOff size={18} />, value: n.dayOff, label: 'day off' },
  ];
  return (
    <section className="sc-card now" aria-label="Right now" data-testid="now-board">
      <div className="now-head">
        <div>
          <p className="sc-card-sub now-kicker"><i className="now-live" />Right now · {n.at}</p>
          <button type="button" className="now-main" onClick={() => onOpen('should')} data-now="should">
            <b className="sc-num">{quiet ? '–' : `${n.here} of ${n.shouldBeHere}`}</b>
            <span>{quiet ? (n.startsLater ? 'nobody is due yet' : n.expectedToday ? 'the day is over' : 'nobody is expected today') : 'who should be here are here'}</span>
            <ArrowUpRight size={18} />
          </button>
        </div>
        <button type="button" className="now-expected" onClick={() => onOpen('expected')} data-now="expected">
          <Users size={16} /><span><b className="sc-num">{n.expectedToday}</b> expected today</span><Clock size={14} />
        </button>
      </div>
      {!quiet && (
        <div className="now-bar" role="img" aria-label={`${n.here} here, ${n.notHere} not here yet, ${n.leftEarly} left early, of ${n.shouldBeHere} who should be here now`}>
          <i className="now-bar-here" style={{ flex: n.here || 0.0001 }} />
          <i className="now-bar-early" style={{ flex: n.leftEarly || 0.0001 }} />
          <i className="now-bar-out" style={{ flex: n.notHere || 0.0001 }} />
          {share != null && <span className="sc-num">{share}%</span>}
        </div>
      )}
      <div className="now-tiles">
        {tiles.filter((t) => !t.hide).map((t) => (
          <button key={t.g} type="button" className="now-tile" data-now={t.g} data-tone={t.value ? t.tone : undefined} onClick={() => onOpen(t.g)}>
            <span className="now-tile-icon">{t.icon}</span>
            <b className="sc-num">{t.value}</b>
            <small>{t.label}</small>
          </button>
        ))}
      </div>
    </section>
  );
};
