import { useEffect, useRef, useState } from 'react';
import type { Me } from './api';
import type { Lang, T } from './i18n';
import { MissedCheckout, Reminders } from './Extras';
import { MyCalendar } from './MyCalendar';
import { reminderSupport } from './reminders';
import { IconBell, IconClock, IconOut } from './icons';

/**
 * The daily screen stays small: the big button, this week, and a row of short
 * buttons. Everything else (my calendar, reminders, a forgotten check-out) opens
 * in a popup: a sheet from the bottom on a phone, a centred window on a tablet
 * or a computer.
 */

type Which = 'calendar' | 'reminders' | 'missed';

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

export function QuickActions(p: {
  t: T; lang: Lang; locale: string; slug: string; token: string; me: Me;
  /** Web Push key and lead minutes, when the school has reminders on and this is not a computer */
  push: { key: string; minutes: number } | null;
  setMe: (fn: (m: Me | null) => Me | null) => void;
  flash: (text: string, bad?: boolean) => void;
}) {
  const { t, me } = p;
  const [open, setOpen] = useState<Which | null>(null);
  const missed = me.missedOut ?? null;
  const canRemind = !!p.push && reminderSupport() !== 'unsupported';
  const remindOn = me.reminders?.on === true;
  // The claim was sent: nothing left to show in that popup.
  const showing: Which | null = open === 'missed' && !missed ? null : open;

  return (
    <>
      <div className="ck-quick" role="group" aria-label={t('quickMore')}>
        {missed && (
          <button className="ck-quick-btn warn" onClick={() => setOpen('missed')} data-testid="quick-missed">
            <IconOut size={18} /><span>{t('quickMissed')}</span>
          </button>
        )}
        <button className="ck-quick-btn" onClick={() => setOpen('calendar')} data-testid="quick-calendar">
          <IconClock size={18} /><span>{t('calTitle')}</span>
        </button>
        {canRemind && (
          <button className={`ck-quick-btn${remindOn ? ' on' : ''}`} onClick={() => setOpen('reminders')} data-testid="quick-reminders">
            <IconBell size={18} /><span>{remindOn ? t('quickRemindOn') : t('quickRemind')}</span>
          </button>
        )}
      </div>

      {showing === 'calendar' && (
        <Sheet label={t('calTitle')} closeLabel={t('close')} onClose={() => setOpen(null)}>
          <MyCalendar t={t} locale={p.locale} slug={p.slug} token={p.token} me={me} />
        </Sheet>
      )}
      {showing === 'reminders' && p.push && (
        <Sheet label={t('remindTitle')} closeLabel={t('close')} onClose={() => setOpen(null)}>
          <Reminders t={t} lang={p.lang} slug={p.slug} token={p.token} pushKey={p.push.key} minutes={p.push.minutes} me={me} flash={p.flash}
            onChange={(on) => p.setMe((m) => (m ? { ...m, reminders: { on } } : m))} />
        </Sheet>
      )}
      {showing === 'missed' && missed && (
        <Sheet label={t('missedTitle')} closeLabel={t('close')} onClose={() => setOpen(null)}>
          <MissedCheckout t={t} slug={p.slug} token={p.token} locale={p.locale} missed={missed} flash={p.flash}
            onState={(st) => { p.setMe((m) => (m ? { ...m, ...st } : m)); setOpen(null); }} />
        </Sheet>
      )}
    </>
  );
}
