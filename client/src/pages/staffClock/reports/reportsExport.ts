import { PDF_SIDE, PDF_SIDE_MM, asPng, generatedAt, pdfKit, pdfNote, save, type PdfKit } from '../dayReportExport.ts';
import { letterheadFrame, loadLetterhead, stampLetterhead, type Letterhead, type LetterheadFrame } from '../../../utils/documentLetterhead.ts';
import type { Kpi, ReportTable, Tone } from './reportsModel.ts';

/**
 * The Reports page's documents as files: PDF (jsPDF + autotable) and Excel
 * (exceljs). Every PDF carries the school's document letterhead (header and footer on
 * every page), then the report's title and the period; every Excel sheet is headed with
 * the school's documents logo and name. Both libraries load only when someone downloads.
 */

export interface ExportMeta {
  school: string;
  /** a data URL of the school's documents logo (Excel files), or null */
  logo: string | null;
  /** "23 Nov 2026 to 26 Nov 2026" */
  period: string;
  /** "Compared with 19 Nov 2026 to 22 Nov 2026", or '' */
  compared: string;
  /** the period includes today, whose numbers still move */
  live: boolean;
}

const TONE_RGB: Record<Tone, [number, number, number]> = { on: [37, 99, 235], late: [217, 119, 6], abs: [220, 38, 38], off: [100, 116, 139] };
const TONE_ARGB: Record<Tone, string> = { on: 'FF2563EB', late: 'FFD97706', abs: 'FFDC2626', off: 'FF64748B' };
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type Logo = Awaited<ReturnType<typeof asPng>>;
type Doc = import('jspdf').jsPDF;
type AutoTable = PdfKit['autoTable'];

const M = PDF_SIDE;
const LH = { sideMm: PDF_SIDE_MM };

/** The title block under the school's header: returns the y where the content starts. */
function pdfTitle(doc: Doc, f: LetterheadFrame, meta: ExportMeta, title: string, sub: string): number {
  const W = doc.internal.pageSize.getWidth();
  const y0 = f.top;
  doc.setFont('helvetica', 'bold').setFontSize(15).setTextColor(17, 24, 39).text(`Staff attendance · ${title}`, M, y0 + 14);
  doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(75, 85, 99).text(`${meta.school} · ${meta.period}${meta.live ? ' (today is still in progress)' : ''}`, M, y0 + 30);
  if (sub) doc.setFontSize(9).setTextColor(107, 114, 128).text(sub, W - M, y0 + 14, { align: 'right' });
  doc.setDrawColor(229, 231, 235).line(M, y0 + 42, W - M, y0 + 42);
  return y0 + 60;
}

/** The short facts as a row of number + label; returns the y below them. */
function pdfFacts(doc: Doc, facts: ReportTable['facts'], y: number): number {
  if (!facts.length) return y;
  const W = doc.internal.pageSize.getWidth();
  const cw = (W - 2 * M) / facts.length;
  facts.forEach((f, i) => {
    const cx = M + i * cw;
    const rgb = f.tone ? TONE_RGB[f.tone] : ([17, 24, 39] as [number, number, number]);
    // A long value (a name) is printed smaller so it stays in its share of the line.
    const size = f.value.length > 14 ? 10 : 16;
    doc.setFont('helvetica', 'bold').setFontSize(size).setTextColor(...rgb).text(doc.splitTextToSize(f.value, cw - 10)[0] as string, cx, y + 14);
    doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(107, 114, 128).text(f.label, cx, y + 28);
  });
  return y + 46;
}

function pdfTable(doc: Doc, autoTable: AutoTable, f: LetterheadFrame, table: ReportTable, startY: number): void {
  const W = doc.internal.pageSize.getWidth() - 2 * M;
  const total = table.columns.reduce((a, c) => a + c.width, 0);
  const columnStyles: Record<number, Record<string, unknown>> = {};
  table.columns.forEach((c, i) => { columnStyles[i] = { cellWidth: (c.width / total) * W, halign: c.align ?? 'left' }; });
  if (!table.rows.length) {
    doc.setFont('helvetica', 'normal').setFontSize(11).setTextColor(107, 114, 128).text(table.empty, M, startY + 16);
    return;
  }
  autoTable(doc, {
    startY,
    // The table stays between the school's header and footer on every page it runs to.
    margin: { left: M, right: M, top: f.top, bottom: f.bottom },
    head: [table.columns.map((c) => c.label)],
    body: table.rows.map((r) => table.columns.map((c) => String(r.cells[c.key] ?? ''))),
    styles: { font: 'helvetica', fontSize: table.columns.length > 9 ? 7.5 : 8.5, cellPadding: 4, textColor: [31, 41, 55], lineColor: [229, 231, 235], lineWidth: 0.5, overflow: 'linebreak' },
    headStyles: { fillColor: [37, 99, 235], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles,
    didParseCell: (d: { section: string; column: { index: number }; row: { index: number }; cell: { styles: { textColor: unknown; fontStyle: string; halign: string } } }) => {
      const c = table.columns[d.column.index];
      if (d.section === 'head' && c?.align) d.cell.styles.halign = c.align;
      if (d.section === 'body' && c?.toned) {
        const tone = table.rows[d.row.index]?.tone;
        if (tone) { d.cell.styles.textColor = TONE_RGB[tone]; d.cell.styles.fontStyle = 'bold'; }
      }
    },
  });
}

/** One report as a jsPDF document. Wide reports are printed across the page. */
export function buildReportPdf({ jsPDF, autoTable }: PdfKit, table: ReportTable, meta: ExportMeta, lh: Letterhead): Doc {
  const doc = new jsPDF({ orientation: table.columns.length > 7 ? 'landscape' : 'portrait', unit: 'pt', format: 'a4' });
  const f = letterheadFrame(doc, lh, LH);
  let y = pdfTitle(doc, f, meta, table.title, table.rows.length ? table.countText : '');
  doc.setFont('helvetica', 'italic').setFontSize(9.5).setTextColor(107, 114, 128).text(table.question, M, y);
  y = pdfFacts(doc, table.facts, y + 14);
  pdfTable(doc, autoTable, f, table, y);
  stampLetterhead(doc, lh, { ...LH, note: pdfNote() });
  return doc;
}

export async function downloadReportPdf(table: ReportTable, meta: ExportMeta, stem: string): Promise<void> {
  const [kit, lh] = await Promise.all([pdfKit(), loadLetterhead()]);
  save(buildReportPdf(kit, table, meta, lh).output('blob'), `${stem}.pdf`);
}

/** The headline numbers as a brief: a card per number, then the day-by-day table. */
export function buildSummaryPdf({ jsPDF, autoTable }: PdfKit, kpis: Kpi[], daily: ReportTable, meta: ExportMeta, context: string, lh: Letterhead): Doc {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const f = letterheadFrame(doc, lh, LH);
  let y = pdfTitle(doc, f, meta, 'Summary', context);
  if (meta.compared) { doc.setFont('helvetica', 'italic').setFontSize(9.5).setTextColor(107, 114, 128).text(meta.compared, M, y); y += 16; }
  const perRow = 2;
  const gap = 12;
  const cw = (W - 2 * M - gap * (perRow - 1)) / perRow;
  const ch = 62;
  kpis.forEach((k, i) => {
    // A row of cards that would reach the footer starts the next page.
    if (i % perRow === 0 && i > 0) y += ch + gap;
    if (i % perRow === 0 && y + ch > f.pageBottom) { doc.addPage(); y = f.top; }
    const cx = M + (i % perRow) * (cw + gap);
    const cy = y;
    doc.setDrawColor(229, 231, 235).setFillColor(248, 250, 252).roundedRect(cx, cy, cw, ch, 10, 10, 'FD');
    doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(107, 114, 128).text(k.label, cx + 14, cy + 18);
    const rgb = k.tone ? TONE_RGB[k.tone] : ([17, 24, 39] as [number, number, number]);
    doc.setFont('helvetica', 'bold').setFontSize(20).setTextColor(...rgb).text(k.value, cx + 14, cy + 42);
    const vw = doc.getTextWidth(k.value);
    doc.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(75, 85, 99).text(doc.splitTextToSize(k.detail, cw - vw - 40)[0] as string, cx + 24 + vw, cy + 41);
    if (k.change) {
      const c: [number, number, number] = k.change.good == null ? [107, 114, 128] : k.change.good ? [37, 99, 235] : [220, 38, 38];
      doc.setFont('helvetica', 'bold').setFontSize(8.5).setTextColor(...c).text(k.change.text, cx + cw - 14, cy + 18, { align: 'right' });
    }
  });
  if (kpis.length) y += ch + gap;
  y += 10;
  if (daily.rows.length > 1) {
    // The heading needs room for itself and a few rows before the footer.
    if (y > f.pageBottom - 90) { doc.addPage(); y = f.top + 12; }
    doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(17, 24, 39).text('Day by day', M, y);
    pdfTable(doc, autoTable, f, daily, y + 10);
  }
  stampLetterhead(doc, lh, { ...LH, note: pdfNote() });
  return doc;
}

export async function downloadSummaryPdf(kpis: Kpi[], daily: ReportTable, meta: ExportMeta, stem: string, context: string): Promise<void> {
  const [kit, lh] = await Promise.all([pdfKit(), loadLetterhead()]);
  save(buildSummaryPdf(kit, kpis, daily, meta, context, lh).output('blob'), `${stem}.pdf`);
}

// ---- Excel ------------------------------------------------------------------------------

type Workbook = import('exceljs').Workbook;

async function workbook(): Promise<Workbook> {
  const xlMod = await import('exceljs');
  // exceljs is CommonJS: its API sits on `default` once bundled.
  const ExcelJS = ((xlMod as unknown as { default?: typeof xlMod }).default ?? xlMod) as typeof import('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Tendo';
  wb.created = new Date();
  return wb;
}

const HEAD_ROW = 7;
/** Sheet names: 31 characters at most, none of \ / ? * [ ] : */
const sheetName = (title: string) => title.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31);

function addSheet(wb: Workbook, table: ReportTable, meta: ExportMeta, logo: Logo): void {
  const ws = wb.addWorksheet(sheetName(table.title), {
    views: [{ state: 'frozen', ySplit: HEAD_ROW }],
    pageSetup: { orientation: table.columns.length > 7 ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
  });
  ws.columns = table.columns.map((c) => ({ key: c.key, width: c.width + 2 }));
  // Header block: logo over the first column, the text beside it.
  const textCol = logo ? 2 : 1;
  if (logo) {
    const id = wb.addImage({ base64: logo.data, extension: 'png' });
    const h = 64;
    ws.addImage(id, { tl: { col: 0, row: 0 }, ext: { width: Math.min(150, Math.round((logo.w / logo.h) * h)), height: h } });
  }
  const line = (row: number, text: string, font: Record<string, unknown>) => { const c = ws.getCell(row, textCol); c.value = text; c.font = font; };
  line(1, meta.school, { bold: true, size: 15 });
  line(2, `Staff attendance · ${table.title}`, { bold: true, size: 11, color: { argb: 'FF2563EB' } });
  line(3, `${meta.period}${meta.live ? ' (today is still in progress)' : ''}`, { size: 10, color: { argb: 'FF4B5563' } });
  line(4, table.question, { italic: true, size: 10, color: { argb: 'FF6B7280' } });
  line(5, [...table.facts.map((f) => `${f.label}: ${f.value}`), `generated ${generatedAt()}`].join('   ·   '), { size: 9, color: { argb: 'FF6B7280' } });
  for (let r = 1; r <= 5; r++) ws.getRow(r).height = 18;
  const head = ws.getRow(HEAD_ROW);
  head.values = table.columns.map((c) => c.label);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.height = 22;
  head.eachCell((c, i) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    c.alignment = { vertical: 'middle', horizontal: table.columns[i - 1]?.align ?? 'left', wrapText: true };
  });
  table.rows.forEach((r, i) => {
    const row = ws.addRow(table.columns.map((c) => r.cells[c.key] ?? ''));
    table.columns.forEach((c, k) => {
      const cell = row.getCell(k + 1);
      if (c.align) cell.alignment = { horizontal: c.align };
      if (c.toned && r.tone) cell.font = { bold: true, color: { argb: TONE_ARGB[r.tone] } };
      if (i % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
    });
  });
  if (!table.rows.length) ws.getCell(HEAD_ROW + 1, 1).value = table.empty;
  else ws.autoFilter = { from: { row: HEAD_ROW, column: 1 }, to: { row: HEAD_ROW + table.rows.length, column: table.columns.length } };
}

/** One report, or several as the sheets of one workbook. */
export async function downloadReportsXlsx(tables: ReportTable[], meta: ExportMeta, stem: string): Promise<void> {
  const [wb, logo] = await Promise.all([workbook(), asPng(meta.logo)]);
  for (const t of tables) addSheet(wb, t, meta, logo);
  const buf = await wb.xlsx.writeBuffer();
  save(new Blob([buf], { type: XLSX_TYPE }), `${stem}.xlsx`);
}
