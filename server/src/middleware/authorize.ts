import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './auth.js';
import { accessMode, enforceHeldAnywhere, shadowCompareLegacy } from '../access/policy.js';

function deny(res: Response, message = 'Forbidden. You do not have permission to perform this action.') {
  return res.status(403).json({ success: false, message });
}

/**
 * Access control v2 hook shared by the guards below (ACCESS_V2_MODE):
 *   off     -> the legacy local-RBAC verdict, unchanged
 *   shadow  -> the legacy verdict; v2 ("held anywhere") compared in the
 *              background and disagreements counted in access_shadow_diffs
 *   enforce -> the v2 verdict ("held anywhere"); no snapshot -> 503
 * Scoped (per class / student) checks live in the routes: see access/policy.ts.
 */
function decideWithV2(
  req: any,
  res: Response,
  next: NextFunction,
  keys: string[],
  legacyAllowed: boolean,
  all: boolean,
  denyMessage?: string
) {
  const mode = accessMode();
  if (mode !== 'enforce') {
    if (mode === 'shadow') shadowCompareLegacy(req, keys, legacyAllowed, all);
    return legacyAllowed ? next() : deny(res, denyMessage);
  }
  enforceHeldAnywhere(req, keys, all)
    .then((allowed) => {
      if (allowed === null) {
        return res.status(503).json({ success: false, message: 'Access check unavailable: could not load your access from the MIS. Please try again shortly.' });
      }
      return allowed ? next() : deny(res, denyMessage);
    })
    .catch(next);
}

/** Allow the request if the user holds ANY of the given permission keys. */
export function authorizePermission(...keys: string[]) {
  return (req: any, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      return res.status(401).json({ success: false, message: 'Unauthorized. Please sign in.' });
    }
    const legacyAllowed = keys.some((k) => authReq.user!.permissions.has(k));
    return decideWithV2(req, res, next, keys, legacyAllowed, false);
  };
}

/** Allow the request only if the user holds ALL of the given permission keys. */
export function authorizeAllPermissions(...keys: string[]) {
  return (req: any, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      return res.status(401).json({ success: false, message: 'Unauthorized. Please sign in.' });
    }
    const legacyAllowed = keys.every((k) => authReq.user!.permissions.has(k));
    return decideWithV2(req, res, next, keys, legacyAllowed, true);
  };
}

/** Allow the request if the resource belongs to the caller (req.params[idParam]
 *  === user.id), otherwise require one of the given permission keys — the
 *  "view own vs. view any" pattern used for /student/:id-style routes. */
export function selfOrPermission(idParam: string, ...keysForOthers: string[]) {
  return (req: any, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      return res.status(401).json({ success: false, message: 'Unauthorized. Please sign in.' });
    }
    // Own records: an identity match, not a capability -- same in every mode.
    if (req.params[idParam] === authReq.user.id) return next();
    const legacyAllowed = keysForOthers.some((k) => authReq.user!.permissions.has(k));
    return decideWithV2(req, res, next, keysForOthers, legacyAllowed, false, 'Forbidden. You can only view your own records.');
  };
}
