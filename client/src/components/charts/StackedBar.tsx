import React, { useState } from 'react';
import { ChartTooltip, Legend, TableTwin, type TooltipState } from './chartCore';
import { useWidth } from './useWidth';
import type { Series } from './statusSeries';

export interface StackedRow<K extends string> {
  label: string;
  values: Record<K, number>;
  /** Shown at the row's end — typically the rate the row works out to. */
  endLabel?: string;
}

/**
 * Horizontal part-to-whole bars, one per row, each segment its own hover /
 * focus target with a 2px surface gap between segments. Every row is scaled
 * to its own total (a 100% stack) so rows with different session counts
 * still compare by share; the tooltip and table carry the raw counts.
 */
export function StackedBar<K extends string>({ title, series, rows, unit = 'sessions' }: {
  title: string;
  series: Series<K>[];
  rows: StackedRow<K>[];
  unit?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TooltipState | null>(null);

  const show = (e: React.SyntheticEvent<HTMLElement>, row: StackedRow<K>, s: Series<K>, total: number) => {
    const wrap = ref.current?.getBoundingClientRect();
    const r = e.currentTarget.getBoundingClientRect();
    if (!wrap) return;
    const n = row.values[s.key];
    setTip({
      x: r.left - wrap.left + r.width / 2, y: r.top - wrap.top + r.height / 2,
      title: row.label,
      rows: [
        { label: `${s.label} · ${total ? Math.round((n / total) * 100) : 0}%`, value: `${n} ${unit}`, color: s.color },
        { label: 'total', value: `${total}` },
      ],
    });
  };

  const visible = rows.filter((r) => series.reduce((t, s) => t + r.values[s.key], 0) > 0);
  if (visible.length === 0) return null;

  return (
    <div className="ch" ref={ref}>
      <div className="ch-head"><span className="ch-title">{title}</span></div>
      <Legend series={series} />
      <div className="ch-stack" style={{ position: 'relative' }}>
        {visible.map((row) => {
          const total = series.reduce((t, s) => t + row.values[s.key], 0);
          return (
            <div key={row.label} className="ch-stack-row">
              <span className="ch-stack-label" title={row.label}>{row.label}</span>
              <div className="ch-stack-track" role="img" aria-label={`${row.label}: ${series.map((s) => `${row.values[s.key]} ${s.label.toLowerCase()}`).join(', ')}`}>
                {series.map((s) => {
                  const n = row.values[s.key];
                  if (n <= 0) return null;
                  const pct = (n / total) * 100;
                  return (
                    <button
                      key={s.key}
                      type="button"
                      className="ch-seg"
                      style={{ flexBasis: `${pct}%`, background: s.color }}
                      aria-label={`${s.label}: ${n} of ${total}`}
                      onPointerEnter={(e) => show(e, row, s, total)}
                      onFocus={(e) => show(e, row, s, total)}
                      onPointerLeave={() => setTip(null)}
                      onBlur={() => setTip(null)}
                    >
                      {/* A share label only where it comfortably fits. */}
                      {pct >= 14 && width > 360 && <span className="ch-seg-label">{Math.round(pct)}%</span>}
                    </button>
                  );
                })}
              </div>
              {row.endLabel && <span className="ch-stack-end">{row.endLabel}</span>}
            </div>
          );
        })}
        <ChartTooltip tip={tip} bounds={{ w: width, h: visible.length * 34 }} />
      </div>
      <TableTwin
        caption={title}
        head={['', ...series.map((s) => s.label), 'Total', ...(visible.some((r) => r.endLabel) ? ['Rate'] : [])]}
        rows={visible.map((r) => [
          r.label, ...series.map((s) => r.values[s.key]),
          series.reduce((t, s) => t + r.values[s.key], 0),
          ...(visible.some((x) => x.endLabel) ? [r.endLabel ?? ''] : []),
        ])}
      />
    </div>
  );
}
