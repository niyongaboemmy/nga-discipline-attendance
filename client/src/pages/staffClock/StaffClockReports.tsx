import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownRight, ArrowUpRight, BarChart3, CalendarDays, ClipboardList, Clock, Download, Eye, FileSpreadsheet, FileText,
  Hourglass, LogOut, Minus, Search, ShieldAlert, TimerOff, Users, UserX, X,
} from 'lucide-react';
import { DashboardLayout } from '../../components/Layout/DashboardLayout';
import { ErrorState } from '../../components/common/ErrorState';
import { Skeleton } from '../../components/common/Skeleton';
import { useToast } from '../../context/ToastContext';
import { ApiError } from '../../api/client';
import { staffClockApi, type ReportsData, type ReportsPreset } from '../../api/staffClock';
import { StaffClockHeader, Spinner } from './StaffClockHeader';
import {
  buildAllReports, dayName, fileStem, kpiList, percent, periodLabel, searchRows, shortDate,
  type Kpi, type ReportId, type ReportTable,
} from './reports/reportsModel';
import { downloadReportPdf, downloadReportsXlsx, downloadSummaryPdf, type ExportMeta } from './reports/reportsExport';
import '../../styles/staffReports.css';

/**
 * Staff attendance reports: choose a period, read the headline numbers, and
 * download any report as a PDF or an Excel file headed with the school's logo.
 * Every report on the page is cut from one answer of the server (reportsModel.ts),
 * so the screen, the PDF and the spreadsheet always say the same thing.
 */

type Mode = ReportsPreset | 'date' | 'range';
const MODES: Array<{ id: Mode; label: string }> = [
  { id: 'today', label: 'Today' }, { id: 'yesterday', label: 'Yesterday' }, { id: 'week', label: 'This week' }, { id: 'month', label: 'This month' },
  { id: 'term', label: 'This term' }, { id: 'date', label: 'A date' }, { id: 'range', label: 'Date range' },
];

const ICONS: Record<ReportId, React.ReactNode> = {
  summary: <BarChart3 size={20} />, register: <ClipboardList size={20} />, staff: <Users size={20} />, daily: <CalendarDays size={20} />,
  late: <TimerOff size={20} />, absent: <UserX size={20} />, leaving: <LogOut size={20} />, hours: <Hourglass size={20} />, review: <ShieldAlert size={20} />,
};
const PREVIEW_ROWS = 300;

export const StaffClockReports: React.FC = () => {
  const toast = useToast();
  const [mode, setMode] = useState<Mode>('today');
  const [date, setDate] = useState('');
  const [range, setRange] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const [data, setData] = useState<ReportsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<ReportId | null>(null);
  const brand = useRef<{ name: string; logo: string | null } | null>(null);
  const seq = useRef(0);

  const load = useCallback(async (q: { preset?: ReportsPreset; from?: string; to?: string }) => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const d = await staffClockApi.reportsData(q);
      if (mine !== seq.current) return; // a newer choice was made meanwhile
      setData(d);
      return d;
    } catch (e) {
      if (mine !== seq.current) return;
      const noTerm = e instanceof ApiError && /term/i.test(e.message);
      setError(e instanceof ApiError ? e.message : 'Could not load the reports.');
      if (noTerm) toast.info('This term has no dates yet', 'Choose a date range instead.');
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void Promise.resolve().then(() => load({ preset: 'today' })); }, [load]);

  const today = data?.today ?? '';
  const choose = (m: Mode) => {
    setMode(m);
    if (m === 'date') {
      const d = date || data?.from || today;
      setDate(d);
      if (d) void load({ from: d, to: d });
    } else if (m === 'range') {
      const r = range.from && range.to ? range : { from: data?.from ?? today, to: data?.to ?? today };
      setRange(r);
      if (r.from && r.to) void load(r);
    } else void load({ preset: m });
  };
  const pickDate = (d: string) => { setDate(d); if (d) void load({ from: d, to: d }); };
  const pickRange = (side: 'from' | 'to', v: string) => {
    const next = { ...range, [side]: v };
    // Picking a start after the end (or the reverse) moves the other side with it.
    if (next.from && next.to && next.from > next.to) { if (side === 'from') next.to = next.from; else next.from = next.to; }
    setRange(next);
    if (next.from && next.to) void load(next);
  };

  const reports = useMemo(() => (data ? buildAllReports(data) : []), [data]);
  const kpis = useMemo(() => (data ? kpiList(data) : []), [data]);
  const byId = useMemo(() => new Map(reports.map((r) => [r.id, r] as const)), [reports]);
  const schoolDays = useMemo(() => (data ? data.days.filter((d) => d.kind === 'school') : []), [data]);

  const meta = useCallback(async (): Promise<ExportMeta> => {
    if (!brand.current) brand.current = await staffClockApi.documentBrand().catch(() => ({ name: 'School', logo: null }));
    const d = data!;
    return {
      school: brand.current.name, logo: brand.current.logo, period: periodLabel(d.from, d.to), live: d.to === d.today,
      compared: d.previous.kpis.schoolDays > 0 ? `Compared with ${periodLabel(d.previous.from, d.previous.to)}` : '',
    };
  }, [data]);

  /** Runs one download: a spinner on its button, then a toast either way. */
  const run = async (key: string, what: string, job: (m: ExportMeta) => Promise<void>) => {
    if (!data || busy) return;
    setBusy(key);
    try {
      await job(await meta());
      toast.success(`${what} downloaded`, periodLabel(data.from, data.to));
    } catch {
      toast.error(`${what} could not be made`, 'Try again. If it keeps failing, reload the page.');
    } finally {
      setBusy(null);
    }
  };
  const pdf = (t: ReportTable) => run(`${t.id}-pdf`, `${t.title} (PDF)`, (m) => downloadReportPdf(t, m, fileStem(t.id, data!.from, data!.to)));
  const xlsx = (t: ReportTable) => run(`${t.id}-xlsx`, `${t.title} (Excel)`, (m) => downloadReportsXlsx([t], m, fileStem(t.id, data!.from, data!.to)));
  const summaryPdf = () => run('summary-pdf', 'Summary (PDF)', (m) => downloadSummaryPdf(kpis, byId.get('daily')!, m, fileStem('summary', data!.from, data!.to), `${data!.kpis.staff} staff · ${data!.kpis.schoolDays} school day${data!.kpis.schoolDays === 1 ? '' : 's'}`));
  const summaryXlsx = () => run('summary-xlsx', 'Summary (Excel)', (m) => downloadReportsXlsx([byId.get('summary')!, byId.get('daily')!], m, fileStem('summary', data!.from, data!.to)));
  const allXlsx = () => run('all-xlsx', 'All reports (Excel)', (m) => downloadReportsXlsx(reports, m, fileStem('all', data!.from, data!.to)));

  const sentence = data
    ? `${periodLabel(data.from, data.to)} · ${data.kpis.schoolDays} school day${data.kpis.schoolDays === 1 ? '' : 's'} · ${data.kpis.staff} staff${data.to === data.today ? ' · today is still in progress' : ''}`
    : '';
  const first = !data && loading;

  return (
    <DashboardLayout>
      <div className="sc-page rp" data-testid="reports">
        <StaffClockHeader
          title="Staff attendance reports"
          lead="Choose a period, read the numbers, then download any report as a PDF or an Excel file with the school's logo."
          actions={
            <button type="button" className="sc-btn sc-btn-primary" onClick={() => void allXlsx()} disabled={!data || !!busy} data-testid="rp-all-xlsx">
              {busy === 'all-xlsx' ? <Spinner /> : <FileSpreadsheet size={18} />}All reports (Excel)
            </button>
          }
        />

        <section className="sc-card rp-period" aria-label="Period">
          <div className="rp-modes" role="group" aria-label="Period">
            {MODES.map((m) => (
              <button key={m.id} type="button" className="rp-mode" aria-pressed={mode === m.id} onClick={() => choose(m.id)} data-mode={m.id}
                disabled={m.id === 'term' && !!data && !data.term} title={m.id === 'term' && data && !data.term ? 'The current term has no dates yet' : undefined}>
                {m.label}
              </button>
            ))}
          </div>
          {mode === 'date' && (
            <label className="rp-dates">
              <span>Date</span>
              <input className="rp-date" type="date" value={date} max={today || undefined} onChange={(e) => pickDate(e.target.value)} data-testid="rp-date" />
            </label>
          )}
          {mode === 'range' && (
            <div className="rp-dates">
              <label><span>From</span><input className="rp-date" type="date" value={range.from} max={today || undefined} onChange={(e) => pickRange('from', e.target.value)} data-testid="rp-from" /></label>
              <label><span>To</span><input className="rp-date" type="date" value={range.to} max={today || undefined} onChange={(e) => pickRange('to', e.target.value)} data-testid="rp-to" /></label>
            </div>
          )}
          <p className="rp-sentence" data-testid="rp-sentence" aria-live="polite">
            {first ? <Skeleton w={320} h={14} /> : <><CalendarDays size={16} />{sentence}{loading && <Spinner />}</>}
          </p>
          {data && mode === 'term' && data.term && <p className="rp-note">{data.term.name}: {shortDate(data.term.start)} to {shortDate(data.term.end)}</p>}
          {data && data.from < data.trackingFrom && <p className="rp-note">Staff check-in started on {shortDate(data.trackingFrom)}. Earlier days are not counted as absences.</p>}
        </section>

        {error && <ErrorState message={error} onRetry={() => choose(mode)} />}

        {first ? (
          <>
            <section className="sc-card"><Skeleton w={160} h={18} /><div className="rp-kpi-grid" style={{ marginTop: 16 }}>{Array.from({ length: 10 }, (_, i) => <Skeleton key={i} h={112} r={20} />)}</div></section>
            <section className="rp-grid">{Array.from({ length: 9 }, (_, i) => <Skeleton key={i} h={190} r={24} />)}</section>
          </>
        ) : data && (
          <div className={loading ? 'rp-stale' : undefined}>
            <section className="sc-card rp-summary" aria-label="Summary" data-testid="rp-summary">
              <div className="rp-sec-head">
                <div>
                  <h2>Summary</h2>
                  <p className="sc-card-sub">
                    {data.previous.kpis.schoolDays > 0 ? `Changes are against ${periodLabel(data.previous.from, data.previous.to)}, the same number of days just before.` : 'No earlier period to compare with yet.'}
                  </p>
                </div>
                <div className="rp-sec-actions">
                  <button type="button" className="sc-btn sc-btn-sm sc-btn-soft" onClick={() => void summaryPdf()} disabled={!!busy} data-testid="rp-summary-pdf">{busy === 'summary-pdf' ? <Spinner /> : <FileText size={16} />}Summary PDF</button>
                  <button type="button" className="sc-btn sc-btn-sm" onClick={() => void summaryXlsx()} disabled={!!busy} data-testid="rp-summary-xlsx">{busy === 'summary-xlsx' ? <Spinner /> : <FileSpreadsheet size={16} />}Summary Excel</button>
                </div>
              </div>
              {data.kpis.schoolDays === 0 && <p className="rp-quiet">No tracked school day in this period: there is nothing to count. Choose another period.</p>}
              <div className="rp-kpi-grid">
                {kpis.map((k) => <KpiCard key={k.id} k={k} report={byId.get(k.report)!} busy={busy} onOpen={() => setPreview(k.report)} onPdf={pdf} onXlsx={xlsx} />)}
              </div>
              {schoolDays.length > 0 && <Trend days={schoolDays} />}
            </section>

            <div className="rp-sec-head rp-sec-head-out">
              <div>
                <h2>Reports</h2>
                <p className="sc-card-sub">Nine documents from the same numbers. Look first, or download straight away.</p>
              </div>
            </div>
            <section className="rp-grid" aria-label="Reports" data-testid="rp-grid">
              {reports.map((t) => (
                <article key={t.id} className="sc-card rp-report" data-report={t.id}>
                  <div className="rp-report-top">
                    <span className="rp-report-icon">{ICONS[t.id]}</span>
                    <span className={`rp-count${t.rows.length ? '' : ' is-zero'}`}>{t.rows.length ? t.countText : 'Nothing to list'}</span>
                  </div>
                  <h3>{t.title}</h3>
                  <p className="rp-q">{t.question}</p>
                  <p className="rp-for">{t.usedFor}</p>
                  <div className="rp-report-actions">
                    <button type="button" className="sc-btn sc-btn-sm" onClick={() => setPreview(t.id)} data-act="preview"><Eye size={16} />Look</button>
                    <button type="button" className="sc-btn sc-btn-sm sc-btn-soft" onClick={() => void pdf(t)} disabled={!!busy} data-act="pdf">{busy === `${t.id}-pdf` ? <Spinner /> : <FileText size={16} />}PDF</button>
                    <button type="button" className="sc-btn sc-btn-sm sc-btn-soft" onClick={() => void xlsx(t)} disabled={!!busy} data-act="xlsx">{busy === `${t.id}-xlsx` ? <Spinner /> : <FileSpreadsheet size={16} />}Excel</button>
                  </div>
                </article>
              ))}
            </section>
          </div>
        )}
      </div>
      {preview && data && byId.get(preview) && (
        <PreviewWindow table={byId.get(preview)!} period={periodLabel(data.from, data.to)} busy={busy} onClose={() => setPreview(null)} onPdf={pdf} onXlsx={xlsx} />
      )}
    </DashboardLayout>
  );
};

const KpiCard: React.FC<{ k: Kpi; report: ReportTable; busy: string | null; onOpen: () => void; onPdf: (t: ReportTable) => void; onXlsx: (t: ReportTable) => void }> = ({ k, report, busy, onOpen, onPdf, onXlsx }) => (
  <div className="rp-kpi" data-kpi={k.id} data-tone={k.tone}>
    <button type="button" className="rp-kpi-main" onClick={onOpen} title={`Open: ${report.title}`}>
      <span className="rp-kpi-label">{k.label}</span>
      <b className="sc-num">{k.value}</b>
      <span className="rp-kpi-detail">{k.detail}</span>
      {k.change ? (
        <span className="rp-change" data-good={k.change.good == null ? 'flat' : k.change.good ? 'yes' : 'no'}>
          {k.change.good == null ? <Minus size={14} /> : /^Up/.test(k.change.text) ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}{k.change.text}
        </span>
      ) : <span className="rp-change" data-good="flat"><Clock size={14} />No comparison</span>}
    </button>
    <div className="rp-kpi-foot">
      <span className="rp-kpi-foot-label">Details</span>
      <span className="rp-kpi-dl" aria-label={`Download the details: ${report.title}`}>
        <Download size={14} />
        <button type="button" onClick={() => onPdf(report)} disabled={!!busy} data-act="kpi-pdf">PDF</button>
        <button type="button" onClick={() => onXlsx(report)} disabled={!!busy} data-act="kpi-xlsx">Excel</button>
      </span>
    </div>
  </div>
);

/** Each school day as one bar (on time, late, absent); a single day as one split line. */
const Trend: React.FC<{ days: ReportsData['days'] }> = ({ days }) => {
  const legend = (
    <div className="rp-legend"><span><i className="rp-on" />On time</span><span><i className="rp-late" />Late</span><span><i className="rp-abs" />Absent or not in yet</span></div>
  );
  if (days.length === 1) {
    const d = days[0];
    const out = d.absent + d.notIn;
    return (
      <div className="rp-trend" data-testid="rp-trend">
        <div className="rp-split" role="img" aria-label={`${d.onTime} on time, ${d.late} late, ${out} ${d.today ? 'not in yet' : 'absent'}`}>
          {d.onTime > 0 && <i className="rp-on" style={{ flex: d.onTime }}>{d.onTime}</i>}
          {d.late > 0 && <i className="rp-late" style={{ flex: d.late }}>{d.late}</i>}
          {out > 0 && <i className="rp-abs" style={{ flex: out }}>{out}</i>}
        </div>
        {legend}
      </div>
    );
  }
  return (
    <div className="rp-trend" data-testid="rp-trend">
      <div className="rp-bars" style={{ gap: days.length > 60 ? 1 : days.length > 25 ? 2 : 5 }}>
        {days.map((d) => {
          const total = Math.max(1, d.onTime + d.late + d.absent + d.notIn);
          return (
            <span key={d.date} className="rp-bar" title={`${dayName(d.date)} ${shortDate(d.date)}: ${d.onTime} on time, ${d.late} late, ${d.today ? `${d.notIn} not in yet` : `${d.absent} absent`}${d.rate != null ? ` · ${percent(d.rate)}` : ''}`}>
              <i className="rp-abs" style={{ flex: (d.absent + d.notIn) / total }} />
              <i className="rp-late" style={{ flex: d.late / total }} />
              <i className="rp-on" style={{ flex: d.onTime / total }} />
            </span>
          );
        })}
      </div>
      <div className="rp-axis"><span>{shortDate(days[0].date)}</span><span>{days.length} school days</span><span>{shortDate(days[days.length - 1].date)}</span></div>
      {legend}
    </div>
  );
};

const PreviewWindow: React.FC<{ table: ReportTable; period: string; busy: string | null; onClose: () => void; onPdf: (t: ReportTable) => void; onXlsx: (t: ReportTable) => void }> = ({ table, period, busy, onClose, onPdf, onXlsx }) => {
  const [query, setQuery] = useState('');
  const rows = useMemo(() => searchRows(table, query), [table, query]);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialog.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);
  const shown = rows.slice(0, PREVIEW_ROWS);
  return (
    <div className="dr-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dr-dialog rp-dialog" role="dialog" aria-modal="true" aria-label={table.title} tabIndex={-1} ref={dialog} data-testid="rp-preview">
        <div className="dr-top">
          <div className="rp-dialog-title">
            <h2>{table.title}</h2>
            <p>{period} · {table.question}</p>
          </div>
          <div className="dr-actions">
            <button type="button" className="sc-btn sc-btn-sm sc-btn-soft" onClick={() => onPdf(table)} disabled={!!busy} data-testid="rp-preview-pdf">{busy === `${table.id}-pdf` ? <Spinner /> : <FileText size={16} />}PDF</button>
            <button type="button" className="sc-btn sc-btn-sm sc-btn-soft" onClick={() => onXlsx(table)} disabled={!!busy} data-testid="rp-preview-xlsx">{busy === `${table.id}-xlsx` ? <Spinner /> : <FileSpreadsheet size={16} />}Excel</button>
            <button type="button" className="sc-btn sc-btn-sm rp-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
          </div>
        </div>
        <div className="dr-tools">
          {table.facts.length > 0 && (
            <div className="rp-facts">
              {table.facts.map((f) => <span key={f.label} className="rp-fact" data-tone={f.tone}><b>{f.value}</b>{f.label}</span>)}
            </div>
          )}
          {table.rows.length > 8 && (
            <label className="sc-search rp-search"><Search size={16} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search this report" aria-label="Search this report" /></label>
          )}
        </div>
        <div className="dr-body">
          {table.rows.length === 0 ? <div className="sc-empty">{table.empty}</div> : rows.length === 0 ? <div className="sc-empty">Nothing in this report matches “{query}”.</div> : (
            <>
              <div className="rp-table-wrap">
                <table className="rp-table">
                  <thead><tr>{table.columns.map((c) => <th key={c.key} style={{ textAlign: c.align ?? 'left' }}>{c.label}</th>)}</tr></thead>
                  <tbody>
                    {shown.map((r, i) => (
                      <tr key={i}>
                        {table.columns.map((c) => <td key={c.key} style={{ textAlign: c.align ?? 'left' }} className={c.toned && r.tone ? `rp-tone-${r.tone}` : undefined}>{r.cells[c.key] ?? ''}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="rp-rows-note">
                {rows.length > PREVIEW_ROWS ? `Showing the first ${PREVIEW_ROWS} of ${rows.length} lines. The PDF and Excel files have all ${table.rows.length}.` : `${rows.length} line${rows.length === 1 ? '' : 's'}${query ? ` of ${table.rows.length}` : ''}. The files always hold the whole report.`}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default StaffClockReports;
