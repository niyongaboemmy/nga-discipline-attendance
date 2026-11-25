/**
 * Tenancy fallback counters (TENANT_SWITCHING_PLAN.md Appendix A.6, Phase 4).
 *
 * Every time Tendo falls back to school 1 instead of knowing the school, it
 * counts it here, by kind:
 *
 *  - `no_context`     code ran with no tenant context (effectiveTenant's shadow path);
 *  - `legacy_tid`     a token or its claims carried no `tid`, so the legacy default was used;
 *  - `payload_no_tid` a job, pub/sub or back-channel logout payload carried no `tid`.
 *
 * The counts for the current UTC day go to MIS `POST /platform/tenancy/fallbacks`
 * once at start-up and every hour (the report doubles as a heartbeat, so it is
 * sent even when everything is 0). MIS turns strict mode on after 7 clean days.
 *
 * Reporting never affects the app: an MIS that does not know the endpoint yet
 * (404), refuses it (401/403) or cannot be reached is logged once, quietly.
 */

export type FallbackKind = 'no_context' | 'legacy_tid' | 'payload_no_tid';
export const FALLBACK_KINDS: readonly FallbackKind[] = ['no_context', 'legacy_tid', 'payload_no_tid'];
const MAX_SITES = 10;

interface DayCounts {
  day: string;
  counts: Record<FallbackKind, number>;
  sites: Set<string>;
}

const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
const emptyDay = (day: string): DayCounts => ({ day, counts: { no_context: 0, legacy_tid: 0, payload_no_tid: 0 }, sites: new Set() });

let today: DayCounts = emptyDay(utcDay());
/** The previous day's totals, kept until a report delivers them (counts from the last hour before midnight). */
let unsentPrevious: DayCounts | null = null;
let clock: () => number = () => Date.now();

function rollover(): DayCounts {
  const day = utcDay(clock());
  if (today.day !== day) {
    const total = FALLBACK_KINDS.reduce((n, k) => n + today.counts[k], 0);
    // Yesterday is re-sent once with its final counts; a quiet yesterday was
    // already reported (every report is cumulative), unless nothing was sent.
    unsentPrevious = total > 0 || !reportedDays.has(today.day) ? today : null;
    today = emptyDay(day);
  }
  return today;
}

/** Count one fallback. `site` names where it happened (kept, at most 10 per day). */
export function noteFallback(kind: FallbackKind, site?: string): void {
  const d = rollover();
  d.counts[kind] += 1;
  if (site && d.sites.size < MAX_SITES) d.sites.add(String(site).slice(0, 120));
}

export interface FallbackReport {
  app: 'tendo';
  day: string;
  counts: Record<FallbackKind, number>;
  sites?: string[];
}

const toReport = (d: DayCounts): FallbackReport => ({
  app: 'tendo',
  day: d.day,
  counts: { ...d.counts },
  ...(d.sites.size ? { sites: [...d.sites] } : {}),
});

/** Today's cumulative counts, as they would be reported. */
export function fallbackSnapshot(): FallbackReport {
  return toReport(rollover());
}

export type ReportOutcome = 'sent' | 'unsupported' | 'failed' | 'skipped';

export interface ReportDeps {
  misBaseUrl: string;
  /** `Authorization` header value for MIS service calls, or null when not configured. */
  authHeader: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const reportedDays = new Set<string>();
let lastOutcome: ReportOutcome | null = null;

function logOnce(outcome: ReportOutcome, detail: string) {
  if (outcome === lastOutcome) return;
  lastOutcome = outcome;
  if (outcome === 'sent') return;
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) return;
  console.info(`[tenancy] fallback report ${outcome}: ${detail}`);
}

async function post(deps: ReportDeps, body: FallbackReport): Promise<ReportOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 5000);
  try {
    const resp = await (deps.fetchImpl ?? fetch)(`${deps.misBaseUrl.replace(/\/+$/, '')}/platform/tenancy/fallbacks`, {
      method: 'POST',
      headers: { Authorization: deps.authHeader!, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (resp.ok) return 'sent';
    if (resp.status === 404 || resp.status === 405 || resp.status === 401 || resp.status === 403) {
      logOnce('unsupported', `MIS answered ${resp.status}`);
      return 'unsupported';
    }
    logOnce('failed', `MIS answered ${resp.status}`);
    return 'failed';
  } catch (err) {
    logOnce('failed', (err as Error)?.message ?? String(err));
    return 'failed';
  } finally {
    clearTimeout(timer);
  }
}

/** Send the day's cumulative counts (and an unsent previous day first). Never throws. */
export async function reportFallbacks(deps: ReportDeps): Promise<ReportOutcome> {
  if (!deps.authHeader || !deps.misBaseUrl) return 'skipped';
  try {
    const current = rollover();
    if (unsentPrevious) {
      const prev = unsentPrevious;
      const r = await post(deps, toReport(prev));
      if (r !== 'sent') return r;
      reportedDays.add(prev.day);
      if (unsentPrevious === prev) unsentPrevious = null;
    }
    const r = await post(deps, toReport(current));
    if (r === 'sent') {
      reportedDays.add(current.day);
      logOnce('sent', '');
    }
    return r;
  } catch {
    return 'failed';
  }
}

/** Report now and every hour. Returns a stop function. The timer never keeps the process alive. */
export function startFallbackReporter(deps: () => ReportDeps, everyMs = 60 * 60 * 1000): () => void {
  void reportFallbacks(deps());
  const t = setInterval(() => void reportFallbacks(deps()), everyMs);
  (t as any).unref?.();
  return () => clearInterval(t);
}

/** Test hooks. */
export function __resetFallbacks(now?: () => number): void {
  clock = now ?? (() => Date.now());
  today = emptyDay(utcDay(clock()));
  unsentPrevious = null;
  reportedDays.clear();
  lastOutcome = null;
}
