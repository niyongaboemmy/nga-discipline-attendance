import type { Role } from './navConfig';

export interface SearchItem {
  /** What's shown as the result title. */
  label: string;
  /** Shown under the label — helps confirm it's the right destination. */
  description: string;
  path: string;
  roles: Role[];
  /** Alternate terms someone might type instead of the exact page name. */
  keywords?: string[];
}

/** Everywhere in the app someone could want to go, with the synonyms they
 *  might actually type — not just the exact nav label. Powers the top-bar
 *  search so "I don't remember where X lives" has an answer. Front-end only:
 *  this searches page/feature names, not live record data. */
export const searchCatalog: SearchItem[] = [
  {
    label: 'Dashboard', description: 'Overview and quick stats', path: '/dashboard',
    roles: ['admin', 'teacher', 'student'], keywords: ['home', 'overview', 'summary'],
  },
  {
    label: 'Attendance Calendar', description: 'Month / week / day — open any lesson for its details or register', path: '/attendance',
    roles: ['admin', 'teacher', 'student'],
    keywords: ['agenda', 'timetable', 'schedule', 'calendar', 'my day', 'week', 'registers', 'take attendance', 'lessons'],
  },

  // Staff check-in (the phone clock)
  {
    label: 'Staff check-in settings', description: 'School zone, check-in times, the staff link and setup checklist', path: '/staff/clock/zone',
    roles: ['admin'], keywords: ['attendance settings', 'staff attendance settings', 'staff clock', 'school zone', 'geofence', 'gps', 'location', 'check in settings', 'clock in', 'setup', 'staff link'],
  },
  {
    label: 'Staff check-in dashboard', description: 'Who checked in today, late, not in yet, unusual check-ins', path: '/staff/clock',
    roles: ['admin'], keywords: ['staff attendance', 'staff clock', 'check-ins', 'late staff', 'teachers attendance'],
  },
  {
    label: 'Staff phones & QR cards', description: 'Approve or remove staff phones; print QR cards for staff without a smartphone', path: '/staff/clock/devices',
    roles: ['admin'], keywords: ['devices', 'phones', 'tablets', 'qr cards', 'staff cards', 'approve phone'],
  },
  {
    label: 'Scan a staff card', description: 'Check a colleague in or out with their QR card', path: '/staff/clock/scan',
    roles: ['admin', 'teacher'], keywords: ['scan', 'qr', 'staff card', 'no smartphone'],
  },
  {
    label: 'Staff check-in poster', description: 'Print the staffroom poster with the check-in link', path: '/staff/clock/poster',
    roles: ['admin'], keywords: ['poster', 'print', 'qr code', 'staff link'],
  },

  // Administration
  {
    label: 'Admin Console', description: 'School-wide administration', path: '/admin',
    roles: ['admin'], keywords: ['administration', 'manage school', 'superadmin'],
  },
  {
    label: 'Roles & Permissions', description: 'Manage role-based access', path: '/admin/roles',
    roles: ['admin'], keywords: ['rbac', 'access control', 'permissions'],
  },
  {
    label: 'Discipline Rules', description: 'The rules catalog — point values and fines per rule', path: '/discipline/rules',
    roles: ['admin'], keywords: ['rules catalog', 'point values', 'fines', 'demerit rules', 'merit rules'],
  },
  {
    label: 'Audit Log', description: 'History of actions taken in the system', path: '/admin/audit',
    roles: ['admin'], keywords: ['activity log', 'history', 'who did what', 'logs'],
  },

  // Attendance (staff)
  {
    label: 'Take a Register', description: 'Open a lesson in the Attendance Calendar to record it', path: '/attendance?view=day',
    roles: ['admin', 'teacher'], keywords: ['roll call', 'check in', 'mark attendance', 'record a session', 'present absent late excused'],
  },
  {
    label: 'Attendance History', description: 'Past attendance sessions and records', path: '/attendance/records',
    roles: ['admin', 'teacher'], keywords: ['attendance records', 'past sessions'],
  },
  {
    label: 'Staff Attendance', description: 'Teacher/staff clock in and clock out', path: '/staff/attendance',
    roles: ['admin', 'teacher'], keywords: ['clock in', 'clock out', 'teacher attendance'],
  },

  {
    label: 'Attendance Report', description: 'Attendance grouped by subject, with a printable register', path: '/attendance/report',
    roles: ['admin', 'teacher', 'student'], keywords: ['my attendance', 'personal attendance', 'register', 'subject attendance', 'print', 'export'],
  },

  // Attendance (student)
  {
    label: 'Leaves & Excuses', description: 'Explain an absence and track whether it was approved', path: '/excuses',
    roles: ['student'], keywords: ['excuse request', 'absence request', 'leave form', 'sick note'],
  },

  // Discipline (staff)
  {
    label: 'Log Conduct Record', description: 'Record a demerit or merit', path: '/discipline/log',
    roles: ['admin', 'teacher'], keywords: ['demerit', 'merit', 'discipline', 'misconduct', 'conduct points'],
  },
  {
    label: 'Discipline Records', description: 'Conduct history and incidents', path: '/discipline/records',
    roles: ['admin', 'teacher'], keywords: ['conduct history', 'incidents', 'discipline log'],
  },
  {
    label: 'Excuse Review', description: 'Approve or deny excuse requests', path: '/excuses/review',
    roles: ['admin', 'teacher'], keywords: ['approve excuse', 'review leave request', 'pending excuses'],
  },

  // Discipline (student)
  {
    label: 'My Conduct', description: 'Your discipline record and points', path: '/discipline/me',
    roles: ['student'], keywords: ['my discipline', 'my points', 'my demerits', 'my merits'],
  },

  // Insights
  {
    label: 'Reports', description: 'School-wide attendance and conduct reports', path: '/reports',
    roles: ['admin', 'teacher'], keywords: ['analytics', 'export csv', 'attendance rate'],
  },
  {
    label: 'Directory', description: 'Student and staff directory', path: '/directory',
    roles: ['admin', 'teacher'], keywords: ['student list', 'staff list', 'contacts', 'find a student'],
  },

  // Settings (one page, two sections — both searchable individually)
  {
    label: 'Settings — Account', description: 'Your name, email, role, and security', path: '/settings',
    roles: ['admin', 'teacher', 'student'], keywords: ['profile', 'account details', 'password', 'security'],
  },
  {
    label: 'Settings — Notifications', description: 'Notification preferences', path: '/settings',
    roles: ['admin', 'teacher', 'student'], keywords: ['email alerts', 'notification preferences'],
  },
];
