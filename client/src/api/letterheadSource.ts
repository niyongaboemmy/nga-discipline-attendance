import { setLetterheadSource, type LetterheadSource } from '../utils/documentLetterhead.ts';

/**
 * Ties the document letterhead (utils/documentLetterhead.ts) to Tendo: the signed-in
 * school's header and footer come from GET /api/sso/branding -- the same MIS
 * `/tenant/branding` reading the staff reports' documents logo comes from. The images
 * themselves are public MIS addresses the browser reads directly. Imported once, from main.tsx.
 */

/** What /api/sso/branding sends -> what the letterhead reads (missing fields: an older MIS). */
export function letterheadSourceOf(d: unknown): LetterheadSource | null {
  if (!d || typeof d !== 'object') return null;
  const b = d as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  return {
    schoolName: text(b.name),
    headerUrl: text(b.documentsLogoUrl),
    fallbackLogoUrl: text(b.logoUrl),
    footerUrl: text(b.documentsFooterUrl),
    footerText: text(b.documentsFooterText),
  };
}

setLetterheadSource(async () => {
  const token = localStorage.getItem('sso_token');
  if (!token) return null;
  const res = await fetch('/api/sso/branding', { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  return letterheadSourceOf((await res.json())?.data);
});
