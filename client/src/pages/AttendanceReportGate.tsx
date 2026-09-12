import React from 'react';
import { useAuth } from '../context/AuthContext';
import { AttendanceReport } from './AttendanceReport';
import { StudentAttendanceReport } from './StudentAttendanceReport';

/**
 * `/attendance/report` is one nav entry for every role. A student has no
 * class to pick and no other students' rows to browse — StudentAttendanceReport
 * auto-detects their own class and scopes everything server-side to their own
 * row (see attendanceReport.service.ts's getOwnSectionReport). Same pattern
 * as AttendanceCalendarGate for /attendance.
 */
export const AttendanceReportGate: React.FC = () => {
  const { user } = useAuth();
  return user?.role === 'student' ? <StudentAttendanceReport /> : <AttendanceReport />;
};

export default AttendanceReportGate;
