import type React from 'react';
import { CheckCircle2, Clock, ShieldCheck, XCircle } from 'lucide-react';

export type StatusKey = 'present' | 'late' | 'excused' | 'absent';

export interface Series<K extends string = string> {
  key: K;
  label: string;
  /** A CSS color — the chart tokens from variables.css. */
  color: string;
  /** Legends always pair the swatch with an icon, so identity never rests on hue alone. */
  icon: React.ReactNode;
}

/** Segment order matters: adjacent pairs were validated to stay apart under
 *  colour-vision deficiency (see the --chart-* note in variables.css). */
export const STATUS_SERIES: Series<StatusKey>[] = [
  { key: 'present', label: 'Present', color: 'var(--chart-present)', icon: <CheckCircle2 size={12} /> },
  { key: 'late', label: 'Late', color: 'var(--chart-late)', icon: <Clock size={12} /> },
  { key: 'excused', label: 'Excused', color: 'var(--chart-excused)', icon: <ShieldCheck size={12} /> },
  { key: 'absent', label: 'Absent', color: 'var(--chart-absent)', icon: <XCircle size={12} /> },
];
