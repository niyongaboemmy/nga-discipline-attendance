/** The central NGA MIS profile picture: signed, versioned URLs in three sizes. */
export interface MisAvatar {
  version: number;
  /** 64 px */
  sm: string;
  /** 256 px */
  md: string;
  /** 512 px */
  lg: string;
}

/** The rendition to load for an avatar drawn at `px` CSS pixels (2x screens included). */
export function avatarSrc(avatar: MisAvatar | null | undefined, px: number): string | null {
  if (!avatar) return null;
  return px <= 32 ? avatar.sm : px <= 128 ? avatar.md : avatar.lg;
}

/**
 * The user with the picture a /verify-mis poll reported, or the same object when
 * nothing changed (so callers can skip a state update). `undefined` = MIS said nothing.
 */
export function withPolledAvatar<U extends { avatar?: MisAvatar | null }>(
  user: U,
  polled: MisAvatar | null | undefined,
): U {
  if (polled === undefined) return user;
  const current = user.avatar ?? null;
  if ((current?.version ?? null) === (polled?.version ?? null) && current?.md === polled?.md) return user;
  return { ...user, avatar: polled };
}

export function initialsOf(name: string): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts.length === 1 ? parts[0][0] : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
