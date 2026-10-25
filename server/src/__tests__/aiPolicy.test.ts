import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { config } from '../config.js';
import {
  getAiPolicy, daAiState, noteAiPolicyVersion, setAiPolicyForTests,
  __resetAiPolicyCache, __ageAiPolicy, AiDisabledError,
} from '../services/aiPolicy.js';
import { generateStructuredContent } from '../services/aiProviders/index.js';

/**
 * The school-wide AI switch (AI_USAGE_CONTROL_PLAN §7): the MIS policy client
 * and the provider chokepoint in front of every model call. MIS is mocked.
 */

const policyBody = (policy: Record<string, unknown>) =>
  new Response(JSON.stringify({ success: true, data: { policy } }), { status: 200 });

function stubMis(handler: () => Response | Promise<Response>) {
  const seen: Array<{ url: string; auth: string | null }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    seen.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
    return handler();
  }));
  return seen;
}

beforeEach(() => { __resetAiPolicyCache(); });
afterEach(() => { vi.unstubAllGlobals(); __resetAiPolicyCache(); });

describe('MIS AI policy client', () => {
  it('reads /integrations/ai-policy with the SSO client credentials', async () => {
    const seen = stubMis(() => policyBody({ v: 4, enabled: true }));
    expect(await getAiPolicy()).toMatchObject({ v: 4, enabled: true });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`${config.ngaMisBaseUrl}/integrations/ai-policy`);
    expect(seen[0].auth).toBe(
      `Basic ${Buffer.from(`${config.ssoClientId}:${config.ssoClientSecret}`).toString('base64')}`);
  });

  it('caches for 60 s, then refetches', async () => {
    const seen = stubMis(() => policyBody({ v: 1, enabled: true }));
    await getAiPolicy();
    await getAiPolicy();
    expect(seen).toHaveLength(1);
    __ageAiPolicy(61_000);
    await getAiPolicy();
    expect(seen).toHaveLength(2);
  });

  it('drops the cache when the verify poll reports a new ai_policy_v', async () => {
    let enabled = true;
    stubMis(() => policyBody({ v: enabled ? 1 : 2, enabled }));
    expect((await daAiState()).enabled).toBe(true);
    enabled = false;
    expect(noteAiPolicyVersion(1)).toBe(false);
    expect((await daAiState()).enabled).toBe(true);
    expect(noteAiPolicyVersion(2)).toBe(true);
    expect(await daAiState()).toEqual({
      enabled: false, reason: 'GLOBAL_OFF', message: 'AI is turned off for the school.',
    });
    expect(noteAiPolicyVersion(undefined)).toBe(false);
  });

  it('keeps the last good copy for 15 minutes when MIS fails, then fails closed', async () => {
    let up = true;
    stubMis(() => (up ? policyBody({ v: 1, enabled: true }) : new Response('down', { status: 502 })));
    await getAiPolicy();
    up = false;
    __ageAiPolicy(14 * 60_000);
    expect((await getAiPolicy())?.enabled).toBe(true);
    __ageAiPolicy(16 * 60_000);
    expect(await getAiPolicy()).toBeNull();
    expect((await daAiState()).reason).toBe('GLOBAL_OFF');
  });

  it('fails closed with no copy at all when MIS is unreachable', async () => {
    stubMis(() => { throw new Error('ECONNREFUSED'); });
    expect(await getAiPolicy()).toBeNull();
    expect(await daAiState()).toMatchObject({ enabled: false, reason: 'GLOBAL_OFF' });
  });

  it('reports APP_OFF when only Tendo ("da") is switched off', async () => {
    setAiPolicyForTests({ v: 1, enabled: true, apps: { da: false } });
    expect(await daAiState()).toMatchObject({ enabled: false, reason: 'APP_OFF' });
    setAiPolicyForTests({ v: 1, enabled: true, apps: { tupo: false } });
    expect((await daAiState()).enabled).toBe(true);
  });
});

describe('provider chokepoint', () => {
  it('refuses every model call with AiDisabledError when AI is off', async () => {
    setAiPolicyForTests(null);
    const call = () => generateStructuredContent({ prompt: 'x', schema: { type: 'object' }, schemaName: 'x' } as any);
    await expect(call()).rejects.toBeInstanceOf(AiDisabledError);
    await expect(call()).rejects.toMatchObject({ code: 'AI_DISABLED', status: 403, reason: 'GLOBAL_OFF' });
  });
});
