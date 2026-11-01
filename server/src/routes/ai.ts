import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { misUserIdOf } from '../access/snapshot.js';
import { myAiSummary } from '../services/myAiGateway.js';

/**
 * My AI for the client (MY_AI_GATEWAY.md "UI in each app"): the signed-in
 * person's cached route map from the MIS, so an AI panel can show
 * "Answers with: School AI ▾". No secrets: keys stay in the MIS.
 * `enabled: false` (and no choices) while My AI is off or the MIS can't say.
 */
const router = Router();
router.use(authMiddleware);

router.get('/my-routes', async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const data = await myAiSummary(misUserIdOf(authReq.user));
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error loading My AI routes:', error);
    return res.json({ success: true, data: { enabled: false, choices: [], byTask: {}, manageUrl: null } });
  }
});

export default router;
