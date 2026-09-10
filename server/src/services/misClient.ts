import { Response } from 'express';
import { config } from '../config.js';
import { AuthenticatedRequest } from '../middleware/auth.js';

/**
 * Shared NGA Central MIS HTTP client.
 *
 * Extracted from routes/mis.ts so other modules (e.g. the calendar-driven
 * schedule routes and the notification generator) can talk to the MIS with
 * the same 403/404-tolerant fallback semantics without importing a route file.
 *
 * Every call forwards the *end user's* MIS access token, so the MIS enforces
 * its own authorization — a teacher/student token only sees what that user may
 * read (see the note at the top of routes/mis.ts).
 */
export class MisRequestError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function misGet(
  misToken: string,
  path: string,
  query?: Record<string, string | undefined>
): Promise<any> {
  const url = new URL(`${config.ngaMisBaseUrl}${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value) url.searchParams.set(key, value);
  }
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${misToken}`, Accept: 'application/json' },
  });
  if (!resp.ok) {
    throw new MisRequestError(resp.status, `MIS returned ${resp.status} for ${path}.`);
  }
  const body = (await resp.json()) as any;
  return body && typeof body === 'object' && 'data' in body ? body.data : body;
}

export async function misGetList(
  misToken: string,
  path: string,
  query?: Record<string, string | undefined>
): Promise<any[]> {
  const data = await misGet(misToken, path, query);
  return Array.isArray(data) ? data : [];
}

/** Same as misGetList but yields null on 403/404 so callers can fall back to
 *  an endpoint this user is actually allowed to read. */
export async function misGetListOrNull(
  misToken: string,
  path: string,
  query?: Record<string, string | undefined>
): Promise<any[] | null> {
  try {
    return await misGetList(misToken, path, query);
  } catch (error) {
    if (error instanceof MisRequestError && (error.status === 403 || error.status === 404)) {
      return null;
    }
    throw error;
  }
}

/** Object-returning variant of misGetListOrNull (the per-role calendar
 *  endpoints return `{ slots, upcoming, term_id }`, not an array). */
export async function misGetOrNullObject(
  misToken: string,
  path: string,
  query?: Record<string, string | undefined>
): Promise<any | null> {
  try {
    return await misGet(misToken, path, query);
  } catch (error) {
    if (error instanceof MisRequestError && (error.status === 403 || error.status === 404)) {
      return null;
    }
    throw error;
  }
}

export function sendMisError(res: Response, path: string, error: unknown) {
  if (error instanceof MisRequestError) {
    return res.status(error.status).json({ success: false, message: error.message });
  }
  console.error(`MIS proxy error (${path}):`, (error as Error).message);
  return res.status(502).json({
    success: false,
    message: 'Could not reach the NGA Central MIS. Please try again.',
  });
}

export function requireMisToken(req: AuthenticatedRequest, res: Response): string | null {
  const misToken = req.user?.misToken;
  if (!misToken) {
    res.status(403).json({
      success: false,
      message: 'This session is not linked to the MIS, so roster data is unavailable.',
    });
    return null;
  }
  return misToken;
}
