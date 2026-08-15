import React, { useEffect, useState, useMemo } from 'react';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { ConfirmDialog } from '../components/common/ConfirmDialog';
import { useToast } from '../context/ToastContext';
import { Plus, Trash2, Save, Lock, AlertCircle, KeyRound } from 'lucide-react';

interface PermissionDef { key: string; category: string; description: string; }
interface RoleDetail {
  id: number;
  name: string;
  level: 'STUDENT' | 'TEACHER' | 'ADMIN';
  description: string | null;
  is_system: number;
  permissionKeys: string[];
  userCount: number;
}

const LEVELS: RoleDetail['level'][] = ['STUDENT', 'TEACHER', 'ADMIN'];
const authHeaders = () => ({ Authorization: `Bearer ${localStorage.getItem('sso_token')}` });

export const RolesPermissions: React.FC = () => {
  const toast = useToast();
  const [roles, setRoles] = useState<RoleDetail[]>([]);
  const [grouped, setGrouped] = useState<Record<string, PermissionDef[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // Editable draft for the selected role.
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [permissionKeys, setPermissionKeys] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Create-role modal state.
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newLevel, setNewLevel] = useState<RoleDetail['level']>('TEACHER');
  const [newDescription, setNewDescription] = useState('');

  const [deleteTarget, setDeleteTarget] = useState<RoleDetail | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [rolesRes, permsRes] = await Promise.all([
        fetch('/api/roles-permissions/roles', { headers: authHeaders() }),
        fetch('/api/roles-permissions/permissions', { headers: authHeaders() }),
      ]);
      const rolesJson = await rolesRes.json();
      const permsJson = await permsRes.json();
      if (!rolesRes.ok || !rolesJson.success) throw new Error(rolesJson.message || 'Failed to load roles.');
      if (!permsRes.ok || !permsJson.success) throw new Error(permsJson.message || 'Failed to load permissions.');
      setRoles(rolesJson.data);
      setGrouped(permsJson.data.grouped);
      if (rolesJson.data.length > 0) setSelectedId((cur) => cur ?? rolesJson.data[0].id);
    } catch (err) {
      setError((err as Error).message || 'Could not reach the server.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const selectedRole = useMemo(() => roles.find((r) => r.id === selectedId) || null, [roles, selectedId]);

  useEffect(() => {
    if (!selectedRole) return;
    setName(selectedRole.name);
    setDescription(selectedRole.description || '');
    setPermissionKeys(new Set(selectedRole.permissionKeys));
    setDirty(false);
  }, [selectedRole]);

  const togglePermission = (key: string) => {
    setPermissionKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
    setDirty(true);
  };

  const save = async () => {
    if (!selectedRole) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/roles-permissions/roles/${selectedRole.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ name, description, permissionKeys: Array.from(permissionKeys) }),
      });
      const result = await res.json();
      if (!res.ok || !result.success) throw new Error(result.message || 'Could not save role.');
      toast.success('Role saved', `"${result.data.name}" was updated.`);
      setRoles((list) => list.map((r) => (r.id === selectedRole.id ? result.data : r)));
      setDirty(false);
    } catch (err) {
      toast.error('Could not save role', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const createRole = async () => {
    if (!newName.trim()) return;
    setSaving(true);
    try {
      const res = await fetch('/api/roles-permissions/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ name: newName, level: newLevel, description: newDescription, permissionKeys: [] }),
      });
      const result = await res.json();
      if (!res.ok || !result.success) throw new Error(result.message || 'Could not create role.');
      toast.success('Role created', `"${result.data.name}" is ready to configure.`);
      setRoles((list) => [...list, result.data]);
      setSelectedId(result.data.id);
      setCreating(false);
      setNewName(''); setNewDescription(''); setNewLevel('TEACHER');
    } catch (err) {
      toast.error('Could not create role', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const deleteRole = async () => {
    if (!deleteTarget) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/roles-permissions/roles/${deleteTarget.id}`, { method: 'DELETE', headers: authHeaders() });
      const result = await res.json();
      if (!res.ok || !result.success) throw new Error(result.message || 'Could not delete role.');
      toast.success('Role deleted', `"${deleteTarget.name}" was removed.`);
      setRoles((list) => list.filter((r) => r.id !== deleteTarget.id));
      if (selectedId === deleteTarget.id) setSelectedId(null);
      setDeleteTarget(null);
    } catch (err) {
      toast.error('Could not delete role', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <DashboardLayout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Roles &amp; Permissions</h1>
          <p className="page-subtitle">Create custom roles and control exactly what each one can do.</p>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
          <Plus size={16} /> New role
        </button>
      </div>

      {loading ? (
        <div style={{ padding: '80px 0' }}><LoadingSpinner /></div>
      ) : error ? (
        <div className="card"><div className="empty-state"><AlertCircle size={28} /><span className="text-sm">{error}</span>
          <button className="btn btn-outline btn-sm mt-2" onClick={load}>Retry</button></div></div>
      ) : (
        <div className="grid grid-sidebar" style={{ ['--sidebar-col-width' as string]: '260px', gap: '20px', alignItems: 'start' }}>
          {/* Role list */}
          <div className="card">
            <div className="card-header"><span className="section-title text-base">Roles</span></div>
            <div>
              {roles.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setSelectedId(r.id)}
                  className={`menu-item w-full text-left${r.id === selectedId ? ' is-active' : ''}`}
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '2px' }}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{r.name}</span>
                    {r.is_system === 1 && <Lock size={12} className="text-tertiary" />}
                  </div>
                  <div className="text-xs text-secondary">{r.level} · {r.userCount} user{r.userCount === 1 ? '' : 's'}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Role editor */}
          {selectedRole ? (
            <div className="card card-pad">
              <div className="flex items-start justify-between mb-4 flex-wrap gap-3">
                <div style={{ flex: 1, minWidth: '240px' }}>
                  <input
                    className="input mb-2"
                    value={name}
                    onChange={(e) => { setName(e.target.value); setDirty(true); }}
                    style={{ fontSize: '18px', fontWeight: 600 }}
                  />
                  <textarea
                    className="input"
                    placeholder="Description (optional)"
                    value={description}
                    onChange={(e) => { setDescription(e.target.value); setDirty(true); }}
                    rows={2}
                  />
                  <div className="text-xs text-secondary mt-2">
                    Level: <strong>{selectedRole.level}</strong> (fixed) · {selectedRole.userCount} user{selectedRole.userCount === 1 ? '' : 's'} assigned
                    {selectedRole.is_system === 1 && <> · <Lock size={12} style={{ display: 'inline', verticalAlign: '-1px' }} /> system role (cannot be deleted)</>}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {selectedRole.is_system === 0 && (
                    <button
                      className="btn btn-outline btn-sm"
                      onClick={() => setDeleteTarget(selectedRole)}
                      disabled={selectedRole.userCount > 0}
                      title={selectedRole.userCount > 0 ? 'Reassign all users off this role first' : undefined}
                    >
                      <Trash2 size={14} /> Delete
                    </button>
                  )}
                  <button className="btn btn-primary btn-sm" onClick={save} disabled={!dirty || saving}>
                    <Save size={14} /> {saving ? 'Saving…' : 'Save changes'}
                  </button>
                </div>
              </div>

              <div className="flex flex-col gap-4">
                {Object.entries(grouped).map(([category, perms]) => (
                  <div key={category}>
                    <div className="section-title text-sm mb-2">{category}</div>
                    <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '8px' }}>
                      {perms.map((p) => (
                        <label key={p.key} className="flex items-start gap-2 text-sm" style={{ cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={permissionKeys.has(p.key)}
                            onChange={() => togglePermission(p.key)}
                            style={{ marginTop: '3px' }}
                          />
                          <span>
                            <div className="font-medium">{p.key}</div>
                            <div className="text-xs text-secondary">{p.description}</div>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="card"><div className="empty-state"><KeyRound size={28} /><span className="text-sm">Select a role to edit its permissions.</span></div></div>
          )}
        </div>
      )}

      {/* Create-role modal (reuses ConfirmDialog's overlay pattern via a simple inline modal) */}
      {creating && (
        <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) setCreating(false); }}>
          <div className="modal-card" role="dialog" aria-modal="true" aria-label="New role">
            <div className="card-header"><span className="section-title text-base">New role</span></div>
            <div className="card-pad flex flex-col gap-3">
              <label className="text-sm font-medium">Name
                <input className="input mt-1" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Discipline Coordinator" />
              </label>
              <label className="text-sm font-medium">Level
                <select className="select mt-1" value={newLevel} onChange={(e) => setNewLevel(e.target.value as RoleDetail['level'])}>
                  {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </label>
              <label className="text-sm font-medium">Description
                <textarea className="input mt-1" rows={2} value={newDescription} onChange={(e) => setNewDescription(e.target.value)} />
              </label>
              <div className="flex justify-end gap-2 mt-2">
                <button className="btn btn-outline btn-sm" onClick={() => setCreating(false)}>Cancel</button>
                <button className="btn btn-primary btn-sm" onClick={createRole} disabled={!newName.trim() || saving}>
                  {saving ? 'Creating…' : 'Create role'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete role?"
        message={deleteTarget ? `"${deleteTarget.name}" will be permanently deleted. This cannot be undone.` : ''}
        confirmLabel="Delete"
        danger
        loading={saving}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={deleteRole}
      />
    </DashboardLayout>
  );
};
