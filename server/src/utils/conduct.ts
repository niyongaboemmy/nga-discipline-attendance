import { Database } from 'sqlite';

/**
 * Shared conduct/discipline logic — the single source of truth for point values,
 * category/sanction vocabularies, and score computation. Imported by the
 * discipline route so the API (not the client) owns these rules.
 */

// Point magnitudes per tier. Always positive; the sign is applied in
// computeConductScore (demerits subtract, merits add).
export const DEMERIT_POINTS: Record<string, number> = { minor: 2, moderate: 5, major: 10 };
export const MERIT_POINTS: Record<string, number> = { small: 3, notable: 5, outstanding: 10 };

export const DEMERIT_SEVERITIES = Object.keys(DEMERIT_POINTS);
export const MERIT_SEVERITIES = Object.keys(MERIT_POINTS);

export const SANCTIONS = [
  'none',
  'warning',
  'parent_contact',
  'detention',
  'suspension',
  'community_service',
  'counseling',
] as const;

export const DEMERIT_CATEGORIES = [
  'Misconduct',
  'Tardiness',
  'Uniform',
  'Disruption',
  'Academic Honesty',
  'Property Damage',
  'Bullying',
  'Other',
] as const;

export const MERIT_CATEGORIES = [
  'Leadership',
  'Helpfulness',
  'Academic Excellence',
  'Sportsmanship',
  'Community Service',
  'Improvement',
  'Other',
] as const;

export const RECORD_STATUSES = ['open', 'under_review', 'resolved', 'dismissed'] as const;

export type DisciplineType = 'demerit' | 'merit';

/**
 * Derive the point magnitude for a record from its type + severity tier.
 * Throws on an unrecognized tier so the route can return a 400.
 */
export function derivePoints(type: DisciplineType, severity: string): number {
  const map = type === 'demerit' ? DEMERIT_POINTS : MERIT_POINTS;
  const points = map[severity];
  if (points === undefined) {
    const allowed = Object.keys(map).join(', ');
    throw new Error(`Invalid severity '${severity}' for ${type}. Expected one of: ${allowed}.`);
  }
  return points;
}

/** Validate a category against the vocabulary for the given type. */
export function isValidCategory(type: DisciplineType, category: string): boolean {
  const list = type === 'demerit' ? DEMERIT_CATEGORIES : MERIT_CATEGORIES;
  return (list as readonly string[]).includes(category);
}

/**
 * Conduct score: starts at 100, demerits subtract their points, merits add theirs,
 * clamped to [0, 100]. Records carry a positive 'points' magnitude plus a 'type'.
 */
export function computeConductScore(records: Array<{ type: string; points: number }>): number {
  let score = 100;
  for (const r of records) {
    score += r.type === 'merit' ? r.points : -r.points;
  }
  return Math.max(0, Math.min(100, score));
}

/**
 * Append a row to the audit_log. Best-effort: failures are logged but never block
 * the primary action (a missing audit row must not fail a role change, etc.).
 */
export async function recordAudit(
  db: Database,
  actor: { id: string; name?: string },
  action: string,
  entityType: string,
  entityId: string | number | null,
  details?: unknown
): Promise<void> {
  try {
    await db.run(
      `INSERT INTO audit_log (actor_id, actor_name, action, entity_type, entity_id, details)
       VALUES (?, ?, ?, ?, ?, ?)`,
      actor.id,
      actor.name || null,
      action,
      entityType,
      entityId === null ? null : String(entityId),
      details === undefined ? null : JSON.stringify(details)
    );
  } catch (err) {
    console.error('Failed to write audit_log entry:', err);
  }
}
