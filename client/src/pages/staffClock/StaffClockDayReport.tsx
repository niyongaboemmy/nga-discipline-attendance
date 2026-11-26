import React, { useMemo, useState } from 'react';
import { ChevronRight, Search } from 'lucide-react';
import { initialsOf, type Overview, type OverviewRow } from '../../api/staffClock';

/**
 * The selected day's report: every staff member with their status (on time,
 * late, absent / not in yet, marked invalid), check-in and check-out times and
 * hours at school. Filters by status, search by name; a row opens the person's
 * history, with the visible rows as the list to step through.
 */

type Filter = 'all' | 'present' | 'late' | 'out' | 'stillIn' | 'noOut';

const toMin = (t: string | null) => {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const hoursOf = (r: OverviewRow) => {
  const a = toMin(r.checkIn);
  const b = toMin(r.checkOut);
  if (a == null || b == null || b < a) return null;
  const m = b - a;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}`;
};

const STATUS: Record<OverviewRow['status'], { label: string; tone: string }> = {
  present: { label: 'On time', tone: 'on' },
  late: { label: 'Late', tone: 'late' },
  not_in: { label: 'Absent', tone: 'abs' },
  invalid: { label: 'Marked invalid', tone: 'abs' },
};

export const DayReport: React.FC<{
  overview: Overview | null;
  loading: boolean;
  flash?: boolean;
  onOpen: (row: OverviewRow, list: OverviewRow[]) => void;
}> = ({ overview, loading, flash, onOpen }) => {
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const rows = useMemo(() => overview?.rows ?? [], [overview]);
  const isToday = !!overview?.isToday;
  const checkoutOpen = overview?.missing?.checkoutOpen !== false;
  const absentWord = isToday ? 'Not in yet' : 'Absent';

  const inSchool = (r: OverviewRow) => r.status === 'present' || r.status === 'late';
  const test: Record<Filter, (r: OverviewRow) => boolean> = {
    all: () => true,
    present: (r) => r.status === 'present',
    late: (r) => r.status === 'late',
    out: (r) => r.status === 'not_in' || r.status === 'invalid',
    stillIn: (r) => inSchool(r) && !r.checkOut,
    noOut: (r) => inSchool(r) && !r.checkOut,
  };
  // Today: "still at school"; a past day: "no check-out".
  const tabs: Array<[Filter, string, string]> = [
    ['all', 'Everyone', 'all'],
    ['present', 'On time', 'on'],
    ['late', 'Late', 'late'],
    ['out', absentWord, 'abs'],
    isToday ? ['stillIn', checkoutOpen ? 'No check-out yet' : 'At school now', 'in'] : ['noOut', 'No check-out', 'in'],
  ];
  const term = q.trim().toLowerCase();
  const order: Record<OverviewRow['status'], number> = { late: 0, not_in: 1, invalid: 2, present: 3 };
  const shown = rows
    .filter(test[filter])
    .filter((r) => !term || r.name.toLowerCase().includes(term) || (r.role ?? '').toLowerCase().includes(term))
    .sort((a, b) => (filter === 'all' ? order[a.status] - order[b.status] : 0) || (toMin(a.checkIn) ?? 9999) - (toMin(b.checkIn) ?? 9999) || a.name.localeCompare(b.name));

  const dayLabel = overview ? new Date(`${overview.date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }) : '';

  return (
    <section id="scr-day-report" className={`sc-card dr${flash ? ' dr-flash' : ''}`} aria-label="Day report">
      <div className="dr-head">
        <div>
          <h2>{isToday ? 'Today, staff by staff' : 'Staff by staff'}</h2>
          <p className="sc-card-sub">{dayLabel}{isToday ? ' · live' : ''} · click someone for their history</p>
        </div>
        <label className="sc-search dr-search">
          <Search size={16} />
          <span className="sr-only">Search staff</span>
          <input placeholder="Search staff" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>

      <div className="dr-tabs" role="tablist" aria-label="Filter by status">
        {tabs.map(([key, label, tone]) => {
          const n = rows.filter(test[key]).length;
          return (
            <button key={key} role="tab" aria-selected={filter === key} className={`dr-tab dr-${tone}${filter === key ? ' on' : ''}`} onClick={() => setFilter(key)} disabled={loading}>
              {key !== 'all' && <i />}{label}<span className="dr-count">{loading ? '…' : n}</span>
            </button>
          );
        })}
      </div>

      {loading || !overview ? (
        <div role="status" aria-busy="true" aria-label="Loading the day">
          {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="sc-skel" style={{ height: 46, margin: '8px 0', borderRadius: 999 }} />)}
        </div>
      ) : shown.length === 0 ? (
        <div className="sc-empty">{term ? `Nobody matches “${q}”.` : filter === 'late' ? 'Nobody was late.' : filter === 'out' ? (isToday ? 'Everyone is in.' : 'Nobody was absent.') : 'Nobody here.'}</div>
      ) : (
        <>
          <div className="sc-table-wrap sc-responsive">
            <table className="sc-table dr-table">
              <thead><tr><th>Staff</th><th>Status</th><th>In</th><th>Out</th><th>At school</th><th>How</th><th aria-label="Open" /></tr></thead>
              <tbody>
                {shown.map((r) => {
                  const s = STATUS[r.status];
                  const absent = r.status === 'not_in' || r.status === 'invalid';
                  return (
                    <tr key={r.userId} className="sc-row-btn" tabIndex={0} data-person={r.userId}
                      onClick={() => onOpen(r, shown)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(r, shown); } }}>
                      <td><span className="sc-who"><span className="sc-avatar">{initialsOf(r.name)}</span><span><b className="sc-clip" title={r.name}>{r.name}</b><small className="sc-clip">{r.role}</small></span></span></td>
                      <td><span className={`dr-pill dr-${s.tone}`}><i />{r.status === 'not_in' ? absentWord : s.label}</span>{r.needsReview && <span className="dr-pill dr-late" style={{ marginLeft: 6 }}>Review</span>}</td>
                      <td className="sc-num" style={{ fontWeight: 600 }}>{r.checkIn ?? '—'}</td>
                      <td className="sc-num">{r.checkOut ?? (absent ? '—' : r.outStatus === 'auto_closed' ? <span className="dr-warn">not checked out</span> : isToday ? <span className="sc-muted">still in</span> : <span className="dr-warn">no check-out</span>)}{r.outStatus === 'early' ? <span className="dr-warn"> · early</span> : null}</td>
                      <td className="sc-num">{hoursOf(r) ?? '—'}</td>
                      <td className="sc-muted">{r.source === 'card' ? 'Staff card' : r.device ?? (r.source ? 'Phone' : absent ? '—' : 'Phone')}</td>
                      <td className="sc-muted" style={{ width: 32 }}><ChevronRight size={16} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="sc-list">
            {shown.map((r) => {
              const s = STATUS[r.status];
              return (
                <button key={r.userId} className="sc-item" onClick={() => onOpen(r, shown)}>
                  <span className="sc-avatar" style={{ width: 38, height: 38 }}>{initialsOf(r.name)}</span>
                  <span className="sc-item-main"><b className="sc-clip" title={r.name}>{r.name}</b><small className="sc-clip sc-muted">{r.checkIn ? `In ${r.checkIn}${r.checkOut ? ` · out ${r.checkOut}` : ''}` : r.role}</small></span>
                  <span className={`dr-pill dr-${s.tone}`}><i />{r.status === 'not_in' ? absentWord : s.label}</span>
                </button>
              );
            })}
          </div>
          <p className="sc-card-sub" style={{ margin: '10px 0 0' }}>{shown.length} of {rows.length} staff</p>
        </>
      )}
    </section>
  );
};
