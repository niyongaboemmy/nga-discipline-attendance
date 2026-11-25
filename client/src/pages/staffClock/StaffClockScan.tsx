import React, { useCallback, useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { Camera, Check, AlertTriangle, LogIn, LogOut, MapPin } from 'lucide-react';
import { DashboardLayout } from '../../components/Layout/DashboardLayout';
import { useToast } from '../../context/ToastContext';
import { usePermissions } from '../../hooks/usePermissions';
import { ApiError } from '../../api/client';
import { staffClockApi, type ScanResult } from '../../api/staffClock';
import { sampleLocation, type Fix } from '../../clock/geo';
import { StaffClockHeader, Spinner } from './StaffClockHeader';

/**
 * Scan a staff QR card (staff without a smartphone). Only people holding
 * STAFF_CLOCK_SCAN; the scanner's own device location must be inside the school
 * zone. The server decides check-in or check-out, on the same rules as phones.
 */

type Outcome = { ok: true; r: ScanResult } | { ok: false; message: string };

export const StaffClockScan: React.FC = () => {
  const toast = useToast();
  const { can } = usePermissions();
  const allowed = can('STAFF_CLOCK_SCAN');
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const raf = useRef<number | undefined>(undefined);
  const lastCode = useRef<{ code: string; at: number } | null>(null);
  const busyRef = useRef(false);
  const [camera, setCamera] = useState<'off' | 'starting' | 'on' | 'denied' | 'unsupported'>('off');
  const [fix, setFix] = useState<{ best: Fix; samples: Fix[]; at: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [manual, setManual] = useState('');

  // One location lookup at a time: a second caller waits for the one already running.
  const inflight = useRef<Promise<{ best: Fix; samples: Fix[]; at: number } | null> | null>(null);
  const fixRef = useRef<{ best: Fix; samples: Fix[]; at: number } | null>(null);
  const locate = useCallback((): Promise<{ best: Fix; samples: Fix[]; at: number } | null> => {
    if (inflight.current) return inflight.current;
    setLocating(true);
    const p = (async () => {
      try {
        const r = await sampleLocation({ maxMs: 8000 });
        const f = { ...r, at: Date.now() };
        fixRef.current = f;
        setFix(f);
        return f;
      } catch {
        toast.error('Location not found', 'Allow location for this site: the scanner must be at school.');
        return null;
      } finally {
        setLocating(false);
        inflight.current = null;
      }
    })();
    inflight.current = p;
    return p;
  }, [toast]);

  const submit = useCallback(async (code: string): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    try {
      const known = fixRef.current;
      let f = known && Date.now() - known.at < 120_000 ? known : null;
      if (!f) f = await locate();
      if (!f) return false;
      const res = await staffClockApi.scan({ code, position: { lat: f.best.lat, lng: f.best.lng, accuracy: f.best.accuracy, ts: f.best.ts }, samples: f.samples });
      const r = res.data as ScanResult;
      setOutcome({ ok: true, r });
      navigator.vibrate?.(40);
      toast.success(r.action === 'check_in' ? `${r.person.name} checked in · ${r.at}` : `${r.person.name} checked out · ${r.at}`);
      return true;
    } catch (e) {
      const message = e instanceof ApiError ? e.message : 'Could not record this card. Try again.';
      setOutcome({ ok: false, message });
      toast.error('Not recorded', message);
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [locate, toast]);

  const stop = () => {
    if (raf.current) cancelAnimationFrame(raf.current);
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    setCamera('off');
  };

  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia) return setCamera('unsupported');
    setCamera('starting');
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      stream.current = s;
      if (video.current) {
        video.current.srcObject = s;
        await video.current.play();
      }
      setCamera('on');
      void locate();
      const tick = () => {
        const v = video.current;
        if (v && v.readyState >= 2 && !busyRef.current) {
          const c = (canvas.current ??= document.createElement('canvas'));
          const w = 480;
          const h = Math.round((v.videoHeight / v.videoWidth) * w) || 360;
          c.width = w;
          c.height = h;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          if (ctx) {
            ctx.drawImage(v, 0, 0, w, h);
            const img = ctx.getImageData(0, 0, w, h);
            const found = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
            const code = found?.data?.trim();
            if (code && !(lastCode.current && lastCode.current.code === code && Date.now() - lastCode.current.at < 6000)) {
              lastCode.current = { code, at: Date.now() };
              void submit(code);
            }
          }
        }
        raf.current = requestAnimationFrame(tick);
      };
      raf.current = requestAnimationFrame(tick);
    } catch {
      setCamera('denied');
    }
  };

  useEffect(() => () => stop(), []);
  // The result card clears itself so the next person can scan.
  useEffect(() => {
    if (!outcome) return;
    const id = window.setTimeout(() => setOutcome(null), outcome.ok ? 5000 : 7000);
    return () => window.clearTimeout(id);
  }, [outcome]);

  return (
    <DashboardLayout>
      <div className="sc-page">
        <StaffClockHeader title="Scan a staff card" lead="For staff without a smartphone. Scan their QR card at school: the first scan of the day checks them in, the next one checks them out." />
        {!allowed ? (
          <div className="sc-notice"><b>You cannot scan staff cards.</b><p>Ask your school admin for the “Scan staff QR cards” permission.</p></div>
        ) : (
          <div className="sc-scan">
            <div className="sc-camera">
              <video ref={video} playsInline muted aria-label="Camera" />
              {camera === 'on' && <div className="sc-frame" />}
              {camera !== 'on' && (
                <div className="sc-camera-msg">
                  {camera === 'starting' ? <Spinner /> : <Camera size={40} />}
                  <div>{camera === 'denied' ? 'The camera is blocked. Allow it for this site in the browser, then try again.' : camera === 'unsupported' ? 'This browser cannot use the camera. Type the card code instead.' : 'Point the camera at the QR code on the staff card.'}</div>
                  {(camera === 'off' || camera === 'denied') && <button className="sc-btn sc-btn-primary" onClick={() => void start()}><Camera size={16} /> Start camera</button>}
                </div>
              )}
              {busy && <div className="sc-camera-msg" style={{ background: 'rgba(0,0,0,.45)' }}><Spinner /><div>Recording…</div></div>}
            </div>

            <div style={{ flex: '1 1 320px', display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
              {outcome ? (
                outcome.ok ? (
                  <div className="sc-result" role="status" aria-live="assertive">
                    <div className="sc-result-badge" style={{ background: 'var(--status-present-bg)', color: 'var(--status-present)' }}>
                      {outcome.r.action === 'check_in' ? <LogIn size={40} /> : <LogOut size={40} />}
                    </div>
                    <b>{outcome.r.person.name}</b>
                    <div className="sc-muted">{outcome.r.action === 'check_in' ? 'Checked in' : 'Checked out'}</div>
                    <div className="sc-result-time">{outcome.r.at}</div>
                    <span className={`sc-pill ${outcome.r.status === 'late' || outcome.r.status === 'early' ? 'sc-tone-amber' : 'sc-tone-green'}`}>
                      <i />{outcome.r.status === 'late' ? 'Late' : outcome.r.status === 'early' ? 'Left early' : 'On time'}
                    </span>
                    {outcome.r.action === 'check_out' && outcome.r.checkIn && <div className="sc-muted" style={{ fontSize: 14 }}>In {outcome.r.checkIn} · Out {outcome.r.checkOut}</div>}
                  </div>
                ) : (
                  <div className="sc-result" role="alert">
                    <div className="sc-result-badge" style={{ background: 'var(--status-late-bg)', color: 'var(--status-late)' }}><AlertTriangle size={40} /></div>
                    <b style={{ fontSize: 18 }}>Not recorded</b>
                    <div style={{ color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{outcome.message}</div>
                  </div>
                )
              ) : (
                <div className="sc-result">
                  <div className="sc-result-badge" style={{ background: 'var(--primary-light)', color: 'var(--primary-text)' }}><Check size={40} /></div>
                  <b style={{ fontSize: 18 }}>Ready to scan</b>
                  <div className="sc-muted">Hold the card 15–30 cm from the camera.</div>
                </div>
              )}

              <section className="sc-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <MapPin size={18} />
                  <b style={{ flex: 1, fontSize: 15 }}>Your location</b>
                  {locating ? <Spinner /> : fix ? <span className="sc-pill sc-tone-green"><i />± {Math.round(fix.best.accuracy)} m</span> : <span className="sc-pill sc-tone-muted"><i />Not found yet</span>}
                </div>
                <p className="sc-card-sub" style={{ margin: 0 }}>Cards are recorded only when this device is inside the school zone.</p>
                <button className="sc-btn sc-btn-sm" onClick={() => void locate()} disabled={locating} style={{ alignSelf: 'flex-start' }}>Find my location</button>
              </section>

              <form className="sc-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} onSubmit={(e) => { e.preventDefault(); if (manual.trim()) void submit(manual.trim()).then((ok) => { if (ok) setManual(''); }); }}>
                <label className="sc-field">Card code (if the camera cannot read it)
                  <input className="sc-input" value={manual} onChange={(e) => setManual(e.target.value.toUpperCase())} placeholder="TC1-…" autoComplete="off" spellCheck={false} />
                </label>
                <button className="sc-btn sc-btn-primary" type="submit" disabled={busy || !manual.trim()}>{busy && <Spinner />}Record</button>
              </form>
              {camera === 'on' && <button className="sc-btn" onClick={stop}>Stop camera</button>}
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
};
