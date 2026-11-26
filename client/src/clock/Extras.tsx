import { useState } from 'react';
import { ClockApiError, clockApi, type DayState, type Me } from './api';
import { notificationsBlocked, ReminderError, reminderSupport, subscribeReminders, unsubscribeReminders } from './reminders';
import type { Lang, T } from './i18n';
import { IconBell, IconClock, IconOut } from './icons';

/**
 * Under the big button on the daily screen: "you forgot to check out" (say when
 * you left; the office confirms) and the check-in / check-out reminders switch.
 */

const minus = (hhmm: string, minutes: number) => {
  const m = Math.max(0, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) - minutes);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

export function MissedCheckout(p: { t: T; slug: string; token: string; locale: string; missed: NonNullable<DayState['missedOut']>; onState: (s: DayState) => void; flash: (text: string, bad?: boolean) => void }) {
  const { t } = p;
  const [time, setTime] = useState('');
  const [busy, setBusy] = useState(false);
  const day = new Date(`${p.missed.date}T12:00:00Z`).toLocaleDateString(p.locale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  const tooEarly = !!time && !!p.missed.checkIn && time <= p.missed.checkIn;
  const send = async () => {
    setBusy(true);
    try {
      p.onState(await clockApi.missedCheckout(p.slug, p.token, { date: p.missed.date, time }));
      p.flash(t('missedSent'));
    } catch (err) {
      p.flash(err instanceof ClockApiError ? err.message : t('somethingWrong'), true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ck-x ck-x-warn" role="group" aria-label={t('missedTitle')} data-testid="missed-out">
      <div className="ck-x-head"><span className="ck-x-icon"><IconOut size={18} /></span><b>{t('missedTitle')}</b></div>
      <p>{t('missedLead', { day, time: p.missed.checkIn ?? '' })}</p>
      <div className="ck-x-row">
        <input className="ck-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label={t('missedAsk')} aria-invalid={tooEarly} />
        <button className="ck-x-btn" disabled={!time || tooEarly || busy} onClick={() => void send()}>{busy ? t('sending') : t('missedSend')}</button>
      </div>
      <small>{tooEarly ? t('missedTooEarly', { time: p.missed.checkIn ?? '' }) : t('missedNote')}</small>
    </div>
  );
}

export function Reminders(p: { t: T; lang: Lang; slug: string; token: string; pushKey: string; minutes: number; me: Me; onChange: (on: boolean) => void; flash: (text: string, bad?: boolean) => void }) {
  const { t, me } = p;
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(notificationsBlocked);
  const support = reminderSupport();
  const on = me.reminders?.on === true && support === 'ok' && !blocked;
  const start = me.rules.lateAfter;
  const end = me.rules.earlyLeaveBefore;
  const when = start && end ? t('remindWhen', { in: minus(start, p.minutes), out: minus(end, p.minutes) }) : t('remindWhenOff');

  const turnOn = async () => {
    setBusy(true);
    try {
      const subscription = await subscribeReminders(p.pushKey);
      const r = await clockApi.pushOn(p.slug, p.token, { subscription, lang: p.lang, test: true });
      p.onChange(true);
      p.flash(r.tested ? t('remindOnTested') : t('remindOnDone'));
    } catch (err) {
      if (err instanceof ReminderError && err.kind === 'blocked') setBlocked(true);
      else p.flash(err instanceof ClockApiError ? err.message : t('remindFailed'), true);
    } finally {
      setBusy(false);
    }
  };
  const turnOff = async () => {
    setBusy(true);
    try {
      await clockApi.pushOff(p.slug, p.token);
      await unsubscribeReminders();
      p.onChange(false);
      p.flash(t('remindOffDone'));
    } catch {
      p.flash(t('somethingWrong'), true);
    } finally {
      setBusy(false);
    }
  };

  if (support === 'unsupported') return null;
  return (
    <div className={`ck-x${on ? ' ck-x-on' : ''}`} role="group" aria-label={t('remindTitle')} data-testid="reminders">
      <div className="ck-x-head">
        <span className="ck-x-icon"><IconBell size={18} /></span>
        <b>{on ? t('remindOn') : t('remindTitle')}</b>
        {support === 'ok' && !blocked && (
          <button className={`ck-x-btn${on ? ' ck-x-btn-quiet' : ''}`} disabled={busy} onClick={() => void (on ? turnOff() : turnOn())} data-testid="reminders-toggle">
            {busy ? t('oneMoment') : on ? t('remindTurnOff') : t('remindTurnOn')}
          </button>
        )}
      </div>
      <p>{support === 'needs_install' ? t('remindInstall') : blocked ? t('remindBlocked') : on ? when : t('remindLead', { minutes: p.minutes })}</p>
    </div>
  );
}

const WEEK_ORDER = ['1', '2', '3', '4', '5', '6', '0'];

/** The person's own working week: today's hours at a glance, the seven days on request. */
export function MyHours(p: { t: T; locale: string; week: NonNullable<Me['myWeek']>; schoolDate: string }) {
  const { t, week } = p;
  const [open, setOpen] = useState(false);
  const todayKey = String(new Date(`${p.schoolDate}T12:00:00Z`).getUTCDay());
  const today = week.days[todayKey];
  // 2024-09-01 was a Sunday: a fixed week to name the days in the page's language.
  const name = (d: string) => new Date(Date.UTC(2024, 8, 1 + Number(d), 12)).toLocaleDateString(p.locale, { weekday: 'long', timeZone: 'UTC' });
  return (
    <div className="ck-x" role="group" aria-label={t('myHours')} data-testid="my-hours">
      <div className="ck-x-head">
        <span className="ck-x-icon"><IconClock size={18} /></span>
        <b>{t('myHours')}</b>
        <button className="ck-x-btn ck-x-btn-quiet" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? t('myHoursHide') : t('myHoursShow')}</button>
      </div>
      <p>{today?.works ? t('myHoursToday', { start: today.start, end: today.end }) : t('myHoursTodayOff')} · {week.own ? t('myHoursOwn') : t('myHoursSchool')}</p>
      {open && (
        <>
          <ul className="ck-hours">
            {WEEK_ORDER.map((d) => {
              const day = week.days[d];
              return (
                <li key={d} className={`${d === todayKey ? 'today' : ''}${day?.works ? '' : ' off'}`}>
                  <span>{name(d)}</span>
                  <b>{day?.works ? `${day.start} – ${day.end}` : t('myHoursOff')}</b>
                </li>
              );
            })}
          </ul>
          <small>{t('myHoursNote')}</small>
        </>
      )}
    </div>
  );
}
