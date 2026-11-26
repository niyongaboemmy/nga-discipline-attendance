import React from 'react';

/**
 * Loading skeletons: grey shapes in the layout of what is coming, shimmering
 * softly, instead of a spinner on an empty page. Pick the variant that matches
 * the content (stat cards, a table, a list, cards, a detail page, a form).
 */

export const Skeleton: React.FC<{ w?: number | string; h?: number | string; r?: number | string; className?: string; style?: React.CSSProperties }> = ({ w = '100%', h = 14, r = 8, className = '', style }) => (
  <span className={`skel ${className}`} style={{ width: w, height: h, borderRadius: r, ...style }} aria-hidden />
);

const Busy: React.FC<{ label?: string; children: React.ReactNode; className?: string }> = ({ label = 'Loading', children, className = '' }) => (
  <div className={`skel-wrap ${className}`} role="status" aria-busy="true" aria-label={label}>
    {children}
  </div>
);

export const SkeletonStats: React.FC<{ count?: number }> = ({ count = 4 }) => (
  <div className="skel-stats">
    {Array.from({ length: count }, (_, i) => (
      <div className="skel-card" key={i}>
        <Skeleton w={36} h={36} r={999} />
        <Skeleton w="55%" h={12} style={{ marginTop: 14 }} />
        <Skeleton w="35%" h={26} r={10} style={{ marginTop: 10 }} />
      </div>
    ))}
  </div>
);

export const SkeletonTable: React.FC<{ rows?: number; cols?: number; label?: string }> = ({ rows = 6, cols = 5, label }) => (
  <Busy label={label}>
    <div className="skel-table">
      <div className="skel-tr skel-th" style={{ gridTemplateColumns: `1.6fr repeat(${cols - 1}, 1fr)` }}>
        {Array.from({ length: cols }, (_, i) => <Skeleton key={i} w={i ? '60%' : '45%'} h={10} />)}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div className="skel-tr" key={r} style={{ gridTemplateColumns: `1.6fr repeat(${cols - 1}, 1fr)` }}>
          <span className="skel-person"><Skeleton w={30} h={30} r={999} /><Skeleton w={`${50 + ((r * 13) % 35)}%`} h={12} /></span>
          {Array.from({ length: cols - 1 }, (_, c) => <Skeleton key={c} w={`${40 + (((r + c) * 17) % 45)}%`} h={12} />)}
        </div>
      ))}
    </div>
  </Busy>
);

export const SkeletonList: React.FC<{ rows?: number; label?: string }> = ({ rows = 5, label }) => (
  <Busy label={label}>
    <div className="skel-list">
      {Array.from({ length: rows }, (_, i) => (
        <div className="skel-li" key={i}>
          <Skeleton w={40} h={40} r={999} />
          <span className="skel-li-text">
            <Skeleton w={`${45 + ((i * 19) % 35)}%`} h={13} />
            <Skeleton w={`${25 + ((i * 11) % 30)}%`} h={11} />
          </span>
          <Skeleton w={72} h={26} r={999} />
        </div>
      ))}
    </div>
  </Busy>
);

export const SkeletonCards: React.FC<{ count?: number; label?: string }> = ({ count = 6, label }) => (
  <Busy label={label}>
    <div className="skel-cards">
      {Array.from({ length: count }, (_, i) => (
        <div className="skel-card" key={i}>
          <span className="skel-row"><Skeleton w={40} h={40} r={12} /><span className="skel-li-text"><Skeleton w="70%" h={13} /><Skeleton w="45%" h={11} /></span></span>
          <Skeleton h={10} style={{ marginTop: 18 }} />
          <Skeleton w="80%" h={10} style={{ marginTop: 8 }} />
        </div>
      ))}
    </div>
  </Busy>
);

/** Whole-page loading in the shape of the page: header, then the content kind. */
export const PageSkeleton: React.FC<{ variant?: 'dashboard' | 'table' | 'list' | 'detail' | 'form' | 'cards'; label?: string; head?: boolean }> = ({ variant = 'table', label, head = true }) => (
  <Busy label={label} className="skel-page">
    {head && <div className="skel-head">
      <span className="skel-li-text"><Skeleton w={220} h={24} r={10} /><Skeleton w={320} h={12} /></span>
      <Skeleton w={130} h={38} r={999} />
    </div>}
    {variant === 'dashboard' && (
      <>
        <SkeletonStats />
        <div className="skel-split">
          <div className="skel-card skel-chart"><Skeleton w="40%" h={14} /><div className="skel-bars">{[62, 80, 45, 90, 70, 55, 84].map((h, i) => <Skeleton key={i} w="100%" h={`${h}%`} r={8} />)}</div></div>
          <div className="skel-card"><Skeleton w="50%" h={14} /><SkeletonList rows={4} /></div>
        </div>
      </>
    )}
    {variant === 'table' && (
      <>
        <div className="skel-filters">{[160, 140, 120].map((w, i) => <Skeleton key={i} w={w} h={38} r={999} />)}</div>
        <div className="skel-card skel-flush"><SkeletonTable /></div>
      </>
    )}
    {variant === 'list' && <div className="skel-card skel-flush"><SkeletonList rows={6} /></div>}
    {variant === 'cards' && <SkeletonCards />}
    {variant === 'detail' && (
      <div className="skel-split">
        <div className="skel-card">
          <span className="skel-row"><Skeleton w={56} h={56} r={999} /><span className="skel-li-text"><Skeleton w="60%" h={18} /><Skeleton w="40%" h={12} /></span></span>
          {[90, 75, 85, 60].map((w, i) => <Skeleton key={i} w={`${w}%`} h={12} style={{ marginTop: 16 }} />)}
        </div>
        <div className="skel-card"><Skeleton w="45%" h={14} /><SkeletonList rows={4} /></div>
      </div>
    )}
    {variant === 'form' && (
      <div className="skel-card skel-form">
        {[0, 1, 2, 3].map((i) => (
          <span className="skel-field" key={i}><Skeleton w={120} h={11} /><Skeleton h={42} r={12} /></span>
        ))}
        <Skeleton w={150} h={42} r={999} style={{ marginTop: 8 }} />
      </div>
    )}
  </Busy>
);
