import React from 'react';
import type { ClockReport, ReportDay, ReportGroup } from '../../api/staffClock';
import { dayRate, fmtDate, heatLevel, lowAndBest, monthBlocks, monthGrid, pct, sumDays } from './reportMath';

/**
 * The pieces of the staff attendance dashboard (design "V3d · Calendar + insights"):
 * the weekly line, the term on month calendars, the current month as a grid of
 * squares, three patterns and the staff groups. No names here: people are only
 * listed in a side sheet, on request.
 */

const WD = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const DOW_NAME = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const dayTip = (d: ReportDay): string => {
  const label = fmtDate(d.date);
  if (d.kind === 'off') return `${label} · no school`;
  if (d.kind === 'future') return `${label} · not yet`;
  if (d.kind === 'untracked') return `${label} · before check-in started`;
  return `${label} · ${pct(dayRate(d))} in · ${d.late} late · ${d.absent} ${d.today ? 'not in yet' : 'absent'}`;
};

export const HeatLegend: React.FC<{ less?: string; more?: string }> = ({ less = 'Fewer in', more = 'More in' }) => (
  <span className="scr-heat-legend">{less}<i className="scr-h1" /><i className="scr-h2" /><i className="scr-h3" /><i className="scr-h4" />{more}</span>
);

/** The split of a set of staff-days (or one day) into on time / late / absent. */
export const SplitBar: React.FC<{ onTime: number; late: number; absent: number }> = ({ onTime, late, absent }) => {
  const total = onTime + late + absent;
  if (!total) return <div className="scr-split" aria-hidden="true" />;
  return (
    <div className="scr-split" role="img" aria-label={`${onTime} on time, ${late} late, ${absent} not in`}>
      {onTime > 0 && <i className="scr-on" style={{ flex: onTime }} />}
      {late > 0 && <i className="scr-late" style={{ flex: late }} />}
      {absent > 0 && <i className="scr-abs" style={{ flex: absent }} />}
    </div>
  );
};

/** Share of staff in, week by week, against the same weeks just before. */
export const WeeklyChart: React.FC<{ weeks: ClockReport['weeks'] }> = ({ weeks }) => {
  const pts = weeks.filter((w) => w.rate != null);
  if (pts.length === 0) return <div className="scr-empty">The weekly line appears after the first school day with check-ins.</div>;
  const W = 640, H = 210, L = 38, R = 12, T = 14, B = 34;
  const all = weeks.flatMap((w) => [w.rate, w.prevRate]).filter((v): v is number => v != null);
  const lo = Math.max(0, Math.min(80, Math.floor(Math.min(...all) / 10) * 10));
  const x = (i: number) => (weeks.length === 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (weeks.length - 1));
  const y = (r: number) => T + (1 - (r - lo) / (100 - lo)) * (H - T - B);
  const line = (key: 'rate' | 'prevRate') => weeks.map((w, i) => (w[key] == null ? null : `${x(i).toFixed(1)},${y(w[key] as number).toFixed(1)}`)).filter(Boolean).join(' ');
  const now = line('rate');
  const first = weeks.findIndex((w) => w.rate != null);
  const last = weeks.length - 1 - [...weeks].reverse().findIndex((w) => w.rate != null);
  const ticks = [100, (100 + lo) / 2, lo];
  const every = Math.ceil(weeks.length / 7);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="scr-svg" role="img" aria-label={`Share of staff checked in per week, from ${pct(pts[0].rate)} to ${pct(pts[pts.length - 1].rate)}`}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className={t === lo ? 'scr-axis' : 'scr-grid'} />
          <text x={L - 8} y={y(t) + 4} textAnchor="end" className="scr-tick">{Math.round(t)}%</text>
        </g>
      ))}
      {pts.length > 1 && <path d={`M${x(first)} ${y(lo)} L${now.split(' ').join(' L')} L${x(last)} ${y(lo)} Z`} className="scr-area" />}
      {line('prevRate') && <polyline points={line('prevRate')} className="scr-line-prev" />}
      <polyline points={now} className="scr-line" />
      {weeks.map((w, i) => (
        <g key={w.start}>
          {w.rate != null && <circle cx={x(i)} cy={y(w.rate)} r="4" className="scr-dot"><title>{`Week of ${fmtDate(w.start, { day: 'numeric', month: 'short' })}: ${pct(w.rate)}${w.prevRate != null ? ` (before: ${pct(w.prevRate)})` : ''}`}</title></circle>}
          {i % every === 0 && <text x={x(i)} y={H - 12} textAnchor="middle" className="scr-tick">{fmtDate(w.start, { day: 'numeric', month: 'short' })}</text>}
        </g>
      ))}
    </svg>
  );
};

/** The period on real month calendars: each day coloured by the share of staff in. */
export const TermCalendar: React.FC<{ days: ReportDay[]; selected: string; onPick: (date: string) => void; inScope: (date: string) => boolean }> = ({ days, selected, onPick, inScope }) => (
  <div className="scr-months">
    {monthBlocks(days).map((m) => (
      <div key={m.key} className="scr-month">
        <div className="scr-month-head">
          <b>{m.name}</b>
          {m.sum.schoolDays > 0 && (
            <>
              <span className="sc-num">{pct(m.sum.rate)} in</span>
              <span className="sc-num scr-t-late">{m.sum.late} late</span>
              <span className="sc-num scr-t-abs">{m.sum.absent} absent</span>
            </>
          )}
        </div>
        <div className="scr-cal">
          {WD.map((w, i) => <span key={i} className="scr-wd">{w}</span>)}
          {m.cells.map((c, i) => {
            if (!c) return <span key={`b${i}`} />;
            const n = Number(c.date.slice(8));
            if (c.kind !== 'school') return <span key={c.date} className={`scr-day scr-day-${c.kind}`} title={dayTip(c)}>{n}</span>;
            return (
              <button key={c.date} type="button" className={`scr-day scr-h${heatLevel(dayRate(c))}${c.date === selected ? ' is-sel' : ''}${c.today ? ' is-today' : ''}${inScope(c.date) ? '' : ' is-out'}`}
                title={dayTip(c)} aria-label={dayTip(c)} aria-pressed={c.date === selected} onClick={() => onPick(c.date)}>{n}</button>
            );
          })}
        </div>
      </div>
    ))}
  </div>
);

/** The month we are in as a grid of squares: weeks across, Monday to Sunday down. */
export const MonthGrid: React.FC<{ days: ReportDay[]; today: string; selected: string; onPick: (date: string) => void }> = ({ days, today, selected, onPick }) => {
  const month = today.slice(0, 7);
  const cols = monthGrid(days, month);
  const list = days.filter((d) => d.date.startsWith(month));
  const sum = sumDays(list, `${month}-01`, today);
  const { low, best } = lowAndBest(list);
  const rows = ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'];
  return (
    <div className="scr-gh">
      <div className="scr-gh-grid" role="group" aria-label={`${fmtDate(today, { month: 'long', year: 'numeric' })}, one square per day`}>
        <div className="scr-gh-col">
          <span className="scr-gh-label" />
          {rows.map((r, i) => <span key={i} className="scr-gh-row">{r}</span>)}
        </div>
        {cols.map((col, i) => (
          <div key={i} className="scr-gh-col">
            <span className="scr-gh-label">{col.label}</span>
            {col.cells.map((c, j) => {
              if (!c) return <i key={j} className="scr-sq scr-sq-none" />;
              if (c.kind !== 'school') return <i key={j} className={`scr-sq scr-sq-${c.kind}`} title={dayTip(c)} />;
              return <button key={j} type="button" className={`scr-sq scr-h${heatLevel(dayRate(c))}${c.date === selected ? ' is-sel' : ''}`} title={dayTip(c)} aria-label={dayTip(c)} onClick={() => onPick(c.date)} />;
            })}
          </div>
        ))}
      </div>
      <div className="scr-gh-side">
        <div className="scr-big-row"><b className="sc-num">{pct(sum.rate)}</b><span>attended</span></div>
        <div className="scr-tiles scr-tiles-2">
          <div className="scr-tile"><b className="sc-num scr-t-late">{sum.late}</b><small>late arrivals</small></div>
          <div className="scr-tile"><b className="sc-num scr-t-abs">{sum.absent}</b><small>absences</small></div>
        </div>
        {low && best && (
          <p className="scr-note">
            Lowest day: <b>{fmtDate(low.date)} · {pct(dayRate(low))}</b><br />
            Best day: <b>{fmtDate(best.date)} · {pct(dayRate(best))}</b>
          </p>
        )}
      </div>
    </div>
  );
};

export const WeekdayBars: React.FC<{ weekdays: ClockReport['weekdays'] }> = ({ weekdays }) => {
  const known = weekdays.filter((w) => w.rate != null);
  if (!known.length) return <div className="scr-empty">Appears after the first full school day.</div>;
  const min = Math.min(...known.map((w) => w.rate as number));
  const lo = Math.max(0, Math.min(80, Math.floor(min / 10) * 10));
  const weakest = known.length > 1 ? known.reduce((a, b) => ((b.rate as number) < (a.rate as number) ? b : a)) : null;
  return (
    <>
      <div className="scr-wkbars">
        {weekdays.map((w) => (
          <div key={w.dow} className="scr-wk">
            <span>{DOW_NAME[w.dow]}</span>
            <span className="scr-track"><i className={weakest && w.dow === weakest.dow && (w.rate as number) < 100 ? 'scr-late' : 'scr-on'} style={{ width: `${w.rate == null ? 0 : Math.max(4, (((w.rate as number) - lo) / (100 - lo)) * 100)}%` }} /></span>
            <b className="sc-num">{pct(w.rate)}</b>
          </div>
        ))}
      </div>
      <p className="scr-foot">Bars start at {lo}%.</p>
    </>
  );
};

/** A simple column chart: arrivals per 15 minutes, or late arrivals per week. */
export const Columns: React.FC<{ items: Array<{ key: string; value: number; late?: boolean; label: string; tip: string }>; cutIndex?: number; cutLabel?: string; showValues?: boolean; label: string }> = ({ items, cutIndex = -1, cutLabel, showValues, label }) => {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="scr-cols" role="img" aria-label={label}>
      {cutIndex > 0 && <div className="scr-cut" style={{ left: `${(cutIndex / items.length) * 100}%` }}><span>{cutLabel}</span></div>}
      <div className="scr-cols-bars" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
        {items.map((i) => (
          <div key={i.key} className="scr-col" title={i.tip}>
            {showValues && i.value > 0 && <span className="sc-num">{i.value}</span>}
            <i className={i.late ? 'scr-late' : 'scr-on'} style={{ height: `${(i.value / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="scr-cols-x" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
        {items.map((i) => <span key={i.key}>{i.label}</span>)}
      </div>
    </div>
  );
};

const GROUP_TONE: Record<ReportGroup['key'], string> = { conversation: 'scr-abs', often_late: 'scr-late', rarely_absent: 'scr-on', on_time: 'scr-on2' };

/** Counts only: "View staff" opens the names in the side sheet. */
export const GroupCards: React.FC<{ groups: ReportGroup[]; staff: number; ready: boolean; onView: (g: ReportGroup) => void }> = ({ groups, staff, ready, onView }) => (
  <div className="scr-groups">
    {groups.map((g) => (
      <section key={g.key} className="sc-card scr-group">
        <div className="scr-group-head">
          <span className="scr-dotlabel"><i className={GROUP_TONE[g.key]} />{g.label}</span>
          <button type="button" className="sc-btn sc-btn-soft sc-btn-sm" disabled={!ready || g.count === 0} onClick={() => onView(g)}>View staff</button>
        </div>
        <div className="scr-big-row"><b className="sc-num">{ready ? g.count : '–'}</b><span>of {staff} staff</span></div>
        <span className="scr-track"><i className={GROUP_TONE[g.key]} style={{ width: `${ready && staff ? Math.max(g.count ? 3 : 0, (g.count / staff) * 100) : 0}%` }} /></span>
        <p className="scr-foot">{g.rule}</p>
      </section>
    ))}
  </div>
);
