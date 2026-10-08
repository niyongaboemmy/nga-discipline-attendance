import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, authHeader } from './testUtils.js';
import { config } from '../config.js';
import { app } from '../app.js';
import { misAvatarOf } from '../routes/sso.js';

/**
 * The profile picture is NGA MIS's, shared by every NGA app. Tendo passes it on at
 * sign-in and on every /verify-mis poll, so the navbar follows a change made in MIS.
 */
const AVATAR = {
  version: 1790000000,
  sm: 'https://api.amashuri.com/avatars/9101/1790000000/sm.webp?s=abc',
  md: 'https://api.amashuri.com/avatars/9101/1790000000/md.webp?s=abc',
  lg: 'https://api.amashuri.com/avatars/9101/1790000000/lg.webp?s=abc',
};

const mis = { avatar: AVATAR as typeof AVATAR | null | undefined };

describe('central profile picture', () => {
  beforeAll(async () => {
    await setupTestDb();
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = String(url);
      const json = (data: any, status = 200) => new Response(JSON.stringify({ success: status < 400, data }), { status });
      if (u.includes('/sso/token')) {
        return json({
          token: 'mis-tok',
          user: { user_id: 9101, username: 'aline', email: 'aline@school.test', avatar_url: AVATAR.md },
          permissions: [],
          ...(mis.avatar === undefined ? {} : { avatar: mis.avatar }),
        });
      }
      if (u.includes('/auth/verify')) {
        return json({ userId: 9101, ...(mis.avatar === undefined ? {} : { avatar: mis.avatar }) });
      }
      return json({});
    }));
  });
  afterAll(() => vi.unstubAllGlobals());

  const session = () =>
    jwt.sign({ id: '9101', name: 'Aline', email: 'aline@school.test', role: 'teacher', misToken: 'mis-tok' }, config.jwtSecret, { expiresIn: '1h' });

  it('accepts only complete http(s) picture sets', () => {
    expect(misAvatarOf({ avatar: AVATAR })).toEqual(AVATAR);
    expect(misAvatarOf({ avatar: null })).toBeNull();
    expect(misAvatarOf({})).toBeNull();
    expect(misAvatarOf({ avatar: { ...AVATAR, md: 'javascript:alert(1)' } })).toBeNull();
    expect(misAvatarOf({ avatar: { ...AVATAR, lg: undefined } })).toBeNull();
  });

  it('sign-in returns the picture without putting it in the session token', async () => {
    mis.avatar = AVATAR;
    const res = await request(app).post('/api/sso/exchange').send({ code: 'abc' });
    expect(res.status).toBe(200);
    expect(res.body.data.user.avatar).toEqual(AVATAR);
    const claims = jwt.decode(res.body.data.token) as any;
    expect(claims.avatar).toBeUndefined();
  });

  it('the verify-mis poll reports the current picture, or that there is none', async () => {
    mis.avatar = AVATAR;
    let res = await request(app).get('/api/sso/verify-mis').set(authHeader(session()));
    expect(res.body).toEqual({ success: true, avatar: AVATAR });

    mis.avatar = null;
    res = await request(app).get('/api/sso/verify-mis').set(authHeader(session()));
    expect(res.body).toEqual({ success: true, avatar: null });
  });

  it('says nothing about pictures when MIS does not (an older MIS)', async () => {
    mis.avatar = undefined;
    const res = await request(app).get('/api/sso/verify-mis').set(authHeader(session()));
    expect(res.body).toEqual({ success: true });
  });
});
