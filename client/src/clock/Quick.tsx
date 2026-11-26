import { useEffect, useRef } from 'react';
import type { Me } from './api';
import type { Lang, T } from './i18n';
import { MissedCheckout, Reminders } from './Extras';
import { MyCalendar } from './MyCalendar';
import { IconBell, IconOut } from './icons';

/**
 * The daily screen stays small: the clock, the big button and this week. Everything
 * else (my calendar, reminders, a forgotten check-out) opens in a popup: a sheet
 * from the bottom on a phone, a centred window on a tablet or a computer. The
 * popups are opened from quiet icons in the header (QuickIcons) and, for a
 * forgotten check-out, from one amber button (QuickMissed).
 */

export type QuickWhich = 'calendar' | 'reminders' | 'missed';

function Sheet(p: { label: string; closeLabel: string; onClose: () => void; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(p.onClose);
  useEffect(() => { close.current = p.onClose; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close.current(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    box.current?.focus();
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, []);
  return (
    <div className="ck-pop-back" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div className="ck-pop" role="dialog" aria-modal="true" aria-label={p.label} tabIndex={-1} ref={box} data-testid="ck-sheet">
        <div className="ck-pop-bar">
          <span className="ck-pop-grip" aria-hidden="true" />
          <button className="ck-pop-close" onClick={p.onClose} aria-label={p.closeLabel}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
        <div className="ck-pop-body">{p.children}</div>
      </div>
    </div>
  );
}

/** Header icons: my calendar, reminders (when this phone can have them). */
export function QuickIcons(p: { t: T; me: Me; canRemind: boolean; onOpen: (w: QuickWhich) => void }) {
  const { t, me } = p;
  const remindOn = me.reminders?.on === true;
  return (
    <>
      <button className="ck-e-icon" onClick={() => p.onOpen('calendar')} aria-label={t('calTitle')} title={t('calTitle')} data-testid="quick-calendar">
        <svg aria-hidden="true" width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="3" /><path d="M3.5 10h17" /><path d="M8 3v4" /><path d="M16 3v4" /></svg>
      </button>
      {p.canRemind && (
        <button className={`ck-e-icon${remindOn ? ' on' : ''}`} onClick={() => p.onOpen('reminders')} aria-label={remindOn ? t('quickRemindOn') : t('quickRemind')} title={remindOn ? t('quickRemindOn') : t('quickRemind')} data-testid="quick-reminders">
          <IconBell size={23} />
        </button>
      )}
    </>
  );
}

/** A day left without a check-out: the one thing on the page that asks for action. */
export function QuickMissed(p: { t: T; me: Me; onOpen: (w: QuickWhich) => void }) {
  if (!p.me.missedOut) return null;
  return (
    <button className="ck-e-alert" onClick={() => p.onOpen('missed')} data-testid="quick-missed">
      <IconOut size={18} /><span>{p.t('quickMissed')}</span>
    </button>
  );
}

export function QuickSheets(p: {
  t: T; lang: Lang; locale: string; slug: string; token: string; me: Me;
  open: QuickWhich | null;
  onClose: () => void;
  /** Web Push key and lead minutes, when the school has reminders on and this is not a computer */
  push: { key: string; minutes: number } | null;
  setMe: (fn: (m: Me | null) => Me | null) => void;
  flash: (text: string, bad?: boolean) => void;
}) {
  const { t, me } = p;
  const missed = me.missedOut ?? null;
  // The claim was sent: nothing left to show in that popup.
  const showing: QuickWhich | null = p.open === 'missed' && !missed ? null : p.open;
  return (
    <>
      {showing === 'calendar' && (
        <Sheet label={t('calTitle')} closeLabel={t('close')} onClose={p.onClose}>
          <MyCalendar t={t} locale={p.locale} slug={p.slug} token={p.token} me={me} />
        </Sheet>
      )}
      {showing === 'reminders' && p.push && (
        <Sheet label={t('remindTitle')} closeLabel={t('close')} onClose={p.onClose}>
          <Reminders t={t} lang={p.lang} slug={p.slug} token={p.token} pushKey={p.push.key} minutes={p.push.minutes} me={me} flash={p.flash}
            onChange={(on) => p.setMe((m) => (m ? { ...m, reminders: { on } } : m))} />
        </Sheet>
      )}
      {showing === 'missed' && missed && (
        <Sheet label={t('missedTitle')} closeLabel={t('close')} onClose={p.onClose}>
          <MissedCheckout t={t} slug={p.slug} token={p.token} locale={p.locale} missed={missed} flash={p.flash}
            onState={(st) => { p.setMe((m) => (m ? { ...m, ...st } : m)); p.onClose(); }} />
        </Sheet>
      )}
    </>
  );
}
