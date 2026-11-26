/** School-admin side of the staff clock (/api/staff/clock). */
import { apiGet, apiPost, apiPut, apiDelete } from './client';

export interface ClockRules {
  enabled: boolean;
  requireZone: boolean;
  maxAccuracy: number;
  allowance: number;
  opens: string;
  lateAfter: string;
  earlyLeaveBefore: string;
  minShiftMinutes: number;
  autoCloseAt: string;
  selfReplaceDays: number;
  googleDomains: string;
  schoolNetworks: string;
  nonSchoolDays: 'allow_flag' | 'refuse';
  allowUnassignedStaff: boolean;
  setupDone?: string[];
}

export interface ClockZone {
  id: number;
  name: string;
  kind: 'circle' | 'polygon';
  center_lat: number | null;
  center_lng: number | null;
  radius_m: number | null;
  active: number;
}

export interface ClockConfig {
  rules: ClockRules;
  zones: ClockZone[];
  link: { slug: string; url: string; display: string };
  school: { name: string; slug: string; timezone: string };
  googleConfigured: boolean;
}

export interface ClockDevice {
  id: number;
  user_id: string;
  user_name: string;
  google_email: string;
  form_factor: 'phone' | 'tablet' | 'desktop';
  label: string | null;
  status: 'pending' | 'active' | 'revoked' | 'replaced' | 'declined';
  registered_at: string;
  approved_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
}

export interface OverviewRow {
  recordId: number | null;
  userId: string;
  name: string;
  role: string;
  checkIn: string | null;
  checkOut: string | null;
  status: 'present' | 'late' | 'not_in' | 'invalid';
  outStatus: string | null;
  distance: number | null;
  source: string | null;
  device: string | null;
  flags: string[];
  needsReview: boolean;
  reviewState: string | null;
}

export interface Overview {
  date: string;
  isToday: boolean;
  serverNow: string;
  rosterSource: 'mis' | 'local';
  rules: { lateAfter: string; earlyLeaveBefore: string; opens: string; enabled: boolean };
  kpis: { staff: number; checkedIn: number; onTime: number; late: number; notIn: number; checkedOut: number; earlyLeave: number; needsReview: number; medianLateMinutes: number | null };
  arrivals: Array<{ from: string; to: string; onTime: number; late: number }>;
  rows: OverviewRow[];
  review: Array<{ recordId: number; userId: string; name: string; at: string | null; flags: string[]; flagText: string[]; distance: number | null; accuracy: number | null }>;
  phones: { registered: number; staff: number; pending: ClockDevice[]; unregistered: Array<{ id: string; name: string }> };
  missing?: { checkoutOpen: boolean; noCheckoutToday: MissingCheckout[]; recentNoCheckout: MissingCheckout[] };
  health?: { google: boolean; zones: number; enabled: boolean; tested: boolean; shared: boolean; unregistered: number; staff: number };
}

export interface MissingCheckout { userId: string; name: string; date: string; checkIn: string | null; autoClosed: boolean }

export interface IssuedCard {
  userId: string;
  name: string;
  code: string;
  cardId: number;
}

export interface ScanResult {
  action: 'check_in' | 'check_out';
  at: string;
  status: string;
  distance: number | null;
  person: { name: string; firstName: string; initials: string };
  checkIn: string | null;
  checkOut: string | null;
}

const data = async <T>(p: Promise<{ data?: T }>) => (await p).data as T;

export type HistoryKind = 'on_time' | 'late' | 'absent' | 'invalid' | 'off' | 'today' | 'future' | 'untracked';
export interface HistoryDay { date: string; kind: HistoryKind; in: string | null; out: string | null; early: boolean; noOut: boolean; minutes: number | null; card: boolean }
export interface PersonHistory {
  person: { id: string; name: string; role: string | null };
  from: string; to: string; today: string; trackingFrom: string;
  rules: { lateAfter: string | null; earlyLeaveBefore: string };
  days: HistoryDay[];
  summary: { schoolDays: number; attended: number; onTime: number; late: number; absent: number; noOut: number; early: number; rate: number | null; punctuality: number | null; avgIn: string | null; streak: number; bestStreak: number };
}

export const staffClockApi = {
  history: (id: string, days = 365) => data(apiGet<PersonHistory>(`/api/staff/clock/people/${encodeURIComponent(id)}/history?days=${days}`)),
  config: () => data(apiGet<ClockConfig>('/api/staff/clock/config')),
  saveRules: (rules: Partial<ClockRules>) => data(apiPut<{ rules: ClockRules }>('/api/staff/clock/config', rules)),
  createZone: (z: { name: string; lat: number; lng: number; radius: number; active?: boolean }) => data(apiPost<ClockZone>('/api/staff/clock/zones', z)),
  updateZone: (id: number, z: Partial<{ name: string; lat: number; lng: number; radius: number; active: boolean }>) =>
    apiPut<ClockZone>(`/api/staff/clock/zones/${id}`, z),
  deleteZone: (id: number) => apiDelete(`/api/staff/clock/zones/${id}`),
  overview: (date?: string) => data(apiGet<Overview>(`/api/staff/clock/overview${date ? `?date=${date}` : ''}`)),
  devices: (status?: string) => data(apiGet<ClockDevice[]>(`/api/staff/clock/devices${status ? `?status=${status}` : ''}`)),
  deviceAction: (id: number, action: 'approve' | 'decline' | 'revoke', reason?: string) => apiPost<ClockDevice>(`/api/staff/clock/devices/${id}/${action}`, { reason }),
  review: (recordId: number, decision: 'accepted' | 'invalid', note?: string) => apiPost(`/api/staff/clock/attendance/${recordId}/review`, { decision, note }),
  cards: () => data(apiGet<Array<{ id: number; user_id: string; user_name: string; issued_at: string; last_used_at: string | null }>>('/api/staff/clock/cards')),
  issueCards: (people: Array<{ id: string; name: string }>) => data(apiPost<{ school: string; cards: IssuedCard[] }>('/api/staff/clock/cards', { people })),
  revokeCard: (id: number) => apiPost(`/api/staff/clock/cards/${id}/revoke`),
  scan: (body: { code: string; position: unknown; samples?: unknown }) => apiPost<ScanResult>('/api/staff/clock/scan', body),
  pair: () => data(apiPost<{ code: string; url: string; expiresIn: number }>('/api/staff/clock/pair')),
  readPair: (code: string) => data(apiGet<{ readings: Array<{ lat: number; lng: number; accuracy: number; ts?: number; at: number }>; expiresIn: number }>(`/api/staff/clock/pair/${encodeURIComponent(code)}`)),
};

export function initialsOf(name: string): string {
  return String(name || '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');
}
