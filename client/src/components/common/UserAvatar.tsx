import React, { useEffect, useState } from 'react';
import { avatarSrc, initialsOf, type MisAvatar } from '../../utils/avatar';
import { useMisAvatar } from '../../utils/avatarDirectory';

interface UserAvatarProps {
  name: string;
  /** The central NGA MIS picture; initials when absent (or if it fails to load). */
  avatar?: MisAvatar | null;
  /** The person's MIS user id: their photo is looked up (batched, cached) when `avatar` isn't given. */
  userId?: string | number | null;
  /** Drawn size in px, used to pick the rendition. */
  px?: number;
  /** Design-system classes, e.g. "avatar avatar-sm" or "hero-avatar". */
  className?: string;
  /** Hidden from screen readers -- for avatars beside a visible name, so it isn't read twice. */
  decorative?: boolean;
}

/** A `.avatar`-styled circle showing the user's NGA profile picture or initials. */
export const UserAvatar: React.FC<UserAvatarProps> = ({ name, avatar, userId, px = 28, className = 'avatar avatar-sm', decorative = false }) => {
  const looked = useMisAvatar(avatar ? null : userId);
  const src = avatarSrc(avatar ?? looked ?? null, px);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);

  if (src && !failed) {
    return (
      <div className={`${className} avatar--photo`}>
        <img src={src} alt={decorative ? '' : name} aria-hidden={decorative || undefined} width={px} height={px} loading="lazy" decoding="async" onError={() => setFailed(true)} />
      </div>
    );
  }
  return (
    <div className={className} {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': name })}>
      {initialsOf(name)}
    </div>
  );
};
