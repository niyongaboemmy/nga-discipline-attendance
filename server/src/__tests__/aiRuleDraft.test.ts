import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { Database } from 'sqlite';
import { setupTestDb, createTestUser, authHeader } from './testUtils.js';
// vi.mock is hoisted above this import, so app.ts picks up the mock below.
// (A top-level `await import` would read more obviously, but tsc compiles
// this directory too and rejects top-level await under this module target.)
import { app } from '../app.js';
import { setAiPolicyForTests, __resetAiPolicyCache } from '../services/aiPolicy.js';

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
});
