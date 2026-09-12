import React from 'react';
import { useAuth } from '../context/AuthContext';
import { AttendanceCalendar } from './AttendanceCalendar';
import { StudentCalendar } from './StudentCalendar';

/**
 * `/attendance` is one nav entry for every role, but a student has nothing
 * to record — the teacher/admin calendar's drawer, overdue alarms, and
 * "record a session" actions don't apply to them. Route to the dedicated
 * read-only StudentCalendar instead, gated by ATTENDANCE_CALENDAR_VIEW_OWN
 * on the server (this is just which component renders, not the security
 * boundary — see hooks/usePermissions.ts).
 */
export const AttendanceCalendarGate: React.FC = () => {
  const { user } = useAuth();
  return user?.role === 'student' ? <StudentCalendar /> : <AttendanceCalendar />;
};

export default AttendanceCalendarGate;
