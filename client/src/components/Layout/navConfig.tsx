import {
  LayoutDashboard,
  CalendarClock,
  History,
  Clock,
  FileText,
  BarChart3,
  Users,
  ShieldCheck,
  Gavel,
  ScrollText,
  ClipboardCheck,
  History as AuditIcon,
  Award,
  KeyRound,
  BookOpen,
  Settings as SettingsIcon,
  type LucideIcon,
} from 'lucide-react';

export type Role = 'admin' | 'teacher' | 'student' | 'unassigned';

export interface NavItem {
  label: string;
  path: string;
  icon: LucideIcon;
  roles: Role[];
  /** Labeled section this item belongs to; consecutive items sharing a
      section render under one small heading. Unsectioned items stand alone. */
  section?: string;
}

/* Items are ordered so that, after filtering by role, every section's items
   are consecutive — the sidebar renders one heading per run. */
export const navItems: NavItem[] = [
  { label: 'Attendance Calendar', path: '/attendance', icon: CalendarClock, roles: ['admin', 'teacher', 'student'] },
  { label: 'Dashboard', path: '/dashboard', icon: LayoutDashboard, roles: ['admin', 'teacher', 'student'] },

  // Admin — Discipline Rules lives here, not under Discipline: it's catalog
  // governance (admin job). Teachers pick rules inline from the same catalog
  // while logging an incident, so they don't need a standalone nav entry.
  { label: 'Admin Console', path: '/admin', icon: ShieldCheck, roles: ['admin'], section: 'Administration' },
  { label: 'Roles & Permissions', path: '/admin/roles', icon: KeyRound, roles: ['admin'], section: 'Administration' },
  { label: 'Discipline Rules', path: '/discipline/rules', icon: BookOpen, roles: ['admin'], section: 'Administration' },
  { label: 'Audit Log', path: '/admin/audit', icon: AuditIcon, roles: ['admin'], section: 'Administration' },

  // Attendance (staff) — taking a register now happens inside the Attendance
  // Calendar (open a lesson) or its "Record a session" action; the standalone
  // /attendance/mark page stays reachable from there for the full-screen view.
  { label: 'Attendance History', path: '/attendance/records', icon: History, roles: ['admin', 'teacher'], section: 'Attendance' },
  { label: 'Staff Attendance', path: '/staff/attendance', icon: Clock, roles: ['admin', 'teacher'], section: 'Attendance' },

  // Attendance (student)
  { label: 'My Attendance', path: '/attendance/me', icon: History, roles: ['student'], section: 'Attendance' },
  { label: 'Leaves & Excuses', path: '/excuses', icon: FileText, roles: ['student'], section: 'Attendance' },

  // Discipline (staff)
  { label: 'Log Conduct Record', path: '/discipline/log', icon: Gavel, roles: ['admin', 'teacher'], section: 'Discipline' },
  { label: 'Discipline Records', path: '/discipline/records', icon: ScrollText, roles: ['admin', 'teacher'], section: 'Discipline' },
  { label: 'Excuse Review', path: '/excuses/review', icon: ClipboardCheck, roles: ['admin', 'teacher'], section: 'Discipline' },

  // Discipline (student)
  { label: 'My Conduct', path: '/discipline/me', icon: Award, roles: ['student'], section: 'Discipline' },

  // Insights — Analytics removed: its content now lives in My Attendance / My Conduct.
  { label: 'Reports', path: '/reports', icon: BarChart3, roles: ['admin', 'teacher'], section: 'Insights' },
  { label: 'Directory', path: '/directory', icon: Users, roles: ['admin', 'teacher'], section: 'Insights' },

  // Common
  { label: 'Settings', path: '/settings', icon: SettingsIcon, roles: ['admin', 'teacher', 'student'] },
];

