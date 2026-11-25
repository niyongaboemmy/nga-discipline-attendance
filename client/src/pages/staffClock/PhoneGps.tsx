import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Smartphone, X } from 'lucide-react';
import { useToast } from '../../context/ToastContext';
import { ApiError } from '../../api/client';
import { staffClockApi } from '../../api/staffClock';
import type { Fix } from '../../clock/geo';
import { Spinner } from './StaffClockHeader';

/**
 * "Use my phone's GPS": a computer has no GPS, so the admin scans a QR code with
 * their phone; the phone sends its own GPS reading (no sign-in, the code is the
 * key, 10 minutes) and it lands here. Setup tests only, never attendance.
 */
export const PhoneGps: React.FC<{ onFix: (fix: Fix) => void; compact?: boolean }> = ({ onFix, compact }) => {
  const toast = useToast();
  const [pair, setPair] = useState<{ code: string; url: string; qr: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [got, setGot] = useState(0);
  const seen = useRef(0);
  const onFixRef = useRef(onFix);
  useEffect(() => {
    onFixRef.current = onFix;
  }, [onFix]);

  const start = async () => {
    setBusy(true);
    try {
      const p = await staffClockApi.pair();
      const qr = await QRCode.toDataURL(p.url, { margin: 1, width: 360, errorCorrectionLevel: 'M' });
      seen.current = 0;
      setGot(0);
      setPair({ code: p.code, url: p.url, qr });
    } catch (e) {
      toast.error('Could not make the phone link', e instanceof ApiError ? e.message : 'Try again.');
    } finally {
      setBusy(false);
    }
  };

  // Wait for the phone: a light poll every 2 s while the panel is open.
  useEffect(() => {
    if (!pair) return;
    let stopped = false;
    const tick = async () => {
      try {
        const r = await staffClockApi.readPair(pair.code);
        if (stopped) return;
        if (r.readings.length > seen.current) {
          const fresh = r.readings.slice(seen.current);
          seen.current = r.readings.length;
          setGot(r.readings.length);
          const best = fresh.reduce((a, b) => (b.accuracy < a.accuracy ? b : a));
          onFixRef.current({ lat: best.lat, lng: best.lng, accuracy: best.accuracy, ts: best.ts ?? best.at });
          toast.success(`Phone location received (± ${Math.round(best.accuracy)} m)`);
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          setPair(null);
          toast.info('The phone link expired', 'Make a new one if you still need it.');
        }
      }
    };
    const id = window.setInterval(() => void tick(), 2000);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [pair, toast]);

  if (!pair) {
    return (
      <button className={`sc-btn${compact ? ' sc-btn-sm' : ''}`} onClick={() => void start()} disabled={busy}>
        {busy ? <Spinner /> : <Smartphone size={compact ? 15 : 18} />}Use my phone’s GPS
      </button>
    );
  }
  return (
    <div className="sc-phone-qr" role="region" aria-label="Use my phone's GPS">
      <img src={pair.qr} alt="QR code: open on your phone to send its location" />
      <span>
        <b>Scan with your phone camera</b>
        <small>Stand where staff arrive and press “Share my location” on the phone. No sign-in is needed, and nothing is recorded as attendance. The result appears here.</small>
        <small className="sc-phone-wait">{got ? <>Received {got} reading{got > 1 ? 's' : ''}. Send again from another spot to compare.</> : <><Spinner /> Waiting for your phone…</>}</small>
      </span>
      <button className="sc-icon-close" aria-label="Close" onClick={() => setPair(null)}><X size={16} /></button>
    </div>
  );
};
