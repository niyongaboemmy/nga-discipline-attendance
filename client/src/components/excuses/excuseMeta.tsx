import type React from 'react';
import { CheckCircle2, Clock, XCircle, Stethoscope, Home, Briefcase, MoreHorizontal } from 'lucide-react';
import type { ExcuseStatus } from '../../api/excuses';

/** One vocabulary for excuse status across the overview, form and detail
 *  pages — icon + word, never colour alone. */
export const STATUS_META: Record<ExcuseStatus, { badge: string; icon: React.ReactNode; label: string; blurb: string }> = {
  pending:  { badge: 'badge-warning', icon: <Clock size={13} />,        label: 'Pending',  blurb: 'Waiting for a teacher to review it.' },
  approved: { badge: 'badge-success', icon: <CheckCircle2 size={13} />, label: 'Approved', blurb: 'Accepted — the absence is now marked excused.' },
  rejected: { badge: 'badge-danger',  icon: <XCircle size={13} />,      label: 'Rejected', blurb: 'Not accepted. You can appeal with new information.' },
};

export const REASONS: Array<{ value: string; icon: React.ReactNode; hint: string }> = [
  { value: 'Medical',  icon: <Stethoscope size={14} />,   hint: 'Illness, appointment, injury' },
  { value: 'Family',   icon: <Home size={14} />,          hint: 'Family emergency or event' },
  { value: 'Official', icon: <Briefcase size={14} />,     hint: 'School activity, competition, official duty' },
  { value: 'Other',    icon: <MoreHorizontal size={14} />, hint: 'Anything else — explain below' },
];

export const fmtDate = (iso: string) =>
  new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

export const fmtLongDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
