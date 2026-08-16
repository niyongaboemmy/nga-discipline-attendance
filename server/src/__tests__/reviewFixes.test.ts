import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { Database } from 'sqlite';
import { setupTestDb, createTestUser, authHeader } from './testUtils.js';
import { app } from '../app.js';
import { recordAudit } from '../shared/audit.js';
import { getStudentTermBalance, listTermBalances } from '../modules/discipline/ledger.service.js';

describe('Regression coverage for code-review fixes', () => {
  let db: Database;
  let adminToken: string;
  let teacherToken: string;

  beforeAll(async () => {
    db = await setupTestDb();
    adminToken = (await createTestUser(db, { id: 'admin-9', name: 'Ada Admin', email: 'ada9@school.test', roleLevel: 'ADMIN' })).token;
    teacherToken = (await createTestUser(db, { id: 'teacher-9', name: 'Tom Teacher', email: 'tom9@school.test', roleLevel: 'TEACHER' })).token;
  });

  describe('POST /discipline/adjust', () => {
    it('rejects a sanction outside the fixed SANCTIONS vocabulary', async () => {
      const ruleRes = await request(app)
        .post('/api/discipline/rules')
        .set(authHeader(adminToken))
        .send({ type: 'demerit', category: 'Misconduct', title: 'Fighting', defaultPoints: 25, severity: 'major' });
      const ruleId = ruleRes.body.data.id;

      const res = await request(app)
        .post('/api/discipline/adjust')
        .set(authHeader(teacherToken))
        .send({
          studentId: 'student-adj-1', studentName: 'Adj Student', ruleId,
          incidentDate: '2026-03-01', sanction: 'expelled',
        });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Invalid sanction/);
    });

    it('escalates a major-severity demerit to staff, matching the legacy POST / behavior', async () => {
      const ruleRes = await request(app)
        .post('/api/discipline/rules')
        .set(authHeader(adminToken))
        .send({ type: 'demerit', category: 'Misconduct', title: 'Fighting (major)', defaultPoints: 25, severity: 'major' });
      const ruleId = ruleRes.body.data.id;

      const before = await db.get(`SELECT COUNT(*) as c FROM notifications WHERE user_id = 'all'`);
      const res = await request(app)
        .post('/api/discipline/adjust')
        .set(authHeader(teacherToken))
        .send({ studentId: 'student-adj-2', studentName: 'Adj Student 2', ruleId, incidentDate: '2026-03-01' });
      expect(res.status).toBe(201);

      const after = await db.get(`SELECT COUNT(*) as c FROM notifications WHERE user_id = 'all'`);
      expect(after.c).toBe(before.c + 1);
    });
  });

  describe('ledger.service.ts — legacy NULL-term rows', () => {
    it('folds a pre-migration (NULL academic_term_id) discipline record into the resolved term balance', async () => {
      // Simulate a record written before term-tracking existed.
      await db.run(
        `INSERT INTO discipline_records (student_id, student_name, type, category, severity, points, title, incident_date, logged_by, logged_by_name, academic_term_id)
         VALUES ('student-legacy-1', 'Legacy Student', 'demerit', 'Misconduct', 'major', 15, 'Old incident', '2025-01-01', 'admin-9', 'Ada Admin', NULL)`
      );

      const balance = await getStudentTermBalance(db, 'student-legacy-1', 1, 42);
      expect(balance.balance).toBe(85); // 100 - 15, the legacy row must count
      expect(balance.demeritPoints).toBe(15);
    });

    it('does not duplicate a student in listTermBalances when they have both a legacy and current-term row', async () => {
      await db.run(
        `INSERT INTO discipline_records (student_id, student_name, type, category, severity, points, title, incident_date, logged_by, logged_by_name, academic_term_id)
         VALUES ('student-legacy-2', 'Legacy Student 2', 'demerit', 'Misconduct', 'minor', 2, 'Old incident', '2025-01-01', 'admin-9', 'Ada Admin', NULL)`
      );
      await db.run(
        `INSERT INTO discipline_records (student_id, student_name, type, category, severity, points, title, incident_date, logged_by, logged_by_name, academic_term_id)
         VALUES ('student-legacy-2', 'Legacy Student 2', 'demerit', 'Misconduct', 'minor', 2, 'New incident', '2026-03-01', 'admin-9', 'Ada Admin', 43)`
      );

      const balances = await listTermBalances(db, 43);
      const matches = balances.filter((b) => b.studentId === 'student-legacy-2');
      expect(matches).toHaveLength(1);
      expect(matches[0].balance).toBe(96); // 100 - 2 - 2, both rows counted once
    });
  });

  describe('discipline conduct score excludes dismissed records', () => {
    it('/discipline/me still lists a dismissed record but does not count it against the score', async () => {
      const studentToken = (await createTestUser(db, { id: 'student-dismiss-1', name: 'Dee Student', email: 'dee@school.test', roleLevel: 'STUDENT' })).token;

      const logRes = await request(app)
        .post('/api/discipline/')
        .set(authHeader(teacherToken))
        .send({
          studentId: 'student-dismiss-1', studentName: 'Dee Student', type: 'demerit',
          category: 'Misconduct', severity: 'major', title: 'Disputed incident', incidentDate: '2026-03-01',
        });
      const recordId = logRes.body.data.id;

      await request(app)
        .put(`/api/discipline/${recordId}/status`)
        .set(authHeader(teacherToken))
        .send({ status: 'dismissed' });

      const meRes = await request(app).get('/api/discipline/me').set(authHeader(studentToken));
      expect(meRes.body.data.records.some((r: any) => r.id === recordId)).toBe(true); // still visible
      expect(meRes.body.data.conductScore).toBe(100); // but not counted
    });
  });

  describe('shared/audit.ts recordAudit', () => {
    it('stores previousValue/newValue even when no `details` argument is passed', async () => {
      await recordAudit(db, { id: 'admin-9', name: 'Ada Admin' }, 'test.diff_only', 'test_entity', 'e1', undefined, {
        previousValue: { points: 5 },
        newValue: { points: 10 },
      });
      const row = await db.get(
        `SELECT details FROM audit_log WHERE action = 'test.diff_only' AND entity_id = 'e1' ORDER BY id DESC LIMIT 1`
      );
      expect(row).toBeTruthy();
      const parsed = JSON.parse(row.details);
      expect(parsed.previousValue).toEqual({ points: 5 });
      expect(parsed.newValue).toEqual({ points: 10 });
    });
  });
});
