import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ClockApiError, clockApi } from './api';
import { GeoError, reloadToAskAgain, sampleLocation } from './geo';
import { detectLang, makeT } from './i18n';
import { IconCheck, IconIn, IconOut, IconPin, IconRetry, IconWarn } from './icons';

/**
 * /c/<school>/tap/<code>: a phone scanned the QR code on a staff member's computer.
 * It reads its location straight away and sends it; the check-in or check-out is
 * recorded for the person signed in on that computer. No sign-in on the phone.
 */

type Phase = 'checking' | 'locating' | 'sending' | 'done' | 'vague' | 'outside' | 'denied' | 'expired' | 'refused' | 'error';

export function TapApp({ slug, code }: { slug: string; code: string }) {
  const t = useMemo(() => makeT(detectLang()), []);
  const [phase, setPhase] = useState<Phase>('checking');
  const [who, setWho] = useState<{ firstName: string; next: string; school: string } | null>(null);
  const [result, setResult] = useState<{ action: string; at: string; status: string } | null>(null);
  const [detail, setDetail] = useState('');
  const started = useRef(false);

  const send = useCallback(async () => {
    setPhase('locating');
    setDetail('');
    try {
      const { best, samples } = await sampleLocation({ maxMs: 20000, goodEnough: 20, patientUntil: 100 });
      setPhase('sending');
      const r = await clockApi.tapSend(slug, code, { position: best, samples, clientTime: new Date().toISOString() });
      setResult(r);
      setPhase('done');
      navigator.vibrate?.(40);
    } catch (err) {
      if (err instanceof GeoError) {
        setPhase(err.kind === 'denied' ? 'denied' : 'vague');
      } else if (err instanceof ClockApiError) {
        if (err.code === 'LOW_ACCURACY') {
          setDetail(`± ${Number(err.data.accuracy ?? 0)} m`);
          setPhase('vague');
        } else if (err.code === 'OUTSIDE_ZONE') {
          setDetail(typeof err.data.outsideBy === 'number' ? `${err.data.outsideBy} m` : '');
          setPhase('outside');
        } else if (err.code === 'TAP_EXPIRED' || err.code === 'TAP_USED' || err.code === 'TAP_TRIES') {
          setDetail(err.message);
          setPhase('expired');
        } else {
          setDetail(err.message);
          setPhase('refused');
        }
      } else {
        setPhase('error');
      }
    }
  }, [slug, code]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    clockApi
      .tapPreview(slug, code)
      .then((p) => {
        setWho({ firstName: p.firstName, next: p.next, school: p.school.name });
        if (p.next === 'check_in' || p.next === 'check_out') void send();
        else {
          setDetail(p.next === 'done' ? t('doneToday') : t('closedToday'));
          setPhase('refused');
        }
      })
      .catch((err) => {
        setDetail(err instanceof ClockApiError ? err.message : '');
        setPhase(err instanceof ClockApiError && err.status === 404 ? 'expired' : 'error');
      });
  }, [slug, code, send, t]);

  const out = (result?.action ?? who?.next) === 'check_out';
  const busy = phase === 'checking' || phase === 'locating' || phase === 'sending';
  const bad = phase === 'vague' || phase === 'outside' || phase === 'denied' || phase === 'expired' || phase === 'refused' || phase === 'error';
  const retry = phase === 'vague' || phase === 'outside' || phase === 'denied' || phase === 'error';

  const title =
    phase === 'done' ? (result?.action === 'check_out' ? t('savedOut', { time: result.at }) : t('savedIn', { time: result?.at ?? '' }))
      : phase === 'vague' ? t('notPrecise', { accuracy: detail.replace(/\D/g, '') || '?' })
        : phase === 'outside' ? t('phoneOutside')
          : phase === 'denied' ? t('hLoc')
            : phase === 'expired' ? t('codeExpired')
              : phase === 'refused' ? detail
                : phase === 'error' ? t('somethingWrong')
                  : out ? t('checkingOut') : t('checkingIn');

  return (
    <div className="ck-app">
      <main className="ck-screen ck-cardscreen ck-tapscreen" data-testid="tap-page" data-phase={phase}>
        <div className="ck-card">
          <div className="ck-card-head">
            {who && <div className="ck-tap-who"><span className="ck-tap-avatar">{(who.firstName[0] || '?').toUpperCase()}</span><span>{who.firstName}<small>{who.school}</small></span></div>}
            <div className={`ck-tap-orb${phase === 'done' ? ' is-done' : bad ? ' is-bad' : ' is-busy'}`}>
              {busy && <span className="ck-tap-pulse" />}
              {phase === 'done' ? <IconCheck size={52} sw={2.4} /> : bad ? <IconWarn size={46} /> : phase === 'locating' ? <IconPin size={46} /> : out ? <IconOut size={46} /> : <IconIn size={46} />}
            </div>
            <h1>{title}</h1>
            <p className="ck-tap-sub">
              {phase === 'done' ? t('tapDoneLead')
                : phase === 'locating' ? t('findMyLocation')
                  : phase === 'outside' && detail ? detail
                    : phase === 'denied' ? `${t('hLoc1')} · ${t('hLoc2')}`
                      : phase === 'vague' ? t('hOutside2')
                        : phase === 'expired' ? detail
                          : ''}
            </p>
            {phase === 'done' && <div className="ck-tap-steps"><span className="done"><IconCheck size={14} sw={3} /></span><i /><span className="done"><IconCheck size={14} sw={3} /></span><i /><span className="done"><IconCheck size={14} sw={3} /></span></div>}
          </div>
          <div className="ck-grow" />
          <div className="ck-card-actions">
            {retry && (
              <button className="ck-btn ck-btn-primary ck-btn-block" onClick={() => { if (phase === 'denied' && reloadToAskAgain()) return; void send(); }}>
                <IconRetry size={18} />{t('tryAgain')}
              </button>
            )}
            {busy && <div className="ck-skel" style={{ height: 8, borderRadius: 999 }} />}
          </div>
        </div>
      </main>
    </div>
  );
}
