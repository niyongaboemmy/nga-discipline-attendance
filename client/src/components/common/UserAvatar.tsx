import React, { useEffect, useState } from 'react';
import { avatarSrc, initialsOf, type MisAvatar } from '../../utils/avatar';

interface UserAvatarProps {
  name: string;
  /** The central NGA MIS picture; initials when absent (or if it fails to load). */
  avatar?: MisAvatar | null;
  /** Drawn size in px, used to pick the rendition. */
  px?: number;
  /** Design-system classes, e.g. "avatar avatar-sm" or "hero-avatar". */
  className?: string;
}

/** A `.avatar`-styled circle showing the user's NGA profile picture or initials. */
export const UserAvatar: React.FC<UserAvatarProps> = ({ name, avatar, px = 28, className = 'avatar avatar-sm' }) => {
  const src = avatarSrc(avatar, px);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);

  if (src && !failed) {
    return (
      <div className={`${className} avatar--photo`}>
        <img src={src} alt={name} width={px} height={px} loading="lazy" decoding="async" onError={() => setFailed(true)} />
      </div>
    );
  }
  return (
    <div className={className} role="img" aria-label={name}>
      {initialsOf(name)}
    </div>
  );
};
