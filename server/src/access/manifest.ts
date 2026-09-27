import { CapabilityDef, defineManifest, Depth, Domain } from '../vendor/nga-access';

/**
 * Discipline & Attendance capability manifest (access control v2 -- see
 * nga_central_mis/ACCESS_LEVELS_RBAC_IMPLEMENTATION_PLAN.md and
 * nga_central_mis/packages/access/README.md).
 *
 * Keys are the existing permission keys (constants/permissions.ts), so no call
 * site is renamed. "*_OWN" keys are granted at SELF scope; "*_ALL" keys carry
 * a read depth: `summary` (aggregates, never names) or `detail` (records).
 * The four DISCIPLINE_SANCTION_* / SUSPEND_* keys are new: they express the
 * sanction ladder (plan §10) as capabilities so it can be re-routed from
 * Access Studio instead of code.
 *
 * Published to MIS on deploy (npm run access:publish). Changing this file is
 * the only access change that needs a deploy.
 */

const R = (label: string, domain: Domain, depths: Depth[] = ['detail'], extra: Partial<CapabilityDef> = {}): CapabilityDef =>
  ({ label, domain, kind: 'READ', depths, ...extra });
const W = (label: string, domain: Domain, extra: Partial<CapabilityDef> = {}): CapabilityDef =>
  ({ label, domain, kind: 'WRITE', ...extra });
const SCHOOL_ONLY = { scopeable: false };

export const DA_MANIFEST = defineManifest({
  app: 'da',
  name: 'Discipline & Attendance',
  version: '2026.09.27',
  capabilities: {
    ATTENDANCE_MARK: W('Mark registers', 'ATTENDANCE'),
    ATTENDANCE_VIEW_ALL: R('View attendance', 'ATTENDANCE', ['summary', 'detail']),
    ATTENDANCE_VIEW_OWN: R('View own attendance', 'ATTENDANCE'),
    ATTENDANCE_CALENDAR_VIEW_OWN: R('View own attendance calendar', 'ATTENDANCE'),
    ATTENDANCE_DASHBOARD_VIEW_OWN: R('View own attendance dashboard', 'ATTENDANCE'),
    ATTENDANCE_REPORT_VIEW_OWN: R('View own attendance report', 'ATTENDANCE'),

    EXCUSES_SUBMIT: W('Submit excuses', 'ATTENDANCE'),
    EXCUSES_VIEW_OWN: R('View own excuses', 'ATTENDANCE'),
    EXCUSES_REVIEW: W('Review excuses', 'ATTENDANCE'),

    DISCIPLINE_LOG: W('Log incidents', 'DISCIPLINE'),
    DISCIPLINE_VIEW_ALL: R('View discipline records', 'DISCIPLINE', ['summary', 'detail', 'sensitive'], { restricted: ['sensitive'] }),
    DISCIPLINE_VIEW_OWN: R('View own conduct', 'DISCIPLINE'),
    DISCIPLINE_REVIEW: W('Review incidents (status)', 'DISCIPLINE'),
    DISCIPLINE_EDIT: W('Edit incidents', 'DISCIPLINE'),
    DISCIPLINE_DELETE: W('Delete incidents', 'DISCIPLINE'),
    DISCIPLINE_ADJUST: W('Adjust conduct points', 'DISCIPLINE'),
    DISCIPLINE_RULES_MANAGE: W('Manage the rules catalog', 'DISCIPLINE', SCHOOL_ONLY),
    DISCIPLINE_SANCTION_MINOR: W('Sanction: warning, parent contact', 'DISCIPLINE'),
    DISCIPLINE_SANCTION_MAJOR: W('Sanction: detention, community service, counselling', 'DISCIPLINE'),
    DISCIPLINE_SUSPEND_RECOMMEND: W('Recommend a suspension', 'DISCIPLINE'),
    DISCIPLINE_SUSPEND_APPROVE: W('Approve a suspension', 'DISCIPLINE'),

    STAFF_ATTENDANCE_CLOCK: W('Clock in/out (staff)', 'ATTENDANCE'),
    STAFF_ATTENDANCE_VIEW_OWN: R('View own staff attendance', 'ATTENDANCE'),
    STAFF_ATTENDANCE_VIEW_ALL: R('View staff attendance', 'ATTENDANCE', ['summary', 'detail']),

    REPORTS_VIEW: R('View attendance & discipline reports', 'REPORTING', ['summary', 'detail']),

    USERS_VIEW: R('View users', 'PEOPLE', ['detail'], SCHOOL_ONLY),
    USERS_MANAGE: W('Manage users and local roles', 'PEOPLE', SCHOOL_ONLY),
    AUDIT_VIEW: R('View the audit log', 'SYSTEM', ['detail'], SCHOOL_ONLY),
    ROLES_PERMISSIONS_VIEW: R('View roles & permissions', 'ACCESS', ['detail'], SCHOOL_ONLY),
    ROLES_PERMISSIONS_MANAGE: W('Manage roles & permissions', 'ACCESS', SCHOOL_ONLY),

    ACADEMIC_PERIOD_VIEW: R('View academic periods', 'ACADEMICS'),
    ACADEMIC_PERIOD_SWITCH: W('Switch own session to another academic period', 'ACADEMICS'),
    ROSTER_VIEW: R('View the roster directory', 'PEOPLE', ['summary', 'detail']),
    ROSTER_SYNC: W('Sync the roster from MIS', 'SYSTEM', SCHOOL_ONLY),
    NOTIFICATIONS_MANAGE: W('Manage notifications', 'SYSTEM'),
    SETTINGS_MANAGE: W('Manage own settings', 'SYSTEM'),
  },
  insights: {
    'attendance.rate': { label: 'Attendance rate', capability: 'ATTENDANCE_VIEW_ALL', minDepth: 'summary', levels: ['SCHOOL', 'PROGRAM', 'GRADE', 'CLASS_GROUP'] },
    'attendance.chronic_absence': { label: 'Chronic absence (count)', capability: 'ATTENDANCE_VIEW_ALL', minDepth: 'summary', levels: ['SCHOOL', 'PROGRAM', 'GRADE', 'CLASS_GROUP'] },
    'excuses.turnaround': { label: 'Excuse turnaround', capability: 'ATTENDANCE_VIEW_ALL', minDepth: 'summary', levels: ['SCHOOL', 'PROGRAM', 'GRADE'] },
    'discipline.incidents': { label: 'Incidents per 100 students', capability: 'DISCIPLINE_VIEW_ALL', minDepth: 'summary', levels: ['SCHOOL', 'PROGRAM', 'GRADE', 'CLASS_GROUP'] },
    'discipline.by_category': { label: 'Incidents by category', capability: 'DISCIPLINE_VIEW_ALL', minDepth: 'summary', levels: ['SCHOOL', 'PROGRAM', 'GRADE', 'CLASS_GROUP'] },
    'staff.register_completion': { label: 'Registers taken on time', capability: 'STAFF_ATTENDANCE_VIEW_ALL', minDepth: 'summary', levels: ['SCHOOL', 'PROGRAM'] },
  },
});

export default DA_MANIFEST;
