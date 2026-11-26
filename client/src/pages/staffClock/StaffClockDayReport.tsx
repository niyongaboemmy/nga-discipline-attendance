import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, FileSpreadsheet, FileText, Search, X } from 'lucide-react';
import { ApiError } from '../../api/client';
import { initialsOf, staffClockApi, type Overview, type OverviewRow } from '../../api/staffClock';
import { useToast } from '../../context/ToastContext';
import { Spinner } from './StaffClockHeader';
import { downloadDayPdf, downloadDayXlsx, type DayExportRow } from './dayReportExport';

/**
 * The selected day's staff, opened on request in a window over the dashboard:
 * every staff member with their status (on time, late, absent / not in yet,
 * marked invalid), check-in and check-out times and hours at school. Filters by
 * status, search by name, step to the previous / next school day, download as a
 * PDF or Excel file headed with the school's documents logo. A row opens the
 * person's history, with the visible rows as the list to step through.
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
  /** the day shown (yyyy-mm-dd), known before its data arrives */
  date: string;
  onOpen: (row: OverviewRow, list: OverviewRow[]) => void;
  onClose: () => void;
  onStep: (n: -1 | 1) => void;
  canPrev: boolean;
  canNext: boolean;
}> = ({ overview, loading, date, onOpen, onClose, onStep, canPrev, canNext }) => {
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<null | 'pdf' | 'xlsx'>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const keys = useRef({ onClose, onStep, canPrev, canNext });
  useEffect(() => { keys.current = { onClose, onStep, canPrev, canNext }; });
  useEffect(() => {
    // A person's history open on top takes Escape and the arrows first.
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('.sh-overlay')) return;
      const k = keys.current;
      if (e.key === 'Escape') { k.onClose(); return; }
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'ArrowLeft' && k.canPrev) k.onStep(-1);
      if (e.key === 'ArrowRight' && k.canNext) k.onStep(1);
    };
    window.addEventListener('keydown', onKey);
    dialog.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, []);
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

  const dayLabel = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const filterLabel = tabs.find(([k]) => k === filter)?.[1] ?? 'Everyone';

  const exportRows = (): DayExportRow[] => shown.map((r) => {
    const absent = r.status === 'not_in' || r.status === 'invalid';
    return {
      name: r.name, role: r.role ?? '', status: r.status === 'not_in' ? absentWord : STATUS[r.status].label, tone: STATUS[r.status].tone as DayExportRow['tone'],
      checkIn: r.checkIn ?? '—',
      checkOut: r.checkOut ?? (absent ? '—' : r.outStatus === 'auto_closed' ? 'not checked out' : isToday ? 'still in' : 'no check-out'),
      hours: hoursOf(r) ?? '—', how: r.source === 'card' ? 'Staff card' : r.device ?? (absent ? '—' : 'Phone'),
    };
  });
  const download = async (kind: 'pdf' | 'xlsx') => {
    if (!overview || !shown.length) return;
    setBusy(kind);
    try {
      const brand = await staffClockApi.documentBrand().catch(() => ({ name: 'Staff attendance', logo: null }));
      const meta = {
        school: brand.name, logo: brand.logo, dateLabel: dayLabel, isToday,
        filterLabel: `${filterLabel}${term ? ` · “${q.trim()}”` : ''} · ${shown.length} of ${rows.length} staff`,
        counts: { staff: rows.length, onTime: rows.filter(test.present).length, late: rows.filter(test.late).length, absent: rows.filter(test.out).length },
        fileStem: `staff-attendance-${overview.date}${filter === 'all' ? '' : `-${filterLabel.toLowerCase().replace(/[^a-z]+/g, '-')}`}`,
      };
      if (kind === 'pdf') await downloadDayPdf(exportRows(), meta);
      else await downloadDayXlsx(exportRows(), meta);
      toast.success(kind === 'pdf' ? 'PDF downloaded' : 'Excel file downloaded', `${shown.length} staff · ${dayLabel}`);
    } catch (e) {
      toast.error('Download failed', e instanceof ApiError ? e.message : 'Try again.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="dr-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
    <div className="dr-dialog" id="scr-day-report" role="dialog" aria-modal="true" aria-label={`Staff on ${dayLabel}`} tabIndex={-1} ref={dialog} data-testid="day-report">
      <header className="dr-top">
        <div className="dr-daynav" role="group" aria-label="Day">
          <button onClick={() => onStep(-1)} disabled={!canPrev} aria-label="Previous school day" title="Previous school day (←)"><ChevronLeft size={18} /></button>
          <div className="dr-daytitle">
            <span className="sc-card-sub">{isToday ? 'Today · live' : 'Staff on'}</span>
            <h2>{dayLabel}</h2>
          </div>
          <button onClick={() => onStep(1)} disabled={!canNext} aria-label="Next school day" title="Next school day (→)"><ChevronRight size={18} /></button>
        </div>
        <div className="dr-actions">
          <button className="sc-btn" onClick={() => void download('pdf')} disabled={!!busy || loading || !shown.length} data-testid="day-pdf">{busy === 'pdf' ? <Spinner /> : <FileText size={16} />} PDF</button>
          <button className="sc-btn" onClick={() => void download('xlsx')} disabled={!!busy || loading || !shown.length} data-testid="day-xlsx">{busy === 'xlsx' ? <Spinner /> : <FileSpreadsheet size={16} />} Excel</button>
          <button className="sh-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
      </header>
      <div className="dr-tools">
        <label className="sc-search dr-search">
          <Search size={16} />
          <span className="sr-only">Search staff</span>
          <input placeholder="Search staff" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <span className="sc-card-sub">Click someone for their history</span>
      </div>
      <div className="dr-body">

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
      </div>
    </div>
    </div>
  );
};
