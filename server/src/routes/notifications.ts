import { Router, Response } from 'express';
import { getDb } from '../database.js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { authorizePermission } from '../middleware/authorize.js';
import { generateForUser } from '../modules/attendance/notifier.service.js';

const router = Router();

router.use(authMiddleware);
router.use(authorizePermission('NOTIFICATIONS_MANAGE'));

// Get user notifications
router.get('/', async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const userId = authReq.user!.id;
  const db = getDb();

  // Reconcile schedule-derived notifications on read — idempotent via
  // dedupe_key, so polling this endpoint is cheap.
  await generateForUser(db, authReq);

  try {
    const list = await db.all(
      `SELECT * FROM notifications
       WHERE user_id = ? OR user_id = 'all'
       ORDER BY created_at DESC
       LIMIT 30`,
      userId
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
  const userId = authReq.user!.id;
  const db = getDb();

  try {
    await db.run(
      "UPDATE notifications SET read = 1 WHERE user_id = ? OR user_id = 'all'",
      userId
    );
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
    await db.run(
      "UPDATE notifications SET read = 1 WHERE id = ? AND (user_id = ? OR user_id = 'all')",
      notifId,
      authReq.user!.id
    );
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
