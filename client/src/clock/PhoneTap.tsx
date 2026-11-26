import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { ClockApiError, clockApi, type DayState, type PunchResult } from './api';
import { loadDevice, signMessage } from './device';
import type { T } from './i18n';
import { IconCheck, IconPhone, IconPin, IconQr, IconRetry, IconWarn } from './icons';

/**
 * Check in or out from a computer with a phone's location. The computer shows a
 * 2-minute QR code; any phone scans it, reads its GPS and sends it; the server
 * records the tap for the person signed in here. This panel polls and hands the
 * result back. A new code is made automatically when one runs out (a few times).
 */

type Phase = 'making' | 'waiting' | 'locating' | 'failed' | 'expired' | 'error';

const POLL_MS = 1500;
const AUTO_RENEW = 4;

export function PhoneTap({
  slug, token, t, next, onDone, onDeviceError,
}: {
  slug: string;
  token: string;
  t: T;
  next: 'check_in' | 'check_out';
  onDone: (result: Omit<PunchResult, 'state'>, state: DayState | null) => void;
  onDeviceError: (err: unknown) => Promise<boolean>;
}) {
  const [phase, setPhase] = useState<Phase>('making');
  const [qr, setQr] = useState<string | null>(null);
  const [left, setLeft] = useState(120);
  const [total, setTotal] = useState(120);
  const [problem, setProblem] = useState<string | null>(null);
  const code = useRef<string | null>(null);
  const renewals = useRef(0);
  const finished = useRef(false);
  // The page re-renders every second (its clock): keep the callbacks out of the effects' deps.
  const doneRef = useRef(onDone);
  const deviceErrRef = useRef(onDeviceError);
  useEffect(() => {
    doneRef.current = onDone;
    deviceErrRef.current = onDeviceError;
  });

  const make = useCallback(async () => {
    setPhase('making');
    setProblem(null);
    code.current = null;
    try {
      const { nonce } = await clockApi.challenge(slug, token);
      const stored = await loadDevice(slug);
      if (!stored) throw new ClockApiError(401, 'DEVICE_UNKNOWN', 'missing key');
      const signature = await signMessage(stored, `tendo-clock-phone-v1|${nonce}`);
      const made = await clockApi.phoneTap(slug, token, { nonce, signature });
      setQr(await QRCode.toDataURL(made.url, { margin: 1, width: 360, errorCorrectionLevel: 'M' }));
      code.current = made.code;
      setTotal(made.expiresIn);
      setLeft(made.expiresIn);
      setPhase('waiting');
    } catch (err) {
      if (await deviceErrRef.current(err)) return;
      setProblem(err instanceof ClockApiError ? err.message : t('somethingWrong'));
      setPhase('error');
    }
  }, [slug, token, t]);

  useEffect(() => {
    // Make the first code once the panel opens (async: no state is set synchronously here).
    const id = window.setTimeout(() => void make(), 0);
    return () => window.clearTimeout(id);
  }, [make]);

  // Poll the code while it is live.
  useEffect(() => {
    if (phase !== 'waiting' && phase !== 'locating' && phase !== 'failed') return;
    const id = window.setInterval(async () => {
      const c = code.current;
      if (!c || finished.current) return;
      try {
        const s = await clockApi.phoneTapStatus(slug, token, c);
        setLeft(s.expiresIn);
        if (s.state === 'done' && s.result) {
          finished.current = true;
          window.clearInterval(id);
          doneRef.current(s.result, s.dayState);
          return;
        }
        if (s.state === 'locating') setPhase('locating');
        if (s.state === 'failed' && s.error) {
          const e = s.error;
          setProblem(
            e.code === 'LOW_ACCURACY' ? t('phoneVague', { accuracy: Number(e.data.accuracy ?? 0) })
              : e.code === 'OUTSIDE_ZONE' ? t('phoneOutside')
                : e.message
          );
          setPhase('failed');
        }
      } catch (err) {
        if (err instanceof ClockApiError && err.status === 404) {
          if (renewals.current < AUTO_RENEW) {
            renewals.current += 1;
            void make();
          } else setPhase('expired');
        }
      }
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [phase, slug, token, t, make]);

  // A smooth countdown between polls.
  useEffect(() => {
    if (phase !== 'waiting' && phase !== 'locating' && phase !== 'failed') return;
    const id = window.setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => window.clearInterval(id);
  }, [phase]);

  const step = phase === 'locating' || phase === 'failed' ? 2 : 1;
  const frac = total ? Math.max(0, Math.min(1, left / total)) : 0;
  const R = 46;
  const C = 2 * Math.PI * R;

  return (
    <div className="ck-ptap" data-testid="phone-tap" data-phase={phase}>
      <div className="ck-ptap-head">
        <span className="ck-ptap-icon"><IconPhone size={18} /></span>
        <b>{next === 'check_out' ? t('scanToOut') : t('scanToIn')}</b>
      </div>

      <div className={`ck-ptap-qr${phase === 'locating' ? ' is-busy' : ''}${phase === 'expired' || phase === 'error' ? ' is-dim' : ''}`}>
        {qr && phase !== 'making' ? <img src={qr} alt={t('anyPhone')} /> : <div className="ck-skel ck-ptap-skel" />}
        {phase === 'locating' && (
          <div className="ck-ptap-over"><span className="ck-ptap-pin"><IconPin size={28} /></span></div>
        )}
        {(phase === 'expired' || phase === 'error') && (
          <div className="ck-ptap-over">
            <button className="ck-btn ck-btn-primary" onClick={() => { renewals.current = 0; void make(); }}>
              <IconRetry size={18} />{t('newCode')}
            </button>
          </div>
        )}
      </div>

      {(phase === 'waiting' || phase === 'locating' || phase === 'failed') && (
        <svg className="ck-ptap-timer" viewBox="0 0 100 100" aria-label={`${left}s`}>
          <circle cx="50" cy="50" r={R} className="ck-ptap-timer-bg" />
          <circle cx="50" cy="50" r={R} className="ck-ptap-timer-fg" strokeDasharray={C} strokeDashoffset={C * (1 - frac)} />
          <text x="50" y="57" textAnchor="middle">{left}</text>
        </svg>
      )}

      <ol className="ck-ptap-steps" aria-label={t('usePhone')}>
        <li className={step > 1 ? 'done' : 'on'}><span>{step > 1 ? <IconCheck size={14} sw={3} /> : <IconQr size={14} />}</span>{t('tapStep1')}</li>
        <li className={step === 2 ? (phase === 'failed' ? 'warn' : 'on') : ''}><span>{phase === 'failed' ? <IconWarn size={14} /> : <IconPin size={14} />}</span>{t('tapStep2')}</li>
        <li><span><IconCheck size={14} sw={3} /></span>{t('tapStep3')}</li>
      </ol>

      <p className={`ck-ptap-note${phase === 'failed' || phase === 'error' ? ' warn' : ''}`} aria-live="polite">
        {phase === 'locating' ? t('phoneLocating') : phase === 'failed' || phase === 'error' ? problem : phase === 'expired' ? t('codeExpired') : t('anyPhone')}
      </p>
    </div>
  );
}
