import { useEffect, useState } from 'react';
import { sampleLocation, GeoError } from './geo';
import { IconCheck, IconPin, IconWarn } from './icons';

/**
 * /c/<school>/pair/<code>: this phone lends its GPS to an admin setting up staff
 * check-in on a computer (computers have no GPS). Nothing is recorded as
 * attendance; the reading only appears on the admin's screen.
 */
export function PairApp({ slug, code }: { slug: string; code: string }) {
  const [state, setState] = useState<'checking' | 'ready' | 'locating' | 'sent' | 'expired' | 'denied' | 'error'>('checking');
  const [school, setSchool] = useState('');
  const [accuracy, setAccuracy] = useState<number | null>(null);

  useEffect(() => {
    fetch(`/api/clock/${encodeURIComponent(slug)}/pair/${encodeURIComponent(code)}`)
      .then(async (r) => {
        if (!r.ok) return setState('expired');
        const b = await r.json();
        setSchool(b?.data?.school?.name ?? '');
        setState('ready');
      })
      .catch(() => setState('error'));
  }, [slug, code]);

  const share = async () => {
    setState('locating');
    try {
      const { best } = await sampleLocation({ maxMs: 12000, goodEnough: 15 });
      const r = await fetch(`/api/clock/${encodeURIComponent(slug)}/pair/${encodeURIComponent(code)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position: best }),
      });
      if (r.status === 404) return setState('expired');
      if (!r.ok) return setState('error');
      setAccuracy(Math.round(best.accuracy));
      setState('sent');
      navigator.vibrate?.(30);
    } catch (e) {
      setState(e instanceof GeoError && e.kind === 'denied' ? 'denied' : 'error');
    }
  };

  return (
    <div className="ck-app">
      <main className="ck-screen ck-cardscreen">
        <div className="ck-card">
          <div className="ck-card-head">
            <div className={`ck-badge${state === 'sent' ? '' : state === 'expired' || state === 'denied' || state === 'error' ? ' ck-badge-amber' : ''}`}>
              {state === 'sent' ? <IconCheck size={44} sw={2.2} /> : state === 'expired' || state === 'denied' || state === 'error' ? <IconWarn size={42} /> : <IconPin size={42} />}
            </div>
            <h1>{state === 'sent' ? 'Location sent' : state === 'expired' ? 'This link expired' : 'Share this phone’s location'}</h1>
            <p>
              {state === 'sent'
                ? `Precision ± ${accuracy} m. Look at the computer: the result is on its screen.`
                : state === 'expired'
                  ? 'Make a new one on the computer (Use my phone’s GPS) and scan it again.'
                  : state === 'denied'
                    ? 'Location is blocked for this site. Allow it in the browser settings, then try again.'
                    : `For the staff check-in setup${school ? ` at ${school}` : ''} on your computer. Stand where staff arrive. Nothing is recorded as attendance.`}
            </p>
          </div>
          <div className="ck-grow" />
          <div className="ck-card-actions">
            {(state === 'ready' || state === 'locating' || state === 'denied' || state === 'error' || state === 'sent') && (
              <button className="ck-btn ck-btn-primary ck-btn-block" onClick={() => void share()} disabled={state === 'locating'}>
                {state === 'locating' && <span className="ck-spinner" />}
                {state === 'locating' ? 'Finding your location…' : state === 'sent' ? 'Send again from here' : 'Share my location'}
              </button>
            )}
            {state === 'checking' && <div className="ck-skel" style={{ height: 58, borderRadius: 999 }} />}
          </div>
        </div>
      </main>
    </div>
  );
}
