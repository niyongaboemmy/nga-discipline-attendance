import React from 'react';

interface HeroBannerProps {
  /** Full display name; the avatar shows its initials. */
  name: string;
  /** Role chip rendered next to the title (e.g. "student"). */
  role: string;
  /** Headline; defaults to a welcome with the first name. */
  title?: string;
  /** Subline content — use <strong> for highlighted figures. */
  children: React.ReactNode;
}

/** Gradient welcome banner used at the top of every dashboard. */
export const HeroBanner: React.FC<HeroBannerProps> = ({ name, role, title, children }) => {
  const initials = name.split(' ').map((p) => p[0]).join('').toUpperCase().slice(0, 2);
  return (
    <section className="hero">
      <div className="hero-avatar">{initials}</div>
      <div style={{ minWidth: 0 }}>
        <div className="hero-title">
          {title || `Welcome back, ${name.split(' ')[0]}!`}
          <span className="hero-chip">{role}</span>
        </div>
        <div className="hero-sub">{children}</div>
      </div>
    </section>
  );
};
