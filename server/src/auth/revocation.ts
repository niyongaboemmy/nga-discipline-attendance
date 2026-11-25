import jwt from 'jsonwebtoken';
import { issuedBeforeRevocation, parseSid } from '../utils/ssoLogout.js';

/**
 * Single sign-out bookkeeping for one school's file (the caller is already in
 * that tenant's database).
 *
 *  - A logout token without `sid` ends every session of the user
 *    (session_revocations, as before).
 *  - A logout token with `sid` (sent by MIS when a browser switches school,
 *    TENANT_SWITCHING_PLAN.md Appendix A.3) ends only the sessions whose
 *    nested MIS token carries that `sid`, plus sessions whose MIS token has
 *    no sid at all (they can't be told apart). The person's other devices
 *    stay signed in.
 */

type Db = {
  get(sql: string, ...params: unknown[]): Promise<any>;
  run(sql: string, ...params: unknown[]): Promise<unknown>;
};

/** Sessions without a sid are filed under ''. */
const NO_SID = '';

/** The `sid` inside a raw MIS token, without verifying it (MIS verifies its own tokens). */
export function sidOfMisToken(token: unknown): string | null {
  if (typeof token !== 'string' || !token) return null;
  try {
    return parseSid((jwt.decode(token) as any)?.sid);
  } catch {
    return null;
  }
}

export async function revokeSessions(db: Db, userId: string, sid: string | null, now = Date.now()): Promise<void> {
  if (!sid) {
    await db.run(
      'INSERT INTO session_revocations (user_id, revoked_at) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET revoked_at = excluded.revoked_at',
      userId,
      now,
    );
    return;
  }
  for (const s of [sid, NO_SID]) {
    await db.run(
      'INSERT INTO session_sid_revocations (user_id, sid, revoked_at) VALUES (?, ?, ?) ON CONFLICT(user_id, sid) DO UPDATE SET revoked_at = excluded.revoked_at',
      userId,
      s,
      now,
    );
  }
}

/** Was this decoded Tendo session ended by a back-channel logout? */
export async function sessionRevoked(db: Db, decoded: { id?: unknown; iat?: number; misToken?: unknown }): Promise<boolean> {
  const userId = String(decoded.id);
  const all = await db.get('SELECT revoked_at FROM session_revocations WHERE user_id = ?', userId);
  if (issuedBeforeRevocation(decoded.iat, all?.revoked_at)) return true;
  const sid = sidOfMisToken(decoded.misToken) ?? NO_SID;
  const one = await db.get('SELECT revoked_at FROM session_sid_revocations WHERE user_id = ? AND sid = ?', userId, sid);
  return issuedBeforeRevocation(decoded.iat, one?.revoked_at);
}
