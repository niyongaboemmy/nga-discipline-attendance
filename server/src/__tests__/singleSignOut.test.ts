import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Database } from 'sqlite';
import { setupTestDb, authHeader } from './testUtils.js';
import { config } from '../config.js';
import { app } from '../app.js';
import { LOGOUT_EVENT, setJwksFetcher } from '../utils/ssoLogout.js';

/**
 * Single sign-out (nga_central_mis/docs/SINGLE_SIGN_OUT.md): signing out of
 * NGA MIS makes MIS POST a signed logout_token here; every Tendo session of
 * that user issued before then must stop working.
 */
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as object), kid: 'k1', alg: 'RS256', use: 'sig' };

const logoutToken = (sub: string, claims: Record<string, unknown> = {}) =>
  jwt.sign(
    { iss: config.ngaMisBaseUrl.replace(/\/$/, ''), aud: config.ssoClientId, jti: crypto.randomUUID(), sub, events: { [LOGOUT_EVENT]: {} }, ...claims },
    privateKey,
    { algorithm: 'RS256', keyid: 'k1', expiresIn: 120 },
  );

describe('Single sign-out (back-channel logout)', () => {
  let db: Database;

  beforeAll(async () => {
    db = await setupTestDb();
    setJwksFetcher(async () => ({ keys: [jwk as any] }));
    await db.run(`INSERT INTO users (id, name, email, role) VALUES ('9001', 'Aline', 'aline@school.test', 'teacher')`);
  });
  afterAll(() => setJwksFetcher(null));

  const session = (iatSecondsAgo = 0) =>
    jwt.sign(
      { id: '9001', name: 'Aline', email: 'aline@school.test', role: 'teacher', iat: Math.floor(Date.now() / 1000) - iatSecondsAgo },
      config.jwtSecret,
      { expiresIn: '1h' },
    );

  it('ends every session issued before the MIS sign-out', async () => {
    const before = session(60);
    expect((await request(app).get('/api/attendance/schedule/day').set(authHeader(before))).status).not.toBe(401);

    const res = await request(app)
      .post('/api/sso/backchannel-logout')
      .type('form')
      .send({ logout_token: logoutToken('9001') });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');

    const after = await request(app).get('/api/attendance/schedule/day').set(authHeader(before));
    expect(after.status).toBe(401);
    expect(after.body.code).toBe('SESSION_ENDED');
  });

  it('a new sign-in afterwards works', async () => {
    await new Promise((r) => setTimeout(r, 1100));
    const fresh = session(0);
    expect((await request(app).get('/api/attendance/schedule/day').set(authHeader(fresh))).status).not.toBe(401);
  });

  it('rejects forged, wrong-audience and replayed tokens', async () => {
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const forged = jwt.sign({ iss: config.ngaMisBaseUrl, aud: config.ssoClientId, sub: '9001', jti: 'x', events: { [LOGOUT_EVENT]: {} } }, other, { algorithm: 'RS256', keyid: 'k1', expiresIn: 60 });
    expect((await request(app).post('/api/sso/backchannel-logout').type('form').send({ logout_token: forged })).status).toBe(400);
    expect((await request(app).post('/api/sso/backchannel-logout').type('form').send({ logout_token: logoutToken('9001', { aud: 'tupo' }) })).status).toBe(400);
    const once = logoutToken('9001');
    expect((await request(app).post('/api/sso/backchannel-logout').type('form').send({ logout_token: once })).status).toBe(200);
    expect((await request(app).post('/api/sso/backchannel-logout').type('form').send({ logout_token: once })).status).toBe(400);
    expect((await request(app).post('/api/sso/backchannel-logout').type('form').send({})).status).toBe(400);
  });
});
