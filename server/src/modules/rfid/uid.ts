/**
 * Card UIDs arrive in whatever shape the reader library prints: "04:a1:b2:c3",
 * "04 A1 B2 C3", "0x04A1B2C3". They are normalised to bare uppercase hex so the
 * same physical card always maps to one `rfid_cards.uid`.
 *
 * 4, 7 and 10 bytes are the ISO 14443 UID sizes (MIFARE / NTAG); 5 bytes covers
 * 125 kHz EM4100 tags. Anything else is treated as a misread, not a card.
 */
const VALID_BYTE_LENGTHS = new Set([4, 5, 7, 10]);

export function normalizeUid(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (/^0x/i.test(s)) s = s.slice(2);
  s = s.replace(/[\s:\-]/g, '').toUpperCase();
  if (!/^[0-9A-F]+$/.test(s) || s.length % 2 !== 0) return null;
  if (!VALID_BYTE_LENGTHS.has(s.length / 2)) return null;
  // An all-zero or all-F UID is what several readers emit on a failed read.
  if (/^0+$/.test(s) || /^F+$/.test(s)) return null;
  return s;
}
