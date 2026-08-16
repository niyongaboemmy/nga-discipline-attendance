/**
 * Presentation metadata for the permission catalog.
 *
 * The server sends each permission as `{ key, category, description }`. The
 * raw key (ATTENDANCE_VIEW_ALL) is precise but reads poorly as a row title,
 * so each one gets a short human label; the server's description stays as
 * the supporting line. Anything not listed here still renders via
 * `humanizeKey`, so a newly added permission degrades gracefully instead of
 * disappearing or showing blank.
 */
export const PERMISSION_LABELS: Record<string, string> = {
  ATTENDANCE_MARK: 'Mark attendance',
  ATTENDANCE_VIEW_ALL: 'View everyone’s attendance',
  ATTENDANCE_VIEW_OWN: 'View own attendance',

  EXCUSES_SUBMIT: 'Submit an excuse',
  EXCUSES_VIEW_OWN: 'View own excuses',
  EXCUSES_REVIEW: 'Review excuses',

  DISCIPLINE_LOG: 'Log a conduct record',
  DISCIPLINE_VIEW_ALL: 'View everyone’s conduct',
  DISCIPLINE_VIEW_OWN: 'View own conduct',
  DISCIPLINE_REVIEW: 'Review conduct records',
  DISCIPLINE_ADJUST: 'Adjust conduct points',
  DISCIPLINE_RULES_MANAGE: 'Manage the rules catalog',

  STAFF_ATTENDANCE_CLOCK: 'Clock in and out',
  STAFF_ATTENDANCE_VIEW_OWN: 'View own staff log',
  STAFF_ATTENDANCE_VIEW_ALL: 'View all staff logs',

  REPORTS_VIEW: 'View reports',

  USERS_VIEW: 'View users',
  USERS_MANAGE: 'Manage users',
  AUDIT_VIEW: 'View the audit log',

  ROLES_PERMISSIONS_VIEW: 'View roles',
  ROLES_PERMISSIONS_MANAGE: 'Manage roles and permissions',

  ACADEMIC_PERIOD_VIEW: 'View the academic period',
  ACADEMIC_PERIOD_SWITCH: 'Switch academic period',

  ROSTER_VIEW: 'View the MIS roster',
  ROSTER_SYNC: 'Sync from the MIS',

  NOTIFICATIONS_MANAGE: 'Manage own notifications',
  SETTINGS_MANAGE: 'Manage own settings',
};

/** Fallback for keys with no curated label: ROSTER_SYNC -> "Roster sync". */
export function humanizeKey(key: string): string {
  const words = key.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const permissionLabel = (key: string) => PERMISSION_LABELS[key] ?? humanizeKey(key);

/**
 * Permissions that widen what a role can do to *other people's* data or to
 * the system itself. Flagged in the UI so an admin can see risk while
 * scanning, rather than having to know each key by heart.
 */
export const SENSITIVE_PERMISSIONS = new Set([
  'ROLES_PERMISSIONS_MANAGE',
  'USERS_MANAGE',
  'DISCIPLINE_RULES_MANAGE',
  'DISCIPLINE_ADJUST',
  'ROSTER_SYNC',
]);

/**
 * Granting these lets a role change who can do what — including granting
 * itself more. Adding one asks for explicit confirmation before saving.
 */
export const ESCALATING_PERMISSIONS = new Set([
  'ROLES_PERMISSIONS_MANAGE',
  'USERS_MANAGE',
]);
