import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { getDb } from '../database.js';

export type Role = 'teacher' | 'admin' | 'student' | 'unassigned';
export type RoleLevel = 'STUDENT' | 'TEACHER' | 'ADMIN';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    name: string;
    email: string;
    role: Role;
    misToken?: string;
    academicYearId?: number;
    academicTermId?: number;
    /** RBAC fields — resolved fresh from the DB on every request (not cached in
     *  the JWT), so a role/permission change takes effect on the very next
     *  request with no re-login needed. Empty/undefined for 'unassigned' users
     *  or a JWT whose subject no longer exists. */
    roleId?: number;
    roleName?: string;
    roleLevel?: RoleLevel;
    permissions: Set<string>;
  };
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      message: 'Access denied. No authorization token provided.',
    });
  }

  const token = authHeader.split(' ')[1];

  let decoded: any;
  try {
    decoded = jwt.verify(token, config.jwtSecret);
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired authorization token.',
    });
  }

  const resolved = await resolvePermissions(decoded.id);

  // A cryptographically valid token whose subject no longer exists locally
  // is a dangling session, not an authorization failure. Returning 403 here
  // left the user stuck on a permanent "Forbidden" on every single route
  // with no way out; 401 tells the client the session is dead so it can
  // clear it and send them back through SSO.
  if (!resolved) {
    return res.status(401).json({
      success: false,
      message: 'Your session is no longer valid. Please sign in again.',
    });
  }

  const { roleId, roleName, roleLevel, permissions } = resolved;
  (req as AuthenticatedRequest).user = { ...decoded, roleId, roleName, roleLevel, permissions };
  next();
}

/** Look up a user's current role + permission set directly from the DB.
 *  Returns null when the token's subject has no user row at all (a dangling
 *  session), which the caller turns into a 401 — distinct from a user who
 *  exists but holds no permissions (an 'unassigned' user, role_id NULL),
 *  who gets an empty set and the usual 403s. */
export async function resolvePermissions(
  userId: string
): Promise<{ roleId?: number; roleName?: string; roleLevel?: RoleLevel; permissions: Set<string> } | null> {
  const db = getDb();
  const user = await db.get(`SELECT role_id FROM users WHERE id = ?`, userId);
  if (!user) return null;

  const row = await db.get(
    `SELECT r.id as roleId, r.name as roleName, r.level as roleLevel
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.id = ?`,
    userId
  );
  // User exists but has no role assigned yet (role_id NULL) — they're
  // 'unassigned' and legitimately hold no permissions until an admin
  // grants a role, so this stays a 403 rather than a forced sign-out.
  if (!row) return { permissions: new Set() };

  const perms = await db.all(
    `SELECT p.key FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?`,
    row.roleId
  );
  return {
    roleId: row.roleId,
    roleName: row.roleName,
    roleLevel: row.roleLevel,
    permissions: new Set(perms.map((p: any) => p.key)),
  };
}
