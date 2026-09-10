import React from 'react';
import { CheckCircle2, XCircle, Clock, ShieldCheck, CircleDashed } from 'lucide-react';

export type AttStatus = 'present' | 'absent' | 'late' | 'excused';
type ChipKind = AttStatus | 'recorded' | 'missing' | 'neutral';

const META: Record<ChipKind, { label: string; icon: React.ReactNode }> = {
  present: { label: 'Present', icon: <CheckCircle2 size={13} /> },
  absent: { label: 'Absent', icon: <XCircle size={13} /> },
  late: { label: 'Late', icon: <Clock size={13} /> },
  excused: { label: 'Excused', icon: <ShieldCheck size={13} /> },
  recorded: { label: 'Recorded', icon: <CheckCircle2 size={13} /> },
  missing: { label: 'Not recorded', icon: <CircleDashed size={13} /> },
  neutral: { label: '—', icon: <CircleDashed size={13} /> },
};

/** Attendance status as an icon + label pill. Colour is reinforcement, never
 *  the sole signal (WCAG 1.4.1). */
export const StatusChip: React.FC<{ kind: ChipKind; label?: string; className?: string }> = ({
  kind,
  label,
  className = '',
}) => {
  const m = META[kind];
  return (
    <span className={`status-chip is-${kind} ${className}`}>
      {m.icon}
      {label ?? m.label}
    </span>
  );
};
