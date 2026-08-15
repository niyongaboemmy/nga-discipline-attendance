import { Router, Response } from 'express';
import { getDb } from '../database.js';
import { config } from '../config.js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { authorizePermission } from '../middleware/authorize.js';
import { recordAudit } from '../utils/conduct.js';

const router = Router();

router.use(authMiddleware);

/**
 * Best-effort import of the real MIS roster using the admin's MIS token.
 * The remote MIS exposes a token-gated GET /users; any users it returns are
 * upserted as 'unassigned' if we don't already track them. Failures (e.g. the
 * MIS being unreachable) are swallowed so the local roster is still served.
 */
async function syncMisUsers(misToken?: string) {
  if (!misToken) return;
  try {
    const resp = await fetch(`${config.ngaMisBaseUrl}/users`, {
      headers: { Authorization: `Bearer ${misToken}` },
    });
    if (!resp.ok) return;
    const body = (await resp.json()) as any;
    const list: any[] = Array.isArray(body) ? body : body.data || body.users || [];
    const db = getDb();
    for (const u of list) {
      const id = u.id || u.uuid || u.email;
      if (!id) continue;
      await db.run(
        `INSERT INTO users (id, name, email, role, source)
         VALUES (?, ?, ?, 'unassigned', 'mis')
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           email = COALESCE(excluded.email, users.email),
           updated_at = CURRENT_TIMESTAMP`,
        id, u.name || u.username || 'Unknown', u.email || null
      );
    }
  } catch (err) {
    console.warn('MIS user sync skipped:', (err as Error).message);
  }
}

// GET /api/admin/users — full roster with roles
router.get('/users', authorizePermission('USERS_VIEW', 'USERS_MANAGE'), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    await syncMisUsers(authReq.user?.misToken);
    const db = getDb();
    const users = await db.all(
      `SELECT id, name, email, role, status, source, last_login, created_at
       FROM users
       ORDER BY (role = 'unassigned') DESC, name ASC`
    );
    return res.json({ success: true, data: users });
  } catch (error) {
    console.error('Error listing users:', error);
    return res.status(500).json({ success: false, message: 'Error fetching users.' });
  }
});

// GET /api/admin/overview — real role counts
router.get('/overview', authorizePermission('USERS_VIEW', 'USERS_MANAGE'), async (_req: any, res: Response) => {
  try {
    const db = getDb();
    const row = await db.get(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN role = 'student' THEN 1 ELSE 0 END) AS students,
         SUM(CASE WHEN role = 'teacher' THEN 1 ELSE 0 END) AS teachers,
         SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS admins,
         SUM(CASE WHEN role = 'unassigned' THEN 1 ELSE 0 END) AS unassigned
       FROM users`
    );
    return res.json({
      success: true,
      data: {
        total: row.total || 0,
        students: row.students || 0,
        teachers: row.teachers || 0,
        admins: row.admins || 0,
        unassigned: row.unassigned || 0,
      },
    });
  } catch (error) {
    console.error('Error building overview:', error);
    return res.status(500).json({ success: false, message: 'Error building overview.' });
  }
});

/** Level string used to keep the legacy `role` column in sync with a role's level. */
const roleForLevel: Record<string, 'student' | 'teacher' | 'admin'> = {
  STUDENT: 'student', TEACHER: 'teacher', ADMIN: 'admin',
};

// PUT /api/admin/users/:id/role — assign / change a user's role (persisted).
// Body: { role_id: number }. The legacy `role` column is derived from the
// target role's level and kept in sync, so existing routing/nav logic that
// still reads `role` continues to work unchanged.
router.put('/users/:id/role', authorizePermission('USERS_MANAGE'), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const { id } = req.params;
  const roleId = Number(req.body?.role_id);

  if (!Number.isFinite(roleId)) {
    return res.status(400).json({ success: false, message: 'role_id is required.' });
  }

  try {
    const db = getDb();
    const existing = await db.get('SELECT id, role, role_id FROM users WHERE id = ?', id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }
    const targetRole = await db.get('SELECT id, name, level FROM roles WHERE id = ?', roleId);
    if (!targetRole) {
      return res.status(400).json({ success: false, message: 'That role does not exist.' });
    }
    const newRoleLevel = roleForLevel[targetRole.level];
    if (!newRoleLevel) {
      return res.status(400).json({ success: false, message: `Unknown role level '${targetRole.level}'.` });
    }

    // Lockout guardrail: if this reassigns the caller's own role away from one
    // that holds ROLES_PERMISSIONS_MANAGE, make sure at least one other user
    // still holds it — otherwise nobody could manage roles again.
    if (id === authReq.user?.id) {
      const targetPerms = await db.all(
        `SELECT p.key FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?`,
        roleId
      );
      const keepsManagePermission = targetPerms.some((p: any) => p.key === 'ROLES_PERMISSIONS_MANAGE');
      if (!keepsManagePermission) {
        const others = await db.get(
          `SELECT COUNT(DISTINCT u.id) as count
           FROM users u JOIN role_permissions rp ON rp.role_id = u.role_id
           JOIN permissions p ON p.id = rp.permission_id
           WHERE p.key = 'ROLES_PERMISSIONS_MANAGE' AND u.id != ?`,
          id
        );
        if (!others || others.count === 0) {
          return res.status(400).json({
            success: false,
            message: 'You cannot remove your own role-management permission — you are the only user who has it.',
          });
        }
      }
    }

    await db.run(
      'UPDATE users SET role = ?, role_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      newRoleLevel, roleId, id
    );
    const updated = await db.get('SELECT id, name, email, role, role_id, status, source, last_login FROM users WHERE id = ?', id);

    await recordAudit(db, authReq.user!, 'role.assign', 'user', id, {
      from: { role: existing.role, roleId: existing.role_id },
      to: { role: newRoleLevel, roleId, roleName: targetRole.name },
    });

    return res.json({ success: true, data: updated, message: 'Role updated.' });
  } catch (error) {
    console.error('Error updating role:', error);
    return res.status(500).json({ success: false, message: 'Error updating role.' });
  }
});

// GET /api/admin/audit — paginated audit trail with optional filters
router.get('/audit', authorizePermission('AUDIT_VIEW'), async (req: any, res: Response) => {
  const { action, entityType, search } = req.query;
  const db = getDb();

  let where = ' WHERE 1=1';
  const params: any[] = [];
  if (action) { where += ' AND action = ?'; params.push(action); }
  if (entityType) { where += ' AND entity_type = ?'; params.push(entityType); }
  if (search) {
    where += ' AND (actor_name LIKE ? OR actor_id LIKE ? OR entity_id LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  try {
    const totalRow = await db.get(`SELECT COUNT(*) as count FROM audit_log${where}`, ...params);
    const rows = await db.all(
      `SELECT * FROM audit_log${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      ...params, limit, offset
    );
    // Surface the distinct action vocabulary so the client can build a filter list.
    const actions = await db.all(`SELECT DISTINCT action FROM audit_log ORDER BY action`);
    return res.json({
      success: true,
      data: rows,
      total: totalRow.count,
      actions: actions.map((a) => a.action),
    });
  } catch (error) {
    console.error('Error fetching audit log:', error);
    return res.status(500).json({ success: false, message: 'Error fetching audit log.' });
  }
});

export default router;
