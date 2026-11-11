import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { ensureTenantDb, tenantDbExists } from '../database.js';
import {
  PRIMARY_TENANT_ID,
  normalizeTenant,
  parseTid,
  runWithTenant,
  tenantRegistry,
} from '../tenancy/index.js';
import { seedSchoolSettings } from '../tenancy/settings.js';

/**
 * Control-plane hooks MIS calls on this app (nga_central_mis/packages/tenancy/
 * CONTRACT.md §4-5), authenticated with the shared provisioning secret:
 *
 *   POST /api/integration/tenants/:tid/provision   body: TenantCtx
 *     Idempotent: creates (or migrates) the school's SQLite file, seeds the
 *     RBAC catalog/system roles and the school's default settings, and
 *     answers { ok, tid, created }. Tenant 1 is never re-seeded.
 *   POST /api/integration/tenants/changed          body: { tid }
 *     Drops the cached tenant registry so a status change applies now.
 *
 * Mounted before the /api/integration router (whose misBearerAuth expects a
 * user's MIS token, not a service secret).
 */
const router = Router();

function requireProvisionSecret(req: Request, res: Response, next: NextFunction) {
  const secret = (process.env.TENANCY_PROVISION_SECRET || '').trim();
  if (!secret) {
    return res.status(503).json({ ok: false, code: 'PROVISIONING_DISABLED', message: 'TENANCY_PROVISION_SECRET is not set.' });
  }
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
  const given = Buffer.from(m?.[1] ?? '');
  const want = Buffer.from(secret);
  // Constant time; the length check leaks only the length.
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', message: 'Invalid provisioning secret.' });
  }
  return next();
}

router.post('/changed', requireProvisionSecret, (_req: Request, res: Response) => {
  tenantRegistry().invalidate();
  return res.json({ ok: true });
});

router.post('/:tid/provision', requireProvisionSecret, async (req: Request, res: Response) => {
  const tid = parseTid(req.params.tid);
  if (!tid) return res.status(400).json({ ok: false, code: 'BAD_TENANT', message: 'Invalid tenant id.' });
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const bodyTid = body.tid ?? body.tenant_id;
  if (bodyTid !== undefined && parseTid(bodyTid) !== tid) {
    return res.status(400).json({ ok: false, code: 'TENANT_MISMATCH', message: 'Body tid does not match the URL.' });
  }
  const tenant = normalizeTenant({ ...body, tid });
  if (!tenant) return res.status(400).json({ ok: false, code: 'BAD_TENANT', message: 'Invalid tenant.' });

  try {
    const isPrimary = tid === PRIMARY_TENANT_ID;
    const created = !isPrimary && !tenantDbExists(tid);
    // Opening runs the full schema + migrations + RBAC seed (all idempotent).
    const db = await ensureTenantDb(tid);
    if (!isPrimary) {
      await runWithTenant({ ...tenant, isPrimary: false }, () => seedSchoolSettings(db, tenant));
    }
    tenantRegistry().invalidate();
    return res.json({ ok: true, tid, created });
  } catch (err) {
    console.error(`[tenancy] provisioning tenant ${tid} failed:`, err);
    return res.status(500).json({ ok: false, code: 'PROVISION_FAILED', message: 'Provisioning failed.' });
  }
});

export default router;
