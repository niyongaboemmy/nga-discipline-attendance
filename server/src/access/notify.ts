import type { Database } from 'sqlite';
import type { Depth, Target } from '../vendor/nga-access/index.js';
import { fetchHolders } from './misService.js';
import { accessMode, inBackground, recordShadowDiff } from './policy.js';

/**
 * Staff notifications ("attendance drop", "major incident", "conduct
 * follow-up") used to go to user_id = 'all' -- every teacher and admin in the
 * school. Under v2 they go to the holders of a capability at the student's
 * class group (GET {MIS}/access/holders), e.g. DISCIPLINE_REVIEW there.
 *
 *   off     -> the legacy 'all' row, byte-for-byte the same INSERT
 *   shadow  -> the legacy 'all' row; who v2 would notify is logged
 *              (console + access_shadow_diffs, capability "notify:<CAP>")
 *   enforce -> one row per holder (local user id == MIS user id). If MIS
 *              can't answer, or nobody holds the capability there, it falls
 *              back to the local admins, then to 'all' if there are none.
 */
export interface StaffNotice {
  kind: string;
  type: 'system' | 'low_attendance';
  title: string;
  message: string;
  dedupeKey?: string | null;
  cap: string;
  minDepth?: Depth | null;
  /** Resolved lazily: in off/shadow the request never waits for it. */
  target: () => Promise<Target | null>;
}

export async function resolveRecipients(cap: string, target: Target | null, minDepth?: Depth | null): Promise<string[]> {
  const holders = await fetchHolders(cap, target, minDepth ?? null);
  return [...new Set(holders.map((h) => String(h.user_id)))];
}

async function insertAll(db: Database, n: StaffNotice) {
  if (n.dedupeKey) {
    await db.run(
      `INSERT INTO notifications (user_id, type, title, message, dedupe_key) VALUES ('all', ?, ?, ?, ?)`,
      n.type, n.title, n.message, n.dedupeKey
    );
  } else {
    await db.run(
      `INSERT INTO notifications (user_id, type, title, message) VALUES ('all', ?, ?, ?)`,
      n.type, n.title, n.message
    );
  }
}

export async function notifyStaff(db: Database, n: StaffNotice): Promise<void> {
  const mode = accessMode();
  if (mode !== 'enforce') {
    await insertAll(db, n);
    if (mode === 'shadow') {
      inBackground(async () => {
        const target = await n.target();
        let recipients: string[] | null = null;
        try {
          recipients = await resolveRecipients(n.cap, target, n.minDepth);
        } catch (err) {
          console.warn(`[access] holders lookup failed (${n.kind}): ${(err as Error)?.message ?? err}`);
          return;
        }
        console.info(`[access] shadow notify ${n.kind}: 'all' now; v2 would notify ${recipients.length} holder(s) of ${n.cap}`);
        await recordShadowDiff({
          userId: 'notify',
          capability: `notify:${n.cap}`,
          route: `NOTIFY ${n.kind}`,
          legacyAllowed: true,
          v2: { allowed: recipients.length > 0, depth: n.minDepth ?? null },
          target: { target, count: recipients.length, recipients: recipients.slice(0, 40) },
        });
      });
    }
    return;
  }

  let recipients: string[] = [];
  try {
    recipients = await resolveRecipients(n.cap, await n.target(), n.minDepth);
  } catch (err) {
    console.warn(`[access] holders lookup failed (${n.kind}), falling back to admins: ${(err as Error)?.message ?? err}`);
  }
  if (recipients.length === 0) {
    const admins = await db.all(`SELECT id FROM users WHERE role = 'admin' AND status = 'active'`);
    recipients = admins.map((a: any) => String(a.id));
  }
  if (recipients.length === 0) {
    await insertAll(db, n);
    return;
  }
  for (const userId of recipients) {
    await db.run(
      `INSERT OR IGNORE INTO notifications (user_id, type, title, message, dedupe_key) VALUES (?, ?, ?, ?, ?)`,
      userId, n.type, n.title, n.message, n.dedupeKey ? `${n.dedupeKey}:u:${userId}` : null
    );
  }
}
