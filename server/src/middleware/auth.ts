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

  try {
    const decoded = jwt.verify(token, config.jwtSecret) as any;
    const { roleId, roleName, roleLevel, permissions } = await resolvePermissions(decoded.id);
    (req as AuthenticatedRequest).user = { ...decoded, roleId, roleName, roleLevel, permissions };
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired authorization token.',
    });
  }
}

/** Look up a user's current role + permission set directly from the DB. */
async function resolvePermissions(
  userId: string
): Promise<{ roleId?: number; roleName?: string; roleLevel?: RoleLevel; permissions: Set<string> }> {
  const db = getDb();
  const row = await db.get(
    `SELECT r.id as roleId, r.name as roleName, r.level as roleLevel
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.id = ?`,
    userId
  );
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
