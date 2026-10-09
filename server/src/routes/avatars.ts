import { Router, Request, Response } from 'express';
import { config } from '../config.js';
import { authMiddleware } from '../middleware/auth.js';
import { basicAuthHeader } from '../access/misService.js';
import { misAvatarOf, type MisAvatar } from './sso.js';

/**
 * POST /api/avatars/lookup { ids: string[] } -- NGA profile photos for the people on
 * a page (registers, directories, admin lists). Tendo's ids are MIS user ids, so this
 * asks MIS directly (POST /users/profile-media/lookup with this app's SSO client
 * credentials) and caches the answers for a few minutes.
 */
const router = Router();

const TTL_MS = 5 * 60_000;
const MAX_IDS = 500;
const cache = new Map<number, { avatar: MisAvatar | null; at: number }>();

type Transport = (ids: number[]) => Promise<Array<{ user_id: number; avatar?: unknown }>>;
const defaultTransport: Transport = async (ids) => {
  const res = await fetch(`${config.ngaMisBaseUrl.replace(/\/+$/, '')}/users/profile-media/lookup`, {
    method: 'POST',
    headers: { Authorization: basicAuthHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_ids: ids }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`MIS lookup answered ${res.status}`);
  const body = (await res.json()) as { data?: { users?: Array<{ user_id: number; avatar?: unknown }> } };
  return body?.data?.users ?? [];
};
let transport: Transport = defaultTransport;

/** Tests swap the MIS call out. */
export function _setAvatarTransportForTests(fn: Transport | null) {
  transport = fn ?? defaultTransport;
  cache.clear();
}

export async function lookupAvatars(rawIds: unknown[], now = Date.now()): Promise<Record<string, MisAvatar>> {
  const ids = Array.from(new Set(rawIds.map(Number))).filter((n) => Number.isSafeInteger(n) && n > 0);
  const out: Record<string, MisAvatar> = {};
  const missing: number[] = [];
  for (const id of ids) {
    const hit = cache.get(id);
    if (hit && now - hit.at < TTL_MS) {
      if (hit.avatar) out[id] = hit.avatar;
    } else missing.push(id);
  }
  if (missing.length) {
    const users = await transport(missing);
    const answered = new Set<number>();
    for (const u of users) {
      const avatar = misAvatarOf(u);
      answered.add(Number(u.user_id));
      cache.set(Number(u.user_id), { avatar, at: now });
      if (avatar) out[u.user_id] = avatar;
    }
    // Ids MIS doesn't know get initials; remember that too, so they aren't re-asked.
    for (const id of missing) if (!answered.has(id)) cache.set(id, { avatar: null, at: now });
  }
  return out;
}

router.post('/lookup', authMiddleware, async (req: Request, res: Response) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids)) return res.status(400).json({ success: false, message: 'ids must be an array' });
  if (ids.length > MAX_IDS) return res.status(400).json({ success: false, message: `At most ${MAX_IDS} ids per request` });
  try {
    res.set('Cache-Control', 'private, max-age=60');
    return res.json({ success: true, data: { avatars: await lookupAvatars(ids) } });
  } catch (err) {
    // Photos are decoration: a slow or unreachable MIS means initials, not an error page.
    console.warn('[avatars] MIS lookup failed:', (err as Error)?.message ?? err);
    return res.json({ success: true, data: { avatars: {} } });
  }
});

export default router;
