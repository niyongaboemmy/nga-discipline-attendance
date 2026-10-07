import { useEffect, useState } from 'react';
import { CloudOff, RefreshCw, AlertTriangle } from 'lucide-react';
import { list, remove } from './outbox';
import { OUTBOX_EVENT, sendWaiting } from './registers';

/**
 * Shown at the top of every page: no connection, registers waiting to be
 * sent (they go by themselves when the connection is back), or a register
 * the server refused (with the reason, and a way to drop it).
 */
export default function OfflineBanner() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [items, setItems] = useState(() => list(localStorage));
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const refresh = () => setItems(list(localStorage));
    const tryNow = async () => {
      setSending(true);
      try {
        await sendWaiting();
      } finally {
        setSending(false);
        refresh();
      }
    };
    const goOnline = () => {
      setOnline(true);
      void tryNow();
    };
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    window.addEventListener(OUTBOX_EVENT, refresh);
    void tryNow();
    const t = window.setInterval(() => {
      if (list(localStorage).some((w) => !w.error)) void tryNow();
    }, 60_000);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      window.removeEventListener(OUTBOX_EVENT, refresh);
      window.clearInterval(t);
    };
  }, []);

  const waiting = items.filter((w) => !w.error);
  const refused = items.filter((w) => w.error);
  if (online && !waiting.length && !refused.length) return null;

  return (
    <div role="status" aria-live="polite" data-testid="offline-banner" className="offline-banner">
      {!online && (
        <p className="offline-banner__row">
          <CloudOff size={16} aria-hidden /> You're offline. You can still take registers: they're saved on this device and sent when the connection is back.
        </p>
      )}
      {waiting.length > 0 && (
        <p className="offline-banner__row">
          <RefreshCw size={16} aria-hidden className={sending ? 'spin' : ''} />
          {waiting.length} register{waiting.length === 1 ? '' : 's'} waiting to be sent
          {online && (
            <button type="button" className="offline-banner__btn" disabled={sending} onClick={() => void sendWaiting()}>
              Send now
            </button>
          )}
        </p>
      )}
      {refused.map((w) => (
        <p key={w.key} className="offline-banner__row offline-banner__row--error">
          <AlertTriangle size={16} aria-hidden />
          A register for {w.payload.className || 'a class'} ({w.payload.date}, period {String(w.payload.period)}) wasn't accepted: {w.error}
          <button type="button" className="offline-banner__btn" onClick={() => { remove(localStorage, w.key); setItems(list(localStorage)); }}>
            Dismiss
          </button>
        </p>
      ))}
    </div>
  );
}
