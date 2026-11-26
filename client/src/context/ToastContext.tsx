import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { Check, AlertTriangle, Info, X } from 'lucide-react';

type ToastKind = 'success' | 'error' | 'info';
interface Toast { id: number; kind: ToastKind; title: string; message?: string; duration: number; leaving?: boolean }

interface ToastApi {
  toast: (kind: ToastKind, title: string, message?: string) => void;
  success: (title: string, message?: string) => void;
  error: (title: string, message?: string) => void;
  info: (title: string, message?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export const useToast = (): ToastApi => {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
};

const ICONS: Record<ToastKind, React.ReactNode> = {
  success: <Check size={16} strokeWidth={3} />,
  error: <AlertTriangle size={16} strokeWidth={2.4} />,
  info: <Info size={16} strokeWidth={2.4} />,
};

const MAX_VISIBLE = 4;
const LEAVE_MS = 180;

/**
 * Feedback for every action. A card with a tinted icon badge (no side strip, no
 * shadow); the ring around the close button shows the time left and pauses while
 * the pointer is on the card. Errors stay a little longer.
 */
export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);
  const timers = useRef(new Map<number, { handle: number; started: number; left: number }>());

  const remove = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) window.clearTimeout(t.handle);
    timers.current.delete(id);
    setToasts((list) => list.map((x) => (x.id === id ? { ...x, leaving: true } : x)));
    window.setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), LEAVE_MS);
  }, []);

  const arm = useCallback((id: number, ms: number) => {
    const handle = window.setTimeout(() => remove(id), ms);
    timers.current.set(id, { handle, started: Date.now(), left: ms });
  }, [remove]);

  const pause = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (!t) return;
    window.clearTimeout(t.handle);
    timers.current.set(id, { ...t, left: Math.max(800, t.left - (Date.now() - t.started)) });
  }, []);

  const resume = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) arm(id, t.left);
  }, [arm]);

  const toast = useCallback((kind: ToastKind, title: string, message?: string) => {
    const id = ++idRef.current;
    const duration = kind === 'error' ? 6000 : 4000;
    setToasts((list) => {
      const next = [{ id, kind, title, message, duration }, ...list];
      // Too many at once: the oldest go first.
      next.slice(MAX_VISIBLE).forEach((x) => window.setTimeout(() => remove(x.id), 0));
      return next;
    });
    arm(id, duration);
  }, [arm, remove]);

  useEffect(() => {
    const all = timers.current;
    return () => all.forEach((t) => window.clearTimeout(t.handle));
  }, []);

  const api = React.useMemo<ToastApi>(() => ({
    toast,
    success: (t, m) => toast('success', t, m),
    error: (t, m) => toast('error', t, m),
    info: (t, m) => toast('info', t, m),
  }), [toast]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-viewport" role="region" aria-live="polite" aria-label="Notifications">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast is-${t.kind}${t.leaving ? ' is-leaving' : ''}`}
            role={t.kind === 'error' ? 'alert' : 'status'}
            onMouseEnter={() => pause(t.id)}
            onMouseLeave={() => resume(t.id)}
            style={{ '--toast-ms': `${t.duration}ms` } as React.CSSProperties}
          >
            <span className="toast-icon" aria-hidden>{ICONS[t.kind]}</span>
            <div className="toast-body">
              <div className="toast-title">{t.title}</div>
              {t.message && <div className="toast-msg">{t.message}</div>}
            </div>
            <button className="toast-close" onClick={() => remove(t.id)} aria-label="Dismiss">
              <svg className="toast-ring" viewBox="0 0 32 32" aria-hidden>
                <circle cx="16" cy="16" r="14" className="toast-ring-bg" />
                <circle cx="16" cy="16" r="14" className="toast-ring-fg" />
              </svg>
              <X size={13} strokeWidth={2.6} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};
