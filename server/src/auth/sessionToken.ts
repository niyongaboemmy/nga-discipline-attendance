import jwt from 'jsonwebtoken';
import { config } from '../config.js';

/**
 * The one way to sign a Tendo session JWT.
 *
 * Every session names its school: `tid` + `tenantSlug` in the user payload (the
 * client's offline keys read them) and `tslug` as a claim. authMiddleware enters
 * that school on every request and refuses a session whose `tid` disagrees with
 * the nested `misToken` (TENANT_MISMATCH). A re-sign that forgets the school
 * (the academic-period switch once did) silently moves the session to tenant 1
 * and logs every non-NGA user out -- so nothing signs a session but this.
 */
export interface SessionTenant {
  tid: number;
  slug: string;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: string;
  preferred_theme?: 'light' | 'dark';
  academicYearId?: number | null;
  academicTermId?: number | null;
}

export function sessionUser(user: SessionUser, tenant: SessionTenant) {
  const { id, name, email, role, preferred_theme, academicYearId, academicTermId } = user;
  return { id, name, email, role, preferred_theme, academicYearId, academicTermId, tid: tenant.tid, tenantSlug: tenant.slug };
}

export function signSession(user: SessionUser, tenant: SessionTenant, misToken: string): { token: string; user: ReturnType<typeof sessionUser> } {
  if (!Number.isSafeInteger(tenant?.tid) || tenant.tid <= 0) throw new Error('A session must name its school');
  const payload = sessionUser(user, tenant);
  const token = jwt.sign({ ...payload, tslug: tenant.slug, misToken }, config.jwtSecret, { expiresIn: '24h' });
  return { token, user: payload };
}
