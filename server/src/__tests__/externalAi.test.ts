import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Database } from 'sqlite';
import { app } from '../app.js';
import { config } from '../config.js';
import { setupTestDb, createTestUser, authHeader } from './testUtils.js';
import { setAiPolicyForTests, __resetAiPolicyCache } from '../services/aiPolicy.js';
import { __resetExternalAiCache } from '../services/externalAi.js';
import { __resetMisBearerCache } from '../middleware/misBearerAuth.js';
import { __resetIntegrationRateLimit } from '../modules/integration/integration.routes.js';

/**
 * External AI (EXTERNAL_AI_CONTRACT.md): "Open in Claude / ChatGPT" + "Paste the
 * answer" on rule drafting, and the connector tools the MIS relays here.
 * No provider and no MIS: both are mocked / stubbed.
 */

const mockGenerate = vi.fn();
vi.mock('../services/aiProviders/index.js', () => ({
  generateStructuredContent: (...args: any[]) => mockGenerate(...args),
  isAnyProviderConfigured: () => true,
}));

const CAP = 'AI_EXTERNAL_CONNECT';
/** A MIS SSO token: what the MIS signs carries the person's permission list. */
const misToken = (userId: number, permissions: string[]) => jwt.sign({ userId, permissions }, 'mis-signing-key');

const POLICY_ON = { v: 1, enabled: true, external: { handoff: true, connector: true, pupilNames: 'with_consent' } };

/** A local session token like the SSO exchange mints, with the MIS token inside. */
const sessionToken = (id: string, role: string, mis: string) =>
  jwt.sign({ id, name: id, email: `${id}@school.test`, role, misToken: mis }, config.jwtSecret, { expiresIn: '1h' });

const DRAFT_ANSWER = {
  rules: [
    { type: 'demerit', category: 'Tardiness', title: 'Late after break', description: 'Back after the bell.', defaultPoints: 2, fineAmount: 0, severity: 'minor' },
  ],
};

describe('External AI hand-off: POST /api/discipline/rules/ai-draft', () => {
  let db: Database;
  let withCap: string;
  let withoutCap: string;

  beforeAll(async () => {
    db = await setupTestDb();
    await createTestUser(db, { id: '8001', name: 'Ada', email: 'ada@s.test', roleLevel: 'ADMIN' });
    await createTestUser(db, { id: '8002', name: 'Bo', email: 'bo@s.test', roleLevel: 'ADMIN' });
    withCap = sessionToken('8001', 'admin', misToken(8001, ['AI_USE', CAP]));
    withoutCap = sessionToken('8002', 'admin', misToken(8002, ['AI_USE']));
  });
  beforeEach(() => {
    setAiPolicyForTests(POLICY_ON);
    mockGenerate.mockReset();
    __resetExternalAiCache();
  });
  afterAll(() => __resetAiPolicyCache());

  const draft = (token: string, body: Record<string, unknown>) =>
    request(app).post('/api/discipline/rules/ai-draft').set(authHeader(token)).send({ prompt: 'rules about lateness', ...body });

  it('prompt mode returns the exact prompt and never calls a provider', async () => {
    await db.run(
      `INSERT INTO discipline_rules (type, category, title, default_points) VALUES ('demerit', 'Contact', 'Call head@school.rw or 0788123456', 3)`,
    );
    const res = await draft(withCap, { aiHandoff: { mode: 'prompt' } });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.handoff.expects).toBe('json');
    expect(res.body.handoff.schemaName).toBe('discipline_rules');
    expect(res.body.handoff.prompt).toContain('rules about lateness');
    expect(res.body.handoff.prompt).toContain('Answer with ONLY one JSON object that matches this JSON Schema, inside a ```json code block');
    // Emails and phone numbers are scrubbed.
    expect(res.body.handoff.prompt).not.toContain('head@school.rw');
    expect(res.body.handoff.prompt).not.toContain('0788123456');
    expect(res.body.handoff.prompt).toContain('[email]');
    expect(res.body.handoff.prompt).toContain('[phone]');
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('import mode turns a pasted answer into the usual drafts, via "handoff", without persisting', async () => {
    const before = (await db.get('SELECT COUNT(*) AS n FROM discipline_rules')).n;
    const pasted = `Sure! Here you go:\n\n\`\`\`json\n${JSON.stringify(DRAFT_ANSWER)}\n\`\`\`\nAnything else?`;
    const res = await draft(withCap, { aiHandoff: { mode: 'import', text: pasted } });
    expect(res.status).toBe(200);
    expect(res.body.data.providerUsed).toBe('handoff');
    expect(res.body.data.ai).toEqual({ route: 'handoff', reason: 'HANDOFF' });
    expect(res.body.data.drafts).toHaveLength(1);
    expect(res.body.data.drafts[0]).toMatchObject({ rule: { title: 'Late after break', defaultPoints: 2 }, error: null });
    expect(mockGenerate).not.toHaveBeenCalled();
    expect((await db.get('SELECT COUNT(*) AS n FROM discipline_rules')).n).toBe(before);
  });

  it('import mode refuses an answer in the wrong format with 400', async () => {
    const res = await draft(withCap, { aiHandoff: { mode: 'import', text: 'I think lateness is bad.' } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AI_HANDOFF_FORMAT');
    expect(res.body.message).toMatch(/isn't in the expected format/);
    const empty = await draft(withCap, { aiHandoff: { mode: 'import', text: '   ' } });
    expect(empty.status).toBe(400);
  });

  it('403 AI_HANDOFF_OFF when the school has hand-off off', async () => {
    setAiPolicyForTests({ v: 2, enabled: true });
    const res = await draft(withCap, { aiHandoff: { mode: 'prompt' } });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ success: false, code: 'AI_HANDOFF_OFF' });
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('403 AI_HANDOFF_NOT_ALLOWED without AI_EXTERNAL_CONNECT', async () => {
    const res = await draft(withoutCap, { aiHandoff: { mode: 'prompt' } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AI_HANDOFF_NOT_ALLOWED');
  });

  it('the school master switch still comes first (AI_DISABLED)', async () => {
    setAiPolicyForTests({ ...POLICY_ON, enabled: false });
    const res = await draft(withCap, { aiHandoff: { mode: 'prompt' } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AI_DISABLED');
  });

  it('ai-status offers hand-off only to someone who may use it', async () => {
    const yes = await request(app).get('/api/discipline/rules/ai-status').set(authHeader(withCap));
    expect(yes.body.data.handoff).toBe(true);
    const no = await request(app).get('/api/discipline/rules/ai-status').set(authHeader(withoutCap));
    expect(no.body.data.handoff).toBeUndefined();
  });
});

describe('Connector tools: /api/integration/mcp/*', () => {
  let db: Database;
  /** MIS token -> MIS user id, answered by the stubbed /auth/verify. */
  const tokens = new Map<string, number>();
  const ADMIN = misToken(9001, ['AI_USE', CAP]);
  const ADMIN_NO_CAP = misToken(9002, ['AI_USE']);
  const TEACHER = misToken(9003, ['AI_USE', CAP]);
  const STUDENT = misToken(9004, ['AI_USE', CAP]);

  beforeAll(async () => {
    db = await setupTestDb();
    await createTestUser(db, { id: '9001', name: 'Ada', email: 'a@s.test', roleLevel: 'ADMIN' });
    await createTestUser(db, { id: '9002', name: 'Bo', email: 'b@s.test', roleLevel: 'ADMIN' });
    await createTestUser(db, { id: '9003', name: 'Tom', email: 't@s.test', roleLevel: 'TEACHER' });
    await createTestUser(db, { id: '9004', name: 'Sam', email: 's@s.test', roleLevel: 'STUDENT' });
    tokens.set(ADMIN, 9001).set(ADMIN_NO_CAP, 9002).set(TEACHER, 9003).set(STUDENT, 9004);
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const token = String((init?.headers as any)?.Authorization ?? '').replace(/^Bearer /, '');
      const json = (data: any, status = 200) => new Response(JSON.stringify({ success: status < 400, data }), { status });
      if (String(url).includes('/auth/verify')) {
        const id = tokens.get(token);
        return id ? json({ userId: id, access_version: 1 }) : json(null, 401);
      }
      return json(null, 404);
    }));
  });
  beforeEach(() => {
    setAiPolicyForTests(POLICY_ON);
    __resetMisBearerCache();
    __resetIntegrationRateLimit();
    __resetExternalAiCache();
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    __resetAiPolicyCache();
  });

  const tools = (token: string) => request(app).get('/api/integration/mcp/tools').set(authHeader(token));
  const call = (token: string, name: string, args: Record<string, unknown> = {}) =>
    request(app).post('/api/integration/mcp/call').set(authHeader(token)).send({ name, arguments: args });

  const RULE = { type: 'demerit', category: 'Phones', title: 'Phone out in class', defaultPoints: 4, severity: 'moderate' };

  it('needs a valid MIS token', async () => {
    const res = await tools('not-a-token');
    expect(res.status).toBe(401);
  });

  it('lists no tools, and refuses calls, while the connector is off', async () => {
    setAiPolicyForTests({ v: 2, enabled: true });
    expect((await tools(ADMIN)).body).toEqual({ tools: [] });
    const res = await call(ADMIN, 'da_list_rules');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EXTERNAL_OFF');

    setAiPolicyForTests({ ...POLICY_ON, apps: { da: false } });
    expect((await tools(ADMIN)).body).toEqual({ tools: [] });
  });

  it('lists both tools for a rules manager holding AI_EXTERNAL_CONNECT', async () => {
    const res = await tools(ADMIN);
    expect(res.status).toBe(200);
    const names = res.body.tools.map((t: any) => t.name);
    expect(names).toEqual(['da_list_rules', 'da_draft_rule']);
    for (const t of res.body.tools) {
      expect(t).toMatchObject({ kind: expect.stringMatching(/^(read|draft)$/), pupilData: false, inputSchema: { type: 'object' } });
      expect(t.needs).toBeUndefined();
    }
  });

  it('gives nothing to staff without AI_EXTERNAL_CONNECT, and nothing to students', async () => {
    expect((await tools(ADMIN_NO_CAP)).body).toEqual({ tools: [] });
    expect((await tools(STUDENT)).body).toEqual({ tools: [] });
    const student = await call(STUDENT, 'da_draft_rule', RULE);
    expect(student.status).toBe(403);
    expect(student.body.code).toBe('TOOL_FORBIDDEN');
    const noCap = await call(ADMIN_NO_CAP, 'da_list_rules');
    expect(noCap.body.code).toBe('TOOL_FORBIDDEN');
  });

  it('da_draft_rule needs DISCIPLINE_RULES_MANAGE', async () => {
    const names = (await tools(TEACHER)).body.tools.map((t: any) => t.name);
    expect(names).not.toContain('da_draft_rule');
    const res = await call(TEACHER, 'da_draft_rule', RULE);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TOOL_FORBIDDEN');
  });

  it('da_draft_rule saves an inactive draft that is never used until a person approves it', async () => {
    const res = await call(ADMIN, 'da_draft_rule', RULE);
    expect(res.status).toBe(200);
    expect(res.body.result.rule).toMatchObject({ title: 'Phone out in class', status: 'draft', defaultPoints: 4 });
    expect(res.body.openUrl).toBe(`${config.appPublicUrl}/discipline/rules?draft=${res.body.result.rule.id}`);
    expect(res.body.summary).toMatch(/draft/i);

    const row = await db.get('SELECT * FROM discipline_rules WHERE id = ?', res.body.result.rule.id);
    expect(row).toMatchObject({ is_active: 0, is_draft: 1, created_by: '9001' });

    // Not in the active catalog the logging screens read.
    const active = await call(ADMIN, 'da_list_rules', {});
    expect(active.body.result.rules.map((r: any) => r.title)).not.toContain('Phone out in class');
    const drafts = await call(ADMIN, 'da_list_rules', { status: 'draft' });
    expect(drafts.body.result.rules.map((r: any) => r.title)).toEqual(['Phone out in class']);

    // A rules manager approves it in the app: active, no longer a draft.
    const session = sessionToken('9001', 'admin', ADMIN);
    const approve = await request(app).put(`/api/discipline/rules/${row.id}`).set(authHeader(session)).send({ isActive: true });
    expect(approve.status).toBe(200);
    expect(await db.get('SELECT is_active, is_draft FROM discipline_rules WHERE id = ?', row.id)).toEqual({ is_active: 1, is_draft: 0 });

    // The same title again is refused rather than duplicated.
    const dup = await call(ADMIN, 'da_draft_rule', RULE);
    expect(dup.status).toBe(400);
    expect(dup.body.code).toBe('BAD_ARGUMENTS');
  });

  it('refuses bad arguments and unknown tools with the contract codes', async () => {
    const bad = await call(ADMIN, 'da_draft_rule', { type: 'demerit', title: 'x' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('BAD_ARGUMENTS');
    const unknown = await call(ADMIN, 'da_delete_rule', { id: 1 });
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('TOOL_UNKNOWN');
  });
});
