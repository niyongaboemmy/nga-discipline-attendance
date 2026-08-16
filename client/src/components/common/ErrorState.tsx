import React from 'react';
import { AlertTriangle, RotateCw } from 'lucide-react';

interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
}

/** Consistent "something went wrong" block for use wherever useApiResource
 *  reports an error — replaces the mix of "shows nothing" / "shows a custom
 *  alert" that different pages previously did on their own. */
export const ErrorState: React.FC<ErrorStateProps> = ({ message, onRetry }) => (
  <div className="alert alert-danger">
    <AlertTriangle size={16} />
    <span>{message}</span>
    {onRetry && (
      <button type="button" className="btn btn-outline btn-sm" onClick={onRetry} style={{ marginLeft: 'auto' }}>
        <RotateCw size={14} /> Retry
      </button>
    )}
  </div>
);
