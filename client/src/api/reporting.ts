import { apiGet } from './client';

export interface AttendanceSummary {
  overallRate: number;
  totalRecords: number;
  bySessionType: Array<{ sessionType: string; total: number; presentRate: number }>;
}

export interface DisciplineSummary {
  totalRecords: number;
  demerits: number;
  merits: number;
  averageBalance: number;
  atRiskCount: number;
}

export interface CombinedReport {
  academicTermId: number | null;
  attendance: AttendanceSummary;
  discipline: DisciplineSummary;
  studentsAtCombinedRisk: Array<{ studentId: string; studentName: string; attendanceRate: number; conductBalance: number }>;
}

export interface TermComparison {
  termA: { academicTermId: number; attendance: AttendanceSummary; discipline: DisciplineSummary };
  termB: { academicTermId: number; attendance: AttendanceSummary; discipline: DisciplineSummary };
  deltas: { attendanceRate: number; disciplineAverageBalance: number; demerits: number; merits: number };
}

export const reportingApi = {
  termly: () => apiGet<{ academicTermId: number | null; attendance: AttendanceSummary; discipline: DisciplineSummary }>(
    '/api/reporting/termly'
  ),
  annual: (academicYearId: number) => apiGet(`/api/reporting/annual?academic_year_id=${academicYearId}`),
  combined: () => apiGet<CombinedReport>('/api/reporting/combined'),
  compare: (termA: number, termB: number) =>
    apiGet<TermComparison>(`/api/reporting/compare?term_a=${termA}&term_b=${termB}`),
};
