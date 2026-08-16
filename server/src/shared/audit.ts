import { Database } from 'sqlite';

/**
 * Append a row to the audit_log. Best-effort by default (a missing audit row
 * must not fail a role change) — pass `required: true` for ledger-affecting
 * writes (discipline point adjustments, rule changes) where the audit row
 * MUST be written in the same transaction as the mutation, so a thrown error
 * here rolls back the caller's transaction instead of silently losing the
 * audit trail.
 */
export async function recordAudit(
  db: Database,
  actor: { id: string; name?: string },
  action: string,
  entityType: string,
  entityId: string | number | null,
  details?: unknown,
  opts: { required?: boolean; previousValue?: unknown; newValue?: unknown } = {}
): Promise<void> {
  const payload = {
    ...((details && typeof details === 'object') ? details : details !== undefined ? { value: details } : {}),
    ...(opts.previousValue !== undefined ? { previousValue: opts.previousValue } : {}),
    ...(opts.newValue !== undefined ? { newValue: opts.newValue } : {}),
  };
  // Serialize whenever there's anything to store — checking `details` alone
  // used to silently drop a previousValue/newValue diff passed with no
  // `details` argument, losing exactly the before/after history this
  // function exists to preserve.
  const hasPayload = Object.keys(payload).length > 0;
  try {
    await db.run(
      `INSERT INTO audit_log (actor_id, actor_name, action, entity_type, entity_id, details)
       VALUES (?, ?, ?, ?, ?, ?)`,
      actor.id,
      actor.name || null,
      action,
      entityType,
      entityId === null ? null : String(entityId),
      hasPayload ? JSON.stringify(payload) : null
    );
  } catch (err) {
    console.error('Failed to write audit_log entry:', err);
    if (opts.required) throw err;
  }
}
