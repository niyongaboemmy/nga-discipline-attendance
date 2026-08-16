import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import { Database } from 'sqlite';
import { setupTestDb, createTestUser, authHeader } from './testUtils.js';

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

const { app } = await import('../app.js');

describe('POST /api/discipline/rules/ai-draft', () => {
  let db: Database;
  let adminToken: string;
  let teacherToken: string;

  beforeAll(async () => {
    db = await setupTestDb();
    adminToken = (
      await createTestUser(db, { id: 'ai-admin', name: 'Ada', email: 'ada@s.test', roleLevel: 'ADMIN' })
    ).token;
    teacherToken = (
      await createTestUser(db, { id: 'ai-teacher', name: 'Tom', email: 'tom@s.test', roleLevel: 'TEACHER' })
    ).token;
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
