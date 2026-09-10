import React, { useEffect, useMemo, useState } from 'react';
import { Modal } from '../common/Modal';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { SearchableSelect } from '../common/SearchableSelect';
import { useToast } from '../../context/ToastContext';
import { usePermissions } from '../../hooks/usePermissions';
import { disciplineApi } from '../../api/discipline';
import { ApiError } from '../../api/client';
import { Pencil, Trash2, History, Save } from 'lucide-react';

interface Props {
  id: number;
  onClose: () => void;
  onChanged: () => void;
}

interface Config {
  demeritCategories: string[]; meritCategories: string[];
  demeritTiers: Record<string, number>; meritTiers: Record<string, number>;
  sanctions: string[];
}

const today = () => new Date().toISOString().split('T')[0];
const fmt = (iso: string) => new Date(iso.replace(' ', 'T') + 'Z').toLocaleString(undefined, {
  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
});

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <div className="text-xs text-secondary" style={{ letterSpacing: '0.04em', textTransform: 'uppercase' }}>{label}</div>
    <div className="text-sm mt-1">{children || <span className="text-tertiary">—</span>}</div>
  </div>
);

export const DisciplineDetailModal: React.FC<Props> = ({ id, onClose, onChanged }) => {
  const toast = useToast();
  const { can } = usePermissions();
  const [detail, setDetail] = useState<any | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [form, setForm] = useState<any>({});

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const [d, c] = await Promise.all([
        disciplineApi.detail(id),
        disciplineApi.config().catch(() => null),
      ]);
      setDetail(d.data);
      if (c) setConfig(c.data as Config);
      const r = d.data!.record as any;
      setForm({
        studentName: r.student_name, className: r.class_name ?? '', category: r.category,
        severity: r.severity ?? '', title: r.title, description: r.description ?? '',
        incidentDate: r.incident_date, location: r.location ?? '', sanction: r.sanction ?? 'none',
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this record.');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  const record = detail?.record as any;
  const isDemerit = record?.type === 'demerit';
  const editable = useMemo(() => {
    if (!record) return false;
    if (can('DISCIPLINE_EDIT')) return true;
    // original logger, within 24h
    const age = Date.now() - new Date(String(record.created_at).replace(' ', 'T') + 'Z').getTime();
    return age < 24 * 3600 * 1000; // server re-checks ownership
  }, [record, can]);

  const categories = isDemerit ? config?.demeritCategories : config?.meritCategories;
  const tiers = isDemerit ? config?.demeritTiers : config?.meritTiers;

  const save = async () => {
    setSaving(true);
    try {
      await disciplineApi.edit(id, {
        studentName: form.studentName,
        className: form.className || null,
        category: form.category,
        severity: form.severity || null,
        title: form.title,
        description: form.description,
        incidentDate: form.incidentDate,
        location: form.location || null,
        sanction: isDemerit ? form.sanction : 'none',
      });
      toast.success('Record corrected');
      setEditing(false);
      await load();
      onChanged();
    } catch (err) {
      toast.error('Could not save', err instanceof ApiError ? err.message : 'Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    try {
      await disciplineApi.remove(id);
      toast.success('Record removed');
      setConfirmDelete(false);
      onChanged();
      onClose();
    } catch (err) {
      toast.error('Could not remove', err instanceof ApiError ? err.message : 'Please try again.');
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={record ? (isDemerit ? 'Demerit record' : 'Merit record') : 'Record'}
      subtitle={record ? `${record.student_name} · ${record.incident_date}` : undefined}
      maxWidth={620}
      footer={
        editing ? (
          <>
            <button className="btn btn-outline" onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={saving || !form.title?.trim()}>
              <Save size={15} /> {saving ? 'Saving…' : 'Save correction'}
            </button>
          </>
        ) : (
          <>
            {can('DISCIPLINE_DELETE') && record && (
              <button className="btn btn-outline btn-danger" onClick={() => setConfirmDelete(true)} style={{ marginRight: 'auto' }}>
                <Trash2 size={15} /> Remove
              </button>
            )}
            {editable && record && (
              <button className="btn btn-outline" onClick={() => setEditing(true)}>
                <Pencil size={15} /> Correct details
              </button>
            )}
            <button className="btn btn-primary" onClick={onClose}>Done</button>
          </>
        )
      }
    >
      {loading ? (
        <div style={{ padding: '40px 0' }}><LoadingSpinner /></div>
      ) : error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : editing ? (
        <div className="flex flex-col gap-3">
          <div className="grid grid-2" style={{ gap: '12px' }}>
            <div className="field">
              <label className="label">Student name</label>
              <input className="input" value={form.studentName} onChange={(e) => setForm((f: any) => ({ ...f, studentName: e.target.value }))} />
            </div>
            <div className="field">
              <label className="label">Class</label>
              <input className="input" value={form.className} onChange={(e) => setForm((f: any) => ({ ...f, className: e.target.value }))} />
            </div>
          </div>
          <div className="grid grid-2" style={{ gap: '12px' }}>
            <div className="field">
              <label className="label">Category</label>
              <SearchableSelect
                value={form.category}
                onChange={(v) => setForm((f: any) => ({ ...f, category: v }))}
                options={(categories ?? [form.category]).map((c) => ({ value: c, label: c }))}
                aria-label="Category"
              />
            </div>
            <div className="field">
              <label className="label">{isDemerit ? 'Severity' : 'Level'}</label>
              <SearchableSelect
                value={form.severity}
                onChange={(v) => setForm((f: any) => ({ ...f, severity: v }))}
                options={Object.keys(tiers ?? {}).map((t) => ({ value: t, label: `${t} (${tiers![t]} pts)` }))}
                aria-label="Severity"
              />
            </div>
          </div>
          <div className="field">
            <label className="label">Title</label>
            <input className="input" value={form.title} onChange={(e) => setForm((f: any) => ({ ...f, title: e.target.value }))} />
          </div>
          <div className="field">
            <label className="label">Description</label>
            <textarea className="textarea" value={form.description} onChange={(e) => setForm((f: any) => ({ ...f, description: e.target.value }))} />
          </div>
          <div className="grid grid-2" style={{ gap: '12px' }}>
            <div className="field">
              <label className="label">Date</label>
              <input className="input" type="date" max={today()} value={form.incidentDate} onChange={(e) => setForm((f: any) => ({ ...f, incidentDate: e.target.value }))} />
            </div>
            <div className="field">
              <label className="label">Location</label>
              <input className="input" value={form.location} onChange={(e) => setForm((f: any) => ({ ...f, location: e.target.value }))} />
            </div>
          </div>
          {isDemerit && (
            <div className="field">
              <label className="label">Sanction</label>
              <SearchableSelect
                value={form.sanction}
                onChange={(v) => setForm((f: any) => ({ ...f, sanction: v }))}
                options={(config?.sanctions ?? ['none']).map((s) => ({ value: s, label: s.replace('_', ' ') }))}
                aria-label="Sanction"
              />
            </div>
          )}
          <p className="text-xs text-secondary">Changing the severity re-derives the points. Every correction is recorded in the history below.</p>
        </div>
      ) : record ? (
        <div className="flex flex-col gap-4">
          <div className="grid grid-2" style={{ gap: '14px' }}>
            <Field label="Points">
              <span className={`badge ${isDemerit ? 'badge-danger' : 'badge-success'}`}>{isDemerit ? '−' : '+'}{record.points}</span>
            </Field>
            <Field label="Status"><span className="badge badge-neutral capitalize">{String(record.status).replace('_', ' ')}</span></Field>
            <Field label="Category">{record.category}{record.severity ? ` · ${record.severity}` : ''}</Field>
            <Field label="Class">{record.class_name}</Field>
            <Field label="Location">{record.location}</Field>
            <Field label="Sanction">{record.sanction && record.sanction !== 'none' ? String(record.sanction).replace('_', ' ') : '—'}</Field>
          </div>
          <Field label="Title">{record.title}</Field>
          <Field label="Description">{record.description}</Field>
          <Field label="Resolution note">{record.resolution_note}</Field>
          <div className="grid grid-2" style={{ gap: '14px' }}>
            <Field label="Logged by">{record.logged_by_name}</Field>
            <Field label="Reviewed by">{record.resolved_by_name}</Field>
          </div>

          <div>
            <div className="flex items-center gap-2 mb-2"><History size={14} /><span className="section-title" style={{ margin: 0 }}>History</span></div>
            {detail.history.length === 0 ? (
              <p className="text-xs text-secondary">No changes recorded.</p>
            ) : (
              <ul className="flex flex-col gap-2" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                {detail.history.map((h: any, i: number) => {
                  let d: any = {};
                  try { d = h.details ? JSON.parse(h.details) : {}; } catch { /* ignore */ }
                  return (
                    <li key={i} className="text-xs" style={{ borderLeft: '2px solid var(--border)', paddingLeft: '10px' }}>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold capitalize">{h.action.replace('discipline.', '').replace('_', ' ')}</span>
                        <span className="text-tertiary">{fmt(h.created_at)}{h.actor_name ? ` · ${h.actor_name}` : ''}</span>
                      </div>
                      {d.from && d.to && <div className="text-secondary">{d.from} → {d.to}</div>}
                      {d.previousValue?.points != null && d.newValue?.points != null && d.previousValue.points !== d.newValue.points && (
                        <div className="text-secondary">points {d.previousValue.points} → {d.newValue.points}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmDelete}
        title="Remove this record?"
        message={record ? `Permanently remove the ${record.category} ${record.type} for ${record.student_name}? It will be excluded from every total and the student's balance. This is kept in the audit log.` : ''}
        confirmLabel="Remove record"
        danger
        onCancel={() => setConfirmDelete(false)}
        onConfirm={remove}
      />
    </Modal>
  );
};
