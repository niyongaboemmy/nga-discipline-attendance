import { Router, Response } from 'express';
import { getDb } from '../database.js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();

router.use(authMiddleware);

// Default preferences applied when a user has saved none yet.
const DEFAULT_PREFS = {
  emailNotifications: true,
  absenceAlerts: true,
  weeklySummary: false,
};

const ALLOWED_KEYS = Object.keys(DEFAULT_PREFS);

function parsePrefs(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== 'string') return { ...DEFAULT_PREFS };
  try {
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_PREFS, ...parsed };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

// GET /api/settings — the current user's preferences
router.get('/', async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const db = getDb();
  try {
    const row = await db.get('SELECT preferences FROM users WHERE id = ?', authReq.user!.id);
    return res.json({ success: true, data: { preferences: parsePrefs(row?.preferences) } });
  } catch (error) {
    console.error('Error fetching settings:', error);
    return res.status(500).json({ success: false, message: 'Error fetching settings.' });
  }
});

// PUT /api/settings — update the current user's preferences
router.put('/', async (req: any, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const { preferences } = req.body as { preferences?: Record<string, unknown> };

  if (!preferences || typeof preferences !== 'object') {
    return res.status(400).json({ success: false, message: 'Missing preferences object.' });
  }

  // Whitelist + coerce to booleans so clients cannot store arbitrary data.
  const clean: Record<string, boolean> = {};
  for (const key of ALLOWED_KEYS) {
    if (key in preferences) clean[key] = Boolean(preferences[key]);
  }
  const merged = { ...DEFAULT_PREFS, ...clean };

  const db = getDb();
  try {
    await db.run(
      'UPDATE users SET preferences = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      JSON.stringify(merged), authReq.user!.id
    );
    return res.json({ success: true, data: { preferences: merged }, message: 'Preferences saved.' });
  } catch (error) {
    console.error('Error saving settings:', error);
    return res.status(500).json({ success: false, message: 'Error saving settings.' });
  }
});

export default router;
