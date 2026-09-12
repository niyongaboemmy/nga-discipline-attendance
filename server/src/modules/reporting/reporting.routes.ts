import { Router, Response } from 'express';
import { getDb } from '../../database.js';
import { authMiddleware, AuthenticatedRequest } from '../../middleware/auth.js';
import { authorizePermission } from '../../middleware/authorize.js';
import { resolveAcademicPeriod } from '../../utils/academicPeriod.js';
import {
  getAttendanceSummary, getDisciplineSummary, getCombinedReport, compareTerms, getAnnualReport,
} from './reporting.service.js';
import {
  listReportableClasses, listClassSections, getClassSectionReport,
  listAvailableSubjects, listSubjectClasses,
} from './attendanceReport.service.js';

/** C: termly / annual / combined / comparison reporting. Mounted at /api/reporting. */
const router = Router();
router.use(authMiddleware);
router.use(authorizePermission('REPORTS_VIEW'));

router.get('/termly', async (req: any, res: Response) => {
  const db = getDb();
  const { academicTermId } = resolveAcademicPeriod(req as AuthenticatedRequest);
  try {
    const [attendance, discipline] = await Promise.all([
      getAttendanceSummary(db, academicTermId),
      getDisciplineSummary(db, academicTermId),
    ]);
    return res.json({ success: true, data: { academicTermId: academicTermId ?? null, attendance, discipline } });
  } catch (error) {
    console.error('Error generating termly report:', error);
    return res.status(500).json({ success: false, message: 'Error generating termly report.' });
  }
});

router.get('/annual', async (req: any, res: Response) => {
  const db = getDb();
  const { academicYearId } = resolveAcademicPeriod(req as AuthenticatedRequest);
  const yearId = req.query.academic_year_id ? Number(req.query.academic_year_id) : academicYearId;
  if (yearId == null) {
    return res.status(400).json({ success: false, message: 'academic_year_id is required (no default academic year on this session).' });
  }
  try {
    const data = await getAnnualReport(db, yearId);
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error generating annual report:', error);
    return res.status(500).json({ success: false, message: 'Error generating annual report.' });
  }
});

router.get('/combined', async (req: any, res: Response) => {
  const db = getDb();
  const { academicTermId } = resolveAcademicPeriod(req as AuthenticatedRequest);
  try {
    const data = await getCombinedReport(db, academicTermId);
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error generating combined report:', error);
    return res.status(500).json({ success: false, message: 'Error generating combined report.' });
  }
});

router.get('/compare', async (req: any, res: Response) => {
  const db = getDb();
  const termA = Number(req.query.term_a);
  const termB = Number(req.query.term_b);
  if (!Number.isFinite(termA) || !Number.isFinite(termB)) {
    return res.status(400).json({ success: false, message: 'term_a and term_b query params are required.' });
  }
  try {
    const data = await compareTerms(db, termA, termB);
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error comparing terms:', error);
    return res.status(500).json({ success: false, message: 'Error comparing terms.' });
  }
});

// Class -> subject attendance register (see attendanceReport.service.ts).
router.get('/attendance/classes', async (req: any, res: Response) => {
  const db = getDb();
  const { academicTermId } = resolveAcademicPeriod(req as AuthenticatedRequest);
  try {
    const data = await listReportableClasses(db, academicTermId);
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error listing reportable classes:', error);
    return res.status(500).json({ success: false, message: 'Error listing classes.' });
  }
});

router.get('/attendance/classes/:classId/sections', async (req: any, res: Response) => {
  const db = getDb();
  const { academicTermId } = resolveAcademicPeriod(req as AuthenticatedRequest);
  try {
    const data = await listClassSections(db, req.params.classId, academicTermId);
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error listing class sections:', error);
    return res.status(500).json({ success: false, message: 'Error listing class sections.' });
  }
});

router.get('/attendance/class/:classId', async (req: any, res: Response) => {
  const db = getDb();
  const { academicTermId } = resolveAcademicPeriod(req as AuthenticatedRequest);
  const sessionType = req.query.session_type === 'subject' ? 'subject' : 'homeroom';
  const subjectId = req.query.subject_id != null ? Number(req.query.subject_id) : undefined;
  if (sessionType === 'subject' && (subjectId == null || !Number.isFinite(subjectId))) {
    return res.status(400).json({ success: false, message: 'subject_id is required when session_type=subject.' });
  }
  const fromDate = typeof req.query.from === 'string' && req.query.from ? req.query.from : undefined;
  const toDate = typeof req.query.to === 'string' && req.query.to ? req.query.to : undefined;
  try {
    const data = await getClassSectionReport(db, {
      classId: req.params.classId, academicTermId, sessionType, subjectId, fromDate, toDate,
    });
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error generating class section report:', error);
    return res.status(500).json({ success: false, message: 'Error generating class section report.' });
  }
});

// Subject-first view: a dashboard of subjects (a teacher's own assignments,
// or every subject for an admin), drilling down into the classes teaching
// each one. See attendanceReport.service.ts.
router.get('/attendance/subjects', async (req: any, res: Response) => {
  const db = getDb();
  const authReq = req as AuthenticatedRequest;
  const { academicTermId } = resolveAcademicPeriod(authReq);
  try {
    const data = await listAvailableSubjects(db, { role: authReq.user!.role, userId: authReq.user!.id, academicTermId });
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error listing available subjects:', error);
    return res.status(500).json({ success: false, message: 'Error listing subjects.' });
  }
});

router.get('/attendance/subjects/:subjectId/classes', async (req: any, res: Response) => {
  const db = getDb();
  const authReq = req as AuthenticatedRequest;
  const { academicTermId } = resolveAcademicPeriod(authReq);
  const subjectId = Number(req.params.subjectId);
  if (!Number.isFinite(subjectId)) {
    return res.status(400).json({ success: false, message: 'subjectId must be a number.' });
  }
  try {
    const data = await listSubjectClasses(db, subjectId, { role: authReq.user!.role, userId: authReq.user!.id, academicTermId });
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error listing classes for subject:', error);
    return res.status(500).json({ success: false, message: 'Error listing classes for subject.' });
  }
});

export default router;
