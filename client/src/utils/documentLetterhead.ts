/**
 * The document letterhead in the browser: ONE place that puts a school's fixed header and
 * footer on every page of every PDF made here (jsPDF) and of every printed page.
 *
 *   header  the school's Documents logo (falls back to its logo, then its name)
 *   footer  the school's footer image and/or footer text lines, then a small line with the
 *           document's own note and "Page N of M"
 *
 * Both are set per school in Tenants & Schools → Edit school → Document letterhead. The
 * server-side twin (Puppeteer PDFs) is backend/src/services/documents/letterhead.ts; the
 * measurements below are the same on both sides.
 *
 * jsPDF, three steps:
 *
 *   const lh = await loadLetterhead();            // cached; never throws
 *   const f = letterheadFrame(doc, lh);           // f.top / f.bottom / f.pageBottom, in the doc's unit
 *   ...draw from f.top; autoTable({ margin: { top: f.top, bottom: f.bottom } })...
 *   stampLetterhead(doc, lh, { note: "Office hours" });   // last: draws it on every page
 *
 * Generators that cannot wait (they return a jsPDF synchronously) use currentLetterhead():
 * the letterhead is loaded once after sign-in (preloadLetterhead) and kept.
 *
 * Printed pages (window.print): wrap the page in <PrintLetterhead> (components/ui/PrintLetterhead).
 *
 * This file has no dependency on the app: only setLetterheadSource() ties it to an API, so
 * Task Mentor and Tendo carry the same file with their own source.
 */

// ─── Measurements (mm), the same as the server ─────────────────────────────
export const EDGE_MM = 6;
export const HEADER_LOGO_MM = 13;
export const HEADER_LOGO_MAX_WIDTH_MM = 70;
export const HEADER_NAME_MM = 6;
export const FOOTER_IMAGE_MAX_MM = 22;
export const FOOTER_TEXT_LINE_MM = 3.6;
export const PAGE_LINE_MM = 4;
export const GAP_MM = 4;
export const FOOTER_TEXT_MAX_LINES = 4;

export interface LetterheadImage {
  /** PNG data URL (what jsPDF and a print page can both use). */
  dataUrl: string;
  width: number;
  height: number;
}

export interface Letterhead {
  schoolName: string;
  header: LetterheadImage | null;
  footer: LetterheadImage | null;
  footerLines: string[];
}

/** What an app's API says about the school's letterhead (addresses, not pixels). */
export interface LetterheadSource {
  schoolName?: string | null;
  /** The Documents logo; `fallbackLogoUrl` (the school's logo) is used when it is not set. */
  headerUrl?: string | null;
  fallbackLogoUrl?: string | null;
  footerUrl?: string | null;
  footerText?: string | null;
}

export const EMPTY_LETTERHEAD: Letterhead = { schoolName: "", header: null, footer: null, footerLines: [] };

export const footerLinesOf = (text: unknown): string[] =>
  typeof text === "string"
    ? text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, FOOTER_TEXT_MAX_LINES)
    : [];

// ─── Loading ────────────────────────────────────────────────────────────────
let source: (() => Promise<LetterheadSource | null>) | null = null;
let loading: Promise<Letterhead> | null = null;
let current: Letterhead = EMPTY_LETTERHEAD;

/** Tells the letterhead where to read the school's settings from (once, at app start). */
export function setLetterheadSource(fn: () => Promise<LetterheadSource | null>): void {
  source = fn;
  resetLetterhead();
}

/** Forget what was loaded: after a sign-in, a school switch or a change of the letterhead. */
export function resetLetterhead(): void {
  loading = null;
  current = EMPTY_LETTERHEAD;
}

/**
 * An image address as a PNG data URL with its size. Drawn through a canvas so SVG and WEBP
 * work in jsPDF too; huge uploads are brought down to print size. null when it cannot be read.
 */
export async function loadLetterheadImage(url: string | null | undefined, maxWidth = 2400): Promise<LetterheadImage | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) return null;
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("image"));
        el.src = objectUrl;
      });
      const w0 = img.naturalWidth || img.width;
      const h0 = img.naturalHeight || img.height;
      if (!w0 || !h0) return null;
      const scale = Math.min(1, maxWidth / w0);
      const width = Math.max(1, Math.round(w0 * scale));
      const height = Math.max(1, Math.round(h0 * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, width, height);
      return { dataUrl: canvas.toDataURL("image/png"), width, height };
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  } catch {
    return null;
  }
}

/** Builds a letterhead from addresses (exported for tests and for previews). */
export async function letterheadFrom(src: LetterheadSource | null | undefined): Promise<Letterhead> {
  if (!src) return EMPTY_LETTERHEAD;
  const [header, footer] = await Promise.all([
    loadLetterheadImage(src.headerUrl).then((img) => img ?? loadLetterheadImage(src.fallbackLogoUrl)),
    loadLetterheadImage(src.footerUrl),
  ]);
  return { schoolName: (src.schoolName ?? "").trim(), header, footer, footerLines: footerLinesOf(src.footerText) };
}

/**
 * The signed-in school's letterhead. Loaded once and kept; never throws -- a document is
 * still made (with page numbers only) when the letterhead cannot be read.
 */
export function loadLetterhead(force = false): Promise<Letterhead> {
  if (force) resetLetterhead();
  if (!loading) {
    const mine = (loading = (async () => {
      try {
        return await letterheadFrom(source ? await source() : null);
      } catch {
        return EMPTY_LETTERHEAD;
      }
    })());
    void mine.then((lh) => {
      if (loading === mine) current = lh;
      // Nothing came back (signed out, network): try again on the next document.
      if (loading === mine && lh === EMPTY_LETTERHEAD) loading = null;
    });
  }
  return loading;
}

/** Start loading in the background (call after sign-in, so synchronous generators have it). */
export function preloadLetterhead(): void {
  void loadLetterhead();
}

/** The letterhead already loaded (empty until then). For generators that cannot await. */
export const currentLetterhead = (): Letterhead => current;

// ─── Layout ─────────────────────────────────────────────────────────────────
export interface LetterheadOptions {
  /** Left/right margin of the document in mm (the letterhead lines up with it). Default 14. */
  sideMm?: number;
  /** false leaves the header out (a document that draws its own masthead). */
  header?: boolean;
  /** Small text at the right of the header, e.g. the document's title. */
  title?: string;
  /** Small text at the left of the page-number line. */
  note?: string;
  /** false leaves "Page N of M" out. */
  pageNumbers?: boolean;
}

export interface LetterheadLayout {
  topMm: number;
  bottomMm: number;
  sideMm: number;
  headerMm: number;
  footerImageWidthMm: number;
  footerImageHeightMm: number;
  showHeader: boolean;
}

/** What the letterhead takes from a page of `pageWidthMm` (pure: unit-tested). */
export function letterheadLayout(lh: Letterhead, pageWidthMm: number, opts: LetterheadOptions = {}): LetterheadLayout {
  const sideMm = opts.sideMm ?? 14;
  const contentWidthMm = pageWidthMm - 2 * sideMm;
  const showHeader = opts.header !== false;
  const headerMm = !showHeader ? 0 : lh.header ? HEADER_LOGO_MM : lh.schoolName || opts.title ? HEADER_NAME_MM : 0;
  const topMm = headerMm ? EDGE_MM + headerMm + GAP_MM : 12;

  let footerImageWidthMm = 0;
  let footerImageHeightMm = 0;
  if (lh.footer && lh.footer.width > 0 && lh.footer.height > 0) {
    const ratio = lh.footer.width / lh.footer.height;
    footerImageWidthMm = contentWidthMm;
    footerImageHeightMm = contentWidthMm / ratio;
    if (footerImageHeightMm > FOOTER_IMAGE_MAX_MM) {
      footerImageHeightMm = FOOTER_IMAGE_MAX_MM;
      footerImageWidthMm = FOOTER_IMAGE_MAX_MM * ratio;
    }
  }
  const textMm = lh.footerLines.length * FOOTER_TEXT_LINE_MM;
  const bandMm = footerImageHeightMm + textMm + (footerImageHeightMm && textMm ? 1 : 0);
  const bottomMm = EDGE_MM + PAGE_LINE_MM + (bandMm ? bandMm + 1 : 0) + GAP_MM;
  const r = (n: number) => Math.round(n * 100) / 100;
  return { topMm: r(topMm), bottomMm: r(bottomMm), sideMm, headerMm, footerImageWidthMm: r(footerImageWidthMm), footerImageHeightMm: r(footerImageHeightMm), showHeader };
}

// ─── jsPDF ──────────────────────────────────────────────────────────────────
/** The few jsPDF members used here (so this file needs no jsPDF import). */
export interface PdfDoc {
  internal: { scaleFactor: number; pageSize: { getWidth(): number; getHeight(): number } };
  getNumberOfPages(): number;
  setPage(n: number): unknown;
  addImage(...args: any[]): unknown;
  text(text: string | string[], x: number, y: number, options?: any): unknown;
  setFont(name: string, style?: string): unknown;
  setFontSize(size: number): unknown;
  setTextColor(...args: any[]): unknown;
  getFontSize?(): number;
}

const MM_TO_PT = 72 / 25.4;
/** mm → the document's own unit (mm, pt, ...). */
const unitOf = (doc: PdfDoc) => (mm: number) => (mm * MM_TO_PT) / doc.internal.scaleFactor;
const pageWidthMm = (doc: PdfDoc) => (doc.internal.pageSize.getWidth() * doc.internal.scaleFactor) / MM_TO_PT;

export interface LetterheadFrame {
  /** First y the document may draw at. */
  top: number;
  /** Space to keep free at the bottom (autoTable's `margin.bottom`). */
  bottom: number;
  /** Last y the document may draw at (page height − bottom). */
  pageBottom: number;
  /** How far to move content that used to start at `oldTop` (never negative). */
  shift(oldTop: number): number;
}

/** Where a jsPDF document may draw, in the document's own unit. */
export function letterheadFrame(doc: PdfDoc, lh: Letterhead = current, opts: LetterheadOptions = {}): LetterheadFrame {
  const u = unitOf(doc);
  const l = letterheadLayout(lh, pageWidthMm(doc), opts);
  const top = u(l.topMm);
  const bottom = u(l.bottomMm);
  return { top, bottom, pageBottom: doc.internal.pageSize.getHeight() - bottom, shift: (oldTop) => Math.max(0, top - oldTop) };
}

/**
 * Draws the letterhead on every page of a finished jsPDF document. Call it last, after all
 * pages exist (it needs the page count for "Page N of M").
 */
export function stampLetterhead(doc: PdfDoc, lh: Letterhead = current, opts: LetterheadOptions = {}): void {
  const u = unitOf(doc);
  const l = letterheadLayout(lh, pageWidthMm(doc), opts);
  const side = u(l.sideMm);
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    const w = doc.internal.pageSize.getWidth();
    const h = doc.internal.pageSize.getHeight();

    // Header: the mark (or the school's name) at the left, the document title at the right.
    if (l.showHeader) {
      if (lh.header) {
        let ih = u(HEADER_LOGO_MM);
        let iw = (ih * lh.header.width) / lh.header.height;
        const max = u(HEADER_LOGO_MAX_WIDTH_MM);
        if (iw > max) {
          iw = max;
          ih = (iw * lh.header.height) / lh.header.width;
        }
        doc.addImage(lh.header.dataUrl, "PNG", side, u(EDGE_MM) + (u(HEADER_LOGO_MM) - ih) / 2, iw, ih, "lh-header", "FAST");
      } else if (lh.schoolName) {
        doc.setFont("helvetica", "bold");
        doc.setFontSize(11);
        doc.setTextColor(26, 35, 51);
        doc.text(lh.schoolName, side, u(EDGE_MM + HEADER_NAME_MM - 1.5));
      }
      if (opts.title) {
        doc.setFont("helvetica", "normal");
        doc.setFontSize(7.5);
        doc.setTextColor(107, 114, 128);
        doc.text(opts.title, w - side, u(EDGE_MM + (l.headerMm || HEADER_NAME_MM) / 2 + 1), { align: "right" });
      }
    }

    // Footer, from the bottom up: page line, text lines, image.
    let y = h - u(EDGE_MM);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(107, 114, 128);
    if (opts.note) doc.text(opts.note, side, y - u(1));
    if (opts.pageNumbers !== false) doc.text(`Page ${p} of ${pages}`, w - side, y - u(1), { align: "right" });
    y -= u(PAGE_LINE_MM + 1);
    if (lh.footerLines.length) {
      doc.setFontSize(7.5);
      doc.setTextColor(26, 35, 51);
      for (let i = lh.footerLines.length - 1; i >= 0; i--) {
        doc.text(lh.footerLines[i], w / 2, y - u(1), { align: "center" });
        y -= u(FOOTER_TEXT_LINE_MM);
      }
      if (lh.footer) y -= u(1);
    }
    if (lh.footer && l.footerImageHeightMm) {
      const iw = u(l.footerImageWidthMm);
      const ih = u(l.footerImageHeightMm);
      doc.addImage(lh.footer.dataUrl, "PNG", (w - iw) / 2, y - ih, iw, ih, "lh-footer", "FAST");
    }
  }
  // Leave the text state as a generator would expect to find it.
  doc.setTextColor(0, 0, 0);
  doc.setFont("helvetica", "normal");
}
