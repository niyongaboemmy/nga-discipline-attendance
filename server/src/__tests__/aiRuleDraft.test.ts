import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { Database } from 'sqlite';
import { setupTestDb, createTestUser, authHeader } from './testUtils.js';
// vi.mock is hoisted above this import, so app.ts picks up the mock below.
// (A top-level `await import` would read more obviously, but tsc compiles
// this directory too and rejects top-level await under this module target.)
import { app } from '../app.js';
import { setAiPolicyForTests, __resetAiPolicyCache } from '../services/aiPolicy.js';
import { __resetMyAiCache } from '../services/myAiGateway.js';

// Mocked so the suite never makes a real provider call (no keys, no cost, no
// flakiness). The contract under test is this route's handling of whatever
// the model returns — the provider fallback chain itself is exercised in the
// MIS, which this module was ported from.
const mockGenerate = vi.fn();
const mockConfigured = vi.fn(() => true);
vi.mock('../services/aiProviders/index.js', () => ({
  generateStructuredContent: (...args: any[]) => mockGenerate(...args),
  isAnyProviderConfigured: () => mockConfigured(),
}));

describe('POST /api/discipline/rules/ai-draft', () => {
  let db: Database;
  let adminToken: string;
  let teacherToken: string;

  beforeAll(async () => {
    // The school's AI switch lives in the MIS; pinned on here, off in its own tests.
    setAiPolicyForTests({ v: 1, enabled: true });
    db = await setupTestDb();
    adminToken = (
      await createTestUser(db, { id: 'ai-admin', name: 'Ada', email: 'ada@s.test', roleLevel: 'ADMIN' })
    ).token;
    teacherToken = (
      await createTestUser(db, { id: 'ai-teacher', name: 'Tom', email: 'tom@s.test', roleLevel: 'TEACHER' })
    ).token;
  });

  afterAll(() => { __resetAiPolicyCache(); });

  it('answers 403 AI_DISABLED when the school has turned AI off, before any provider', async () => {
    setAiPolicyForTests({ v: 2, enabled: false });
    mockGenerate.mockClear();
    try {
      const res = await request(app)
        .post('/api/discipline/rules/ai-draft')
        .set(authHeader(adminToken))
        .send({ prompt: 'rules about lateness' });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        success: false, code: 'AI_DISABLED', reason: 'GLOBAL_OFF', message: 'AI is turned off for the school.',
      });
      expect(mockGenerate).not.toHaveBeenCalled();

      setAiPolicyForTests({ v: 3, enabled: true, apps: { da: false } });
      const appOff = await request(app)
        .post('/api/discipline/rules/ai-draft')
        .set(authHeader(adminToken))
        .send({ prompt: 'rules about lateness' });
      expect(appOff.status).toBe(403);
      expect(appOff.body.reason).toBe('APP_OFF');
    } finally {
      setAiPolicyForTests({ v: 1, enabled: true });
    }
  });

  it('GET /rules/ai-status reports the school switch for the rules page', async () => {
    const on = await request(app).get('/api/discipline/rules/ai-status').set(authHeader(adminToken));
    expect(on.status).toBe(200);
    expect(on.body.data).toMatchObject({ available: true, configured: true, policy: { enabled: true } });

    setAiPolicyForTests(null);
    try {
      const off = await request(app).get('/api/discipline/rules/ai-status').set(authHeader(adminToken));
      expect(off.body.data).toEqual({
        available: false,
        configured: true,
        policy: { enabled: false, reason: 'GLOBAL_OFF', message: 'AI is turned off for the school.' },
      });
    } finally {
      setAiPolicyForTests({ v: 1, enabled: true });
    }

    const teacher = await request(app).get('/api/discipline/rules/ai-status').set(authHeader(teacherToken));
    expect(teacher.status).toBe(403);
  });

  it('requires DISCIPLINE_RULES_MANAGE', async () => {
    const res = await request(app)
      .post('/api/discipline/rules/ai-draft')
      .set(authHeader(teacherToken))
      .send({ prompt: 'lateness rules' });
    expect(res.status).toBe(403);
  });

  it('rejects an empty prompt', async () => {
    const res = await request(app)
      .post('/api/discipline/rules/ai-draft')
      .set(authHeader(adminToken))
      .send({ prompt: '' });
    expect(res.status).toBe(400);
  });

  it('returns drafts without persisting anything', async () => {
    mockGenerate.mockResolvedValueOnce({
      providerUsed: 'gemini',
      data: {
        rules: [
          { type: 'demerit', category: 'Tardiness', title: 'Late to class', description: 'After the bell.', defaultPoints: 3, fineAmount: 0, severity: 'minor' },
        ],
      },
    });

    const res = await request(app)
      .post('/api/discipline/rules/ai-draft')
      .set(authHeader(adminToken))
      .send({ prompt: 'rules about lateness' });

    expect(res.status).toBe(200);
    expect(res.body.data.providerUsed).toBe('gemini');
    expect(res.body.data.drafts).toHaveLength(1);
    expect(res.body.data.drafts[0].error).toBeNull();

    // Crucially: drafting must not write. The catalog is still empty.
    const listed = await request(app).get('/api/discipline/rules').set(authHeader(adminToken));
    expect(listed.body.data).toHaveLength(0);
  });

  it('flags model output that fails validation instead of trusting it', async () => {
    mockGenerate.mockResolvedValueOnce({
      providerUsed: 'groq',
      data: {
        rules: [
          { type: 'demerit', category: 'OK', title: 'Valid one', description: 'x', defaultPoints: 2, fineAmount: 0, severity: 'minor' },
          // Invalid: bad type, and points out of range.
          { type: 'bogus', category: 'X', title: 'Nonsense', description: 'x', defaultPoints: 999, fineAmount: 0, severity: 'minor' },
        ],
      },
    });

    const res = await request(app)
      .post('/api/discipline/rules/ai-draft')
      .set(authHeader(adminToken))
      .send({ prompt: 'anything' });

    expect(res.status).toBe(200);
    expect(res.body.data.drafts[0].error).toBeNull();
    expect(res.body.data.drafts[1].error).toBeTruthy();
  });

  it('marks drafts that duplicate an existing rule', async () => {
    await request(app)
      .post('/api/discipline/rules')
      .set(authHeader(adminToken))
      .send({ type: 'demerit', category: 'Uniform', title: 'Untidy uniform', defaultPoints: 2 });

    mockGenerate.mockResolvedValueOnce({
      providerUsed: 'gemini',
      data: {
        rules: [
          { type: 'demerit', category: 'Uniform', title: 'untidy UNIFORM', description: 'x', defaultPoints: 2, fineAmount: 0, severity: 'minor' },
        ],
      },
    });

    const res = await request(app)
      .post('/api/discipline/rules/ai-draft')
      .set(authHeader(adminToken))
      .send({ prompt: 'uniform rules' });

    expect(res.status).toBe(200);
    expect(res.body.data.drafts[0].duplicate).toBe(true);
  });

  it('503s with a clear message when no provider is configured', async () => {
    mockConfigured.mockReturnValueOnce(false);
    const res = await request(app)
      .post('/api/discipline/rules/ai-draft')
      .set(authHeader(adminToken))
      .send({ prompt: 'anything' });

    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/not configured/i);
  });

  describe('My AI (own keys via the MIS gateway)', () => {
    // Tendo's local user id is the MIS user id; the gateway is told this one.
    let misAdminToken: string;
    const MIS_ID = 9001;
    const draft = { type: 'demerit', category: 'Phones', title: 'Phone in class', description: 'x', defaultPoints: 2, fineAmount: 0, severity: 'minor' };

    beforeAll(async () => {
      misAdminToken = (
        await createTestUser(db, { id: String(MIS_ID), name: 'Mia', email: 'mia@s.test', roleLevel: 'ADMIN' })
      ).token;
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      __resetMyAiCache();
      setAiPolicyForTests({ v: 1, enabled: true });
    });

    it('policy.personal off: the school path is unchanged and nothing goes to the MIS', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      mockGenerate.mockClear();
      mockGenerate.mockResolvedValueOnce({ providerUsed: 'gemini', data: { rules: [draft] } });
      const res = await request(app)
        .post('/api/discipline/rules/ai-draft')
        .set(authHeader(misAdminToken))
        .send({ prompt: 'phone rules' });
      expect(res.status).toBe(200);
      expect(res.body.data.providerUsed).toBe('gemini');
      expect(res.body.data.drafts[0].rule.title).toBe('Phone in class');
      expect(res.body.data.ai).toEqual({ route: 'school', reason: 'PERSONAL_OFF' });
      expect(mockGenerate).toHaveBeenCalledOnce();
      expect(fetchSpy).not.toHaveBeenCalled();

      const status = await request(app).get('/api/discipline/rules/ai-status').set(authHeader(misAdminToken));
      expect(status.body.data.myAi).toBeUndefined();
    });

    it('a personal route: the gateway gets the same prompt + schema, and `ai` is returned', async () => {
      setAiPolicyForTests({ v: 1, enabled: true, personal: { enabled: true } });
      const ai = { route: 'personal', reason: 'PERSONAL', credentialId: 12, label: 'My Claude', provider: 'anthropic', model: 'claude-sonnet-5-5' };
      const calls: Array<{ url: string; headers: Headers; body: any }> = [];
      vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : null });
        if (url.endsWith('/integrations/ai/routes')) {
          return new Response(JSON.stringify({ success: true, data: {
            v: 3, policyV: 1, enabled: true,
            byTask: { author: { route: 'personal', reason: 'PERSONAL', credentialId: 12, provider: 'anthropic', model: 'claude-sonnet-5-5', label: 'My Claude' } },
            choices: [{ credentialId: 12, provider: 'anthropic', model: 'claude-sonnet-5-5', label: 'My Claude' }],
          } }), { status: 200 });
        }
        return new Response(JSON.stringify({ success: true, data: { rules: [draft] }, ai }), { status: 200 });
      }));
      mockGenerate.mockClear();

      const status = await request(app).get('/api/discipline/rules/ai-status').set(authHeader(misAdminToken));
      expect(status.body.data.myAi).toMatchObject({
        enabled: true, choices: [{ credentialId: 12, label: 'My Claude' }],
      });
      expect(status.body.data.myAi.manageUrl).toMatch(/\/my-ai$/);

      const res = await request(app)
        .post('/api/discipline/rules/ai-draft')
        .set(authHeader(misAdminToken))
        .send({ prompt: 'phone rules', aiRoute: '12' });
      expect(res.status).toBe(200);
      expect(res.body.data.ai).toEqual(ai);
      expect(res.body.data.providerUsed).toBe('anthropic');
      expect(res.body.data.drafts[0].rule.title).toBe('Phone in class');
      expect(mockGenerate).not.toHaveBeenCalled();

      const post = calls.find((c) => c.url.endsWith('/gateway/json'))!;
      expect(post.headers.get('x-nga-on-behalf-of')).toBe(String(MIS_ID));
      expect(post.body).toMatchObject({
        task: 'author', feature: 'da.rules-draft', inAssessment: false, aiRoute: '12',
        schemaName: 'discipline_rules', maxOutputTokens: 4000,
      });
      expect(post.body.prompt).toContain('"""phone rules"""');
      expect(post.body.schema.required).toEqual(['rules']);

      const mine = await request(app).get('/api/ai/my-routes').set(authHeader(misAdminToken));
      expect(mine.body.data).toMatchObject({ enabled: true, choices: [{ credentialId: 12 }] });
    });

    it('a key that fails without fallback answers 503 with its message', async () => {
      setAiPolicyForTests({ v: 1, enabled: true, personal: { enabled: true } });
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
        success: false, code: 'AI_KEY_NO_CREDIT', message: 'Your key is out of credit.', fallbackAllowed: false, label: 'My Claude',
      }), { status: 503 })));
      mockGenerate.mockClear();
      const res = await request(app)
        .post('/api/discipline/rules/ai-draft')
        .set(authHeader(misAdminToken))
        .send({ prompt: 'phone rules', aiRoute: '12' });
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ success: false, code: 'AI_KEY_NO_CREDIT', message: 'Your key is out of credit.' });
      expect(mockGenerate).not.toHaveBeenCalled();
    });

    it('a key that fails with fallback: the school AI drafts, and `ai` says why', async () => {
      setAiPolicyForTests({ v: 1, enabled: true, personal: { enabled: true } });
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
        success: false, code: 'AI_KEY_NO_CREDIT', message: 'Out of credit.', fallbackAllowed: true, label: 'My Claude',
      }), { status: 503 })));
      mockGenerate.mockResolvedValueOnce({ providerUsed: 'groq', data: { rules: [draft] } });
      const res = await request(app)
        .post('/api/discipline/rules/ai-draft')
        .set(authHeader(misAdminToken))
        .send({ prompt: 'phone rules', aiRoute: '12' });
      expect(res.status).toBe(200);
      expect(res.body.data.providerUsed).toBe('groq');
      expect(res.body.data.ai).toEqual({ route: 'school', reason: 'KEY_NOT_ACTIVE', fallbackFrom: 'AI_KEY_NO_CREDIT', label: 'My Claude' });
    });
  });
});
