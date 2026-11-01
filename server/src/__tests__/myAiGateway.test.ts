import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { config } from '../config.js';
import { setAiPolicyForTests, __resetAiPolicyCache, AiDisabledError } from '../services/aiPolicy.js';
import {
  getMyAiRoutes, noteAiRoutesVersion, withPersonalAi, gatewayJson, PersonalAiUnavailableError,
  __resetMyAiCache, __ageMyAiRoutes,
} from '../services/myAiGateway.js';

/**
 * My AI gateway client (MY_AI_GATEWAY.md): the MIS is mocked with a stubbed
 * fetch; the school AI is a spy. Every row of the contract table is covered.
 */

const USER = 4321;
const ON = { v: 7, enabled: true, personal: { enabled: true } };

const routesBody = (over: Record<string, unknown> = {}) => ({
  success: true,
  data: {
    v: 100, policyV: 7, enabled: true,
    byTask: {
      author: { route: 'personal', reason: 'PERSONAL', credentialId: 12, provider: 'anthropic', model: 'claude-sonnet-5-5', label: 'My Claude', fallbackToSchool: true },
      assist: { route: 'school', reason: 'NO_ROUTE' },
    },
    choices: [{ credentialId: 12, provider: 'anthropic', model: 'claude-sonnet-5-5', label: 'My Claude' }],
    ...over,
  },
});

type Seen = { url: string; method: string; headers: Headers; body: any };

/** Route MIS calls: GET /routes and POST /gateway/json answer from the handlers. */
function stubMis(handlers: {
  routes?: () => Response | Promise<Response>;
  json?: (body: any) => Response | Promise<Response>;
}) {
  const seen: Seen[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    seen.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers), body });
    if (url.endsWith('/integrations/ai/routes')) {
      if (!handlers.routes) throw new Error('unexpected routes call');
      return handlers.routes();
    }
    if (url.endsWith('/integrations/ai/gateway/json')) {
      if (!handlers.json) throw new Error('unexpected gateway call');
      return handlers.json(body);
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
  return seen;
}

const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

const PARAMS = { prompt: 'Draft rules', schema: { type: 'object' }, schemaName: 'discipline_rules', maxOutputTokens: 4000 };

function run(opts: { aiRoute?: string | null; school?: ReturnType<typeof vi.fn> } = {}) {
  const school = opts.school ?? vi.fn(async () => ({ data: { rules: ['school'] }, providerUsed: 'gemini' }));
  const p = withPersonalAi<{ rules: string[] }>(
    { misUserId: USER, task: 'author', feature: 'da.rules-draft', aiRoute: opts.aiRoute ?? null },
    { personal: gatewayJson(USER, PARAMS), school },
  );
  return { p, school };
}

beforeEach(() => { __resetAiPolicyCache(); __resetMyAiCache(); setAiPolicyForTests(ON); });
afterEach(() => { vi.unstubAllGlobals(); __resetAiPolicyCache(); __resetMyAiCache(); });

describe('My AI routes', () => {
  it('reads /integrations/ai/routes with SSO Basic auth on behalf of the MIS user, and caches 60 s', async () => {
    const seen = stubMis({ routes: () => res(200, routesBody()) });
    const r = await getMyAiRoutes(USER);
    expect(r?.choices).toHaveLength(1);
    await getMyAiRoutes(USER);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`${config.ngaMisBaseUrl}/integrations/ai/routes`);
    expect(seen[0].headers.get('authorization')).toBe(
      `Basic ${Buffer.from(`${config.ssoClientId}:${config.ssoClientSecret}`).toString('base64')}`);
    expect(seen[0].headers.get('x-nga-on-behalf-of')).toBe(String(USER));
    __ageMyAiRoutes(USER, 61_000);
    await getMyAiRoutes(USER);
    expect(seen).toHaveLength(2);
  });

  it('drops the cached map on a new ai_routes_v or ai_policy_v, not on the same ones', async () => {
    const seen = stubMis({ routes: () => res(200, routesBody()) });
    await getMyAiRoutes(USER);
    expect(noteAiRoutesVersion(USER, 100, 7)).toBe(false);
    expect(noteAiRoutesVersion(USER, undefined, undefined)).toBe(false);
    await getMyAiRoutes(USER);
    expect(seen).toHaveLength(1);

    expect(noteAiRoutesVersion(USER, 101, 7)).toBe(true);
    await getMyAiRoutes(USER);
    expect(seen).toHaveLength(2);

    expect(noteAiRoutesVersion(USER, 100, 8)).toBe(true);
    await getMyAiRoutes(USER);
    expect(seen).toHaveLength(3);
  });

  it('drops the cached map when the school policy version moves on', async () => {
    const seen = stubMis({ routes: () => res(200, routesBody()) });
    await getMyAiRoutes(USER);
    setAiPolicyForTests({ ...ON, v: 8 });
    await getMyAiRoutes(USER);
    expect(seen).toHaveLength(2);
  });

  it('makes no network call while policy.personal is off or off for "da"', async () => {
    const seen = stubMis({ routes: () => res(200, routesBody()) });
    setAiPolicyForTests({ v: 7, enabled: true });
    expect(await getMyAiRoutes(USER)).toBeNull();
    setAiPolicyForTests({ v: 7, enabled: true, personal: { enabled: true, apps: { da: false } } });
    expect(await getMyAiRoutes(USER)).toBeNull();
    expect(seen).toHaveLength(0);
  });
});

describe('withPersonalAi', () => {
  it('200: the person\'s own key answers through /gateway/json with the same prompt and schema', async () => {
    const ai = { route: 'personal', reason: 'PERSONAL', credentialId: 12, label: 'My Claude', provider: 'anthropic', model: 'claude-sonnet-5-5' };
    const seen = stubMis({
      routes: () => res(200, routesBody()),
      json: () => res(200, { success: true, data: { rules: ['mine'] }, ai, usage: { input_tokens: 1, output_tokens: 2 } }),
    });
    const { p, school } = run();
    const out = await p;
    expect(out).toEqual({ data: { rules: ['mine'] }, providerUsed: 'anthropic', ai });
    expect(school).not.toHaveBeenCalled();
    const post = seen.find((s) => s.url.endsWith('/gateway/json'))!;
    expect(post.method).toBe('POST');
    expect(post.headers.get('x-nga-on-behalf-of')).toBe(String(USER));
    expect(post.body).toEqual({
      task: 'author', feature: 'da.rules-draft', inAssessment: false, aiRoute: null, ...PARAMS,
    });
  });

  it('409 AI_USE_SCHOOL: the school AI answers, labelled with the reason', async () => {
    stubMis({
      routes: () => res(200, routesBody()),
      json: () => res(409, { success: false, code: 'AI_USE_SCHOOL', reason: 'IN_ASSESSMENT', skipped: null }),
    });
    const { p, school } = run();
    expect(await p).toEqual({
      data: { rules: ['school'] }, providerUsed: 'gemini',
      ai: { route: 'school', reason: 'IN_ASSESSMENT', skipped: null },
    });
    expect(school).toHaveBeenCalledOnce();
  });

  it('503 with fallbackAllowed: the school AI answers, labelled with fallbackFrom', async () => {
    stubMis({
      routes: () => res(200, routesBody()),
      json: () => res(503, { success: false, code: 'AI_KEY_NO_CREDIT', message: 'Out of credit', fallbackAllowed: true, label: 'My Claude' }),
    });
    const { p } = run();
    expect((await p).ai).toEqual({ route: 'school', reason: 'KEY_NOT_ACTIVE', fallbackFrom: 'AI_KEY_NO_CREDIT', label: 'My Claude' });
  });

  it('503 without fallback: a 503 error carrying the message, and no school call', async () => {
    stubMis({
      routes: () => res(200, routesBody()),
      json: () => res(503, { success: false, code: 'AI_KEY_INVALID', message: 'Your key was refused.', fallbackAllowed: false, label: 'My Claude' }),
    });
    const { p, school } = run();
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(PersonalAiUnavailableError);
    expect(err).toMatchObject({ status: 503, code: 'AI_KEY_INVALID', message: 'Your key was refused.' });
    expect(school).not.toHaveBeenCalled();
  });

  it('403 AI_DISABLED from the gateway is refused as today', async () => {
    stubMis({
      routes: () => res(200, routesBody()),
      json: () => res(403, { success: false, code: 'AI_DISABLED', reason: 'APP_OFF', message: 'off' }),
    });
    const err = await run().p.catch((e) => e);
    expect(err).toBeInstanceOf(AiDisabledError);
    expect(err.reason).toBe('APP_OFF');
  });

  it('network failure: the school AI answers with GATEWAY_UNAVAILABLE', async () => {
    stubMis({
      routes: () => res(200, routesBody()),
      json: () => { throw new TypeError('fetch failed'); },
    });
    const { p, school } = run();
    expect((await p).ai).toEqual({ route: 'school', reason: 'GATEWAY_UNAVAILABLE' });
    expect(school).toHaveBeenCalledOnce();
  });

  it('an unexpected 5xx from the gateway also means the school AI', async () => {
    stubMis({ routes: () => res(200, routesBody()), json: () => res(502, { oops: true }) });
    expect((await run().p).ai).toEqual({ route: 'school', reason: 'GATEWAY_UNAVAILABLE' });
  });

  it('policy.personal off: straight to the school AI with no network call at all', async () => {
    const seen = stubMis({});
    setAiPolicyForTests({ v: 7, enabled: true });
    const { p, school } = run({ aiRoute: '12' });
    expect((await p).ai).toEqual({ route: 'school', reason: 'PERSONAL_OFF' });
    expect(school).toHaveBeenCalledOnce();

    setAiPolicyForTests({ v: 7, enabled: true, personal: { enabled: true, apps: { da: false } } });
    expect((await run().p).ai).toEqual({ route: 'school', reason: 'APP_OFF' });
    expect(seen).toHaveLength(0);
  });

  it('the cached map says school for this task: no gateway hop', async () => {
    const seen = stubMis({
      routes: () => res(200, routesBody({ byTask: { author: { route: 'school', reason: 'NO_ROUTE' } } })),
    });
    expect((await run().p).ai).toEqual({ route: 'school', reason: 'NO_ROUTE' });
    expect(seen.map((s) => s.url.split('/').pop())).toEqual(['routes']);
  });

  it('a one-off aiRoute goes to the gateway unchanged even when the map says school', async () => {
    const seen = stubMis({
      json: () => res(200, { success: true, data: { rules: [] }, ai: { route: 'personal', reason: 'PERSONAL', provider: 'openai', model: 'gpt-x' } }),
    });
    const out = await run({ aiRoute: '12:claude-opus' }).p;
    expect(out.ai.route).toBe('personal');
    expect(seen).toHaveLength(1);
    expect(seen[0].body.aiRoute).toBe('12:claude-opus');
  });

  it('routes unreadable (MIS down): still tries the gateway, then the school AI', async () => {
    stubMis({
      routes: () => { throw new TypeError('down'); },
      json: () => { throw new TypeError('down'); },
    });
    expect((await run().p).ai).toEqual({ route: 'school', reason: 'GATEWAY_UNAVAILABLE' });
  });
});
