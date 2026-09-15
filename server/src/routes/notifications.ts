import { Router, Response } from 'express';
import { getDb } from '../database.js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { authorizePermission } from '../middleware/authorize.js';
import { generateForUser } from '../modules/attendance/notifier.service.js';

const router = Router();

router.use(authMiddleware);
router.use(authorizePermission('NOTIFICATIONS_MANAGE'));

/**
 * Who a row is for. `user_id = 'all'` rows are staff broadcasts — "attendance
 * drop: <student>", "major incident: <student>", "conduct follow-up" — written
 * by the mark/discipline flows for whoever supervises students. A student
 * must only ever see rows addressed to them personally; surfacing a
 * classmate's attendance or conduct to them is both noise and a privacy leak.
 */
function audienceClause(req: AuthenticatedRequest): { sql: string; params: string[] } {
  const userId = req.user!.id;
  const isStaff = req.user!.role === 'teacher' || req.user!.role === 'admin';
  return isStaff
    ? { sql: "(user_id = ? OR user_id = 'all')", params: [userId] }
    : { sql: 'user_id = ?', params: [userId] };
}

// Get user notifications
router.get('/', async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const db = getDb();

  // Reconcile schedule-derived notifications on read — idempotent via
  // dedupe_key, so polling this endpoint is cheap.
  await generateForUser(db, authReq);

  try {
    const audience = audienceClause(authReq);
    const list = await db.all(
      `SELECT * FROM notifications
       WHERE ${audience.sql}
       ORDER BY created_at DESC
       LIMIT 30`,
      ...audience.params
    );
    return res.json({
      success: true,
      data: list,
    });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    return res.status(500).json({
      success: false,
      message: 'Database error fetching notifications.',
    });
  }
});

// Mark all of the current user's notifications as read
router.put('/read-all', async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const db = getDb();

  try {
    const audience = audienceClause(authReq);
    await db.run(`UPDATE notifications SET read = 1 WHERE ${audience.sql}`, ...audience.params);
    return res.json({ success: true, message: 'All notifications marked as read.' });
  } catch (error) {
    console.error('Error marking all notifications read:', error);
    return res.status(500).json({ success: false, message: 'Database error marking notifications read.' });
  }
});

// Mark notification as read (only the user's own or shared broadcasts)
router.put('/:id/read', async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const notifId = req.params.id;
  const db = getDb();

  try {
    const audience = audienceClause(authReq);
    await db.run(`UPDATE notifications SET read = 1 WHERE id = ? AND ${audience.sql}`, notifId, ...audience.params);
    return res.json({
      success: true,
      message: 'Notification marked as read.',
    });
  } catch (error) {
    console.error('Error marking notification read:', error);
    return res.status(500).json({
      success: false,
      message: 'Database error marking notification read.',
    });
  }
});

// Delete a single notification. Only user-owned notifications can be deleted —
// shared broadcasts ('all') are left intact so they remain visible to everyone.
router.delete('/:id', async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const userId = authReq.user!.id;
  const db = getDb();

  try {
    await db.run('DELETE FROM notifications WHERE id = ? AND user_id = ?', req.params.id, userId);
    return res.json({ success: true, message: 'Notification removed.' });
  } catch (error) {
    console.error('Error deleting notification:', error);
    return res.status(500).json({ success: false, message: 'Database error deleting notification.' });
  }
});

// Clear all of the current user's own notifications (keeps broadcasts).
router.delete('/', async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const userId = authReq.user!.id;
  const db = getDb();

  try {
    await db.run('DELETE FROM notifications WHERE user_id = ?', userId);
    return res.json({ success: true, message: 'Notifications cleared.' });
  } catch (error) {
    console.error('Error clearing notifications:', error);
    return res.status(500).json({ success: false, message: 'Database error clearing notifications.' });
  }
});

export default router;
