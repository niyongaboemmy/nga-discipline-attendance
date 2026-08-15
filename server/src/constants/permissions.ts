export type RoleLevel = 'STUDENT' | 'TEACHER' | 'ADMIN';

export interface PermissionDefinition {
  key: string;
  category: string;
  description: string;
}

export const PERMISSION_CATEGORIES = {
  ATTENDANCE: 'Attendance',
  EXCUSES: 'Excuses & Leave',
  DISCIPLINE: 'Discipline & Conduct',
  STAFF_ATTENDANCE: 'Staff Attendance',
  REPORTS: 'Reports',
  USERS: 'Users & Roster',
  ROLES_PERMISSIONS: 'Roles & Permissions',
  ACADEMICS: 'Academic Period',
  ROSTER: 'MIS Roster',
  NOTIFICATIONS: 'Notifications',
  SETTINGS: 'Account Settings',
} as const;

export const PERMISSIONS: PermissionDefinition[] = [
  { key: 'ATTENDANCE_MARK', category: PERMISSION_CATEGORIES.ATTENDANCE, description: 'Mark student attendance for a class session.' },
  { key: 'ATTENDANCE_VIEW_ALL', category: PERMISSION_CATEGORIES.ATTENDANCE, description: "View any student's attendance history." },
  { key: 'ATTENDANCE_VIEW_OWN', category: PERMISSION_CATEGORIES.ATTENDANCE, description: 'View your own attendance history.' },

  { key: 'EXCUSES_SUBMIT', category: PERMISSION_CATEGORIES.EXCUSES, description: 'Submit an excuse/leave request.' },
  { key: 'EXCUSES_VIEW_OWN', category: PERMISSION_CATEGORIES.EXCUSES, description: 'View your own excuse requests.' },
  { key: 'EXCUSES_REVIEW', category: PERMISSION_CATEGORIES.EXCUSES, description: 'Review and approve/reject excuse requests.' },

  { key: 'DISCIPLINE_LOG', category: PERMISSION_CATEGORIES.DISCIPLINE, description: 'Log a discipline record (merit or demerit).' },
  { key: 'DISCIPLINE_VIEW_ALL', category: PERMISSION_CATEGORIES.DISCIPLINE, description: "View any student's discipline records." },
  { key: 'DISCIPLINE_VIEW_OWN', category: PERMISSION_CATEGORIES.DISCIPLINE, description: 'View your own discipline records.' },
  { key: 'DISCIPLINE_REVIEW', category: PERMISSION_CATEGORIES.DISCIPLINE, description: "Update a discipline record's review status/sanction." },

  { key: 'STAFF_ATTENDANCE_CLOCK', category: PERMISSION_CATEGORIES.STAFF_ATTENDANCE, description: 'Clock yourself in/out as staff.' },
  { key: 'STAFF_ATTENDANCE_VIEW_OWN', category: PERMISSION_CATEGORIES.STAFF_ATTENDANCE, description: 'View your own staff attendance log.' },
  { key: 'STAFF_ATTENDANCE_VIEW_ALL', category: PERMISSION_CATEGORIES.STAFF_ATTENDANCE, description: "View all staff members' attendance logs." },

  { key: 'REPORTS_VIEW', category: PERMISSION_CATEGORIES.REPORTS, description: 'View attendance/discipline reports and analytics.' },

  { key: 'USERS_VIEW', category: PERMISSION_CATEGORIES.USERS, description: 'View the user roster and admin overview.' },
  { key: 'USERS_MANAGE', category: PERMISSION_CATEGORIES.USERS, description: 'Sync the roster and assign roles to users.' },
  { key: 'AUDIT_VIEW', category: PERMISSION_CATEGORIES.USERS, description: 'View the audit log.' },

  { key: 'ROLES_PERMISSIONS_VIEW', category: PERMISSION_CATEGORIES.ROLES_PERMISSIONS, description: 'View roles and their permissions.' },
  { key: 'ROLES_PERMISSIONS_MANAGE', category: PERMISSION_CATEGORIES.ROLES_PERMISSIONS, description: 'Create, edit, and delete roles and their permissions.' },

  { key: 'ACADEMIC_PERIOD_VIEW', category: PERMISSION_CATEGORIES.ACADEMICS, description: 'View academic years/terms and the currently selected period.' },
  { key: 'ACADEMIC_PERIOD_SWITCH', category: PERMISSION_CATEGORIES.ACADEMICS, description: 'Switch your own session to a different academic year/term.' },

  { key: 'ROSTER_VIEW', category: PERMISSION_CATEGORIES.ROSTER, description: 'View classes, students, staff, and schedules from the MIS.' },

  { key: 'NOTIFICATIONS_MANAGE', category: PERMISSION_CATEGORIES.NOTIFICATIONS, description: 'View and manage your own in-app notifications.' },

  { key: 'SETTINGS_MANAGE', category: PERMISSION_CATEGORIES.SETTINGS, description: 'View and update your own account preferences.' },
];

export const PERMISSION_KEYS = new Set(PERMISSIONS.map((p) => p.key));

/** Seed permission sets for the 3 system roles — reproduces the exact behavior
 *  of the old flat role model so migrating to RBAC changes nothing by default. */
export const DEFAULT_ROLE_PERMISSIONS: Record<'Student' | 'Teacher' | 'Admin', string[]> = {
  Student: [
    'ATTENDANCE_VIEW_OWN',
    'EXCUSES_SUBMIT',
    'EXCUSES_VIEW_OWN',
    'DISCIPLINE_VIEW_OWN',
    'ACADEMIC_PERIOD_VIEW', 'ACADEMIC_PERIOD_SWITCH',
    'ROSTER_VIEW',
    'NOTIFICATIONS_MANAGE',
    'SETTINGS_MANAGE',
  ],
  Teacher: [
    'ATTENDANCE_MARK',
    'ATTENDANCE_VIEW_ALL',
    'EXCUSES_REVIEW',
    'DISCIPLINE_LOG',
    'DISCIPLINE_VIEW_ALL',
    'DISCIPLINE_REVIEW',
    'STAFF_ATTENDANCE_CLOCK',
    'STAFF_ATTENDANCE_VIEW_OWN',
    'REPORTS_VIEW',
    'ACADEMIC_PERIOD_VIEW', 'ACADEMIC_PERIOD_SWITCH',
    'ROSTER_VIEW',
    'NOTIFICATIONS_MANAGE',
    'SETTINGS_MANAGE',
  ],
  Admin: [
    'ATTENDANCE_MARK', 'ATTENDANCE_VIEW_ALL', 'ATTENDANCE_VIEW_OWN',
    'EXCUSES_SUBMIT', 'EXCUSES_VIEW_OWN', 'EXCUSES_REVIEW',
    'DISCIPLINE_LOG', 'DISCIPLINE_VIEW_ALL', 'DISCIPLINE_VIEW_OWN', 'DISCIPLINE_REVIEW',
    'STAFF_ATTENDANCE_CLOCK', 'STAFF_ATTENDANCE_VIEW_OWN', 'STAFF_ATTENDANCE_VIEW_ALL',
    'REPORTS_VIEW',
    'USERS_VIEW', 'USERS_MANAGE', 'AUDIT_VIEW',
    'ROLES_PERMISSIONS_VIEW', 'ROLES_PERMISSIONS_MANAGE',
    'ACADEMIC_PERIOD_VIEW', 'ACADEMIC_PERIOD_SWITCH',
    'ROSTER_VIEW',
    'NOTIFICATIONS_MANAGE',
    'SETTINGS_MANAGE',
  ],
};

/** System roles seeded on first boot, keyed by name (matches DEFAULT_ROLE_PERMISSIONS). */
export const SYSTEM_ROLES: Array<{ name: string; level: RoleLevel; description: string }> = [
  { name: 'Student', level: 'STUDENT', description: 'Default student role.' },
  { name: 'Teacher', level: 'TEACHER', description: 'Default teacher/instructor role.' },
  { name: 'Admin', level: 'ADMIN', description: 'Default administrator role with full access.' },
];
