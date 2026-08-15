import React from 'react';

interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  fullPage?: boolean;
}

const sizeMap = { sm: 24, md: 40, lg: 56 };

export const LoadingSpinner: React.FC<LoadingSpinnerProps> = ({ size = 'md', fullPage = false }) => {
  const px = sizeMap[size];

  const spinner = (
    <div
      style={{
        width: px,
        height: px,
        border: '3px solid var(--border)',
        borderTopColor: 'var(--primary)',
        borderRadius: '50%',
        animation: 'spin 0.8s linear infinite',
      }}
      role="status"
      aria-label="Loading"
    />
  );

  if (fullPage) {
    return (
      <div
        className="flex items-center justify-center"
        style={{ position: 'fixed', inset: 0, background: 'var(--bg-page)', zIndex: 9999 }}
      >
        {spinner}
      </div>
    );
  }

  return <div className="flex items-center justify-center">{spinner}</div>;
};
