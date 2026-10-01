import express, { Router } from 'express';
import type { ActivityRelay } from '../vendor/nga-activity-relay/relay.js';

/**
 * Usage analytics relay routes (nga_central_mis USAGE_ANALYTICS_IMPLEMENTATION_PLAN.md §5.2).
 *
 * Mounted at /api/activity BEFORE the app's global JSON parser, so the
 * browser's beacons (`text/plain`) and the 256 kB limit apply here. There is
 * deliberately no auth middleware: identity comes from the relay's
 * `getUserId` (null = public visitor), and nothing here ever answers 401.
 */
export function activityRouter(relay: ActivityRelay): Router {
  const router = Router();
  router.post(
    '/',
    express.json({ limit: '256kb', type: ['application/json', 'text/plain'] }),
    (req: express.Request, res: express.Response) => void relay.handler(req, res),
    // A body the parser refuses (malformed or too large) is just dropped.
    (_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(204).end();
    },
  );
  router.get('/config', (req, res) => void relay.configHandler(req, res));
  return router;
}
