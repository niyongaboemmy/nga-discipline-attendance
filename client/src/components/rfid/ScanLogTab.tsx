import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Radio, Search } from 'lucide-react';
import { ErrorState } from '../common/ErrorState';
import { SearchableSelect } from '../common/SearchableSelect';
import { apiGet } from '../../api/client';
import { OUTCOME_META, type ScanEvent, type ScanOutcome } from '../../api/rfid';
import { useRfidStream } from '../../hooks/useRfidStream';
import { fmtSchoolClock, schoolToday } from '../../utils/time';
import { defer, errMsg, showUid } from '../../utils/rfidCards';
import { OutcomeBadge } from './CardBits';

/** Every tap the scanner sent, newest first, live for today. */
const LiveDot: React.FC<{ state: ReturnType<typeof useRfidStream> }> = ({ state }) => (
  <span className={`rfid-live is-${state}`} role="status">
    <span className="rfid-live-dot" aria-hidden="true" />
    {state === 'live' ? 'Live' : state === 'off' ? 'Not live' : state === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}
  </span>
);


// ───────────────────────────── Scan log tab ─────────────────────────────

const OUTCOME_FILTERS = [
  { value: '', label: 'All scans' },
  { value: 'problems', label: 'Needs attention' },
  { value: 'unresolved', label: 'Unregistered cards' },
  ...(Object.keys(OUTCOME_META) as ScanOutcome[]).filter((o) => o !== 'pending').map((o) => ({ value: o, label: OUTCOME_META[o].label })),
];

export const ScanLogTab: React.FC<{ version: number }> = ({ version }) => {
  const [date, setDate] = useState(schoolToday());
  const [outcome, setOutcome] = useState('');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<ScanEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const reqId = useRef(0);

  const load = useCallback(async () => {
    const mine = ++reqId.current;
    setError(null);
    try {
      const qs = new URLSearchParams({ limit: '200' });
      if (date) qs.set('date', date);
      if (outcome) qs.set('outcome', outcome);
      if (search.trim()) qs.set('search', search.trim());
      const r = await apiGet<ScanEvent[]>(`/api/rfid/scans?${qs}`);
      if (mine !== reqId.current) return;
      setRows(r.data ?? []);
      setTotal(r.total ?? 0);
    } catch (err) {
      if (mine === reqId.current) setError(errMsg(err, 'Could not load scans.'));
    } finally {
      if (mine === reqId.current) setLoading(false);
    }
  }, [date, outcome, search]);

  useEffect(() => defer(load, search ? 300 : 0), [load, version, search]);

  const viewingToday = date === schoolToday();
  const stream = useRfidStream((e) => {
    if (e.type !== 'scan' || !viewingToday) return;
    // Refetch rather than splice: the row needs server-side joins (card label,
    // scanner name) and filters. Highlight the new one when it lands.
    setFresh((s) => new Set(s).add(e.scanId));
    void load();
  }, { enabled: viewingToday, onReconnect: load });

  const summary = useMemo(() => {
    const recorded = rows.filter((r) => r.outcome.startsWith('recorded_')).length;
    const problems = rows.filter((r) => OUTCOME_META[r.outcome]?.tone === 'absent').length;
    return { recorded, problems };
  }, [rows]);

  return (
    <>
      <div className="card card-body mb-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="field">
            <label className="label" htmlFor="scan-date">Day</label>
            <input id="scan-date" type="date" className="input" value={date} max={schoolToday()} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="field" style={{ minWidth: 200 }}>
            <span className="label">Outcome</span>
            <SearchableSelect value={outcome} onChange={setOutcome} options={OUTCOME_FILTERS} aria-label="Filter by outcome" />
          </div>
          <div className="rp-search" style={{ flex: 1, minWidth: 200 }}>
            <Search className="field-icon" size={15} />
            <input className="input" placeholder="Student, class or UID…" value={search} aria-label="Search scans" onChange={(e) => setSearch(e.target.value)} />
          </div>
          {viewingToday && <LiveDot state={stream} />}
        </div>
      </div>

      {error && <div className="mb-4"><ErrorState message={error} onRetry={load} /></div>}

      <div className="card">
        {!loading && rows.length > 0 && (
          <div className="card-header text-sm text-secondary">
            {total} scan{total === 1 ? '' : 's'} · {summary.recorded} recorded attendance · {summary.problems} need attention
          </div>
        )}
        {loading ? (
          <div className="p-4 flex flex-col gap-2">{[0, 1, 2, 3].map((i) => <div key={i} className="rp-skeleton" />)}</div>
        ) : rows.length === 0 ? (
          <div className="empty-state" style={{ padding: '48px 0' }}>
            <Radio size={28} />
            <span className="text-sm">{viewingToday ? 'No scans yet today. New taps appear here as they happen.' : 'No scans on this day.'}</span>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Time</th><th>Result</th><th>Student</th><th>Card</th><th>Scanner</th></tr></thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id} className={fresh.has(s.id) ? 'rfid-fresh' : undefined}>
                    <td className="mono text-sm" title={s.timeSource === 'device' ? `Replayed from the scanner's buffer; received ${fmtSchoolClock(s.receivedAt, true)}` : undefined}>
                      {fmtSchoolClock(s.at, true)}{s.timeSource === 'device' && ' ⟲'}
                    </td>
                    <td>
                      <OutcomeBadge outcome={s.outcome} />
                      {s.detail && <div className="text-xs text-tertiary mt-1">{s.detail}</div>}
                    </td>
                    <td>{s.studentName ? <><div className="font-medium">{s.studentName}</div><div className="text-xs text-secondary">{s.className ?? ''}</div></> : <span className="text-tertiary">—</span>}</td>
                    <td><code className="mono text-xs">{s.cardLabel ? `${s.cardLabel} · ` : ''}{s.uid ? showUid(s.uid) : s.uidRaw}</code></td>
                    <td className="text-sm text-secondary">{s.deviceName ?? (s.source === 'manual_entry' ? 'Entered by hand' : '—')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
};

