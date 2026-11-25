import { FALLBACK_SCHOOL_NAME, useAuth } from '../context/AuthContext';

/** The current school's name and logo (MIS branding), with the fallback name until it is known. */
export function useSchoolName(): { name: string; logoUrl: string | null } {
  const { school } = useAuth();
  return { name: school?.name || FALLBACK_SCHOOL_NAME, logoUrl: school?.logoUrl ?? null };
}
