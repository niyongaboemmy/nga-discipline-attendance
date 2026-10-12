import React, { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Cloud, Nfc, Server, UserPlus } from 'lucide-react';
import { apiGet } from '../../api/client';
import type { FeedStatus } from '../../api/rfid';
import { useRfidStream } from '../../hooks/useRfidStream';
import { fmtSchoolClock, relativeTime } from '../../utils/time';
import { showUid, type AssignTarget } from '../../utils/rfidCards';

/**
 * The path a tap takes, and whether each step is working:
 *   scanner → Supabase (when a card last arrived)  →  Tendo (reading every second?)
 * A card that "doesn't show up" is then easy to place: if the scanner's time
 * doesn't move when you tap, the tap never reached Supabase.
 */
export const ScannerFeed: React.FC<{ canManage: boolean; onAssign: (c: AssignTarget) => void }> = ({ canManage, onAssign }) => {
  const [status, setStatus] = useState<FeedStatus | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await apiGet<FeedStatus>('/api/rfid/bridge/status');
      setStatus(r.data ?? null);
      setUnreachable(false);
    } catch {
      setUnreachable(true);
    }
  }, []);
  useEffect(() => {
    const first = setTimeout(load, 0);
    const t = setInterval(load, 5_000);
    return () => { clearTimeout(first); clearInterval(t); };
  }, [load]);
  useRfidStream(() => { void load(); });

  if (!status && !unreachable) {
    return <div className="card card-body mb-4"><div className="rp-skeleton" /></div>;
  }
  const live = !unreachable && !!status?.live;
  const last = status?.lastScan ?? null;
  const waiting = last && last.cardStatus === 'unassigned' && last.cardId != null && last.uid;
  const owner = last?.holderName ?? last?.studentName ?? null;

  return (
    <section className="card mb-4 rfid-feed" aria-label="Scanner feed" aria-live="polite">
      <div className="rfid-pipe">
        <div className="rfid-pipe-step">
          <span className="rfid-pipe-icon"><Nfc size={18} /></span>
          <div className="rfid-shrink">
            <div className="rfid-pipe-title">Scanner</div>
            {last ? (
              <div className="text-sm">
                Last card <strong>{relativeTime(last.at)}</strong>
                <span className="text-secondary"> · <span className="mono">{fmtSchoolClock(last.at, true)}</span> · <code className="mono">{showUid(last.uid)}</code></span>
              </div>
            ) : <div className="text-sm text-secondary">No card has been scanned yet</div>}
          </div>
        </div>
        <ArrowRight size={16} className="rfid-pipe-arrow" aria-hidden="true" />
        <div className="rfid-pipe-step">
          <span className="rfid-pipe-icon"><Cloud size={18} /></span>
          <div>
            <div className="rfid-pipe-title">Supabase</div>
            <div className="text-sm text-secondary">Stores every tap</div>
          </div>
        </div>
        <ArrowRight size={16} className="rfid-pipe-arrow" aria-hidden="true" />
        <div className={`rfid-pipe-step ${live ? 'is-live' : 'is-down'}`}>
          <span className="rfid-pipe-icon"><Server size={18} /></span>
          <div className="rfid-shrink">
            <div className="rfid-pipe-title">
              Tendo <span className={`rfid-live ${live ? 'is-live' : 'is-off'}`}><span className="rfid-live-dot" aria-hidden="true" />{live ? 'Live' : 'Not live'}</span>
            </div>
            <div className="text-sm text-secondary">
              {live
                ? `Checks for new taps every second · last check ${status?.secondsSinceCheck ?? 0}s ago`
                : unreachable ? 'This page can’t reach the Tendo server.' : status?.reason}
            </div>
          </div>
        </div>
      </div>

      {waiting && (
        <div className="rfid-waiting">
          <span className="rfid-waiting-dot" aria-hidden="true" />
          <span className="flex-1">
            Card <code className="mono font-semibold">{showUid(last.uid)}</code> was scanned and nobody holds it yet.
          </span>
          {canManage && (
            <button className="btn btn-primary btn-sm" onClick={() => onAssign({ id: last.cardId!, uid: last.uid!, label: null })}>
              <UserPlus size={14} /> Assign it
            </button>
          )}
        </div>
      )}
      {!waiting && owner && (
        <div className="rfid-feed-last text-sm">
          Last card belongs to <strong>{owner}</strong>{last?.className && owner === last.studentName ? ` (${last.className})` : ''}
        </div>
      )}
      {live && (
        <div className="rfid-feed-hint text-xs text-secondary">
          Tapped a card and the scanner time above didn’t change? The tap never reached Supabase. Check the scanner’s Wi-Fi.
        </div>
      )}
    </section>
  );
};
