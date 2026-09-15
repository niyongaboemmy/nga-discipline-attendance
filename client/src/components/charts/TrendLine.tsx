import React, { useMemo, useState } from 'react';
import { ChartTooltip, TableTwin, type TooltipRow, type TooltipState } from './chartCore';
import { useWidth } from './useWidth';

export interface TrendPoint {
  /** Short axis label ("Sep 3"). */
  label: string;
  /** Full label for the tooltip/table ("Wed, Sep 3, 2026"). */
  longLabel: string;
  /** 0–100. */
  value: number;
  /** Extra readout rows for the tooltip (present/absent/… counts). */
  detail?: TooltipRow[];
}

const H = 230;
const PAD = { top: 14, right: 18, bottom: 26, left: 34 };
const TICKS = [0, 25, 50, 75, 100];

/**
 * A single-series rate over time: 2px line, 10% area wash, end marker with a
 * surface ring, hairline grid, and a crosshair that snaps to the nearest
 * date on hover or with the arrow keys. One series, so no legend — the
 * heading names it.
 */
export const TrendLine: React.FC<{ points: TrendPoint[]; title: string; valueLabel?: string }> = ({
  points, title, valueLabel = 'Attendance',
}) => {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const n = points.length;
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - (Math.min(100, Math.max(0, v)) / 100) * plotH;

  const path = useMemo(() => {
    if (n === 0) return { line: '', area: '' };
    const pts = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`);
    const line = `M${pts.join('L')}`;
    const area = `${line}L${x(n - 1).toFixed(1)},${(PAD.top + plotH).toFixed(1)}L${x(0).toFixed(1)},${(PAD.top + plotH).toFixed(1)}Z`;
    return { line, area };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, width]);

  // Show every label when they fit, otherwise thin them out; the last date is
  // always labelled, and a regular label too close to it is dropped so the
  // two never collide.
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 56))));
  const showLabel = (i: number) => i === n - 1 || (i % labelEvery === 0 && n - 1 - i >= labelEvery);

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (n === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const i = n <= 1 ? 0 : Math.round(((px - PAD.left) / plotW) * (n - 1));
    setActive(Math.min(n - 1, Math.max(0, i)));
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (n === 0) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); setActive((a) => Math.min(n - 1, (a ?? -1) + 1)); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); setActive((a) => Math.max(0, (a ?? n) - 1)); }
    else if (e.key === 'Escape') setActive(null);
  };

  const tip: TooltipState | null = active != null && points[active]
    ? {
        x: x(active), y: y(points[active].value),
        title: points[active].longLabel,
        rows: [{ label: valueLabel, value: `${points[active].value}%`, color: 'var(--chart-line)' }, ...(points[active].detail ?? [])],
      }
    : null;

  if (n === 0) return null;
  const last = points[n - 1];

  return (
    <div className="ch" ref={ref}>
      <div className="ch-head"><span className="ch-title">{title}</span></div>
      <div className="ch-plot" style={{ height: H }}>
        {width > 0 && (
          <svg
            width={width} height={H} role="img" aria-label={`${title}: ${points.map((p) => `${p.label} ${p.value}%`).join(', ')}`}
            tabIndex={0}
            onPointerMove={onMove} onPointerLeave={() => setActive(null)} onKeyDown={onKey} onBlur={() => setActive(null)}
          >
            {TICKS.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} className="ch-grid" />
                <text x={PAD.left - 8} y={y(t) + 3.5} className="ch-tick" textAnchor="end">{t}</text>
              </g>
            ))}
            <path d={path.area} className="ch-area" />
            <path d={path.line} className="ch-line" />
            {points.map((p, i) => (
              showLabel(i) && (
                <text key={p.label + i} x={x(i)} y={H - 8} className="ch-tick" textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>{p.label}</text>
              )
            ))}
            {active != null && (
              <line x1={x(active)} x2={x(active)} y1={PAD.top} y2={PAD.top + plotH} className="ch-crosshair" />
            )}
            {/* End marker: the one direct label a single series gets. */}
            <circle cx={x(n - 1)} cy={y(last.value)} r={5.5} className="ch-ring" />
            <circle cx={x(n - 1)} cy={y(last.value)} r={4} className="ch-dot" />
            {active != null && active !== n - 1 && (
              <>
                <circle cx={x(active)} cy={y(points[active].value)} r={5.5} className="ch-ring" />
                <circle cx={x(active)} cy={y(points[active].value)} r={4} className="ch-dot" />
              </>
            )}
            <text
              x={Math.min(x(n - 1) + 8, width - PAD.right)} y={y(last.value) - 9}
              className="ch-endlabel" textAnchor={x(n - 1) + 8 > width - 40 ? 'end' : 'start'}
            >
              {last.value}%
            </text>
          </svg>
        )}
        <ChartTooltip tip={tip} bounds={{ w: width, h: H }} />
      </div>
      <TableTwin
        caption={title}
        head={['Date', `${valueLabel} (%)`, ...(points[0]?.detail?.map((d) => d.label) ?? [])]}
        rows={points.map((p) => [p.longLabel, p.value, ...(p.detail?.map((d) => d.value) ?? [])])}
      />
    </div>
  );
};
