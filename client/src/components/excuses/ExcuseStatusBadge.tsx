import React from 'react';
import type { ExcuseStatus } from '../../api/excuses';
import { STATUS_META } from './excuseMeta';

export const ExcuseStatusBadge: React.FC<{ status: ExcuseStatus; size?: 'sm' | 'md' }> = ({ status, size = 'sm' }) => {
  const m = STATUS_META[status];
  return (
    <span className={`badge ${m.badge}${size === 'md' ? ' ex-badge-md' : ''}`}>
      {m.icon}<span style={{ marginLeft: 4 }}>{m.label}</span>
    </span>
  );
};
