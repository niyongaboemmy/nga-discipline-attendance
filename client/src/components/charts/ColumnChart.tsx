import React, { useState } from 'react';
import { ChartTooltip, TableTwin, type TooltipState } from './chartCore';
import { useWidth } from './useWidth';

export interface Column {
  label: string;
  value: number;
  color: string;
  icon?: React.ReactNode;
  /** Tooltip detail, e.g. the rate band the tier covers. */
  hint?: string;
}


/**
 * A few columns (≤ 6) with the value on each cap — for "how many fall in
 * each band". Columns are capped at 24px wide, 4px-rounded at the data end
 * and square at the baseline. The columns here are status-coloured tiers,
 * each labelled with its icon and name, so hue is never the only signal.
 */
export const ColumnChart: React.FC<{ title: string; columns: Column[]; unit?: string; plotHeight?: number }> = ({ title, columns, unit = 'students', plotHeight: PLOT_H = 120 }) => {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TooltipState | null>(null);
  const max = Math.max(1, ...columns.map((c) => c.value));

  const show = (e: React.SyntheticEvent<HTMLElement>, c: Column) => {
    const wrap = ref.current?.getBoundingClientRect();
    const r = e.currentTarget.getBoundingClientRect();
    if (!wrap) return;
    setTip({
      x: r.left - wrap.left + r.width / 2, y: r.top - wrap.top,
      title: c.label,
      rows: [{ label: unit, value: String(c.value), color: c.color }, ...(c.hint ? [{ label: c.hint, value: '' }] : [])],
    });
  };

  return (
    <div className="ch" ref={ref}>
      <div className="ch-head"><span className="ch-title">{title}</span></div>
      <div className="ch-cols" style={{ position: 'relative', height: PLOT_H + 44 }} role="img" aria-label={`${title}: ${columns.map((c) => `${c.label} ${c.value}`).join(', ')}`}>
        {columns.map((c) => (
          <div key={c.label} className="ch-col">
            <div className="ch-col-plot" style={{ height: PLOT_H }}>
              <span className="ch-col-value">{c.value}</span>
              <button
                type="button"
                className="ch-col-bar"
                style={{ height: `${(c.value / max) * 100}%`, background: c.color }}
                aria-label={`${c.label}: ${c.value} ${unit}`}
                onPointerEnter={(e) => show(e, c)}
                onFocus={(e) => show(e, c)}
                onPointerLeave={() => setTip(null)}
                onBlur={() => setTip(null)}
              />
            </div>
            <div className="ch-col-label"><span style={{ color: c.color }}>{c.icon}</span>{c.label}</div>
          </div>
        ))}
        <ChartTooltip tip={tip} bounds={{ w: width, h: PLOT_H + 44 }} />
      </div>
      <TableTwin caption={title} head={['Band', unit[0].toUpperCase() + unit.slice(1)]} rows={columns.map((c) => [c.label, c.value])} />
    </div>
  );
};
