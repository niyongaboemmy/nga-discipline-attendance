import { apiGet, apiPost, apiPut, apiDelete } from './client';

export interface DisciplineRule {
  id: number;
  type: 'demerit' | 'merit';
  category: string;
  title: string;
  description: string | null;
  default_points: number;
  fine_amount: number;
  severity: string | null;
  is_active: number;
}

export interface RuleInput {
  type: 'demerit' | 'merit';
  category: string;
  title: string;
  description?: string;
  defaultPoints: number;
  fineAmount?: number;
  severity?: string;
}

export interface TermBalance {
  studentId: string;
  studentName: string;
  academicYearId: number | null;
  academicTermId: number | null;
  balance: number;
  meritPoints: number;
  demeritPoints: number;
  eventCount: number;
}

export const disciplineApi = {
  listRules: (params?: { type?: string; active?: boolean }) => {
    const qs = new URLSearchParams();
    if (params?.type) qs.set('type', params.type);
    if (params?.active !== undefined) qs.set('active', String(params.active));
    const suffix = qs.toString() ? `?${qs}` : '';
    return apiGet<DisciplineRule[]>(`/api/discipline/rules${suffix}`);
  },
  createRule: (input: RuleInput) => apiPost<DisciplineRule>('/api/discipline/rules', input),
  updateRule: (id: number, input: Partial<RuleInput> & { isActive?: boolean }) =>
    apiPut<DisciplineRule>(`/api/discipline/rules/${id}`, input),
  retireRule: (id: number) => apiDelete<DisciplineRule>(`/api/discipline/rules/${id}`),

  adjust: (input: {
    studentId: string; studentName: string; ruleId: number; incidentDate: string;
    className?: string; description?: string; location?: string; sanction?: string;
  }) => apiPost('/api/discipline/adjust', input),

  config: () => apiGet<{
    demeritCategories: string[]; meritCategories: string[];
    demeritTiers: Record<string, number>; meritTiers: Record<string, number>;
    sanctions: string[]; recordStatuses: string[];
  }>('/api/discipline/config'),

  detail: (id: number) => apiGet<{
    record: Record<string, unknown>;
    rule: DisciplineRule | null;
    history: { action: string; actor_name: string | null; details: string | null; created_at: string }[];
  }>(`/api/discipline/${id}`),
  edit: (id: number, patch: Record<string, unknown>) => apiPut(`/api/discipline/${id}`, patch),
  remove: (id: number, reason?: string) => apiDelete(`/api/discipline/${id}`, reason ? { reason } : undefined),
  setStatus: (id: number, body: { status: string; resolutionNote?: string; sanction?: string }) =>
    apiPut(`/api/discipline/${id}/status`, body),

  myTermBalance: () => apiGet<TermBalance>('/api/discipline/term-balance/me'),
  studentTermBalance: (studentId: string) => apiGet<TermBalance>(`/api/discipline/term-balance/${studentId}`),
  stats: () => apiGet<{ studentCount: number; averageBalance: number; atRiskCount: number; students: TermBalance[] }>(
    '/api/discipline/stats'
  ),
};
