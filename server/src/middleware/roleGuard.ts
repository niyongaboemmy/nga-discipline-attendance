import { Response, NextFunction } from 'express';
import { AuthenticatedRequest, Role } from './auth.js';

export function roleGuard(allowedRoles: Role[]) {
  return (req: any, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized. Please sign in.',
      });
    }

    if (!allowedRoles.includes(authReq.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Forbidden. Role '${authReq.user.role}' is not authorized to perform this action.`,
      });
    }

    next();
  };
}
