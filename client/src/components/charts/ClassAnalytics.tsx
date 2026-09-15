import React, { useMemo } from 'react';
import type { ClassSectionReport } from '../../api/attendanceReport';
import { COMMENT_META, COMMENT_FILL } from '../../utils/attendanceComment';
import { dailyClassRates, sumCounts, tierCounts } from '../../utils/attendanceAnalytics';
import { STATUS_SERIES } from './statusSeries';
import { TrendLine, type TrendPoint } from './TrendLine';
import { StackedBar } from './StackedBar';
import { ColumnChart } from './ColumnChart';

const fmtShort = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const fmtLong = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

const TIER_BANDS = { Excellent: '95% and above', Good: '85 – 94%', Fair: '75 – 84%', Poor: 'below 75%' } as const;

/**
 * The three analytics a class register needs and no more:
 *   - how attendance moved day by day (the trend),
 *   - what the marks were made of (present / late / excused / absent),
 *   - how the students spread across the comment tiers.
 * The per-student ranking and the register grid stay below, unchanged.
 */
export const ClassAnalytics: React.FC<{ report: ClassSectionReport }> = ({ report }) => {
  const daily = useMemo(() => dailyClassRates(report), [report]);
  const totals = useMemo(() => sumCounts(report.students), [report]);
  const tiers = useMemo(() => tierCounts(report.students), [report]);

  const points: TrendPoint[] = daily.map((d) => ({
    label: fmtShort(d.date),
    longLabel: fmtLong(d.date),
    value: d.rate,
    detail: STATUS_SERIES.map((s) => ({ label: s.label.toLowerCase(), value: String(d.counts[s.key]), color: s.color })),
  }));

  if (report.students.length === 0) return null;

  return (
    <div className="ar-analytics">
      {points.length >= 2 ? (
        <TrendLine title="Daily attendance rate" points={points} valueLabel="Class rate" />
      ) : (
        <div className="ch">
          <div className="ch-head"><span className="ch-title">Daily attendance rate</span></div>
          <p className="text-xs text-secondary">The trend appears once there are at least two recorded days in the range.</p>
        </div>
      )}
      <div className="ar-analytics-side">
        <StackedBar
          title="What the marks were"
          series={STATUS_SERIES}
          rows={[{ label: 'All sessions', values: totals, endLabel: `${report.classAverageRate}%` }]}
        />
        <ColumnChart
          title="Students by attendance band"
          columns={(Object.keys(tiers) as Array<keyof typeof tiers>).map((k) => ({
            label: k, value: tiers[k], color: COMMENT_FILL[k], icon: COMMENT_META[k].icon, hint: TIER_BANDS[k],
          }))}
        />
      </div>
    </div>
  );
};
