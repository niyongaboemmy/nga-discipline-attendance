import React, { useCallback, useEffect, useState } from 'react';
import { Pencil, Router } from 'lucide-react';
import { ErrorState } from '../common/ErrorState';
import { Modal } from '../common/Modal';
import { apiGet, apiPut } from '../../api/client';
import type { RfidDevice } from '../../api/rfid';
import { useToast } from '../../context/ToastContext';
import { relativeTime } from '../../utils/time';
import { defer, errMsg, olderThan } from '../../utils/rfidCards';

/** The physical readers: name, place, and whether they've been heard from. */
// ───────────────────────────── Scanners tab ─────────────────────────────

export const ScannersTab: React.FC<{ canManage: boolean; version: number; onChanged: () => void }> = ({ canManage, version, onChanged }) => {
  const toast = useToast();
  const [rows, setRows] = useState<RfidDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<RfidDevice | null>(null);
  const [form, setForm] = useState({ name: '', location: '', status: 'active' as 'active' | 'disabled' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await apiGet<RfidDevice[]>('/api/rfid/devices');
      setRows(r.data ?? []);
    } catch (err) {
      setError(errMsg(err, 'Could not load scanners.'));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => defer(load), [load, version]);

  const openEdit = (d: RfidDevice) => {
    setEditing(d);
    setForm({ name: d.name || d.code, location: d.location || '', status: d.status });
  };
  const save = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      await apiPut(`/api/rfid/devices/${editing.id}`, { name: form.name.trim(), location: form.location.trim() || undefined, status: form.status });
      toast.success('Scanner updated', form.name);
      setEditing(null);
      onChanged();
    } catch (err) {
      toast.error('Could not save', errMsg(err, ''));
    } finally {
      setBusy(false);
    }
  };

  const health = (d: RfidDevice) => {
    if (d.status === 'disabled') return { cls: 'badge-neutral', label: 'Disabled' };
    if (!d.lastSeenAt) return { cls: 'badge-neutral', label: 'Never seen' };
    return olderThan(d.lastSeenAt, 24 * 3600_000) ? { cls: 'badge-late', label: 'Quiet' } : { cls: 'badge-present', label: 'Active today' };
  };

  return (
    <div className="card">
      {error && <div className="p-4"><ErrorState message={error} onRetry={load} /></div>}
      {loading ? (
        <div className="p-4 flex flex-col gap-2">{[0, 1].map((i) => <div key={i} className="rp-skeleton" />)}</div>
      ) : rows.length === 0 ? (
        <div className="empty-state" style={{ padding: '48px 0' }}>
          <Router size={28} />
          <span className="text-sm">No scanners have reported yet.</span>
          <span className="text-xs text-secondary mt-1">A scanner appears here the first time it sends a tap that includes its device ID.</span>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table table--hover">
            <thead><tr><th>Scanner</th><th>Status</th><th>Last heard</th><th>Taps (24 h)</th><th>Clock</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {rows.map((d) => {
                const h = health(d);
                const skewS = d.clockSkewMs != null ? Math.round(d.clockSkewMs / 1000) : null;
                return (
                  <tr key={d.id}>
                    <td>
                      <div className="font-medium">{d.name || d.code}</div>
                      <div className="text-xs text-secondary">{d.location || 'No location'} · <code className="mono">{d.code}</code></div>
                    </td>
                    <td><span className={`badge ${h.cls}`}>{h.label}</span></td>
                    <td className="text-sm">{d.lastSeenAt ? relativeTime(d.lastSeenAt) : '—'}</td>
                    <td>{d.scans24h}</td>
                    <td className="text-sm">
                      {skewS == null ? <span className="text-tertiary">Not reported</span>
                        : Math.abs(skewS) > 60 ? <span className="text-warning" title="Scan times use the server clock, so this does not affect attendance.">{Math.abs(skewS)} s {skewS > 0 ? 'slow' : 'fast'}</span>
                        : <span className="text-secondary">In sync</span>}
                    </td>
                    <td className="text-right">
                      {canManage && <button className="btn btn-ghost btn-sm" onClick={() => openEdit(d)}><Pencil size={13} /> Edit</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <Modal open title={`Scanner ${editing.code}`} onClose={() => setEditing(null)} maxWidth={440}
          footer={<>
            <button className="btn btn-outline" onClick={() => setEditing(null)} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={busy || !form.name.trim()}>{busy ? 'Saving…' : 'Save'}</button>
          </>}>
          <div className="flex flex-col gap-3">
            <div className="field">
              <label className="label" htmlFor="dev-name">Name</label>
              <input id="dev-name" className="input" value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="field">
              <label className="label" htmlFor="dev-loc">Location</label>
              <input id="dev-loc" className="input" value={form.location} maxLength={120} placeholder="e.g. Main gate" onChange={(e) => setForm({ ...form, location: e.target.value })} />
            </div>
            <div className="field">
              <span className="label">Status</span>
              <div className="segmented">
                {(['active', 'disabled'] as const).map((s) => (
                  <button key={s} type="button" className={`segmented-btn${form.status === s ? ' is-active' : ''}`} aria-pressed={form.status === s}
                    onClick={() => setForm({ ...form, status: s })}>{s === 'active' ? 'Active' : 'Disabled'}</button>
                ))}
              </div>
              {form.status === 'disabled' && <span className="text-xs text-secondary">Taps from a disabled scanner are logged but never recorded as attendance.</span>}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};

