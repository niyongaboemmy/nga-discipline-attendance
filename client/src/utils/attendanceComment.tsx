import React from 'react';
import { CheckCircle2, ThumbsUp, AlertCircle, XCircle } from 'lucide-react';

export type AttendanceCommentTier = 'Excellent' | 'Good' | 'Fair' | 'Poor';

/** Excellent/Good/Fair/Poor -> the same semantic tokens used everywhere else
 *  in the app (success/info/warning/danger) rather than a new palette. Mirrors
 *  server/src/modules/reporting/attendanceReport.service.ts's attendanceComment(). */
export const COMMENT_META: Record<AttendanceCommentTier, { color: string; icon: React.ReactNode }> = {
  Excellent: { color: 'var(--success)', icon: <CheckCircle2 size={12} /> },
  Good: { color: 'var(--info)', icon: <ThumbsUp size={12} /> },
  Fair: { color: 'var(--warning)', icon: <AlertCircle size={12} /> },
  Poor: { color: 'var(--danger)', icon: <XCircle size={12} /> },
};

/** Fill colours for chart marks (bars, columns) — the --chart-* tokens, which
 *  stay legible as large fills on both themes; COMMENT_META's colours are the
 *  text/badge tokens and are too light for fills in dark mode. */
export const COMMENT_FILL: Record<AttendanceCommentTier, string> = {
  Excellent: 'var(--chart-present)', Good: 'var(--chart-excused)', Fair: 'var(--chart-late)', Poor: 'var(--chart-absent)',
};

export const COMMENT_BADGE: Record<AttendanceCommentTier, string> = {
  Excellent: 'badge-success', Good: 'badge-info', Fair: 'badge-warning', Poor: 'badge-danger',
};

/** For a bare rate (no comment field alongside it, e.g. an overview card). */
export function rateColor(rate: number): string {
  if (rate >= 95) return COMMENT_META.Excellent.color;
  if (rate >= 85) return COMMENT_META.Good.color;
  if (rate >= 75) return COMMENT_META.Fair.color;
  return COMMENT_META.Poor.color;
}
