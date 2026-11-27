import { letterheadLayout, type Letterhead } from '../../utils/documentLetterhead.ts';

/**
 * The paper of the staff clock's print sheets (poster, QR cards): A4 upright, 10mm margins.
 * Rendered in a <style> by the page that prints, before its <PrintLetterhead>, so the rule
 * exists only while that page is open and the school's letterhead can widen the top and
 * bottom margins after it.
 */
export const SC_SHEET_SIDE_MM = 10;
export const SC_SHEET_PAGE_CSS = `@media print { @page { size: A4; margin: ${SC_SHEET_SIDE_MM}mm; } }`;

/** The height left for one A4 sheet's content (mm): under the letterhead when it is printed. */
export function sheetContentHeightMm(lh: Letterhead, letterheadPrinted: boolean): number {
  if (!letterheadPrinted) return 297 - 2 * SC_SHEET_SIDE_MM;
  const l = letterheadLayout(lh, 210, { sideMm: SC_SHEET_SIDE_MM });
  // 1mm spare, so a rounding never sends the last line to a second sheet.
  return Math.floor(297 - l.topMm - l.bottomMm - 1);
}
