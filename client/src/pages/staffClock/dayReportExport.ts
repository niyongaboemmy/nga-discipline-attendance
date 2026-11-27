import { letterheadFrame, loadLetterhead, stampLetterhead, type Letterhead } from '../../utils/documentLetterhead.ts';

/**
 * The day report as a document: PDF (jsPDF + autotable) or Excel (exceljs). The PDF
 * carries the school's document letterhead (header and footer on every page); the
 * Excel file is headed with the school's documents logo and name. Both libraries
 * load only when someone downloads.
 */

export interface DayExportMeta {
  school: string;
  /** the documents logo for the Excel file: a data URL (any browser image type) or null */
  logo: string | null;
  /** e.g. "Thursday, 26 November 2026" */
  dateLabel: string;
  /** e.g. "Everyone" or "Late" */
  filterLabel: string;
  isToday: boolean;
  counts: { onTime: number; late: number; absent: number; staff: number };
  /** file name stem, e.g. staff-attendance-2026-11-26 */
  fileStem: string;
}

export interface DayExportRow {
  name: string;
  role: string;
  status: string;
  tone: 'on' | 'late' | 'abs' | 'off';
  checkIn: string;
  checkOut: string;
  hours: string;
  how: string;
}

const TONE_RGB: Record<DayExportRow['tone'], [number, number, number]> = { on: [37, 99, 235], late: [217, 119, 6], abs: [220, 38, 38], off: [100, 116, 139] };
const TONE_ARGB: Record<DayExportRow['tone'], string> = { on: 'FF2563EB', late: 'FFD97706', abs: 'FFDC2626', off: 'FF64748B' };

/** Any image data URL -> a PNG data URL with its size (jsPDF and exceljs take PNG). */
export async function asPng(src: string | null): Promise<{ data: string; w: number; h: number } | null> {
  if (!src) return null;
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    const max = 320;
    const k = Math.min(1, max / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    const w = Math.max(1, Math.round((img.naturalWidth || max) * k));
    const h = Math.max(1, Math.round((img.naturalHeight || max) * k));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d')!.drawImage(img, 0, 0, w, h);
    return { data: c.toDataURL('image/png'), w, h };
  } catch {
    return null;
  }
}

export const generatedAt = () => new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function save(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export type PdfKit = { jsPDF: typeof import('jspdf').jsPDF; autoTable: (doc: unknown, opts: Record<string, unknown>) => void };

/** jsPDF + autotable, loaded only when someone downloads. */
export async function pdfKit(): Promise<PdfKit> {
  const [pdfMod, tableMod] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  // Either module may arrive as ESM or as a CommonJS wrapper, depending on the build.
  type Loose = { [k: string]: unknown; default?: Loose & ((...a: unknown[]) => unknown) };
  const pm = pdfMod as unknown as Loose;
  const jsPDF = (pm.jsPDF ?? (pm.default as Loose | undefined)?.jsPDF ?? pm.default) as PdfKit['jsPDF'];
  const tm = tableMod as unknown as Loose;
  const autoTable = [tm.default, tm.autoTable, (tm.default as Loose | undefined)?.default, (tm.default as Loose | undefined)?.autoTable].find((f) => typeof f === 'function') as PdfKit['autoTable'];
  return { jsPDF, autoTable };
}

/** Left/right margin of the staff reports (pt), and the same in mm for the letterhead. */
export const PDF_SIDE = 40;
export const PDF_SIDE_MM = (PDF_SIDE * 25.4) / 72;
export const pdfNote = () => `Generated ${generatedAt()} · Tendo · Amashuri`;

/**
 * The day report as a jsPDF document. The school's header and footer (the document
 * letterhead) are on every page; the title block and the table stay between them.
 */
export function buildDayPdf({ jsPDF, autoTable }: PdfKit, rows: DayExportRow[], meta: DayExportMeta, lh: Letterhead): import('jspdf').jsPDF {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const M = PDF_SIDE;
  const f = letterheadFrame(doc, lh, { sideMm: PDF_SIDE_MM });
  const y0 = f.top;
  // Title block: the report, then the school, the day and the filter.
  doc.setFont('helvetica', 'bold').setFontSize(15).setTextColor(17, 24, 39).text('Staff attendance report', M, y0 + 14);
  doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(75, 85, 99).text(`${meta.school} · ${meta.dateLabel}${meta.isToday ? ' (live)' : ''} · ${meta.filterLabel}`, M, y0 + 30, { maxWidth: W - 2 * M });
  doc.setDrawColor(229, 231, 235).line(M, y0 + 42, W - M, y0 + 42);
  // Summary.
  const absentWord = meta.isToday ? 'Not in yet' : 'Absent';
  const cells: Array<[string, number, [number, number, number]]> = [
    ['Staff', meta.counts.staff, [17, 24, 39]], ['On time', meta.counts.onTime, TONE_RGB.on], ['Late', meta.counts.late, TONE_RGB.late], [absentWord, meta.counts.absent, TONE_RGB.abs],
  ];
  const cw = (W - 2 * M) / cells.length;
  cells.forEach(([label, n, rgb], i) => {
    const cx = M + i * cw;
    doc.setFont('helvetica', 'bold').setFontSize(18).setTextColor(...rgb).text(String(n), cx, y0 + 70);
    doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(107, 114, 128).text(label, cx, y0 + 84);
  });
  autoTable(doc, {
    startY: y0 + 102,
    margin: { left: M, right: M, top: f.top, bottom: f.bottom },
    head: [['#', 'Staff', 'Role', 'Status', 'In', 'Out', 'At school', 'How']],
    body: rows.map((r, i) => [String(i + 1), r.name, r.role, r.status, r.checkIn, r.checkOut, r.hours, r.how]),
    styles: { font: 'helvetica', fontSize: 9, cellPadding: 5, textColor: [31, 41, 55], lineColor: [229, 231, 235], lineWidth: 0.5 },
    headStyles: { fillColor: [37, 99, 235], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles: { 0: { cellWidth: 22, halign: 'right' }, 4: { halign: 'center' }, 5: { halign: 'center' }, 6: { halign: 'center' } },
    didParseCell: (d: { section: string; column: { index: number }; row: { index: number }; cell: { styles: { textColor: unknown; fontStyle: string } } }) => {
      if (d.section === 'body' && d.column.index === 3) {
        const tone = rows[d.row.index]?.tone;
        if (tone) { d.cell.styles.textColor = TONE_RGB[tone]; d.cell.styles.fontStyle = 'bold'; }
      }
    },
  });
  // Last: the school's header and footer on every page.
  stampLetterhead(doc, lh, { sideMm: PDF_SIDE_MM, note: pdfNote() });
  return doc;
}

export async function downloadDayPdf(rows: DayExportRow[], meta: DayExportMeta): Promise<void> {
  const [kit, lh] = await Promise.all([pdfKit(), loadLetterhead()]);
  save(buildDayPdf(kit, rows, meta, lh).output('blob'), `${meta.fileStem}.pdf`);
}

export async function downloadDayXlsx(rows: DayExportRow[], meta: DayExportMeta): Promise<void> {
  const [xlMod, logo] = await Promise.all([import('exceljs'), asPng(meta.logo)]);
  // exceljs is CommonJS: its API sits on `default` once bundled.
  const ExcelJS = ((xlMod as unknown as { default?: typeof xlMod }).default ?? xlMod) as typeof import('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Tendo';
  const ws = wb.addWorksheet('Staff attendance', { views: [{ state: 'frozen', ySplit: 6 }], pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  ws.columns = [
    { key: 'n', width: 6 }, { key: 'name', width: 34 }, { key: 'role', width: 18 }, { key: 'status', width: 14 },
    { key: 'in', width: 10 }, { key: 'out', width: 16 }, { key: 'hours', width: 12 }, { key: 'how', width: 26 },
  ];
  // Header block: logo (A1:A4), school, title, day, summary.
  const textCol = logo ? 2 : 1;
  if (logo) {
    const id = wb.addImage({ base64: logo.data, extension: 'png' });
    const h = 64;
    ws.addImage(id, { tl: { col: 0, row: 0 }, ext: { width: Math.round((logo.w / logo.h) * h), height: h } });
  }
  ws.getCell(1, textCol).value = meta.school;
  ws.getCell(1, textCol).font = { bold: true, size: 15 };
  ws.getCell(2, textCol).value = 'Staff attendance report';
  ws.getCell(2, textCol).font = { size: 11, color: { argb: 'FF4B5563' } };
  ws.getCell(3, textCol).value = `${meta.dateLabel}${meta.isToday ? ' (live)' : ''} · ${meta.filterLabel}`;
  ws.getCell(3, textCol).font = { size: 10, color: { argb: 'FF4B5563' } };
  ws.getCell(4, textCol).value = `${meta.counts.staff} staff · ${meta.counts.onTime} on time · ${meta.counts.late} late · ${meta.counts.absent} ${meta.isToday ? 'not in yet' : 'absent'} · generated ${generatedAt()}`;
  ws.getCell(4, textCol).font = { size: 9, color: { argb: 'FF6B7280' } };
  for (let r = 1; r <= 4; r++) ws.getRow(r).height = 18;
  const head = ws.getRow(6);
  head.values = ['#', 'Staff', 'Role', 'Status', 'In', 'Out', 'At school', 'How'];
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } }; c.alignment = { vertical: 'middle' }; });
  head.height = 22;
  rows.forEach((r, i) => {
    const row = ws.addRow([i + 1, r.name, r.role, r.status, r.checkIn, r.checkOut, r.hours, r.how]);
    row.getCell(4).font = { bold: true, color: { argb: TONE_ARGB[r.tone] } };
    if (i % 2 === 1) row.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }; });
    [5, 6, 7].forEach((k) => { row.getCell(k).alignment = { horizontal: 'center' }; });
  });
  ws.autoFilter = { from: { row: 6, column: 1 }, to: { row: 6 + rows.length, column: 8 } };
  const buf = await wb.xlsx.writeBuffer();
  save(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${meta.fileStem}.xlsx`);
}
