import { Settings as SettingsIcon, type LucideIcon } from 'lucide-react';
import { NAV_AREAS, placeLinks, type Role } from './navModel';

export type { Role };

export interface NavItem {
  label: string;
  path: string;
  icon: LucideIcon;
  roles: Role[];
  /** The menu area the page sits in (Attendance, Discipline…). */
  section?: string;
  /** Also require one of these permissions (in addition to the role). */
  anyPermission?: string[];
}

/** Every menu page as a flat list (Welcome's quick links). The menu itself is
 *  drawn from navModel's areas; this list is derived from it so the two never disagree. */
export const navItems: NavItem[] = [
  ...placeLinks(NAV_AREAS).map(({ link, area, group }) => ({ ...link, section: group ? area.label : undefined })),
  { label: 'Settings', path: '/settings', icon: SettingsIcon, roles: ['admin', 'teacher', 'student'] },
];
