import { Router, Response } from 'express';
import { getDb } from '../database.js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { authorizePermission } from '../middleware/authorize.js';
import { recordAudit } from '../utils/conduct.js';
import { PERMISSIONS, PERMISSION_KEYS, PERMISSION_CATEGORIES } from '../constants/permissions.js';

const router = Router();
router.use(authMiddleware);

const VALID_LEVELS = ['STUDENT', 'TEACHER', 'ADMIN'];

// GET /api/roles-permissions/me — the caller's own resolved role + permission
// set, straight from what authMiddleware just computed for this request. Lets
// the frontend re-sync after a role change without a full re-login.
router.get('/me', async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  return res.json({
    success: true,
    data: {
      roleId: authReq.user?.roleId ?? null,
      roleName: authReq.user?.roleName ?? null,
      roleLevel: authReq.user?.roleLevel ?? null,
      permissionKeys: Array.from(authReq.user?.permissions ?? []),
    },
  });
});

// GET /api/roles-permissions/permissions — full catalog, grouped by category.
router.get('/permissions', async (_req: any, res: Response) => {
  const grouped: Record<string, typeof PERMISSIONS> = {};
  for (const p of PERMISSIONS) {
    (grouped[p.category] ||= []).push(p);
  }
  return res.json({ success: true, data: { categories: PERMISSION_CATEGORIES, grouped, all: PERMISSIONS } });
});

async function loadRole(id: number) {
  const db = getDb();
  const role = await db.get('SELECT id, name, level, description, is_system, created_at, updated_at FROM roles WHERE id = ?', id);
  if (!role) return null;
  const perms = await db.all(
    `SELECT p.key FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ? ORDER BY p.key`,
    id
  );
  const userCount = await db.get('SELECT COUNT(*) as count FROM users WHERE role_id = ?', id);
  return { ...role, permissionKeys: perms.map((p: any) => p.key), userCount: userCount.count };
}

// GET /api/roles-permissions/roles — list all roles with their permission keys.
router.get('/roles', authorizePermission('ROLES_PERMISSIONS_VIEW', 'ROLES_PERMISSIONS_MANAGE'), async (_req: any, res: Response) => {
  try {
    const db = getDb();
    const roles = await db.all('SELECT id FROM roles ORDER BY level ASC, name ASC');
    const full = await Promise.all(roles.map((r: any) => loadRole(r.id)));
    return res.json({ success: true, data: full });
  } catch (error) {
    console.error('Error listing roles:', error);
    return res.status(500).json({ success: false, message: 'Error fetching roles.' });
  }
});

// GET /api/roles-permissions/roles/:id — single role detail.
router.get('/roles/:id', authorizePermission('ROLES_PERMISSIONS_VIEW', 'ROLES_PERMISSIONS_MANAGE'), async (req: any, res: Response) => {
  try {
    const role = await loadRole(Number(req.params.id));
    if (!role) return res.status(404).json({ success: false, message: 'Role not found.' });
    return res.json({ success: true, data: role });
  } catch (error) {
    console.error('Error fetching role:', error);
    return res.status(500).json({ success: false, message: 'Error fetching role.' });
  }
});

function validatePermissionKeys(keys: unknown): string[] | null {
  if (!Array.isArray(keys)) return null;
  const unique = Array.from(new Set(keys.map(String)));
  if (unique.some((k) => !PERMISSION_KEYS.has(k))) return null;
  return unique;
}

// POST /api/roles-permissions/roles — create a custom role.
router.post('/roles', authorizePermission('ROLES_PERMISSIONS_MANAGE'), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const { name, level, description } = req.body as { name?: string; level?: string; description?: string };
  const permissionKeys = validatePermissionKeys(req.body?.permissionKeys ?? []);

  if (!name || String(name).trim().length === 0 || String(name).length > 60) {
    return res.status(400).json({ success: false, message: 'Role name is required (max 60 characters).' });
  }
  if (!level || !VALID_LEVELS.includes(level)) {
    return res.status(400).json({ success: false, message: `level must be one of: ${VALID_LEVELS.join(', ')}.` });
  }
  if (permissionKeys === null) {
    return res.status(400).json({ success: false, message: 'permissionKeys must be an array of valid permission keys.' });
  }

  const db = getDb();
  try {
    const existing = await db.get('SELECT id FROM roles WHERE name = ?', name);
    if (existing) {
      return res.status(400).json({ success: false, message: 'A role with that name already exists.' });
    }

    await db.run('BEGIN TRANSACTION');
    const result = await db.run(
      'INSERT INTO roles (name, level, description, is_system) VALUES (?, ?, ?, 0)',
      name, level, description || null
    );
    const roleId = result.lastID!;
    for (const key of permissionKeys) {
      const perm = await db.get('SELECT id FROM permissions WHERE key = ?', key);
      if (perm) await db.run('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)', roleId, perm.id);
    }
    await db.run('COMMIT');

    await recordAudit(db, authReq.user!, 'role.create', 'role', roleId, { name, level, permissionKeys });

    const created = await loadRole(roleId);
    return res.json({ success: true, data: created, message: 'Role created.' });
  } catch (error: any) {
    await db.run('ROLLBACK');
    console.error('Error creating role:', error);
    return res.status(500).json({ success: false, message: error.message || 'Error creating role.' });
  }
});

// PUT /api/roles-permissions/roles/:id — rename / redescribe / replace permission set.
// The role's level is immutable after creation (it's load-bearing for routing/nav).
router.put('/roles/:id', authorizePermission('ROLES_PERMISSIONS_MANAGE'), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const id = Number(req.params.id);
  const { name, description } = req.body as { name?: string; description?: string };
  const permissionKeysProvided = req.body?.permissionKeys !== undefined;
  const permissionKeys = permissionKeysProvided ? validatePermissionKeys(req.body.permissionKeys) : [];

  if (permissionKeysProvided && permissionKeys === null) {
    return res.status(400).json({ success: false, message: 'permissionKeys must be an array of valid permission keys.' });
  }
  if (name !== undefined && (String(name).trim().length === 0 || String(name).length > 60)) {
    return res.status(400).json({ success: false, message: 'Role name must be 1-60 characters.' });
  }

  const db = getDb();
  try {
    const existing = await db.get('SELECT id, name FROM roles WHERE id = ?', id);
    if (!existing) return res.status(404).json({ success: false, message: 'Role not found.' });

    if (name && name !== existing.name) {
      const clash = await db.get('SELECT id FROM roles WHERE name = ? AND id != ?', name, id);
      if (clash) return res.status(400).json({ success: false, message: 'A role with that name already exists.' });
    }

    // Lockout guardrail: don't let the last role holding ROLES_PERMISSIONS_MANAGE lose it.
    if (permissionKeysProvided && !permissionKeys!.includes('ROLES_PERMISSIONS_MANAGE')) {
      const holdsItNow = await db.get(
        `SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
         WHERE rp.role_id = ? AND p.key = 'ROLES_PERMISSIONS_MANAGE'`,
        id
      );
      if (holdsItNow) {
        const otherRolesWithIt = await db.get(
          `SELECT COUNT(DISTINCT rp.role_id) as count FROM role_permissions rp
           JOIN permissions p ON p.id = rp.permission_id
           WHERE p.key = 'ROLES_PERMISSIONS_MANAGE' AND rp.role_id != ?`,
          id
        );
        if (!otherRolesWithIt || otherRolesWithIt.count === 0) {
          return res.status(400).json({
            success: false,
            message: 'Cannot remove role-management permission from the only role that has it.',
          });
        }
      }
    }

    await db.run('BEGIN TRANSACTION');
    if (name !== undefined || description !== undefined) {
      await db.run(
        'UPDATE roles SET name = COALESCE(?, name), description = COALESCE(?, description), updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        name ?? null, description ?? null, id
      );
    }
    if (permissionKeysProvided) {
      await db.run('DELETE FROM role_permissions WHERE role_id = ?', id);
      for (const key of permissionKeys!) {
        const perm = await db.get('SELECT id FROM permissions WHERE key = ?', key);
        if (perm) await db.run('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)', id, perm.id);
      }
    }
    await db.run('COMMIT');

    await recordAudit(db, authReq.user!, 'role.update', 'role', id, { name, description, permissionKeys });

    const updated = await loadRole(id);
    return res.json({ success: true, data: updated, message: 'Role updated.' });
  } catch (error: any) {
    await db.run('ROLLBACK');
    console.error('Error updating role:', error);
    return res.status(500).json({ success: false, message: error.message || 'Error updating role.' });
  }
});

// DELETE /api/roles-permissions/roles/:id — blocked for system roles or roles still in use.
router.delete('/roles/:id', authorizePermission('ROLES_PERMISSIONS_MANAGE'), async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const id = Number(req.params.id);
  const db = getDb();

  try {
    const role = await db.get('SELECT id, name, is_system FROM roles WHERE id = ?', id);
    if (!role) return res.status(404).json({ success: false, message: 'Role not found.' });
    if (role.is_system) {
      return res.status(400).json({ success: false, message: 'System roles cannot be deleted.' });
    }
    const inUse = await db.get('SELECT COUNT(*) as count FROM users WHERE role_id = ?', id);
    if (inUse.count > 0) {
      return res.status(400).json({ success: false, message: `Cannot delete: ${inUse.count} user(s) still have this role.` });
    }

    await db.run('DELETE FROM roles WHERE id = ?', id);
    await recordAudit(db, authReq.user!, 'role.delete', 'role', id, { name: role.name });

    return res.json({ success: true, message: 'Role deleted.' });
  } catch (error) {
    console.error('Error deleting role:', error);
    return res.status(500).json({ success: false, message: 'Error deleting role.' });
  }
});

export default router;
