import React, { useEffect, useRef, useState } from 'react';
import type { Series } from './statusSeries';

/** Shared chart chrome: the tooltip, the legend, and the table twin. */

export interface TooltipRow { label: string; value: string; color?: string }
export interface TooltipState { x: number; y: number; title: string; rows: TooltipRow[] }

/** Positioned inside a `position: relative` chart wrapper; clamps to its
 *  bounds so it never spills off a narrow card. */
export const ChartTooltip: React.FC<{ tip: TooltipState | null; bounds: { w: number; h: number } }> = ({ tip, bounds }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 160, h: 60 });
  useEffect(() => {
    if (ref.current) setSize({ w: ref.current.offsetWidth, h: ref.current.offsetHeight });
  }, [tip]);
  if (!tip) return null;
  const gap = 12;
  let left = tip.x + gap;
  if (left + size.w > bounds.w) left = Math.max(0, tip.x - size.w - gap);
  let top = tip.y - size.h / 2;
  top = Math.min(Math.max(0, top), Math.max(0, bounds.h - size.h));
  return (
    <div ref={ref} className="ch-tip" style={{ left, top }} role="status">
      <div className="ch-tip-title">{tip.title}</div>
      {tip.rows.map((r, i) => (
        <div key={i} className="ch-tip-row">
          {r.color && <span className="ch-tip-key" style={{ background: r.color }} />}
          <span className="ch-tip-value">{r.value}</span>
          <span className="ch-tip-label">{r.label}</span>
        </div>
      ))}
    </div>
  );
};

export const Legend: React.FC<{ series: Series[]; shape?: 'rect' | 'line' }> = ({ series, shape = 'rect' }) => (
  <div className="ch-legend" aria-hidden="true">
    {series.map((s) => (
      <span key={s.key} className="ch-legend-item">
        <span className={`ch-swatch is-${shape}`} style={{ background: s.color }} />
        {s.icon}
        {s.label}
      </span>
    ))}
  </div>
);

/** Every chart ships a table twin — the accessible, print-safe reading. */
export const TableTwin: React.FC<{ caption: string; head: string[]; rows: (string | number)[][] }> = ({ caption, head, rows }) => (
  <details className="ch-table">
    <summary>View as table</summary>
    <div className="table-wrap">
      <table className="table">
        <caption className="sr-only">{caption}</caption>
        <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}
        </tbody>
      </table>
    </div>
  </details>
);
