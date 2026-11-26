import {
  Award,
  BarChart3,
  BookOpen,
  Building2,
  CalendarClock,
  ClipboardCheck,
  Clock,
  CreditCard,
  FileText,
  Gavel,
  History,
  KeyRound,
  LayoutDashboard,
  MapPin,
  ScanLine,
  ScrollText,
  ShieldCheck,
  Table2,
  Users,
  type LucideIcon,
} from 'lucide-react';

export type Role = 'admin' | 'teacher' | 'student' | 'unassigned';

/**
 * The Tendo menu as data, in the same shape as the Amashuri (central MIS) menu:
 * area (rail icon) › group (heading in the panel) › page. A group shows when any
 * page in it is visible, an area when any group is.
 */
export interface NavLink {
  label: string;
  path: string;
  icon: LucideIcon;
  roles: Role[];
  /** Also require one of these permissions (in addition to the role). */
  anyPermission?: string[];
}

export interface NavGroup {
  label: string;
  items: NavLink[];
}

export interface NavArea {
  id: string;
  label: string;
  icon: LucideIcon;
  /** A direct page (Dashboard): the rail icon navigates instead of opening a panel. */
  link?: NavLink;
  groups?: NavGroup[];
}

const EVERYONE: Role[] = ['admin', 'teacher', 'student'];
const STAFF: Role[] = ['admin', 'teacher'];

export const NAV_AREAS: NavArea[] = [
  // Dashboard first: it's the overview you land on.
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, link: { label: 'Dashboard', path: '/dashboard', icon: LayoutDashboard, roles: EVERYONE } },
  {
    id: 'attendance',
    label: 'Attendance',
    icon: CalendarClock,
    groups: [
      {
        // Taking a register happens inside the Attendance Calendar (open a lesson) or
        // its "Record a session" action. Students get just the calendar and the report.
        label: 'Students',
        items: [
          { label: 'Attendance Calendar', path: '/attendance', icon: CalendarClock, roles: EVERYONE },
          { label: 'Attendance History', path: '/attendance/records', icon: History, roles: STAFF },
          { label: 'Attendance Report', path: '/attendance/report', icon: Table2, roles: EVERYONE },
          // Card attendance: the card tap stands in for the teacher marking the register.
          { label: 'Attendance Cards', path: '/attendance/cards', icon: CreditCard, roles: ['admin'] },
          { label: 'Leaves & Excuses', path: '/excuses', icon: FileText, roles: ['student'] },
        ],
      },
      {
        label: 'Staff',
        items: [
          { label: 'Staff Attendance', path: '/staff/attendance', icon: Clock, roles: STAFF },
          {
            label: 'Staff Check-in',
            path: '/staff/clock',
            icon: MapPin,
            roles: STAFF,
            anyPermission: ['STAFF_ATTENDANCE_ZONES_MANAGE', 'STAFF_ATTENDANCE_VIEW_ALL', 'STAFF_DEVICES_MANAGE'],
          },
          { label: 'Scan Staff Card', path: '/staff/clock/scan', icon: ScanLine, roles: STAFF, anyPermission: ['STAFF_CLOCK_SCAN'] },
        ],
      },
    ],
  },
  {
    id: 'discipline',
    label: 'Discipline',
    icon: Gavel,
    groups: [
      {
        label: 'Discipline',
        items: [
          { label: 'Log Conduct Record', path: '/discipline/log', icon: Gavel, roles: STAFF },
          { label: 'Discipline Records', path: '/discipline/records', icon: ScrollText, roles: STAFF },
          { label: 'Excuse Review', path: '/excuses/review', icon: ClipboardCheck, roles: STAFF },
          { label: 'My Conduct', path: '/discipline/me', icon: Award, roles: ['student'] },
        ],
      },
    ],
  },
  {
    id: 'insights',
    label: 'Insights',
    icon: BarChart3,
    groups: [
      {
        label: 'Insights',
        items: [
          { label: 'Reports', path: '/reports', icon: BarChart3, roles: STAFF },
          { label: 'Directory', path: '/directory', icon: Users, roles: STAFF },
        ],
      },
    ],
  },
  {
    // Discipline Rules lives here, not under Discipline: it's catalog governance
    // (admin job). Teachers pick rules inline while logging an incident.
    id: 'admin',
    label: 'Administration',
    icon: Building2,
    groups: [
      {
        label: 'Administration',
        items: [
          { label: 'Admin Console', path: '/admin', icon: ShieldCheck, roles: ['admin'] },
          { label: 'Roles & Permissions', path: '/admin/roles', icon: KeyRound, roles: ['admin'] },
          { label: 'Discipline Rules', path: '/discipline/rules', icon: BookOpen, roles: ['admin'] },
          { label: 'Audit Log', path: '/admin/audit', icon: History, roles: ['admin'] },
        ],
      },
    ],
  },
];

/** The areas, groups and pages this person may open. */
export function visibleAreas(role: Role, can: (keys: string[]) => boolean): NavArea[] {
  const ok = (l: NavLink) => l.roles.includes(role) && (!l.anyPermission || can(l.anyPermission));
  return NAV_AREAS.map((a): NavArea | null => {
    if (a.link) return ok(a.link) ? a : null;
    const groups = (a.groups ?? []).map((g) => ({ ...g, items: g.items.filter(ok) })).filter((g) => g.items.length > 0);
    return groups.length ? { ...a, groups } : null;
  }).filter((a): a is NavArea => !!a);
}

/** A page with the area and group it sits in, for search, pins and recents. */
export interface PlacedLink {
  link: NavLink;
  area: NavArea;
  group: NavGroup | null;
}

export function placeLinks(areas: NavArea[]): PlacedLink[] {
  return areas.flatMap((area): PlacedLink[] =>
    area.link ? [{ link: area.link, area, group: null }] : (area.groups ?? []).flatMap((group) => group.items.map((link) => ({ link, area, group }))),
  );
}

/**
 * The page the current URL belongs to: an exact match, else the longest path the URL
 * sits under (/attendance/report lights Attendance Report, not Attendance Calendar,
 * while /attendance/session still lights the calendar).
 */
export function matchPath<T extends { link: NavLink }>(placed: T[], pathname: string): T | null {
  let best: T | null = null;
  for (const p of placed) {
    const path = p.link.path;
    if (pathname === path) return p;
    if (pathname.startsWith(`${path}/`) && (!best || path.length > best.link.path.length)) best = p;
  }
  return best;
}
