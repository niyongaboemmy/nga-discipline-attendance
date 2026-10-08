import React from 'react';
import { UserAvatar } from './UserAvatar';
import type { MisAvatar } from '../../utils/avatar';

interface HeroBannerProps {
  /** Full display name; the avatar shows its initials. */
  name: string;
  /** Role chip rendered next to the title (e.g. "student"). */
  role: string;
  /** Headline; defaults to a welcome with the first name. */
  title?: string;
  /** Subline content — use <strong> for highlighted figures. */
  children: React.ReactNode;
  /** The user's NGA profile picture; initials when absent. */
  avatar?: MisAvatar | null;
}

/** Gradient welcome banner used at the top of every dashboard. */
export const HeroBanner: React.FC<HeroBannerProps> = ({ name, role, title, children, avatar }) => {
  return (
    <section className="hero">
      <UserAvatar name={name} avatar={avatar} px={48} className="hero-avatar" />
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
