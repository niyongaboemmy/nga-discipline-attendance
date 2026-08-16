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
    // .app-boot-badge / .app-boot-ring are defined in index.html so the same
    // branded mark is shown here and in the pre-React boot splash.
    return (
      <div
        className="flex items-center justify-center"
        // --z-overlay, not an arbitrary 9999: this sat above dialogs, so a
        // full-page load could paint over an open one.
        style={{ position: 'fixed', inset: 0, background: 'var(--bg-page)', zIndex: 'var(--z-overlay)' as any }}
        role="status"
        aria-label="Loading Tendo"
      >
        <div className="app-boot-badge">
          <span className="app-boot-ring" />
          <span className="app-boot-ring app-boot-ring-delayed" />
          <img src="/favicon.svg" alt="" width="40" height="40" />
        </div>
      </div>
    );
  }

  return <div className="flex items-center justify-center">{spinner}</div>;
};
