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

export default router;
