import { Response } from 'express';
import { getDb } from '../../database.js';
import { config } from '../../config.js';
import { IntegrationRequest } from '../../middleware/misBearerAuth.js';
import { holdsAnyPermission } from '../../middleware/authorize.js';
import { recordAudit } from '../../shared/audit.js';
import { getAiPolicy } from '../../services/aiPolicy.js';
import { holdsExternalCap } from '../../services/externalAi.js';
import { aiAppEnabled } from '../../vendor/nga-access/index.js';
import * as rulesRepo from '../discipline/rules.repository.js';
import { ruleSchema } from '../discipline/rules.routes.js';

/**
 * Connector (MCP) tools for Tendo (EXTERNAL_AI_CONTRACT.md §2).
 *
 * The MIS hosts the only MCP endpoint; for "da_" tools it relays the call here
 * with a short-lived MIS token for the signed-in person (misBearerAuth, the
 * same auth as /home-summary). Tools exist only while the school allows the
 * connector (master + "da" switches and policy.external.connector), for staff
 * holding AI_EXTERNAL_CONNECT. Writes only ever create drafts: a rule drafted
 * here is inactive (is_draft = 1) until a person with DISCIPLINE_RULES_MANAGE
 * approves it on the rules page.
 */

const MANAGE = 'DISCIPLINE_RULES_MANAGE';
const LIST_KEYS = [MANAGE, 'DISCIPLINE_LOG'];
const PAGE = 100;
/** Contract: keep each result under about 50 KB. */
const MAX_RESULT_BYTES = 50_000;

interface ToolDef {
  name: string;
  title: string;
  description: string;
  kind: 'read' | 'draft';
  pupilData: boolean;
  inputSchema: Record<string, unknown>;
  /** Local permissions, any of which allows the tool. */
  needs: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'da_list_rules',
    title: 'Discipline rules',
    description:
      "Lists the school's discipline rules catalog in Tendo (merits and demerits): title, category, points, fine, severity and status. No pupil data. Paginate with `cursor`.",
    kind: 'read',
    pupilData: false,
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['demerit', 'merit'], description: 'Only demerits or only merits.' },
        status: { type: 'string', enum: ['active', 'draft', 'retired', 'all'], description: 'Default: active.' },
        cursor: { type: 'string', description: 'From nextCursor of the previous page.' },
      },
      required: [],
    },
    needs: LIST_KEYS,
  },
  {
    name: 'da_draft_rule',
    title: 'Draft a discipline rule',
    description:
      'Saves ONE new discipline rule in Tendo as an inactive draft. It is not used for any pupil until a person with rule-management rights approves it in Tendo (openUrl). Check da_list_rules first to avoid duplicates.',
    kind: 'draft',
    pupilData: false,
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['demerit', 'merit'] },
        category: { type: 'string', description: 'Short grouping, e.g. Tardiness, Uniform, Service.' },
        title: { type: 'string', description: 'The rule, stated concisely (max 150 characters).' },
        description: { type: 'string', description: 'When it applies (optional).' },
        defaultPoints: { type: 'integer', minimum: 1, maximum: 100, description: 'Higher means more serious.' },
        fineAmount: { type: 'number', minimum: 0, description: 'Monetary fine; 0 or omitted when none.' },
        severity: { type: 'string', description: 'Demerits: minor|moderate|major. Merits: small|notable|outstanding.' },
      },
      required: ['type', 'category', 'title', 'defaultPoints'],
    },
    needs: [MANAGE],
  },
];

const publicTool = ({ needs: _needs, ...t }: ToolDef) => t;

type Gate = { ok: true } | { ok: false; status: number; code: string; message: string };

/** May this person use the connector at all right now? */
async function connectorGate(r: IntegrationRequest): Promise<Gate> {
  const policy = await getAiPolicy();
  if (!policy || !aiAppEnabled(policy, 'da') || !policy.external.connector) {
    return { ok: false, status: 403, code: 'EXTERNAL_OFF', message: 'The NGA connector is turned off for Tendo.' };
  }
  if (r.homeProvisioned === false || !r.user) {
    return { ok: false, status: 403, code: 'TOOL_FORBIDDEN', message: 'Sign in to Tendo once before using it from your AI.' };
  }
  if (!(await holdsExternalCap(r.user))) {
    return { ok: false, status: 403, code: 'TOOL_FORBIDDEN', message: 'Your role cannot use NGA from your own Claude or ChatGPT.' };
  }
  return { ok: true };
}

/** GET /api/integration/mcp/tools: the tools this person may use right now. */
export async function mcpTools(req: any, res: Response) {
  const r = req as IntegrationRequest;
  const gate = await connectorGate(r);
  if (!gate.ok) return res.json({ tools: [] });
  const tools: ReturnType<typeof publicTool>[] = [];
  for (const t of TOOLS) if (await holdsAnyPermission(req, t.needs)) tools.push(publicTool(t));
  return res.json({ tools });
}

const refuse = (res: Response, status: number, code: string, message: string) => res.status(status).json({ code, message });

const statusOf = (r: rulesRepo.DisciplineRule) => (r.is_draft ? 'draft' : r.is_active ? 'active' : 'retired');
const ruleRow = (r: rulesRepo.DisciplineRule) => ({
  id: r.id,
  type: r.type,
  category: r.category,
  title: r.title,
  description: r.description,
  defaultPoints: r.default_points,
  fineAmount: Number(r.fine_amount) || 0,
  severity: r.severity,
  status: statusOf(r),
});

const rulesUrl = (id?: number) => `${config.appPublicUrl}/discipline/rules${id ? `?draft=${id}` : ''}`;

/** POST /api/integration/mcp/call */
export async function mcpCall(req: any, res: Response) {
  const r = req as IntegrationRequest;
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const name = typeof body.name === 'string' ? body.name : '';
  const args = body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments) ? body.arguments : {};

  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return refuse(res, 404, 'TOOL_UNKNOWN', `Tendo has no tool called "${name}".`);
  const gate = await connectorGate(r);
  if (!gate.ok) return refuse(res, gate.status, gate.code, gate.message);
  if (!(await holdsAnyPermission(req, tool.needs))) {
    return refuse(res, 403, 'TOOL_FORBIDDEN', 'You do not have permission to use this tool in Tendo.');
  }

  const db = getDb();
  if (tool.name === 'da_list_rules') {
    const type = args.type === 'demerit' || args.type === 'merit' ? args.type : undefined;
    const status = ['active', 'draft', 'retired', 'all'].includes(args.status) ? args.status : 'active';
    const offset = typeof args.cursor === 'string' && /^\d{1,6}$/.test(args.cursor) ? Number(args.cursor) : 0;
    if (args.type !== undefined && !type) return refuse(res, 400, 'BAD_ARGUMENTS', 'type must be "demerit" or "merit".');
    const all = (await rulesRepo.listRules(db, { type })).filter((x) => status === 'all' || statusOf(x) === status);
    const rows: ReturnType<typeof ruleRow>[] = [];
    let size = 0;
    let i = offset;
    for (; i < all.length && rows.length < PAGE; i++) {
      const row = ruleRow(all[i]);
      size += JSON.stringify(row).length;
      if (size > MAX_RESULT_BYTES && rows.length) break;
      rows.push(row);
    }
    const nextCursor = i < all.length ? String(i) : null;
    return res.json({
      result: { rules: rows, total: all.length, nextCursor },
      summary: `${rows.length} of ${all.length} ${status === 'all' ? '' : `${status} `}rule${all.length === 1 ? '' : 's'}.`,
      openUrl: rulesUrl(),
    });
  }

  // da_draft_rule
  const parsed = ruleSchema.safeParse({
    type: args.type,
    category: typeof args.category === 'string' ? args.category.trim() : args.category,
    title: typeof args.title === 'string' ? args.title.trim() : args.title,
    description: typeof args.description === 'string' ? args.description.trim() || undefined : args.description,
    defaultPoints: args.defaultPoints,
    fineAmount: args.fineAmount ?? 0,
    severity: args.severity,
  });
  if (!parsed.success) {
    return refuse(res, 400, 'BAD_ARGUMENTS', parsed.error.issues.map((x) => `${x.path.join('.') || 'rule'}: ${x.message}`).join('; '));
  }
  const rule = parsed.data;
  const clash = (await rulesRepo.listRules(db, { type: rule.type }))
    .find((x) => x.title.trim().toLowerCase() === rule.title.toLowerCase());
  if (clash) {
    return refuse(res, 400, 'BAD_ARGUMENTS', `A ${rule.type} rule called "${clash.title}" already exists (${statusOf(clash)}).`);
  }
  const created = await rulesRepo.createRule(db, { ...rule, createdBy: r.user!.id, draft: true });
  await recordAudit(db, r.user!, 'discipline_rule.draft_external', 'discipline_rule', created.id, {
    via: 'connector', title: created.title, type: created.type,
  });
  return res.status(200).json({
    result: { rule: ruleRow(created) },
    summary: `Saved "${created.title}" as a draft rule. It stays inactive until someone approves it in Tendo.`,
    openUrl: rulesUrl(created.id),
  });
}
