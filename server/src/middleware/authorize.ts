import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './auth.js';

function deny(res: Response, message = 'Forbidden. You do not have permission to perform this action.') {
  return res.status(403).json({ success: false, message });
}

/** Allow the request if the user holds ANY of the given permission keys. */
export function authorizePermission(...keys: string[]) {
  return (req: any, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      return res.status(401).json({ success: false, message: 'Unauthorized. Please sign in.' });
    }
    if (keys.some((k) => authReq.user!.permissions.has(k))) return next();
    return deny(res);
  };
}

/** Allow the request only if the user holds ALL of the given permission keys. */
export function authorizeAllPermissions(...keys: string[]) {
  return (req: any, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      return res.status(401).json({ success: false, message: 'Unauthorized. Please sign in.' });
    }
    if (keys.every((k) => authReq.user!.permissions.has(k))) return next();
    return deny(res);
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
    if (req.params[idParam] === authReq.user.id) return next();
    if (keysForOthers.some((k) => authReq.user!.permissions.has(k))) return next();
    return deny(res, 'Forbidden. You can only view your own records.');
  };
}
