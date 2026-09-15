import type { ClassSectionReport, StudentAttendanceRow } from '../api/attendanceReport';
import type { StatusKey } from '../components/charts/statusSeries';

/**
 * Everything the report charts plot is derived here from the report payload
 * the pages already fetch — no extra endpoints. The attendance rule matches
 * the server's: present, late and excused all count as attended; only an
 * unexcused absence counts against the rate.
 */

export type StatusCounts = Record<StatusKey, number>;
export const emptyCounts = (): StatusCounts => ({ present: 0, late: 0, excused: 0, absent: 0 });

const isStatus = (s: string): s is StatusKey => s === 'present' || s === 'late' || s === 'excused' || s === 'absent';

export const rateOf = (c: StatusCounts): number => {
  const total = c.present + c.late + c.excused + c.absent;
  return total === 0 ? 0 : Math.round(((c.present + c.late + c.excused) / total) * 100);
};

/** Per date: how the whole class was marked, and the day's attendance rate. */
export function dailyClassRates(report: ClassSectionReport): Array<{ date: string; counts: StatusCounts; rate: number }> {
  return report.dateColumns.map((date) => {
    const counts = emptyCounts();
    for (const s of report.students) {
      const m = s.marks[date];
      if (m && isStatus(m)) counts[m] += 1;
    }
    return { date, counts, rate: rateOf(counts) };
  }).filter((d) => d.counts.present + d.counts.late + d.counts.excused + d.counts.absent > 0);
}

/** Running attendance rate for one student across the dates they were marked —
 *  "where has my term been heading", not the noise of a single day. */
export function runningRate(row: StudentAttendanceRow, dateColumns: string[]): Array<{ date: string; status: StatusKey; rate: number }> {
  const acc = emptyCounts();
  const out: Array<{ date: string; status: StatusKey; rate: number }> = [];
  for (const date of dateColumns) {
    const m = row.marks[date];
    if (!m || !isStatus(m)) continue;
    acc[m] += 1;
    out.push({ date, status: m, rate: rateOf(acc) });
  }
  return out;
}

export const countsOf = (r: { present: number; late: number; excused: number; absent: number }): StatusCounts => ({
  present: r.present, late: r.late, excused: r.excused, absent: r.absent,
});

export function sumCounts(rows: StudentAttendanceRow[]): StatusCounts {
  return rows.reduce((t, r) => ({
    present: t.present + r.present, late: t.late + r.late, excused: t.excused + r.excused, absent: t.absent + r.absent,
  }), emptyCounts());
}

/** How many students land in each comment tier. */
export function tierCounts(rows: StudentAttendanceRow[]): Record<StudentAttendanceRow['comment'], number> {
  const out = { Excellent: 0, Good: 0, Fair: 0, Poor: 0 };
  for (const r of rows) out[r.comment] += 1;
  return out;
}
