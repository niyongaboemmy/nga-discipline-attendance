import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, authHeader, createTestUser } from './testUtils.js';
import { config } from '../config.js';
import { app } from '../app.js';
import { _setAvatarTransportForTests } from '../routes/avatars.js';

/** Photos for the people on a page: MIS user ids in, NGA photo sets out (cached). */
const A = (id: number) => ({
  version: 1,
  sm: `https://api.amashuri.com/avatars/${id}/1/sm.webp?s=x`,
  md: `https://api.amashuri.com/avatars/${id}/1/md.webp?s=x`,
  lg: `https://api.amashuri.com/avatars/${id}/1/lg.webp?s=x`,
});

describe('POST /api/avatars/lookup', () => {
  const asked: number[][] = [];
  let token = '';
  const session = () => token;

  beforeAll(async () => {
    const db = await setupTestDb();
    ({ token } = await createTestUser(db, { id: '9101', name: 'Aline', email: 'a@x.rw', roleLevel: 'TEACHER' }));
    _setAvatarTransportForTests(async (ids) => {
      asked.push(ids);
      return ids.filter((id) => id !== 404).map((id) => ({ user_id: id, avatar: id === 2 ? null : A(id) }));
    });
  });
  afterAll(() => _setAvatarTransportForTests(null));

  it('returns photos for people who have one, and caches MIS answers', async () => {
    let res = await request(app).post('/api/avatars/lookup').set(authHeader(session())).send({ ids: ['1', '2', '404', 'x@y'] });
    expect(res.status).toBe(200);
    expect(res.body.data.avatars).toEqual({ 1: A(1) });
    res = await request(app).post('/api/avatars/lookup').set(authHeader(session())).send({ ids: ['1', '2', '404', '3'] });
    expect(res.body.data.avatars).toEqual({ 1: A(1), 3: A(3) });
    expect(asked).toEqual([[1, 2, 404], [3]]);
  });

  it('drops links that are not http(s)', async () => {
    _setAvatarTransportForTests(async (ids) => ids.map((id) => ({ user_id: id, avatar: { ...A(id), md: 'javascript:alert(1)' } })));
    const res = await request(app).post('/api/avatars/lookup').set(authHeader(session())).send({ ids: ['77'] });
    expect(res.body.data.avatars).toEqual({});
  });

  it('answers with no photos (not an error) when MIS is unreachable', async () => {
    _setAvatarTransportForTests(async () => { throw new Error('ECONNREFUSED'); });
    const res = await request(app).post('/api/avatars/lookup').set(authHeader(session())).send({ ids: ['88'] });
    expect(res.status).toBe(200);
    expect(res.body.data.avatars).toEqual({});
  });

  it('needs sign-in and a sane request', async () => {
    expect((await request(app).post('/api/avatars/lookup').send({ ids: ['1'] })).status).toBe(401);
    expect((await request(app).post('/api/avatars/lookup').set(authHeader(session())).send({ ids: '1' })).status).toBe(400);
    const tooMany = Array.from({ length: 501 }, (_, i) => String(i + 1));
    expect((await request(app).post('/api/avatars/lookup').set(authHeader(session())).send({ ids: tooMany })).status).toBe(400);
  });
});
