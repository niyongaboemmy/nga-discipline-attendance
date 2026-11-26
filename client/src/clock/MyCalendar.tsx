import { useEffect, useMemo, useState } from 'react';
import { clockApi, type Me, type MyCalendar as Cal, type MyDay, type MyDayKind } from './api';
import type { T } from './i18n';
import { IconChevron, IconClock } from './icons';

/**
 * The person's own calendar on the check-in page: a month of their days. Each
 * square says when they are expected at school (their own hours, or the school's),
 * which days are off or closed, and what was recorded on the days gone by. A tap on
 * a day gives its detail; "Weekly hours" shows the plan as a simple list.
 */

const WEEK_ORDER = ['1', '2', '3', '4', '5', '6', '0'];
const KIND_KEY: Record<MyDayKind, Parameters<T>[0]> = {
  on_time: 'calOnTime', late: 'calLateK', absent: 'calAbsentK', today: 'calTodayK', planned: 'calPlanned', off: 'calOff', closed: 'calClosed', untracked: 'calUntracked',
};
const shift = (month: string, n: number) => {
  const d = new Date(`${month}-15T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
};

export function MyCalendar(p: { t: T; locale: string; slug: string; token: string; me: Me }) {
  const { t, me } = p;
  const [view, setView] = useState<'month' | 'week'>('month');
  const [month, setMonth] = useState<string | null>(null);
  const [cal, setCal] = useState<Cal | null>(null);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  // Reload when today's taps change, so the square of today follows the big button.
  const stamp = `${me.today?.checkIn ?? ''}|${me.today?.checkOut ?? ''}`;

  useEffect(() => {
    let live = true;
    clockApi.calendar(p.slug, p.token, month ?? undefined)
      .then((c) => { if (live) { setCal(c); setFailed(false); setPicked((d) => (d && d.startsWith(c.month) ? d : c.today.startsWith(c.month) ? c.today : null)); } })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [p.slug, p.token, month, stamp]);

  const fmt = (date: string, opts: Intl.DateTimeFormatOptions) => new Date(`${date}T12:00:00Z`).toLocaleDateString(p.locale, { ...opts, timeZone: 'UTC' });
  // 2024-09-01 was a Sunday: a fixed week to name the days in the page's language.
  const dayName = (d: string, style: 'long' | 'narrow') => new Date(Date.UTC(2024, 8, 1 + Number(d), 12)).toLocaleDateString(p.locale, { weekday: style, timeZone: 'UTC' });

  const cells = useMemo(() => {
    if (!cal) return [] as Array<MyDay | null>;
    const lead = (new Date(`${cal.days[0].date}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday first
    const out: Array<MyDay | null> = [...Array(lead).fill(null), ...cal.days];
    while (out.length % 7) out.push(null);
    return out;
  }, [cal]);
  const sel = cal && picked ? cal.days.find((d) => d.date === picked) ?? null : null;
  const loading = !cal || (month != null && cal.month !== month);
  const shown = month ?? cal?.month ?? me.schoolDate.slice(0, 7);
  const s = cal?.summary;
  const hoursText = s ? `${Math.floor(s.plannedMinutes / 60)}${s.plannedMinutes % 60 ? `:${String(s.plannedMinutes % 60).padStart(2, '0')}` : ''}` : '';
  const todayKey = String(new Date(`${me.schoolDate}T12:00:00Z`).getUTCDay());
  const line = (d: MyDay) => (d.in ? d.in : d.start ? d.start : '');

  return (
    <section className="ck-cal" aria-label={t('calTitle')} data-testid="my-calendar">
      <div className="ck-cal-head">
        <span className="ck-x-icon"><IconClock size={18} /></span>
        <b>{t('calTitle')}</b>
        <div className="ck-cal-seg" role="group" aria-label={t('calTitle')}>
          <button aria-pressed={view === 'month'} onClick={() => setView('month')}>{t('calMonth')}</button>
          <button aria-pressed={view === 'week'} onClick={() => setView('week')} data-testid="cal-weekly">{t('calWeekly')}</button>
        </div>
      </div>

      {view === 'week' ? (
        me.myWeek ? (
          <>
            <p className="ck-cal-sub">{me.myWeek.own ? t('myHoursOwn') : t('myHoursSchool')}</p>
            <ul className="ck-hours">
              {WEEK_ORDER.map((d) => {
                const day = me.myWeek!.days[d];
                return (
                  <li key={d} className={`${d === todayKey ? 'today' : ''}${day?.works ? '' : ' off'}`}>
                    <span>{dayName(d, 'long')}</span>
                    <b>{day?.works ? `${day.start} – ${day.end}` : t('myHoursOff')}</b>
                  </li>
                );
              })}
            </ul>
            <small className="ck-cal-note">{t('myHoursNote')}</small>
          </>
        ) : null
      ) : (
        <>
          <div className="ck-cal-nav">
            <button onClick={() => setMonth(shift(shown, -1))} disabled={!cal || shown <= cal.min} aria-label={t('calPrev')}><span className="ck-cal-flip"><IconChevron size={18} /></span></button>
            <b aria-live="polite">{fmt(`${shown}-01`, { month: 'long', year: 'numeric' })}</b>
            <button onClick={() => setMonth(shift(shown, 1))} disabled={!cal || shown >= cal.max} aria-label={t('calNext')}><IconChevron size={18} /></button>
          </div>
          {failed && !cal ? (
            <p className="ck-cal-sub" role="alert">{t('calFail')}</p>
          ) : (
            <>
              <div className="ck-cal-chips" aria-busy={loading}>
                {s && !loading ? (
                  <>
                    <span>{t('calWorkDays', { n: s.workDays })}</span>
                    <span>{t('calHours', { h: hoursText })}</span>
                    {s.worked > 0 && <span className="on">{t('calWorked', { n: s.worked })}</span>}
                    {s.late > 0 && <span className="late">{t('calLate', { n: s.late })}</span>}
                    {s.absent > 0 && <span className="abs">{t('calAbsent', { n: s.absent })}</span>}
                    {s.left > 0 && <span>{t('calLeft', { n: s.left })}</span>}
                  </>
                ) : <span className="ck-cal-skel" style={{ width: 220 }} />}
              </div>
              <div className="ck-cal-grid" role="grid" aria-label={fmt(`${shown}-01`, { month: 'long', year: 'numeric' })}>
                {WEEK_ORDER.map((d) => <span key={d} className="ck-cal-wd" aria-hidden="true">{dayName(d, 'narrow')}</span>)}
                {loading
                  ? Array.from({ length: 35 }, (_, i) => <span key={i} className="ck-cal-cell ck-cal-skel" />)
                  : cells.map((d, i) => d ? (
                    <button key={d.date} role="gridcell" className={`ck-cal-cell k-${d.kind}${d.date === cal!.today ? ' is-today' : ''}${picked === d.date ? ' is-picked' : ''}`}
                      aria-label={`${fmt(d.date, { weekday: 'long', day: 'numeric', month: 'long' })}: ${t(KIND_KEY[d.kind])}${d.start ? `, ${d.start} – ${d.end}` : ''}`}
                      aria-selected={picked === d.date} onClick={() => setPicked(d.date)}>
                      <span className="ck-cal-n">{Number(d.date.slice(8))}</span>
                      <span className="ck-cal-t">{line(d)}</span>
                      {(d.noOut || d.early) && <i className="ck-cal-flag" />}
                    </button>
                  ) : <span key={`b${i}`} className="ck-cal-cell k-blank" />)}
              </div>
              {sel && !loading && (
                <div className="ck-cal-day" aria-live="polite">
                  <div className="ck-cal-day-head">
                    <b>{fmt(sel.date, { weekday: 'long', day: 'numeric', month: 'long' })}</b>
                    <span className={`ck-cal-pill k-${sel.kind}`}><i />{t(KIND_KEY[sel.kind])}</span>
                  </div>
                  <div className="ck-cal-facts">
                    {sel.start && sel.end && <span>{t('calExpected', { start: sel.start, end: sel.end })}</span>}
                    {sel.in && <span>{t('calIn', { time: sel.in })}</span>}
                    {sel.out && <span>{t('calOut', { time: sel.out })}</span>}
                    {sel.noOut && <span className="warn">{t('calNoOut')}</span>}
                    {sel.early && <span className="warn">{t('calEarly')}</span>}
                  </div>
                </div>
              )}
              <div className="ck-cal-legend" aria-hidden="true">
                {(['on_time', 'late', 'absent', 'planned', 'off'] as MyDayKind[]).map((k) => <span key={k}><i className={`k-${k}`} />{t(KIND_KEY[k])}</span>)}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
