import { asPng, generatedAt, save } from '../dayReportExport';
import type { Kpi, ReportTable, Tone } from './reportsModel';

/**
 * The Reports page's documents as files: PDF (jsPDF + autotable) and Excel
 * (exceljs). Every file is headed with the school's documents logo and name, the
 * report's title and the period. Both libraries load only when someone downloads.
 */

export interface ExportMeta {
  school: string;
  /** a data URL of the school's documents logo, or null */
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
type Loose = { [k: string]: unknown; default?: Loose & ((...a: unknown[]) => unknown) };
type Doc = import('jspdf').jsPDF;
type AutoTable = (doc: unknown, opts: Record<string, unknown>) => void;

async function pdfKit(): Promise<{ jsPDF: typeof import('jspdf').jsPDF; autoTable: AutoTable }> {
  const [pdfMod, tableMod] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  // Either module may arrive as ESM or as a CommonJS wrapper, depending on the build.
  const pm = pdfMod as unknown as Loose;
  const jsPDF = (pm.jsPDF ?? (pm.default as Loose | undefined)?.jsPDF ?? pm.default) as typeof import('jspdf').jsPDF;
  const tm = tableMod as unknown as Loose;
  const autoTable = [tm.default, tm.autoTable, (tm.default as Loose | undefined)?.default, (tm.default as Loose | undefined)?.autoTable].find((f) => typeof f === 'function') as AutoTable;
  return { jsPDF, autoTable };
}

const M = 40;

/** Logo, school, title, period: returns the y where the content starts. */
function pdfHeader(doc: Doc, logo: Logo, meta: ExportMeta, title: string, sub: string): number {
  const W = doc.internal.pageSize.getWidth();
  let x = M;
  if (logo) {
    const h = 46;
    const w = Math.min(120, (logo.w / logo.h) * h);
    doc.addImage(logo.data, 'PNG', M, 34, w, h);
    x = M + w + 14;
  }
  doc.setFont('helvetica', 'bold').setFontSize(15).setTextColor(17, 24, 39).text(meta.school, x, 50);
  doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(37, 99, 235).text(`Staff attendance · ${title}`, x, 66);
  doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(75, 85, 99).text(`${meta.period}${meta.live ? ' (today is still in progress)' : ''}`, x, 80);
  if (sub) doc.setFontSize(9).setTextColor(107, 114, 128).text(sub, W - M, 80, { align: 'right' });
  doc.setDrawColor(229, 231, 235).line(M, 94, W - M, 94);
  return 112;
}

function pdfFooter(doc: Doc): void {
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    const W = doc.internal.pageSize.getWidth();
    const H = doc.internal.pageSize.getHeight();
    doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(156, 163, 175);
    doc.text(`Generated ${generatedAt()} · Tendo · Amashuri`, M, H - 24);
    doc.text(`Page ${i} of ${pages}`, W - M, H - 24, { align: 'right' });
  }
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

function pdfTable(doc: Doc, autoTable: AutoTable, table: ReportTable, startY: number): void {
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
    margin: { left: M, right: M, bottom: 48, top: 40 },
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

/** One report as a PDF. Wide reports are printed across the page. */
export async function downloadReportPdf(table: ReportTable, meta: ExportMeta, stem: string): Promise<void> {
  const [{ jsPDF, autoTable }, logo] = await Promise.all([pdfKit(), asPng(meta.logo)]);
  const doc = new jsPDF({ orientation: table.columns.length > 7 ? 'landscape' : 'portrait', unit: 'pt', format: 'a4' });
  let y = pdfHeader(doc, logo, meta, table.title, table.rows.length ? table.countText : '');
  doc.setFont('helvetica', 'italic').setFontSize(9.5).setTextColor(107, 114, 128).text(table.question, M, y);
  y = pdfFacts(doc, table.facts, y + 14);
  pdfTable(doc, autoTable, table, y);
  pdfFooter(doc);
  save(doc.output('blob'), `${stem}.pdf`);
}

/** The headline numbers as a one-page brief: a card per number, then the day-by-day table. */
export async function downloadSummaryPdf(kpis: Kpi[], daily: ReportTable, meta: ExportMeta, stem: string, context: string): Promise<void> {
  const [{ jsPDF, autoTable }, logo] = await Promise.all([pdfKit(), asPng(meta.logo)]);
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  let y = pdfHeader(doc, logo, meta, 'Summary', context);
  if (meta.compared) { doc.setFont('helvetica', 'italic').setFontSize(9.5).setTextColor(107, 114, 128).text(meta.compared, M, y); y += 16; }
  const perRow = 2;
  const gap = 12;
  const cw = (W - 2 * M - gap * (perRow - 1)) / perRow;
  const ch = 62;
  kpis.forEach((k, i) => {
    const cx = M + (i % perRow) * (cw + gap);
    const cy = y + Math.floor(i / perRow) * (ch + gap);
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
  y += Math.ceil(kpis.length / perRow) * (ch + gap) + 10;
  if (daily.rows.length > 1) {
    if (y > doc.internal.pageSize.getHeight() - 160) { doc.addPage(); y = 56; }
    doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(17, 24, 39).text('Day by day', M, y);
    pdfTable(doc, autoTable, daily, y + 10);
  }
  pdfFooter(doc);
  save(doc.output('blob'), `${stem}.pdf`);
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
