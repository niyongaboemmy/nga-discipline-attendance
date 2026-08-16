import React, { useEffect, useState } from 'react';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { ErrorState } from '../components/common/ErrorState';
import { ConfirmDialog } from '../components/common/ConfirmDialog';
import { Modal } from '../components/common/Modal';
import { useToast } from '../context/ToastContext';
import { usePermissions } from '../hooks/usePermissions';
import { disciplineApi, type DisciplineRule, type RuleInput } from '../api/discipline';
import { ApiError } from '../api/client';
import { SearchableSelect } from '../components/common/SearchableSelect';
import { RuleImportModal } from '../components/discipline/RuleImportModal';
import { Pager, clampPage } from '../components/common/Pager';
import { Plus, Trash2, Pencil, Gavel, Award, ShieldCheck, Upload, Sparkles } from 'lucide-react';

const emptyForm: RuleInput = {
  type: 'demerit', category: '', title: '', description: '', defaultPoints: 5, fineAmount: 0, severity: 'minor',
};

// Legacy tier vocabulary offered as suggestions so rule severities stay
// aligned with what LogIncident's manual-entry fallback expects — a
// free-text field here could otherwise drift from that fixed enum.
const SEVERITY_OPTIONS: Record<'demerit' | 'merit', string[]> = {
  demerit: ['minor', 'moderate', 'major'],
  merit: ['small', 'notable', 'outstanding'],
};

/** B.1: the discipline rules catalog — the governable directory of rules
 *  (with their point value and optional fine) that /discipline/log and
 *  /discipline/adjust draw from, instead of a hardcoded list. Admin-only. */
export const DisciplineRules: React.FC = () => {
  const toast = useToast();
  const { can } = usePermissions();
  const canManage = can('DISCIPLINE_RULES_MANAGE');

  const [rules, setRules] = useState<DisciplineRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // null = closed; otherwise which add-flow is open (spreadsheet or AI).
  const [addMode, setAddMode] = useState<'file' | 'ai' | null>(null);
  const RULES_PAGE_SIZE = 10;
  const [demeritPage, setDemeritPage] = useState(1);
  const [meritPage, setMeritPage] = useState(1);
  const [form, setForm] = useState<RuleInput>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [retireTarget, setRetireTarget] = useState<DisciplineRule | null>(null);
  const [retiring, setRetiring] = useState(false);
  const [severityCustom, setSeverityCustom] = useState(false);

  const [editTarget, setEditTarget] = useState<DisciplineRule | null>(null);
  const [editForm, setEditForm] = useState<RuleInput | null>(null);
  const [editSeverityCustom, setEditSeverityCustom] = useState(false);
  const [editSaving, setEditSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await disciplineApi.listRules();
      setRules(res.data || []);
    } catch (err) {
      // A permanent ErrorState (not just a transient toast) — otherwise a
      // failed fetch leaves the page looking like a genuinely empty catalog
      // ("No rules yet.") instead of a broken one once the toast dismisses.
      setError(err instanceof ApiError ? err.message : 'Could not load discipline rules.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const update = (patch: Partial<RuleInput>) => setForm((f) => ({ ...f, ...patch }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.category.trim() || !form.title.trim() || form.defaultPoints <= 0) {
      toast.error('Incomplete rule', 'Category, title, and a positive point value are required.');
      return;
    }
    setSaving(true);
    try {
      const res = await disciplineApi.createRule(form);
      setRules((list) => [...list, res.data!].sort((a, b) => a.title.localeCompare(b.title)));
      toast.success('Rule created', `"${res.data!.title}" is now available for logging.`);
      setForm(emptyForm);
      setCreating(false);
    } catch (err) {
      toast.error('Could not create rule', (err as ApiError).message);
    } finally {
      setSaving(false);
    }
  };

  const openEdit = (rule: DisciplineRule) => {
    setEditTarget(rule);
    setEditForm({
      type: rule.type, category: rule.category, title: rule.title, description: rule.description ?? '',
      defaultPoints: rule.default_points, fineAmount: rule.fine_amount, severity: rule.severity ?? '',
    });
    setEditSeverityCustom(!!rule.severity && !SEVERITY_OPTIONS[rule.type].includes(rule.severity));
  };

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editTarget || !editForm) return;
    if (!editForm.category.trim() || !editForm.title.trim() || editForm.defaultPoints <= 0) {
      toast.error('Incomplete rule', 'Category, title, and a positive point value are required.');
      return;
    }
    setEditSaving(true);
    try {
      const res = await disciplineApi.updateRule(editTarget.id, editForm);
      setRules((list) => list.map((r) => (r.id === editTarget.id ? res.data! : r)));
      toast.success('Rule updated', `"${res.data!.title}" was saved.`);
      setEditTarget(null);
      setEditForm(null);
    } catch (err) {
      toast.error('Could not update rule', (err as ApiError).message);
    } finally {
      setEditSaving(false);
    }
  };

  const confirmRetire = async () => {
    if (!retireTarget) return;
    setRetiring(true);
    try {
      await disciplineApi.retireRule(retireTarget.id);
      setRules((list) => list.map((r) => (r.id === retireTarget.id ? { ...r, is_active: 0 } : r)));
      toast.success('Rule retired', `"${retireTarget.title}" is no longer available for new records.`);
      setRetireTarget(null);
    } catch (err) {
      toast.error('Could not retire rule', (err as ApiError).message);
    } finally {
      setRetiring(false);
    }
  };

  const demerits = rules.filter((r) => r.type === 'demerit');
  const merits = rules.filter((r) => r.type === 'merit');

  const renderTable = (
    list: DisciplineRule[],
    icon: React.ReactNode,
    pager: { page: number; setPage: (p: number) => void; label: string }
  ) => {
    const pageCount = Math.max(1, Math.ceil(list.length / RULES_PAGE_SIZE));
    const page = clampPage(pager.page, pageCount);
    const rows = list.slice((page - 1) * RULES_PAGE_SIZE, page * RULES_PAGE_SIZE);
    return (
    <div className="card">
      <table className="table">
        <thead>
          <tr>
            <th>Rule</th><th>Category</th><th>Points</th><th>Fine</th><th>Status</th>{canManage && <th />}
          </tr>
        </thead>
        <tbody>
          {list.length === 0 ? (
            <tr><td colSpan={6}><div className="empty-state" style={{ padding: '24px' }}>{icon}<span className="text-sm">No rules yet.</span></div></td></tr>
          ) : rows.map((r) => (
            <tr key={r.id}>
              <td>
                <div className="text-sm font-semibold">{r.title}</div>
                {r.description && <div className="text-xs text-secondary">{r.description}</div>}
              </td>
              <td className="text-sm">{r.category}{r.severity ? ` · ${r.severity}` : ''}</td>
              <td><span className={`badge ${r.type === 'merit' ? 'badge-success' : 'badge-danger'}`}>{r.type === 'merit' ? '+' : '−'}{r.default_points}</span></td>
              <td className="text-sm">{r.fine_amount > 0 ? r.fine_amount.toLocaleString() : '—'}</td>
              <td><span className={`badge ${r.is_active ? 'badge-success' : 'badge-neutral'}`}>{r.is_active ? 'Active' : 'Retired'}</span></td>
              {canManage && (
                <td>
                  <div className="flex gap-1">
                    <button className="btn btn-outline btn-sm" onClick={() => openEdit(r)} title="Edit rule">
                      <Pencil size={14} />
                    </button>
                    {r.is_active === 1 && (
                      <button className="btn btn-outline btn-sm" onClick={() => setRetireTarget(r)} title="Retire rule">
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {list.length > 0 && (
        <Pager
          page={page}
          pageCount={pageCount}
          total={list.length}
          pageSize={RULES_PAGE_SIZE}
          onChange={pager.setPage}
          label={pager.label}
        />
      )}
    </div>
    );
  };

  return (
    <DashboardLayout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Discipline Rules</h1>
          <p className="page-subtitle">The governable directory of demerit/merit rules, their point values, and fines.</p>
        </div>
        {canManage && (
          <div className="flex items-center gap-2">
            <button className="btn btn-outline" onClick={() => setAddMode('file')}>
              <Upload size={16} /> Import
            </button>
            <button className="btn btn-outline" onClick={() => setAddMode('ai')}>
              <Sparkles size={16} /> Describe with AI
            </button>
            <button className="btn btn-primary" onClick={() => setCreating((v) => !v)}>
              <Plus size={16} /> New rule
            </button>
          </div>
        )}
      </div>

      {canManage && addMode && (
        <RuleImportModal
          open
          mode={addMode}
          onClose={() => setAddMode(null)}
          onImported={load}
        />
      )}

      {creating && canManage && (
        <section className="card mb-4">
          <div className="card-header"><span className="section-title">New rule</span></div>
          <div className="card-body">
            <form onSubmit={submit} className="flex flex-col gap-3">
              <div className="field">
                <label className="label">Type</label>
                <div className="segmented">
                  <button type="button" onClick={() => { update({ type: 'demerit', severity: 'minor' }); setSeverityCustom(false); }} className={`segmented-btn is-absent${form.type === 'demerit' ? ' is-active' : ''}`}>
                    <Gavel size={14} /> Demerit
                  </button>
                  <button type="button" onClick={() => { update({ type: 'merit', severity: 'small' }); setSeverityCustom(false); }} className={`segmented-btn is-present${form.type === 'merit' ? ' is-active' : ''}`}>
                    <Award size={14} /> Merit
                  </button>
                </div>
              </div>
              <div className="grid grid-2" style={{ gap: '12px' }}>
                <div className="field">
                  <label className="label">Category</label>
                  <input className="input" placeholder="e.g. Tardiness" value={form.category} onChange={(e) => update({ category: e.target.value })} required />
                </div>
                <div className="field">
                  <label className="label">Severity tier (optional label)</label>
                  {severityCustom ? (
                    <input className="input" placeholder="Custom severity label" value={form.severity} onChange={(e) => update({ severity: e.target.value })} />
                  ) : (
                    <SearchableSelect
                      aria-label="Severity tier"
                      value={form.severity ?? ''}
                      onChange={(v) => {
                        if (v === '__custom__') { setSeverityCustom(true); update({ severity: '' }); }
                        else update({ severity: v });
                      }}
                      options={[
                        ...SEVERITY_OPTIONS[form.type].map((s) => ({ value: s, label: s })),
                        { value: '__custom__', label: 'Custom…' },
                      ]}
                    />
                  )}
                </div>
              </div>
              <div className="field">
                <label className="label">Title</label>
                <input className="input" placeholder="e.g. Late to class" value={form.title} onChange={(e) => update({ title: e.target.value })} required />
              </div>
              <div className="field">
                <label className="label">Description</label>
                <textarea className="textarea" value={form.description} onChange={(e) => update({ description: e.target.value })} />
              </div>
              <div className="grid grid-2" style={{ gap: '12px' }}>
                <div className="field">
                  <label className="label">Default points</label>
                  <input className="input" type="number" min={1} max={100} value={form.defaultPoints} onChange={(e) => update({ defaultPoints: Number(e.target.value) })} required />
                </div>
                <div className="field">
                  <label className="label">Fine amount (optional)</label>
                  <input className="input" type="number" min={0} value={form.fineAmount} onChange={(e) => update({ fineAmount: Number(e.target.value) })} />
                </div>
              </div>
              <div className="flex gap-2">
                <button type="button" className="btn btn-outline" onClick={() => { setCreating(false); setForm(emptyForm); setSeverityCustom(false); }}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Create rule'}</button>
              </div>
            </form>
          </div>
        </section>
      )}

      {loading ? (
        <div style={{ padding: '80px 0' }}><LoadingSpinner /></div>
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <div className="flex flex-col gap-4">
          <div>
            <span className="section-title">Demerit rules</span>
            <div className="mt-2">
              {renderTable(demerits, <Gavel size={24} />, {
                page: demeritPage, setPage: setDemeritPage, label: 'Demerit rules pages',
              })}
            </div>
          </div>
          <div>
            <span className="section-title">Merit rules</span>
            <div className="mt-2">
              {renderTable(merits, <ShieldCheck size={24} />, {
                page: meritPage, setPage: setMeritPage, label: 'Merit rules pages',
              })}
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!retireTarget}
        title="Retire this rule?"
        message={`"${retireTarget?.title}" will no longer be selectable for new records. Past records referencing it are unaffected.`}
        confirmLabel="Retire"
        danger
        loading={retiring}
        onConfirm={confirmRetire}
        onCancel={() => setRetireTarget(null)}
      />

      <Modal
        open={!!editTarget && !!editForm}
        title={`Edit rule${editTarget ? `: ${editTarget.title}` : ''}`}
        onClose={() => { setEditTarget(null); setEditForm(null); }}
        maxWidth={520}
      >
        {editForm && (
          <form onSubmit={saveEdit} className="flex flex-col gap-3">
            <div className="grid grid-2" style={{ gap: '12px' }}>
              <div className="field">
                <label className="label">Category</label>
                <input className="input" value={editForm.category} onChange={(e) => setEditForm({ ...editForm, category: e.target.value })} required />
              </div>
              <div className="field">
                <label className="label">Severity tier</label>
                {editSeverityCustom ? (
                  <input className="input" placeholder="Custom severity label" value={editForm.severity} onChange={(e) => setEditForm({ ...editForm, severity: e.target.value })} />
                ) : (
                  <SearchableSelect
                    aria-label="Severity tier"
                    value={editForm.severity ?? ''}
                    onChange={(v) => {
                      if (v === '__custom__') { setEditSeverityCustom(true); setEditForm({ ...editForm, severity: '' }); }
                      else setEditForm({ ...editForm, severity: v });
                    }}
                    options={[
                      ...SEVERITY_OPTIONS[editForm.type].map((s) => ({ value: s, label: s })),
                      { value: '__custom__', label: 'Custom…' },
                    ]}
                  />
                )}
              </div>
            </div>
            <div className="field">
              <label className="label">Title</label>
              <input className="input" value={editForm.title} onChange={(e) => setEditForm({ ...editForm, title: e.target.value })} required />
            </div>
            <div className="field">
              <label className="label">Description</label>
              <textarea className="textarea" value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} />
            </div>
            <div className="grid grid-2" style={{ gap: '12px' }}>
              <div className="field">
                <label className="label">Default points</label>
                <input className="input" type="number" min={1} max={100} value={editForm.defaultPoints} onChange={(e) => setEditForm({ ...editForm, defaultPoints: Number(e.target.value) })} required />
              </div>
              <div className="field">
                <label className="label">Fine amount</label>
                <input className="input" type="number" min={0} value={editForm.fineAmount} onChange={(e) => setEditForm({ ...editForm, fineAmount: Number(e.target.value) })} />
              </div>
            </div>
            <div className="flex gap-2 justify-end mt-2">
              <button type="button" className="btn btn-outline" onClick={() => { setEditTarget(null); setEditForm(null); }}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={editSaving}>{editSaving ? 'Saving…' : 'Save changes'}</button>
            </div>
          </form>
        )}
      </Modal>
    </DashboardLayout>
  );
};
