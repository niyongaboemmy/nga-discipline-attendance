import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_LETTERHEAD, footerLinesOf, letterheadFrame, letterheadLayout, stampLetterhead, type Letterhead, type PdfDoc,
} from '../src/utils/documentLetterhead.ts';
import { letterheadSourceOf } from '../src/api/letterheadSource.ts';
import { buildDayPdf, pdfKit, type DayExportMeta, type DayExportRow, type PdfKit } from '../src/pages/staffClock/dayReportExport.ts';
import { buildReportPdf, buildSummaryPdf, type ExportMeta } from '../src/pages/staffClock/reports/reportsExport.ts';
import type { Kpi, ReportTable } from '../src/pages/staffClock/reports/reportsModel.ts';
import { sheetContentHeightMm } from '../src/pages/staffClock/sheetPage.ts';

// A 1x1 PNG: enough for jsPDF to place an image. The sizes are the letterhead's own.
const PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const FULL: Letterhead = {
  schoolName: 'Example School',
  header: { dataUrl: PX, width: 248, height: 108 },
  footer: { dataUrl: PX, width: 1245, height: 159 },
  footerLines: ['PO Box 1, Example Town', 'office@example.test'],
};
const PT = 72 / 25.4;

test('layout: the room the letterhead takes from a page', () => {
  // Nothing set: a plain top margin and room for the page-number line only.
  assert.deepEqual(letterheadLayout(EMPTY_LETTERHEAD, 210), { topMm: 12, bottomMm: 14, sideMm: 14, headerMm: 0, footerImageWidthMm: 0, footerImageHeightMm: 0, showHeader: true });
  // Name only: a 6mm name line.
  assert.equal(letterheadLayout({ ...EMPTY_LETTERHEAD, schoolName: 'Example School' }, 210).topMm, 16);
  // Logo + footer strip + 2 lines on A4 upright: the strip would be 23.24mm tall across the
  // 182mm between the margins, so it is held at 22mm and narrowed to keep its shape.
  const l = letterheadLayout(FULL, 210);
  assert.equal(l.topMm, 23);
  assert.deepEqual([l.footerImageHeightMm, l.footerImageWidthMm], [22, 172.26]);
  // Across the page (297mm) it is wider still, so the same cap applies.
  assert.equal(letterheadLayout(FULL, 297).footerImageHeightMm, 22);
  // A flatter strip fills the width.
  assert.deepEqual(((x) => [x.footerImageWidthMm, x.footerImageHeightMm])(letterheadLayout({ ...FULL, footer: { dataUrl: PX, width: 1820, height: 100 } }, 210)), [182, 10]);
  assert.equal(l.bottomMm, Math.round((6 + 4 + (22 + 7.2 + 1) + 1 + 4) * 100) / 100);
  // A tall footer image is capped at 22mm and keeps its shape.
  const tall = letterheadLayout({ ...FULL, footer: { dataUrl: PX, width: 400, height: 200 }, footerLines: [] }, 210);
  assert.deepEqual([tall.footerImageHeightMm, tall.footerImageWidthMm], [22, 44]);
  // header: false leaves the top alone; the footer is still reserved.
  const bare = letterheadLayout(FULL, 210, { header: false });
  assert.deepEqual([bare.topMm, bare.showHeader, bare.bottomMm], [12, false, l.bottomMm]);
  // At most 4 footer lines, blank ones dropped.
  assert.deepEqual(footerLinesOf(' a \n\n b \r\n c \n d \n e '), ['a', 'b', 'c', 'd']);
  assert.deepEqual(footerLinesOf(null), []);
});

test('frame and stamp work in the document\'s own unit (a fake jsPDF in points)', () => {
  const calls: Array<{ page: number; kind: string; args: unknown[] }> = [];
  let page = 1;
  const doc: PdfDoc = {
    internal: { scaleFactor: 1, pageSize: { getWidth: () => 595.28, getHeight: () => 841.89 } },
    getNumberOfPages: () => 3,
    setPage: (n) => { page = n; },
    addImage: (...args) => { calls.push({ page, kind: 'image', args }); },
    text: (...args) => { calls.push({ page, kind: 'text', args }); },
    setFont: () => undefined, setFontSize: () => undefined, setTextColor: () => undefined,
  };
  const f = letterheadFrame(doc, FULL);
  assert.ok(Math.abs(f.top - 23 * PT) < 0.01);
  assert.ok(Math.abs(f.pageBottom - (841.89 - f.bottom)) < 0.01);
  assert.equal(f.shift(40), f.top - 40);
  assert.equal(f.shift(500), 0);
  stampLetterhead(doc, FULL, { note: 'A note' });
  for (const p of [1, 2, 3]) {
    const mine = calls.filter((c) => c.page === p);
    const images = mine.filter((c) => c.kind === 'image');
    assert.deepEqual(images.map((c) => c.args[6]), ['lh-header', 'lh-footer']);
    // The header ends above the frame's top; the footer starts below its bottom.
    const [, , , hy, , hh] = images[0].args as number[];
    assert.ok(hy + hh <= f.top);
    const [, , , fy] = images[1].args as number[];
    assert.ok(fy >= f.pageBottom);
    const texts = mine.filter((c) => c.kind === 'text').map((c) => c.args[0]);
    assert.deepEqual(texts, ['A note', `Page ${p} of 3`, 'office@example.test', 'PO Box 1, Example Town']);
  }
});

test('the app\'s branding answer becomes the letterhead\'s source (an older MIS has no footer)', () => {
  assert.deepEqual(letterheadSourceOf({ tid: 2, name: 'Example School', logoUrl: 'https://mis.test/l/primary', documentsLogoUrl: 'https://mis.test/l/documents', documentsFooterUrl: 'https://mis.test/l/footer', documentsFooterText: 'One\nTwo' }),
    { schoolName: 'Example School', headerUrl: 'https://mis.test/l/documents', fallbackLogoUrl: 'https://mis.test/l/primary', footerUrl: 'https://mis.test/l/footer', footerText: 'One\nTwo' });
  assert.deepEqual(letterheadSourceOf({ tid: 2, name: 'Example School', logoUrl: null }),
    { schoolName: 'Example School', headerUrl: null, fallbackLogoUrl: null, footerUrl: null, footerText: null });
  assert.equal(letterheadSourceOf(null), null);
});

// ---- the converted generators, with the real jsPDF ---------------------------------------

interface Seen { page: number; kind: 'image' | 'text'; alias?: string; text?: string; y: number; h?: number }

/** The real jsPDF, with every image and text it is asked to draw written down. */
async function spyKit(): Promise<{ kit: PdfKit; seen: Seen[] }> {
  const real = await pdfKit();
  const seen: Seen[] = [];
  const Spy = function (opts: unknown) {
    const doc = new real.jsPDF(opts as never) as unknown as Record<string, (...a: never[]) => unknown> & { getCurrentPageInfo(): { pageNumber: number } };
    const image = doc.addImage.bind(doc);
    const text = doc.text.bind(doc);
    doc.addImage = (...a: never[]) => { const n = a as unknown as [string, string, number, number, number, number, string]; seen.push({ page: doc.getCurrentPageInfo().pageNumber, kind: 'image', alias: n[6], y: n[3], h: n[5] }); return image(...a); };
    doc.text = (...a: never[]) => { const n = a as unknown as [string | string[], number, number]; seen.push({ page: doc.getCurrentPageInfo().pageNumber, kind: 'text', text: ([] as string[]).concat(n[0]).join(' '), y: n[2] }); return text(...a); };
    return doc;
  } as unknown as PdfKit['jsPDF'];
  return { kit: { jsPDF: Spy, autoTable: real.autoTable }, seen };
}

/** Every page has the header and the footer, and nothing else is drawn over them. */
function assertFramed(doc: import('jspdf').jsPDF, seen: Seen[], lh: Letterhead, sideMm: number, minPages: number) {
  const pages = doc.getNumberOfPages();
  assert.ok(pages >= minPages, `expected at least ${minPages} pages, got ${pages}`);
  const f = letterheadFrame(doc as unknown as PdfDoc, lh, { sideMm });
  const footerText = (t: string) => /^Page \d+ of \d+$/.test(t) || t.startsWith('Generated ') || lh.footerLines.includes(t);
  for (let p = 1; p <= pages; p++) {
    const mine = seen.filter((s) => s.page === p);
    assert.deepEqual(mine.filter((s) => s.kind === 'image').map((s) => s.alias), ['lh-header', 'lh-footer'], `page ${p}: header and footer images`);
    assert.ok(mine.some((s) => s.text === `Page ${p} of ${pages}`), `page ${p}: page number`);
    for (const s of mine) {
      if (s.kind === 'image') continue;
      if (footerText(s.text!)) assert.ok(s.y > f.pageBottom, `page ${p}: "${s.text}" belongs in the footer`);
      else assert.ok(s.y >= f.top && s.y <= f.pageBottom, `page ${p}: "${s.text}" at y=${s.y} is outside ${f.top}..${f.pageBottom}`);
    }
    const header = mine.find((s) => s.alias === 'lh-header')!;
    const footer = mine.find((s) => s.alias === 'lh-footer')!;
    assert.ok(header.y + header.h! <= f.top);
    assert.ok(footer.y >= f.pageBottom);
  }
}

const SIDE_MM = (40 * 25.4) / 72;
const dayMeta: DayExportMeta = { school: 'Example School', logo: null, dateLabel: 'Thursday, 26 November 2026', filterLabel: 'Everyone', isToday: false, counts: { onTime: 80, late: 30, absent: 10, staff: 120 }, fileStem: 'staff-attendance-2026-11-26' };
const dayRows: DayExportRow[] = Array.from({ length: 120 }, (_, i) => ({ name: `Staff member ${i + 1}`, role: 'Teacher', status: i % 4 === 0 ? 'Late' : 'On time', tone: i % 4 === 0 ? 'late' : 'on', checkIn: '07:45', checkOut: '16:30', hours: '8 h 45 min', how: 'Phone' }));

test('day report PDF: header and footer on every page, the table between them', async () => {
  const { kit, seen } = await spyKit();
  const doc = buildDayPdf(kit, dayRows, dayMeta, FULL);
  assertFramed(doc, seen, FULL, SIDE_MM, 3);
  assert.ok(seen.some((s) => s.text === 'Staff attendance report' && s.page === 1));
  assert.ok(seen.some((s) => s.text === 'Staff member 120'));
});

test('day report PDF without a letterhead: page numbers only, nothing thrown', async () => {
  const { kit, seen } = await spyKit();
  const doc = buildDayPdf(kit, dayRows.slice(0, 5), dayMeta, EMPTY_LETTERHEAD);
  assert.equal(doc.getNumberOfPages(), 1);
  assert.equal(seen.filter((s) => s.kind === 'image').length, 0);
  assert.ok(seen.some((s) => s.text === 'Page 1 of 1'));
});

const table = (cols: number, rows: number): ReportTable => ({
  id: 'late', title: 'Late arrivals', question: 'Who came late, and how often?', countText: `${rows} staff`, empty: 'Nobody was late.',
  facts: [{ label: 'Late arrivals', value: '42', tone: 'late' }, { label: 'Most often', value: 'Staff member 3' }],
  columns: Array.from({ length: cols }, (_, c) => ({ key: `c${c}`, label: `Column ${c + 1}`, width: 12 })),
  rows: Array.from({ length: rows }, (_, r) => ({ cells: Object.fromEntries(Array.from({ length: cols }, (_, c) => [`c${c}`, `r${r + 1}c${c + 1}`])) })),
} as unknown as ReportTable);
const meta: ExportMeta = { school: 'Example School', logo: null, period: '23 Nov 2026 to 26 Nov 2026', compared: 'Compared with 19 Nov 2026 to 22 Nov 2026', live: false };

test('report PDFs (upright and across the page) and the summary keep to the frame', async () => {
  for (const cols of [5, 9]) {
    const { kit, seen } = await spyKit();
    const doc = buildReportPdf(kit, table(cols, 150), meta, FULL);
    assert.equal(doc.internal.pageSize.getWidth() > doc.internal.pageSize.getHeight(), cols > 7);
    assertFramed(doc, seen, FULL, SIDE_MM, 3);
  }
  const { kit, seen } = await spyKit();
  const kpis = Array.from({ length: 16 }, (_, i) => ({ id: `k${i}`, label: `Number ${i + 1}`, value: `${i + 1}%`, detail: 'of school days' })) as unknown as Kpi[];
  const doc = buildSummaryPdf(kit, kpis, table(5, 60), meta, '120 staff · 4 school days', FULL);
  // 16 cards do not fit above the footer on one page: they carry on under the next header.
  assertFramed(doc, seen, FULL, SIDE_MM, 2);
  assert.ok(seen.some((s) => s.text === 'Day by day'));
});

test('poster: one A4 sheet, as tall as the room between the header and the footer', () => {
  assert.equal(sheetContentHeightMm(FULL, false), 277);
  assert.equal(sheetContentHeightMm(EMPTY_LETTERHEAD, true), 297 - 12 - 14 - 1);
  const l = letterheadLayout(FULL, 210, { sideMm: 10 });
  assert.ok(sheetContentHeightMm(FULL, true) + l.topMm + l.bottomMm <= 297);
});
