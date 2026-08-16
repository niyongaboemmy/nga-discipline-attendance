import React, { useRef, useState } from 'react';
import { Download, Upload, FileSpreadsheet, CheckCircle2, AlertTriangle, X, Sparkles } from 'lucide-react';
import { Modal } from '../common/Modal';
import { apiPost, ApiError } from '../../api/client';

type Mode = 'file' | 'ai';

interface AiDraft {
  index: number;
  rule: ParsedRule;
  error: string | null;
  duplicate: boolean;
}

const AI_EXAMPLES = [
  'Standard secondary-school rules for lateness, uniform and phone use',
  '5 merit rules that reward helping classmates and school service',
  'Rules for exam misconduct, with higher points for repeat offences',
];

/** Column order of the template — also the order rows are read back in. */
const COLUMNS = [
  { key: 'type', header: 'Type', width: 12, required: true, note: 'demerit or merit' },
  { key: 'category', header: 'Category', width: 22, required: true, note: 'e.g. Tardiness' },
  { key: 'title', header: 'Title', width: 34, required: true, note: 'The rule itself' },
  { key: 'description', header: 'Description', width: 44, required: false, note: 'Optional detail' },
  { key: 'defaultPoints', header: 'Points', width: 10, required: true, note: 'Whole number, 1-100' },
  { key: 'fineAmount', header: 'Fine', width: 12, required: false, note: 'Optional, 0 if none' },
  { key: 'severity', header: 'Severity', width: 14, required: false, note: 'Optional' },
] as const;

const SAMPLE_ROWS = [
  ['demerit', 'Tardiness', 'Late to class', 'Arrived after the bell without a pass.', 5, 500, 'minor'],
  ['demerit', 'Uniform', 'Incomplete uniform', 'Missing tie, badge or correct shoes.', 3, 0, 'minor'],
  ['merit', 'Service', 'Helped a classmate', 'Went out of their way to support a peer.', 4, 0, ''],
];

export interface ParsedRule {
  type: string;
  category: string;
  title: string;
  description?: string;
  defaultPoints: number;
  fineAmount?: number;
  severity?: string;
}

interface RowResult {
  rowNumber: number;
  rule: ParsedRule;
  error: string | null;
}

interface ImportReport {
  created: Array<{ row: number; title: string }>;
  skipped: Array<{ row: number; title: string; reason: string }>;
  errors: Array<{ row: number; message: string }>;
}

const str = (v: unknown) => (v == null ? '' : String(v).trim());

/** Minimal RFC4180-style CSV split: handles quoted fields, escaped quotes
 *  and newlines inside quotes. exceljs's CSV reader wants a Node stream, so
 *  parsing the text directly is both simpler and browser-safe. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Client-side mirror of the server's per-row rules, so problems surface in
 *  the preview instead of only after upload. The server revalidates. */
function validateRow(raw: Record<string, unknown>): { rule: ParsedRule; error: string | null } {
  const type = str(raw.type).toLowerCase();
  const category = str(raw.category);
  const title = str(raw.title);
  const description = str(raw.description);
  const severity = str(raw.severity);
  const pointsRaw = str(raw.defaultPoints);
  const fineRaw = str(raw.fineAmount);

  const points = Number(pointsRaw);
  const fine = fineRaw === '' ? 0 : Number(fineRaw);

  const rule: ParsedRule = {
    type,
    category,
    title,
    ...(description ? { description } : {}),
    defaultPoints: Number.isFinite(points) ? points : NaN,
    ...(Number.isFinite(fine) ? { fineAmount: fine } : {}),
    ...(severity ? { severity } : {}),
  };

  const problems: string[] = [];
  if (type !== 'demerit' && type !== 'merit') problems.push('Type must be “demerit” or “merit”');
  if (!category) problems.push('Category is required');
  if (!title) problems.push('Title is required');
  if (!Number.isInteger(points) || points <= 0 || points > 100) {
    problems.push('Points must be a whole number between 1 and 100');
  }
  if (fineRaw !== '' && (!Number.isFinite(fine) || fine < 0)) problems.push('Fine must be 0 or more');

  return { rule, error: problems.length ? problems.join('; ') : null };
}

interface RuleImportModalProps {
  open: boolean;
  onClose: () => void;
  /** Called after a successful import so the page can refresh its list. */
  onImported: () => void;
  /** Which way of adding rules this was opened for. Both share the preview
   *  and commit path, but they're separate entry points on the page rather
   *  than a switcher buried inside one dialog. */
  mode: Mode;
}

export const RuleImportModal: React.FC<RuleImportModalProps> = ({ open, onClose, onImported, mode }) => {
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<RowResult[] | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [prompt, setPrompt] = useState('');
  const [providerUsed, setProviderUsed] = useState<string | null>(null);

  const reset = () => {
    setFileName(null);
    setRows(null);
    setParseError(null);
    setReport(null);
    setBusy(false);
    setPrompt('');
    setProviderUsed(null);
  };

  /** Ask the server to draft rules. Nothing is written — the drafts land in
   *  the same preview table the spreadsheet path uses, and only reach the
   *  database if the user confirms. */
  const draftWithAi = async () => {
    if (prompt.trim().length < 3) return;
    setBusy(true);
    setParseError(null);
    setReport(null);
    setRows(null);
    setProviderUsed(null);
    try {
      const res = await apiPost<{ drafts: AiDraft[]; providerUsed: string }>(
        '/api/discipline/rules/ai-draft',
        { prompt: prompt.trim() }
      );
      const drafts = res.data?.drafts ?? [];
      if (drafts.length === 0) {
        setParseError('The AI returned no rules. Try describing the rules you want more specifically.');
        return;
      }
      setProviderUsed(res.data?.providerUsed ?? null);
      setRows(
        drafts.map((d, i) => ({
          // Drafts have no spreadsheet row, so number them from 1 for display.
          rowNumber: i + 1,
          rule: d.rule,
          error: d.error ?? (d.duplicate ? 'A rule with this type and title already exists.' : null),
        }))
      );
    } catch (err) {
      setParseError(err instanceof ApiError ? err.message : 'Could not reach the AI service.');
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    reset();
    onClose();
  };

  // exceljs is ~1MB; loading it only when this modal is used keeps it out of
  // the main bundle for everyone who never imports a spreadsheet.
  const loadExcel = () => import('exceljs');

  const downloadTemplate = async () => {
    setBusy(true);
    try {
      const ExcelJS = (await loadExcel()).default;
      const wb = new ExcelJS.Workbook();
      const sheet = wb.addWorksheet('Discipline rules');

      sheet.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
      sheet.getRow(1).font = { bold: true };
      sheet.getRow(1).alignment = { vertical: 'middle' };

      SAMPLE_ROWS.forEach((r) => sheet.addRow(r));

      // A guidance sheet beats a wall of comments in the header row.
      const help = wb.addWorksheet('How to use');
      help.columns = [
        { header: 'Column', key: 'col', width: 18 },
        { header: 'Required', key: 'req', width: 12 },
        { header: 'What to enter', key: 'note', width: 52 },
      ];
      help.getRow(1).font = { bold: true };
      COLUMNS.forEach((c) =>
        help.addRow({ col: c.header, req: c.required ? 'Yes' : 'Optional', note: c.note })
      );
      help.addRow({});
      help.addRow({
        col: 'Note',
        req: '',
        note: 'Delete the three sample rows on the first sheet before importing.',
      });

      const buf = await wb.xlsx.writeBuffer();
      const url = URL.createObjectURL(
        new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = 'discipline-rules-template.xlsx';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setParseError('Could not build the template file.');
      console.error(err);
    } finally {
      setBusy(false);
    }
  };

  const handleFile = async (file: File) => {
    setBusy(true);
    setParseError(null);
    setReport(null);
    setRows(null);
    setFileName(file.name);

    try {
      // Normalise both formats to [rowNumber, cells[]] so the mapping below
      // is written once.
      let table: Array<{ rowNumber: number; cells: unknown[] }>;

      if (file.name.toLowerCase().endsWith('.csv')) {
        // Excel's "Save as CSV" is a very common way to hand this back.
        const grid = parseCsv(await file.text());
        table = grid.map((cells, i) => ({ rowNumber: i + 1, cells }));
      } else {
        const ExcelJS = (await loadExcel()).default;
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(await file.arrayBuffer());
        const sheet = wb.worksheets[0];
        if (!sheet) throw new Error('The file has no sheets.');

        table = [];
        sheet.eachRow((row, rowNumber) => {
          const cells: unknown[] = [];
          row.eachCell({ includeEmpty: true }, (cell, col) => {
            const v = cell.value;
            // Formula cells expose their computed result, not the formula;
            // rich text arrives as a runs array.
            cells[col - 1] =
              v && typeof v === 'object' && 'result' in (v as any)
                ? (v as any).result
                : v && typeof v === 'object' && 'richText' in (v as any)
                  ? (v as any).richText.map((t: any) => t.text).join('')
                  : v;
          });
          table.push({ rowNumber, cells });
        });
      }

      const header = table[0];
      if (!header) throw new Error('The file appears to be empty.');

      // Map by header name so column order in the user's file doesn't matter.
      const indexByKey = new Map<string, number>();
      header.cells.forEach((cell, idx) => {
        const name = str(cell).toLowerCase();
        const match = COLUMNS.find(
          (c) => c.header.toLowerCase() === name || c.key.toLowerCase() === name
        );
        if (match) indexByKey.set(match.key, idx);
      });

      const missing = COLUMNS.filter((c) => c.required && !indexByKey.has(c.key)).map((c) => c.header);
      if (missing.length) {
        throw new Error(
          `Missing required column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Use the template.`
        );
      }

      const parsed: RowResult[] = [];
      for (const { rowNumber, cells } of table.slice(1)) {
        const raw: Record<string, unknown> = {};
        for (const c of COLUMNS) {
          const idx = indexByKey.get(c.key);
          if (idx != null) raw[c.key] = cells[idx];
        }
        // Skip rows the user emptied out rather than deleted.
        if (COLUMNS.every((c) => str(raw[c.key]) === '')) continue;
        const { rule, error } = validateRow(raw);
        parsed.push({ rowNumber, rule, error });
      }

      if (parsed.length === 0) throw new Error('No data rows found below the header.');
      setRows(parsed);
    } catch (err: any) {
      setParseError(err?.message || 'Could not read that file.');
      setRows(null);
    } finally {
      setBusy(false);
    }
  };

  const validRows = rows?.filter((r) => !r.error) ?? [];
  const invalidRows = rows?.filter((r) => r.error) ?? [];

  const submit = async () => {
    if (validRows.length === 0) return;
    setBusy(true);
    setParseError(null);
    try {
      const res = await apiPost<ImportReport>('/api/discipline/rules/import', {
        rules: validRows.map((r) => r.rule),
      });
      setReport(res.data ?? null);
      setRows(null);
      onImported();
    } catch (err) {
      setParseError(err instanceof ApiError ? err.message : 'Could not import the rules.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={mode === 'ai' ? 'Draft rules with AI' : 'Import discipline rules'}
      maxWidth={820}
      footer={
        <>
          <button className="btn btn-outline" onClick={close} disabled={busy}>
            {report ? 'Done' : 'Cancel'}
          </button>
          {!report && (
            <button
              className="btn btn-primary"
              onClick={submit}
              disabled={busy || validRows.length === 0}
            >
              {busy
                ? 'Working…'
                : `${mode === 'ai' ? 'Add' : 'Import'} ${validRows.length || ''} rule${validRows.length === 1 ? '' : 's'}`}
            </button>
          )}
        </>
      }
    >
      {/* AI drafting */}
      {!report && mode === 'ai' && (
        <div className="field">
          <label className="label" htmlFor="ai-rule-prompt">
            Describe the rules you need
          </label>
          <textarea
            id="ai-rule-prompt"
            className="textarea"
            rows={3}
            value={prompt}
            placeholder="e.g. Rules for lateness and uniform, with fines for repeat offences"
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') draftWithAi();
            }}
          />
          <div className="ai-examples">
            {AI_EXAMPLES.map((ex) => (
              <button key={ex} type="button" className="chip" onClick={() => setPrompt(ex)}>
                {ex}
              </button>
            ))}
          </div>
          <div className="flex items-center justify-between mt-2">
            <p className="text-xs text-secondary">
              Nothing is saved until you review the drafts and confirm.
            </p>
            <button
              className="btn btn-secondary btn-sm"
              onClick={draftWithAi}
              disabled={busy || prompt.trim().length < 3}
            >
              <Sparkles size={14} /> {busy ? 'Drafting…' : 'Draft rules'}
            </button>
          </div>
        </div>
      )}

      {/* Step 1 — template */}
      {!report && mode === 'file' && (
        <div className="import-step">
          <div className="import-step-body">
            <span className="import-step-num">1</span>
            <div>
              <div className="import-step-title">Start from the template</div>
              <p className="text-xs text-secondary">
                It includes the required columns, a “How to use” sheet, and three sample rows to
                replace.
              </p>
            </div>
          </div>
          <button className="btn btn-outline btn-sm" onClick={downloadTemplate} disabled={busy}>
            <Download size={14} /> Template
          </button>
        </div>
      )}

      {/* Step 2 — upload */}
      {!report && mode === 'file' && (
        <>
          <div className="import-step" style={{ borderBottom: 'none', paddingBottom: 4 }}>
            <div className="import-step-body">
              <span className="import-step-num">2</span>
              <div>
                <div className="import-step-title">Upload your filled-in file</div>
                <p className="text-xs text-secondary">Accepts .xlsx and .csv, up to 500 rows.</p>
              </div>
            </div>
          </div>

          <div
            className={`import-drop${dragging ? ' is-dragging' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files?.[0];
              if (f) handleFile(f);
            }}
            onClick={() => fileRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') fileRef.current?.click();
            }}
          >
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.csv"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
                e.target.value = '';
              }}
            />
            {fileName ? (
              <>
                <FileSpreadsheet size={20} />
                <span className="import-drop-name">{fileName}</span>
                <span className="text-xs text-secondary">Click to choose a different file</span>
              </>
            ) : (
              <>
                <Upload size={20} />
                <span className="import-drop-name">Drop a file here, or click to browse</span>
              </>
            )}
          </div>
        </>
      )}

      {parseError && (
        <div className="import-alert is-error mt-3">
          <AlertTriangle size={15} />
          <span>{parseError}</span>
        </div>
      )}

      {/* Step 3 — preview */}
      {rows && (
        <div className="mt-4">
          <div className="import-summary">
            <span className="badge badge-success">{validRows.length} ready</span>
            {invalidRows.length > 0 && (
              <span className="badge badge-danger">{invalidRows.length} need fixing</span>
            )}
            <span className="text-xs text-secondary">
              {mode === 'ai'
                ? `Only the valid drafts are added — review them before confirming.${providerUsed ? ` Drafted by ${providerUsed}.` : ''}`
                : 'Only the valid rows are imported — fix the rest and upload again.'}
            </span>
          </div>

          <div className="import-preview">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 52 }}>{mode === 'ai' ? '#' : 'Row'}</th>
                  <th>Rule</th>
                  <th style={{ width: 80 }}>Type</th>
                  <th style={{ width: 70 }}>Points</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.rowNumber} className={r.error ? 'is-invalid-row' : undefined}>
                    <td className="text-xs text-secondary">{r.rowNumber}</td>
                    <td>
                      <div className="import-cell-title">{r.rule.title || <em>(no title)</em>}</div>
                      <div className="text-xs text-secondary">{r.rule.category}</div>
                    </td>
                    <td className="text-xs">{r.rule.type}</td>
                    <td className="text-xs">
                      {Number.isFinite(r.rule.defaultPoints) ? r.rule.defaultPoints : '—'}
                    </td>
                    <td>
                      {r.error ? (
                        <span className="import-row-error">
                          <AlertTriangle size={12} /> {r.error}
                        </span>
                      ) : (
                        <span className="import-row-ok">
                          <CheckCircle2 size={12} /> Ready
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Step 4 — result */}
      {report && (
        <div className="mt-2">
          <div className="import-alert is-success">
            <CheckCircle2 size={15} />
            <span>
              Imported <strong>{report.created.length}</strong> rule
              {report.created.length === 1 ? '' : 's'}.
            </span>
          </div>

          {report.skipped.length > 0 && (
            <div className="mt-3">
              <div className="import-result-heading">
                <X size={13} /> Skipped {report.skipped.length} (already exist)
              </div>
              <ul className="import-result-list">
                {report.skipped.map((s) => (
                  <li key={`s-${s.row}`}>
                    <span className="text-secondary">Row {s.row}:</span> {s.title}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report.errors.length > 0 && (
            <div className="mt-3">
              <div className="import-result-heading">
                <AlertTriangle size={13} /> Rejected {report.errors.length}
              </div>
              <ul className="import-result-list">
                {report.errors.map((e) => (
                  <li key={`e-${e.row}`}>
                    <span className="text-secondary">Row {e.row}:</span> {e.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
};
