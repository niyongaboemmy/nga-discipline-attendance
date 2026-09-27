import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { getSnapshot, misUserIdOf } from '../access/snapshot.js';
import { accessMode } from '../access/policy.js';

/**
 * Access control v2 for the client (plan §7.2): the signed-in user's MIS
 * snapshot for this app, so the UI can later gate itself with the same
 * vendored core. 503 when there is none (MIS without access v2, MIS
 * unreachable for >24h, or a session not linked to MIS).
 */
const router = Router();
router.use(authMiddleware);

router.get('/me', async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const snapshot = await getSnapshot(authReq.user, authReq.user?.misToken);
    if (!snapshot) {
      return res.status(503).json({
        success: false,
        mode: accessMode(),
        message: misUserIdOf(authReq.user) == null || !authReq.user?.misToken
          ? 'This session is not linked to a MIS account, so no access snapshot is available.'
          : 'Access snapshot unavailable from the MIS.',
      });
    }
    return res.json({ success: true, mode: accessMode(), data: snapshot });
  } catch (error) {
    console.error('Error loading access snapshot:', error);
    return res.status(503).json({ success: false, mode: accessMode(), message: 'Access snapshot unavailable.' });
  }
});

export default router;
