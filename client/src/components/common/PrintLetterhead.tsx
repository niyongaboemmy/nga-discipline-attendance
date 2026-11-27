import { useEffect, useState } from "react";
import {
  EDGE_MM,
  FOOTER_TEXT_LINE_MM,
  GAP_MM,
  HEADER_LOGO_MAX_WIDTH_MM,
  HEADER_LOGO_MM,
  type Letterhead,
  currentLetterhead,
  letterheadLayout,
  loadLetterhead,
} from "../../utils/documentLetterhead.ts";

/**
 * The school's letterhead on a page that is printed with window.print().
 *
 * It renders nothing on screen and does not touch the page's layout: it only adds an @page
 * rule. The header and footer go into the paper's margins (CSS page-margin boxes), so they
 * repeat on every sheet and the content can never run under them. Drop it anywhere in a
 * component that has a Print button:
 *
 *   <PrintLetterhead note="Mentorship session log" />
 *
 * Page-margin boxes are printed by Chromium 131+ (Chrome, Edge, the Windows desktop app).
 * Other browsers print the page as before, without the letterhead.
 */

/** A string inside CSS `content: "..."` (line breaks become \A). */
export const cssString = (s: string): string =>
  `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\A ")}"`;

export const supportsMarginBoxes = (): boolean => {
  if (typeof navigator === "undefined") return false;
  const m = /(?:Chrome|Chromium|Edg)\/(\d+)/.exec(navigator.userAgent);
  return !!m && Number(m[1]) >= 131;
};

export interface PrintLetterheadOptions {
  /** Small text on the last footer line, before the page number (the document's name). */
  note?: string;
  /** Printed paper width in mm (210 portrait, 297 landscape): sizes the footer image. */
  pageWidthMm?: number;
  /** The page's side margin in mm; used to size the footer image. */
  sideMm?: number;
}

/** The @page rule for a letterhead (pure: unit-tested). Empty when there is nothing to print. */
export function printLetterheadCss(lh: Letterhead, opts: PrintLetterheadOptions = {}): string {
  const { note, pageWidthMm = 210, sideMm = 14 } = opts;
  const l = letterheadLayout(lh, pageWidthMm, { sideMm });
  const boxes: string[] = [];

  if (lh.header) {
    boxes.push(
      `@top-left { content: ""; width: ${HEADER_LOGO_MAX_WIDTH_MM}mm; background: url("${lh.header.dataUrl}") no-repeat left ${EDGE_MM}mm / auto ${HEADER_LOGO_MM}mm; }`,
    );
  } else if (lh.schoolName) {
    boxes.push(
      `@top-left { content: ${cssString(lh.schoolName)}; font: 700 11pt Arial, Helvetica, sans-serif; color: #1a2333; vertical-align: bottom; padding-bottom: ${GAP_MM}mm; white-space: nowrap; }`,
    );
  }

  // One centred box: the footer image as its background, then the text lines and, last,
  // the note with the page number.
  const pageLine = `${note ? `${note} · ` : ""}Page `;
  const text = [...lh.footerLines, pageLine].join("\n");
  const image =
    lh.footer && l.footerImageHeightMm
      ? ` background: url("${lh.footer.dataUrl}") no-repeat center ${GAP_MM}mm / ${l.footerImageWidthMm}mm ${l.footerImageHeightMm}mm;`
      : "";
  boxes.push(
    `@bottom-center { content: ${cssString(text)} counter(page) " of " counter(pages); white-space: pre; width: 100%; text-align: center; vertical-align: bottom; padding-bottom: ${EDGE_MM - 1}mm; font: 7.5pt/${FOOTER_TEXT_LINE_MM}mm Arial, Helvetica, sans-serif; color: #374151;${image} }`,
  );

  return `@media print { @page { margin-top: ${l.topMm}mm; margin-bottom: ${l.bottomMm}mm; ${boxes.join(" ")} } html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }`;
}

export interface PrintLetterheadProps extends PrintLetterheadOptions {
  /** A letterhead to print instead of the signed-in school's (previews, tests). */
  letterhead?: Letterhead;
}

export function PrintLetterhead({ letterhead, ...opts }: PrintLetterheadProps) {
  const [loaded, setLoaded] = useState<Letterhead>(() => letterhead ?? currentLetterhead());
  useEffect(() => {
    if (letterhead) {
      setLoaded(letterhead);
      return;
    }
    let alive = true;
    void loadLetterhead().then((lh) => alive && setLoaded(lh));
    return () => {
      alive = false;
    };
  }, [letterhead]);

  if (!supportsMarginBoxes()) return null;
  return <style data-print-letterhead="">{printLetterheadCss(loaded, opts)}</style>;
}

export default PrintLetterhead;
