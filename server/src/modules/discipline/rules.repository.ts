import { Database } from 'sqlite';

export interface DisciplineRule {
  id: number;
  type: 'demerit' | 'merit';
  category: string;
  title: string;
  description: string | null;
  default_points: number;
  fine_amount: number;
  severity: string | null;
  is_active: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateRuleInput {
  type: 'demerit' | 'merit';
  category: string;
  title: string;
  description?: string | null;
  defaultPoints: number;
  fineAmount?: number;
  severity?: string | null;
  createdBy: string;
}

export interface UpdateRuleInput {
  category?: string;
  title?: string;
  description?: string | null;
  defaultPoints?: number;
  fineAmount?: number;
  severity?: string | null;
  isActive?: boolean;
}

export async function listRules(
  db: Database,
  filters: { type?: string; isActive?: boolean } = {}
): Promise<DisciplineRule[]> {
  const clauses: string[] = [];
  const params: any[] = [];
  if (filters.type) {
    clauses.push('type = ?');
    params.push(filters.type);
  }
  if (filters.isActive !== undefined) {
    clauses.push('is_active = ?');
    params.push(filters.isActive ? 1 : 0);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  return db.all(`SELECT * FROM discipline_rules${where} ORDER BY type, category, title`, ...params);
}

export async function getRule(db: Database, id: number): Promise<DisciplineRule | undefined> {
  return db.get(`SELECT * FROM discipline_rules WHERE id = ?`, id);
}

export async function createRule(db: Database, input: CreateRuleInput): Promise<DisciplineRule> {
  const result = await db.run(
    `INSERT INTO discipline_rules
       (type, category, title, description, default_points, fine_amount, severity, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    input.type,
    input.category,
    input.title,
    input.description ?? null,
    input.defaultPoints,
    input.fineAmount ?? 0,
    input.severity ?? null,
    input.createdBy
  );
  const rule = await getRule(db, result.lastID!);
  await recordRuleVersion(db, rule!.id, null, input.defaultPoints, input.fineAmount ?? 0);
  return rule!;
}

export async function updateRule(db: Database, id: number, input: UpdateRuleInput): Promise<DisciplineRule | undefined> {
  const existing = await getRule(db, id);
  if (!existing) return undefined;

  await db.run(
    `UPDATE discipline_rules SET
       category = COALESCE(?, category),
       title = COALESCE(?, title),
       description = COALESCE(?, description),
       default_points = COALESCE(?, default_points),
       fine_amount = COALESCE(?, fine_amount),
       severity = COALESCE(?, severity),
       is_active = COALESCE(?, is_active),
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    input.category ?? null,
    input.title ?? null,
    input.description ?? null,
    input.defaultPoints ?? null,
    input.fineAmount ?? null,
    input.severity ?? null,
    input.isActive === undefined ? null : (input.isActive ? 1 : 0),
    id
  );

  const updated = await getRule(db, id);
  // A point/fine value change gets its own version row, dated from today —
  // records created before this point keep their original snapshot values.
  if (input.defaultPoints !== undefined || input.fineAmount !== undefined) {
    await recordRuleVersion(db, id, null, updated!.default_points, updated!.fine_amount);
  }
  return updated;
}

async function recordRuleVersion(
  db: Database,
  ruleId: number,
  academicTermId: number | null,
  points: number,
  fineAmount: number
): Promise<void> {
  await db.run(
    `INSERT INTO discipline_rule_versions (rule_id, academic_term_id, points, fine_amount, effective_from)
     VALUES (?, ?, ?, ?, date('now'))`,
    ruleId, academicTermId, points, fineAmount
  );
}

export async function listRuleVersions(db: Database, ruleId: number) {
  return db.all(
    `SELECT * FROM discipline_rule_versions WHERE rule_id = ? ORDER BY effective_from DESC, id DESC`,
    ruleId
  );
}
