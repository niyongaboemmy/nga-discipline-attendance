import { useEffect, useState } from 'react';
import { listeners } from './trackRequests';

/** The "Saving…" pill (see trackRequests.ts). */
export function NetActivity() {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let timer: number | undefined;
    const on = (n: number) => {
      window.clearTimeout(timer);
      if (n > 0) timer = window.setTimeout(() => setBusy(true), 300);
      else setBusy(false);
    };
    listeners.add(on);
    return () => {
      listeners.delete(on);
      window.clearTimeout(timer);
    };
  }, []);
  if (!busy) return null;
  return (
    <div className="net-pill" role="status" aria-live="polite">
      <span className="btn-spin" aria-hidden />
      Saving…
    </div>
  );
}
