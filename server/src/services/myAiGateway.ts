import { config } from '../config.js';
import { getAiPolicy, AiDisabledError } from './aiPolicy.js';
import { AI_REASON_MESSAGES } from '../vendor/nga-access/index.js';
import type { AiPolicy, AiReason, AiTask } from '../vendor/nga-access/index.js';
import { scopedKey, tenantHeader } from '../tenancy/index.js';

/**
 * My AI: people's own AI provider keys, held in the central MIS
 * (MY_AI_GATEWAY.md, PERSONAL_AI_PROVIDERS_PLAN.md §3 and §10).
 *
 * Tendo keeps its own school AI exactly as it is. For a call made by a person,
 * Tendo asks the MIS whether that person's own key should answer; if so the call
 * goes to the MIS gateway, which calls the provider with the key. Keys never
 * reach this server.
 *
 *  - Auth: the SSO client credentials (HTTP Basic), like the ai-policy read,
 *    plus `X-Nga-On-Behalf-Of: <MIS user id>`. Tendo's local user id IS the MIS
 *    user id (see access/snapshot.ts misUserIdOf); callers pass it through that.
 *  - The route map is cached per person for 60 s and dropped when /auth/verify
 *    reports a new `ai_routes_v` or `ai_policy_v` (noteAiRoutesVersion).
 *  - While the school's `policy.personal` is off (or off for "da") nothing here
 *    touches the network.
 *  - Any MIS trouble means the school AI answers: the gateway never makes AI
 *    less available than it was.
 */

const APP = 'da' as const;
const ROUTES_FRESH_MS = 60_000;
/** After a failed routes read, don't ask again for this long. */
const ROUTES_RETRY_MS = 30_000;
const ROUTES_TIMEOUT_MS = () => Number(process.env.MY_AI_ROUTES_TIMEOUT_MS) || 3_000;
/** A model call takes a while; past this the school AI answers instead. */
const GATEWAY_TIMEOUT_MS = () => Number(process.env.MY_AI_GATEWAY_TIMEOUT_MS) || 120_000;

export interface MyAiTaskRoute {
  route: 'personal' | 'school';
  reason: string;
  credentialId?: number;
  provider?: string;
  model?: string;
  label?: string;
  fallbackToSchool?: boolean;
}

export interface MyAiChoice {
  credentialId: number;
  provider: string;
  model: string;
  label: string;
}

export interface MyAiRoutes {
  v: number;
  policyV: number;
  enabled: boolean;
  byTask: Partial<Record<AiTask, MyAiTaskRoute>>;
  choices: MyAiChoice[];
}

/** What answered a call, returned to the client beside `providerUsed`. */
export interface AiAnswerLabel {
  route: 'personal' | 'school';
  reason: string;
  skipped?: unknown;
  fallbackFrom?: string;
  label?: string;
  credentialId?: number;
  provider?: string;
  model?: string;
}

/* ---------------------------------------------------------------- policy */

/** The policy when My AI may be used in Tendo at all, else null. Never a network call of our own. */
export async function personalAiPolicy(): Promise<AiPolicy | null> {
  const policy = await getAiPolicy();
  const p = policy?.personal;
  if (!policy || !p || !p.enabled || p.apps[APP] === false) return null;
  return policy;
}

/** Why the gateway was skipped, in the vocabulary of decidePersonalRoute. */
async function skipReason(): Promise<'PERSONAL_OFF' | 'APP_OFF' | null> {
  const policy = await getAiPolicy();
  const p = policy?.personal;
  if (!policy || !p || !p.enabled) return 'PERSONAL_OFF';
  if (p.apps[APP] === false) return 'APP_OFF';
  return null;
}

/* ------------------------------------------------------------ transport */

function headers(misUserId: number): Record<string, string> {
  const auth = Buffer.from(`${config.ssoClientId}:${config.ssoClientSecret}`).toString('base64');
  return {
    Authorization: `Basic ${auth}`,
    Accept: 'application/json',
    'X-Nga-On-Behalf-Of': String(misUserId),
    ...tenantHeader(),
  };
}

const base = () => `${config.ngaMisBaseUrl}/integrations/ai`;

/* --------------------------------------------------------------- routes */

interface RoutesEntry { data: MyAiRoutes; fetchedAt: number }
/** Keyed `t<tid>:<MIS user id>`: user ids are unique only inside one school. */
const routesCache = new Map<string, RoutesEntry>();
const routesInflight = new Map<string, Promise<MyAiRoutes | null>>();
const routesFailedAt = new Map<string, number>();
const MAX_CACHED = 2_000;

async function fetchRoutes(misUserId: number): Promise<MyAiRoutes | null> {
  try {
    const res = await fetch(`${base()}/routes`, {
      headers: headers(misUserId),
      signal: AbortSignal.timeout(ROUTES_TIMEOUT_MS()),
    });
    if (!res.ok) {
      routesFailedAt.set(scopedKey(misUserId), Date.now());
      return null;
    }
    const body = (await res.json()) as { success?: boolean; data?: MyAiRoutes };
    if (!body?.success || !body.data) { routesFailedAt.set(scopedKey(misUserId), Date.now()); return null; }
    const data: MyAiRoutes = {
      v: Number(body.data.v) || 0,
      policyV: Number(body.data.policyV) || 0,
      enabled: body.data.enabled === true,
      byTask: body.data.byTask && typeof body.data.byTask === 'object' ? body.data.byTask : {},
      choices: Array.isArray(body.data.choices) ? body.data.choices : [],
    };
    if (routesCache.size >= MAX_CACHED) {
      const oldest = routesCache.keys().next().value;
      if (oldest !== undefined) routesCache.delete(oldest);
    }
    routesCache.set(scopedKey(misUserId), { data, fetchedAt: Date.now() });
    routesFailedAt.delete(scopedKey(misUserId));
    return data;
  } catch (err) {
    console.warn('[my-ai] MIS routes unreachable:', err instanceof Error ? err.message : err);
    routesFailedAt.set(scopedKey(misUserId), Date.now());
    return null;
  }
}

/**
 * This person's My AI route map for Tendo, or null when My AI is off, the
 * person is unknown, or the MIS cannot say (then the school AI answers).
 */
export async function getMyAiRoutes(misUserId: number | null | undefined): Promise<MyAiRoutes | null> {
  if (!misUserId || !Number.isInteger(misUserId) || misUserId <= 0) return null;
  const policy = await personalAiPolicy();
  if (!policy) return null;

  const now = Date.now();
  const hit = routesCache.get(scopedKey(misUserId));
  // A policy change since this copy was read makes it stale whatever its age.
  if (hit && hit.data.policyV && policy.v && hit.data.policyV !== policy.v) routesCache.delete(scopedKey(misUserId));
  const entry = routesCache.get(scopedKey(misUserId));
  if (entry && now - entry.fetchedAt < ROUTES_FRESH_MS) return entry.data;

  const failedAt = routesFailedAt.get(scopedKey(misUserId));
  if (failedAt && now - failedAt < ROUTES_RETRY_MS) return entry?.data ?? null;

  let p = routesInflight.get(scopedKey(misUserId));
  if (!p) {
    p = fetchRoutes(misUserId).finally(() => routesInflight.delete(scopedKey(misUserId)));
    routesInflight.set(scopedKey(misUserId), p);
  }
  return (await p) ?? null;
}

/**
 * /auth/verify reported these versions for this person. A different
 * `ai_routes_v` (their keys or "what answers what" changed) or `ai_policy_v`
 * drops their cached route map. Returns true when something was dropped.
 */
export function noteAiRoutesVersion(misUserId: number | null | undefined, routesV: unknown, policyV?: unknown): boolean {
  if (!misUserId) return false;
  const hit = routesCache.get(scopedKey(misUserId));
  if (!hit) return false;
  const differs = (seen: unknown, cached: number) => {
    if (seen === null || seen === undefined) return false;
    const n = Number(seen);
    return Number.isFinite(n) && n !== cached;
  };
  if (differs(routesV, hit.data.v) || differs(policyV, hit.data.policyV)) {
    routesCache.delete(scopedKey(misUserId));
    routesFailedAt.delete(scopedKey(misUserId));
    return true;
  }
  return false;
}

/* -------------------------------------------------------------- gateway */

export interface GatewayMeta {
  task: AiTask;
  feature: string;
  inAssessment?: boolean;
  /** A one-off choice from the AI panel: "school", "<credentialId>" or "<credentialId>:<model>". */
  aiRoute?: string | null;
}

export type GatewayOutcome<T> =
  | { kind: 'personal'; data: T; ai: AiAnswerLabel; usage?: unknown }
  /** 409 AI_USE_SCHOOL */
  | { kind: 'use-school'; reason: string; skipped?: unknown }
  /** 503 AI_KEY_* / AI_PERSONAL_FAILED */
  | { kind: 'key-failed'; code: string; message: string; fallbackAllowed: boolean; label?: string }
  /** 403 AI_DISABLED */
  | { kind: 'disabled'; reason: string; message: string }
  /** Network, timeout, any other status: the school AI answers. */
  | { kind: 'unavailable'; reason: string };

/** POST to the gateway on a person's behalf and classify the answer. Never throws. */
export async function postJson<T>(
  misUserId: number,
  path: '/gateway/json' | '/gateway/text',
  body: Record<string, unknown>,
): Promise<GatewayOutcome<T>> {
  let res: Response;
  try {
    res = await fetch(`${base()}${path}`, {
      method: 'POST',
      headers: { ...headers(misUserId), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS()),
    });
  } catch (err) {
    console.warn('[my-ai] MIS gateway unreachable:', err instanceof Error ? err.message : err);
    return { kind: 'unavailable', reason: 'GATEWAY_UNAVAILABLE' };
  }
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }

  if (res.status === 200 && json?.success) {
    return { kind: 'personal', data: json.data as T, ai: json.ai as AiAnswerLabel, usage: json.usage };
  }
  if (res.status === 409 && json?.code === 'AI_USE_SCHOOL') {
    return { kind: 'use-school', reason: String(json.reason ?? 'NO_ROUTE'), skipped: json.skipped ?? null };
  }
  if (res.status === 503 && typeof json?.code === 'string') {
    return {
      kind: 'key-failed',
      code: json.code,
      message: String(json.message ?? 'Your own AI key could not answer.'),
      fallbackAllowed: json.fallbackAllowed === true,
      label: typeof json.label === 'string' ? json.label : undefined,
    };
  }
  if (res.status === 403 && json?.code === 'AI_DISABLED') {
    return { kind: 'disabled', reason: String(json.reason ?? 'GLOBAL_OFF'), message: String(json.message ?? '') };
  }
  if (res.status === 403 && typeof json?.code === 'string' && json.code.startsWith('AI_GATEWAY_')) {
    // Unknown app / inactive user: the school AI answers (Tendo's own auth already refuses inactive users).
    return { kind: 'unavailable', reason: json.code };
  }
  console.warn('[my-ai] MIS gateway answered', res.status);
  return { kind: 'unavailable', reason: 'GATEWAY_UNAVAILABLE' };
}

/* ------------------------------------------------------- withPersonalAi */

/** 503 to the person: their own key failed and they did not allow the school AI to answer. */
export class PersonalAiUnavailableError extends Error {
  readonly status = 503;
  constructor(readonly code: string, message: string, readonly label?: string) {
    super(message);
    this.name = 'PersonalAiUnavailableError';
  }
}

export const isPersonalAiUnavailableError = (e: unknown): e is PersonalAiUnavailableError =>
  e instanceof PersonalAiUnavailableError;

export interface SchoolResult<T> { data: T; providerUsed: string }

export interface AiAnswer<T> {
  data: T;
  providerUsed: string;
  ai: AiAnswerLabel;
}

/**
 * Run one AI call by a person: their own key through the MIS gateway when that
 * is what answers them, otherwise (or on any fallback the contract allows) the
 * app's own school AI, unchanged. Implements the MY_AI_GATEWAY.md table:
 *
 *   policy.personal off / apps.da false → school, no network
 *   200            → personal answer, ai from the gateway
 *   409            → school, ai { route: school, reason, skipped }
 *   503 + fallback → school, ai { reason: KEY_NOT_ACTIVE, fallbackFrom, label }
 *   503 no fallback→ PersonalAiUnavailableError (503 with the message)
 *   403 AI_DISABLED→ AiDisabledError, as today
 *   other/network  → school, ai { reason: GATEWAY_UNAVAILABLE }
 *
 * The school policy (assertDaAiEnabled / daAiState) must already have allowed
 * the call: My AI only picks which AI answers it. Background work never comes here.
 */
export async function withPersonalAi<T>(
  ctx: GatewayMeta & { misUserId: number | null | undefined },
  run: {
    personal: (meta: Required<Pick<GatewayMeta, 'task' | 'feature'>> & { inAssessment: boolean; aiRoute: string | null }) =>
      Promise<GatewayOutcome<T>>;
    school: () => Promise<SchoolResult<T>>;
  },
): Promise<AiAnswer<T>> {
  const school = async (ai: AiAnswerLabel): Promise<AiAnswer<T>> => {
    const out = await run.school();
    return { data: out.data, providerUsed: out.providerUsed, ai };
  };

  const off = await skipReason();
  if (off) return school({ route: 'school', reason: off });
  const misUserId = ctx.misUserId;
  if (!misUserId || !Number.isInteger(misUserId) || misUserId <= 0) {
    return school({ route: 'school', reason: 'NO_ROUTE' });
  }

  const aiRoute = typeof ctx.aiRoute === 'string' && ctx.aiRoute.trim() ? ctx.aiRoute.trim().slice(0, 200) : null;

  // No one-off choice: the cached map says when the school answers anyway, saving a hop.
  if (!aiRoute) {
    const routes = await getMyAiRoutes(misUserId);
    const forTask = routes?.byTask?.[ctx.task];
    if (routes && (!routes.enabled || forTask?.route !== 'personal')) {
      return school({ route: 'school', reason: forTask?.reason ?? 'NO_ROUTE' });
    }
  }

  const outcome = await run.personal({
    task: ctx.task,
    feature: ctx.feature,
    inAssessment: ctx.inAssessment === true,
    aiRoute,
  });

  switch (outcome.kind) {
    case 'personal': {
      const ai = { ...outcome.ai, route: 'personal' as const };
      return {
        data: outcome.data,
        providerUsed: ai.provider ?? 'my-ai',
        ai,
      };
    }
    case 'use-school':
      return school({ route: 'school', reason: outcome.reason, skipped: outcome.skipped ?? null });
    case 'key-failed':
      if (outcome.fallbackAllowed) {
        return school({ route: 'school', reason: 'KEY_NOT_ACTIVE', fallbackFrom: outcome.code, label: outcome.label });
      }
      throw new PersonalAiUnavailableError(outcome.code, outcome.message, outcome.label);
    case 'disabled': {
      const reason = (outcome.reason in AI_REASON_MESSAGES ? outcome.reason : 'GLOBAL_OFF') as AiReason;
      throw new AiDisabledError(reason);
    }
    case 'unavailable':
    default:
      return school({ route: 'school', reason: outcome.kind === 'unavailable' ? outcome.reason : 'GATEWAY_UNAVAILABLE' });
  }
}

/** The personal branch for structured output: the same prompt + schema the school call uses. */
export function gatewayJson<T>(
  misUserId: number,
  params: { prompt: string; schema: unknown; schemaName?: string; maxOutputTokens?: number; disableThinking?: boolean },
) {
  return (meta: { task: AiTask; feature: string; inAssessment: boolean; aiRoute: string | null }) =>
    postJson<T>(misUserId, '/gateway/json', { ...meta, ...params });
}

/** For the UI: may this person pick their own AI here, and from what. */
export async function myAiSummary(misUserId: number | null | undefined) {
  const routes = await getMyAiRoutes(misUserId);
  return {
    enabled: !!routes?.enabled,
    choices: routes?.enabled ? routes.choices : [],
    byTask: routes?.enabled ? routes.byTask : {},
    manageUrl: `${config.ngaMisFrontendUrl}/my-ai`,
  };
}

/* ---- tests ---- */

export function __resetMyAiCache(): void {
  routesCache.clear();
  routesInflight.clear();
  routesFailedAt.clear();
}

export function __ageMyAiRoutes(misUserId: number, ageMs: number): void {
  const hit = routesCache.get(scopedKey(misUserId));
  if (hit) routesCache.set(scopedKey(misUserId), { ...hit, fetchedAt: Date.now() - ageMs });
}
