import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { getAiPolicy } from './aiPolicy.js';
import { aiAppEnabled, externalPupilDataAllowed } from '../vendor/nga-access/index.js';
import type { AiPolicy } from '../vendor/nga-access/index.js';
import { matchesSchema } from './aiProviders/schemaValidator.js';
import type { JSONSchema } from './aiProviders/types.js';

/**
 * External AI: people's own Claude / ChatGPT subscriptions
 * (REUSING_AI_SUBSCRIPTIONS_ANALYSIS.md, EXTERNAL_AI_CONTRACT.md in the MIS).
 *
 * A subscription can never be called by Tendo (vendor terms). The person takes
 * Tendo's prompt to their own chat ("Open in Claude / ChatGPT") and pastes the
 * answer back ("Paste the answer"), or adds NGA as a connector in their own
 * Claude/ChatGPT and the MIS relays tool calls here (routes in
 * modules/integration/mcp.ts).
 *
 * Both are staff-only (MIS capability AI_EXTERNAL_CONNECT, read from the
 * person's MIS permission list) and behind the school's policy: the master and
 * "da" switches, then policy.external, all off by default.
 *
 * Same wording and rules as the MIS reference (backend/src/services/ai/handoff.ts).
 */

export const CAP_EXTERNAL = 'AI_EXTERNAL_CONNECT';

export type AiHandoff =
  | { mode: 'prompt'; pupilConsent?: boolean }
  | { mode: 'import'; text: string };

export interface HandoffPayload {
  prompt: string;
  expects: 'json' | 'text';
  schemaName?: string;
}

/** A refusal with Tendo's envelope: `{ success:false, code, message }`. */
export class ExternalAiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ExternalAiError';
  }
}

export const isExternalAiError = (e: unknown): e is ExternalAiError => e instanceof ExternalAiError;
export const externalAiBody = (e: ExternalAiError) => ({ success: false as const, code: e.code, message: e.message });

const MAX_PASTE = 200_000;

/** `aiHandoff` from a request body. Anything that isn't a hand-off is ignored (a normal AI call). */
export function parseHandoff(raw: unknown): AiHandoff | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (r.mode === 'prompt') return { mode: 'prompt', pupilConsent: r.pupilConsent === true };
  if (r.mode === 'import') {
    const text = typeof r.text === 'string' ? r.text : '';
    if (!text.trim()) throw new ExternalAiError(400, 'AI_HANDOFF_EMPTY', 'Paste the answer from your AI first.');
    if (text.length > MAX_PASTE) throw new ExternalAiError(400, 'AI_HANDOFF_TOO_LONG', 'That answer is too long to import.');
    return { mode: 'import', text };
  }
  return undefined;
}

/** Emails and phone numbers never leave in a hand-off prompt (same patterns as the MIS). */
export function scrub(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/(?:\+?250|0)\s?7\d(?:[\s-]?\d){7}/g, '[phone]')
    .replace(/\+\d{1,3}(?:[\s-]?\d){7,12}/g, '[phone]');
}

/** The provider prompt plus an instruction any chat model follows: one fenced JSON object. */
export function jsonHandoffPrompt(prompt: string, schema: JSONSchema): string {
  return [
    prompt.trim(),
    '',
    'Answer with ONLY one JSON object that matches this JSON Schema, inside a ```json code block, with no other text:',
    JSON.stringify(schema),
  ].join('\n');
}

const NOT_IN_FORMAT =
  "The pasted answer isn't in the expected format. Paste the whole reply, including the ```json block, or ask your AI to answer again in that format.";

/** The JSON object in a pasted answer: the last ```json block, else the outermost {...}. */
export function readPastedJson<T>(text: string, schema: JSONSchema): T {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1].trim()).filter((s) => s.startsWith('{'));
  const candidates = fenced.length ? fenced.reverse() : [];
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (matchesSchema(parsed, schema)) return parsed as T;
    } catch {
      /* try the next candidate */
    }
  }
  throw new ExternalAiError(400, 'AI_HANDOFF_FORMAT', NOT_IN_FORMAT);
}

/* ------------------------------------------------- MIS permission list */

const PERMS_TTL_MS = 60_000;
const permsCache = new Map<string, { perms: Set<string>; at: number }>();
const tokenKey = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/**
 * The person's MIS permission list. The SSO token the MIS mints carries it as
 * a `permissions` claim (decoded, not verified: the token came from the MIS
 * through our own session or was just verified by /auth/verify). A token
 * without the claim falls back to MIS GET /users/me. Empty on any failure.
 */
export async function misPermissionsOf(misToken: string | null | undefined): Promise<Set<string>> {
  if (!misToken) return new Set();
  try {
    const claims = jwt.decode(misToken) as { permissions?: unknown } | null;
    if (claims && Array.isArray(claims.permissions)) {
      return new Set(claims.permissions.filter((p): p is string => typeof p === 'string'));
    }
  } catch {
    /* not a JWT: ask the MIS */
  }
  const key = tokenKey(misToken);
  const hit = permsCache.get(key);
  if (hit && Date.now() - hit.at < PERMS_TTL_MS) return hit.perms;
  try {
    const resp = await fetch(`${config.ngaMisBaseUrl}/users/me`, {
      headers: { Authorization: `Bearer ${misToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(3_000),
    });
    if (!resp.ok) return new Set();
    const body = (await resp.json()) as any;
    const list = (body?.data ?? body)?.permissions;
    const perms = new Set<string>(Array.isArray(list) ? list.filter((p: unknown): p is string => typeof p === 'string') : []);
    if (permsCache.size > 2_000) permsCache.clear();
    permsCache.set(key, { perms, at: Date.now() });
    return perms;
  } catch {
    return new Set();
  }
}

/** Does this person hold AI_EXTERNAL_CONNECT in the MIS? Students never do. */
export async function holdsExternalCap(user: { role?: string; roleLevel?: string; misToken?: string } | undefined): Promise<boolean> {
  if (!user || user.role === 'student' || user.roleLevel === 'STUDENT') return false;
  return (await misPermissionsOf(user.misToken)).has(CAP_EXTERNAL);
}

/* ------------------------------------------------------------ hand-off */

/**
 * The hand-off this request asks for, after the school's rules, or undefined
 * for a normal AI call. Throws ExternalAiError (403) when it isn't allowed.
 */
export async function handoffFor(
  req: { body?: any; user?: { role?: string; roleLevel?: string; misToken?: string } },
): Promise<{ handoff: AiHandoff; policy: AiPolicy } | undefined> {
  const handoff = parseHandoff(req.body?.aiHandoff);
  if (!handoff) return undefined;
  const policy = await getAiPolicy();
  if (!policy || !aiAppEnabled(policy, 'da')) {
    // The caller's own AI_DISABLED check normally answers first; this is the backstop.
    throw new ExternalAiError(403, 'AI_DISABLED', 'AI is turned off for the school.');
  }
  if (!policy.external.handoff) {
    throw new ExternalAiError(403, 'AI_HANDOFF_OFF', 'Open in Claude / ChatGPT is turned off for the school.');
  }
  if (!(await holdsExternalCap(req.user))) {
    throw new ExternalAiError(403, 'AI_HANDOFF_NOT_ALLOWED', 'Your role cannot use your own Claude or ChatGPT with NGA.');
  }
  return { handoff, policy };
}

/** Pupil data may leave only with the school's policy and this person's consent for this request. */
export function assertHandoffPupilData(policy: AiPolicy, pupilData: boolean, consent: boolean | undefined): void {
  if (!pupilData) return;
  if (!externalPupilDataAllowed(policy, consent === true)) {
    throw new ExternalAiError(
      403,
      'AI_HANDOFF_PUPIL_CONSENT',
      'This prompt includes a pupil\'s details. Tick "Include pupil details" to take it to your own AI, or use the school\'s AI.',
    );
  }
}

/** What answered a hand-off import, shown as "via your own AI (pasted)". */
export const HANDOFF_AI = { route: 'handoff' as const, reason: 'HANDOFF' };

/**
 * A JSON feature's hand-off: prompt mode returns the payload to send back
 * (no provider is called); import mode returns the validated pasted object.
 */
export function runJsonHandoff<T>(
  ctx: { handoff: AiHandoff; policy: AiPolicy },
  params: { prompt: string; schema: JSONSchema; schemaName?: string },
  pupilData = false,
): { prompt: HandoffPayload } | { data: T } {
  if (ctx.handoff.mode === 'prompt') {
    assertHandoffPupilData(ctx.policy, pupilData, ctx.handoff.pupilConsent);
    return {
      prompt: { prompt: scrub(jsonHandoffPrompt(params.prompt, params.schema)), expects: 'json', schemaName: params.schemaName },
    };
  }
  return { data: readPastedJson<T>(ctx.handoff.text, params.schema) };
}

/** Test hook. */
export function __resetExternalAiCache() {
  permsCache.clear();
}
