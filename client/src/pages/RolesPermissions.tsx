import React, { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { ConfirmDialog } from '../components/common/ConfirmDialog';
import { Modal } from '../components/common/Modal';
import { ErrorState } from '../components/common/ErrorState';
import { useToast } from '../context/ToastContext';
import { apiGet, apiPost, apiPut, apiDelete, ApiError } from '../api/client';
import { SearchableSelect } from '../components/common/SearchableSelect';
import {
  Plus, Trash2, Save, Lock, KeyRound, Search, X, ChevronRight, ShieldAlert,
  Check, Minus, Columns3, Users, RotateCcw,
} from 'lucide-react';
import {
  permissionLabel, SENSITIVE_PERMISSIONS, ESCALATING_PERMISSIONS,
} from './rolesPermissionsMeta';

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

/** Highlights the matched substring so a filtered list shows *why* each row
 *  matched, rather than leaving the user to re-scan for it. */
const Highlight: React.FC<{ text: string; query: string }> = ({ text, query }) => {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
};

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

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newLevel, setNewLevel] = useState<RoleDetail['level']>('TEACHER');
  const [newDescription, setNewDescription] = useState('');

  const [deleteTarget, setDeleteTarget] = useState<RoleDetail | null>(null);
  const [query, setQuery] = useState('');
  const [showEnabledOnly, setShowEnabledOnly] = useState(false);
  const [showChangedOnly, setShowChangedOnly] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [compare, setCompare] = useState(false);
  // Set when a role switch is attempted with unsaved edits pending.
  const [pendingRoleId, setPendingRoleId] = useState<number | null>(null);
  const [escalationPrompt, setEscalationPrompt] = useState<string[] | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [rolesRes, permsRes] = await Promise.all([
        apiGet<RoleDetail[]>('/api/roles-permissions/roles'),
        apiGet<{ grouped: Record<string, PermissionDef[]> }>('/api/roles-permissions/permissions'),
      ]);
      const rolesData = rolesRes.data || [];
      setRoles(rolesData);
      setGrouped(permsRes.data?.grouped || {});
      if (rolesData.length > 0) setSelectedId((cur) => cur ?? rolesData[0].id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
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
  }, [selectedRole]);

  const allPermissions = useMemo(() => Object.values(grouped).flat(), [grouped]);

  // The draft compared against what's actually stored — drives the save bar,
  // the per-row "changed" marker, and the unsaved-changes guard.
  const diff = useMemo(() => {
    if (!selectedRole) return { added: [] as string[], removed: [] as string[], renamed: false };
    const saved = new Set(selectedRole.permissionKeys);
    const added = [...permissionKeys].filter((k) => !saved.has(k));
    const removed = [...saved].filter((k) => !permissionKeys.has(k));
    const renamed =
      name !== selectedRole.name || description !== (selectedRole.description || '');
    return { added, removed, renamed };
  }, [selectedRole, permissionKeys, name, description]);

  const changeCount = diff.added.length + diff.removed.length + (diff.renamed ? 1 : 0);
  const dirty = changeCount > 0;
  const changedKeys = useMemo(
    () => new Set([...diff.added, ...diff.removed]),
    [diff.added, diff.removed]
  );

  // Warn before a tab close / reload discards edits.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const togglePermission = (key: string) => {
    setPermissionKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const setGroup = (perms: PermissionDef[], on: boolean) => {
    setPermissionKeys((prev) => {
      const next = new Set(prev);
      perms.forEach((p) => (on ? next.add(p.key) : next.delete(p.key)));
      return next;
    });
  };

  const discard = () => {
    if (!selectedRole) return;
    setName(selectedRole.name);
    setDescription(selectedRole.description || '');
    setPermissionKeys(new Set(selectedRole.permissionKeys));
  };

  /** Switching roles replaces the draft, so unsaved edits would vanish
   *  silently — ask first instead. */
  const requestSelect = (id: number) => {
    if (id === selectedId) return;
    if (dirty) { setPendingRoleId(id); return; }
    setSelectedId(id);
  };

  const persist = useCallback(async () => {
    if (!selectedRole) return;
    setSaving(true);
    try {
      const res = await apiPut<RoleDetail>(`/api/roles-permissions/roles/${selectedRole.id}`, {
        name, description, permissionKeys: Array.from(permissionKeys),
      });
      toast.success('Role saved', `"${res.data!.name}" was updated.`);
      setRoles((list) => list.map((r) => (r.id === selectedRole.id ? res.data! : r)));
    } catch (err) {
      toast.error('Could not save role', err instanceof ApiError ? err.message : 'Network error.');
    } finally {
      setSaving(false);
      setEscalationPrompt(null);
    }
  }, [selectedRole, name, description, permissionKeys, toast]);

  const save = () => {
    // Granting the ability to manage roles or users lets this role widen its
    // own access later — worth one deliberate confirmation.
    const escalating = diff.added.filter((k) => ESCALATING_PERMISSIONS.has(k));
    if (escalating.length > 0) { setEscalationPrompt(escalating); return; }
    persist();
  };

  const createRole = async () => {
    if (!newName.trim()) return;
    setSaving(true);
    try {
      const res = await apiPost<RoleDetail>('/api/roles-permissions/roles', {
        name: newName, level: newLevel, description: newDescription, permissionKeys: [],
      });
      toast.success('Role created', `"${res.data!.name}" is ready to configure.`);
      setRoles((list) => [...list, res.data!]);
      setSelectedId(res.data!.id);
      setCreating(false);
      setNewName(''); setNewDescription(''); setNewLevel('TEACHER');
    } catch (err) {
      toast.error('Could not create role', err instanceof ApiError ? err.message : 'Network error.');
    } finally {
      setSaving(false);
    }
  };

  const deleteRole = async () => {
    if (!deleteTarget) return;
    setSaving(true);
    try {
      await apiDelete(`/api/roles-permissions/roles/${deleteTarget.id}`);
      toast.success('Role deleted', `"${deleteTarget.name}" was removed.`);
      setRoles((list) => list.filter((r) => r.id !== deleteTarget.id));
      if (selectedId === deleteTarget.id) setSelectedId(null);
      setDeleteTarget(null);
    } catch (err) {
      toast.error('Could not delete role', err instanceof ApiError ? err.message : 'Network error.');
    } finally {
      setSaving(false);
    }
  };

  /** Groups surviving the search + chip filters. Groups keep their header
   *  (with a match count) so results stay anchored to their resource. */
  const visibleGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: Array<{ category: string; perms: PermissionDef[]; total: number }> = [];
    for (const [category, perms] of Object.entries(grouped)) {
      let list = perms;
      if (q) {
        list = list.filter(
          (p) =>
            p.key.toLowerCase().includes(q) ||
            p.description.toLowerCase().includes(q) ||
            permissionLabel(p.key).toLowerCase().includes(q) ||
            category.toLowerCase().includes(q)
        );
      }
      if (showEnabledOnly) list = list.filter((p) => permissionKeys.has(p.key));
      if (showChangedOnly) list = list.filter((p) => changedKeys.has(p.key));
      if (list.length) out.push({ category, perms: list, total: perms.length });
    }
    return out;
  }, [grouped, query, showEnabledOnly, showChangedOnly, permissionKeys, changedKeys]);

  const filtering = !!query.trim() || showEnabledOnly || showChangedOnly;
  const clearFilters = () => { setQuery(''); setShowEnabledOnly(false); setShowChangedOnly(false); };
  const enabledCount = permissionKeys.size;

  const levelBadge = (level: RoleDetail['level']) =>
    level === 'ADMIN' ? 'badge-primary' : level === 'TEACHER' ? 'badge-info' : 'badge-neutral';

  return (
    <DashboardLayout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Roles &amp; Permissions</h1>
          <p className="page-subtitle">Create custom roles and control exactly what each one can do.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            className={`btn btn-outline btn-sm${compare ? ' is-active' : ''}`}
            onClick={() => setCompare((v) => !v)}
            aria-pressed={compare}
          >
            <Columns3 size={15} /> {compare ? 'Edit roles' : 'Compare roles'}
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
            <Plus size={16} /> New role
          </button>
        </div>
      </div>

      {loading ? (
        <div className="rp-layout">
          <div className="card card-pad flex flex-col gap-2">
            {[0, 1, 2].map((i) => <div key={i} className="rp-skeleton" />)}
          </div>
          <div className="card card-pad flex flex-col gap-2">
            {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="rp-skeleton" />)}
          </div>
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : compare ? (
        <CompareMatrix roles={roles} grouped={grouped} />
      ) : (
        <div className="rp-layout">
          {/* ---- Role rail ---- */}
          <div className="card rp-rail">
            <div className="rp-rail-head">
              <span className="section-title">Roles</span>
              <span className="text-xs text-secondary">{roles.length}</span>
            </div>
            <div className="rp-rail-list" role="tablist" aria-label="Roles">
              {roles.map((r) => (
                <button
                  key={r.id}
                  role="tab"
                  aria-selected={r.id === selectedId}
                  onClick={() => requestSelect(r.id)}
                  className={`rp-role${r.id === selectedId ? ' is-active' : ''}`}
                >
                  <span className="rp-role-avatar">
                    {r.is_system === 1 ? <Lock size={13} /> : <KeyRound size={13} />}
                  </span>
                  <span className="rp-role-main">
                    <span className="rp-role-name">{r.name}</span>
                    <span className="rp-role-meta">
                      {r.level} · {r.userCount} user{r.userCount === 1 ? '' : 's'}
                    </span>
                  </span>
                  <span className="rp-role-count">{r.permissionKeys.length}</span>
                </button>
              ))}
            </div>
          </div>

          {/* ---- Editor ---- */}
          {selectedRole ? (
            <div className="card">
              <div className="rp-head">
                <div className="rp-head-top">
                  <div style={{ flex: 1, minWidth: 240 }}>
                    <input
                      className="rp-name-input"
                      value={name}
                      aria-label="Role name"
                      onChange={(e) => setName(e.target.value)}
                    />
                    <textarea
                      className="rp-desc-input"
                      placeholder="Add a short description…"
                      aria-label="Role description"
                      value={description}
                      rows={2}
                      onChange={(e) => setDescription(e.target.value)}
                    />
                  </div>
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
                </div>
                <div className="rp-meta-row">
                  <span className={`badge ${levelBadge(selectedRole.level)}`}>{selectedRole.level}</span>
                  <span className="badge badge-neutral">
                    <Users size={11} style={{ marginRight: 4 }} />
                    {selectedRole.userCount} assigned
                  </span>
                  <span className="badge badge-neutral">{enabledCount} of {allPermissions.length} permissions</span>
                  {selectedRole.is_system === 1 && (
                    <span className="badge badge-neutral"><Lock size={11} style={{ marginRight: 4 }} /> System role</span>
                  )}
                </div>
              </div>

              {/* ---- Toolbar ---- */}
              <div className="rp-toolbar">
                <div className="rp-search">
                  <Search className="field-icon" size={15} />
                  <input
                    className="input"
                    placeholder="Search permissions…"
                    value={query}
                    aria-label="Search permissions"
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {query && (
                    <button className="rp-search-clear" onClick={() => setQuery('')} aria-label="Clear search">
                      <X size={13} />
                    </button>
                  )}
                </div>
                <button
                  className={`rp-chip${showEnabledOnly ? ' is-on' : ''}`}
                  onClick={() => setShowEnabledOnly((v) => !v)}
                  aria-pressed={showEnabledOnly}
                >
                  Enabled <span className="rp-chip-num">{enabledCount}</span>
                </button>
                <button
                  className={`rp-chip${showChangedOnly ? ' is-on' : ''}`}
                  onClick={() => setShowChangedOnly((v) => !v)}
                  aria-pressed={showChangedOnly}
                  disabled={changedKeys.size === 0}
                >
                  Changed <span className="rp-chip-num">{changedKeys.size}</span>
                </button>
                <button
                  className="rp-chip"
                  onClick={() =>
                    setCollapsed((prev) =>
                      prev.size ? new Set() : new Set(Object.keys(grouped))
                    )
                  }
                >
                  {collapsed.size ? 'Expand all' : 'Collapse all'}
                </button>
              </div>

              {/* ---- Groups ---- */}
              <div className="rp-groups">
                {visibleGroups.length === 0 ? (
                  <div className="empty-state" style={{ padding: '48px 0' }}>
                    <Search size={26} />
                    <span className="text-sm">No permissions match these filters.</span>
                    <button className="btn btn-outline btn-sm mt-3" onClick={clearFilters}>
                      <RotateCcw size={14} /> Clear filters
                    </button>
                  </div>
                ) : (
                  visibleGroups.map(({ category, perms, total }) => {
                    const isOpen = !collapsed.has(category);
                    const groupOn = grouped[category].filter((p) => permissionKeys.has(p.key)).length;
                    return (
                      <fieldset key={category} className="rp-fieldset rp-group">
                        <legend className="sr-only">{category}</legend>
                        <div className="rp-group-head">
                          <button
                            type="button"
                            onClick={() =>
                              setCollapsed((prev) => {
                                const next = new Set(prev);
                                if (next.has(category)) next.delete(category); else next.add(category);
                                return next;
                              })
                            }
                            aria-expanded={isOpen}
                            className="flex items-center gap-2"
                            style={{ flex: 1, textAlign: 'left' }}
                          >
                            <ChevronRight size={15} className={`rp-group-caret${isOpen ? ' is-open' : ''}`} />
                            <span className="rp-group-title">
                              <Highlight text={category} query={query} />
                            </span>
                          </button>
                          <span className={`rp-group-count${groupOn === grouped[category].length ? ' is-full' : ''}`}>
                            {filtering ? `${perms.length} of ${total} shown` : `${groupOn}/${grouped[category].length}`}
                          </span>
                          <GroupCheckbox
                            perms={perms}
                            enabled={permissionKeys}
                            onChange={(next) => setGroup(perms, next)}
                            label={category}
                          />
                        </div>

                        {isOpen && (
                          <div className="rp-group-body">
                            {perms.map((p) => {
                              const checked = permissionKeys.has(p.key);
                              const changed = changedKeys.has(p.key);
                              return (
                                <label
                                  key={p.key}
                                  className={`rp-perm${changed ? ' is-changed' : ''}`}
                                >
                                  <input
                                    type="checkbox"
                                    className="rp-check"
                                    checked={checked}
                                    onChange={() => togglePermission(p.key)}
                                    aria-describedby={`desc-${p.key}`}
                                  />
                                  <span className="rp-perm-body">
                                    <span className="rp-perm-label">
                                      <Highlight text={permissionLabel(p.key)} query={query} />
                                      {SENSITIVE_PERMISSIONS.has(p.key) && (
                                        <span className="rp-badge-sensitive">
                                          <ShieldAlert size={9} /> Sensitive
                                        </span>
                                      )}
                                    </span>
                                    <span className="rp-perm-desc" id={`desc-${p.key}`}>
                                      <Highlight text={p.description} query={query} />
                                    </span>
                                    <span className="rp-perm-key">
                                      <Highlight text={p.key} query={query} />
                                    </span>
                                  </span>
                                </label>
                              );
                            })}
                          </div>
                        )}
                      </fieldset>
                    );
                  })
                )}
              </div>

              {/* ---- Contextual save bar ---- */}
              {dirty && (
                <div className="rp-savebar">
                  <span className="rp-savebar-msg" role="status">
                    <span className="rp-dot" />
                    {changeCount} unsaved change{changeCount === 1 ? '' : 's'}
                    {(diff.added.length > 0 || diff.removed.length > 0) && (
                      <span className="text-tertiary">
                        · {diff.added.length} added, {diff.removed.length} removed
                      </span>
                    )}
                  </span>
                  <div className="flex items-center gap-2">
                    <button className="btn btn-ghost btn-sm" onClick={discard} disabled={saving}>
                      Discard
                    </button>
                    <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
                      <Save size={14} /> {saving ? 'Saving…' : 'Save changes'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="card">
              <div className="empty-state" style={{ padding: '60px 0' }}>
                <KeyRound size={28} />
                <span className="text-sm">Select a role to edit its permissions.</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ---- New role ---- */}
      <Modal open={creating} title="New role" onClose={() => setCreating(false)}>
        <div className="flex flex-col gap-3">
          <label className="text-sm font-medium">Name
            <input className="input mt-1" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Discipline Coordinator" />
          </label>
          <label className="text-sm font-medium">Level
            <SearchableSelect
              className="mt-1"
              aria-label="Level"
              value={newLevel}
              onChange={(v) => setNewLevel(v as RoleDetail['level'])}
              options={LEVELS.map((l) => ({ value: l, label: l }))}
            />
          </label>
          <label className="text-sm font-medium">Description
            <textarea className="input mt-1" rows={2} value={newDescription} onChange={(e) => setNewDescription(e.target.value)} />
          </label>
          <p className="text-xs text-secondary">
            The new role starts with no permissions — you’ll pick them next.
          </p>
          <div className="flex justify-end gap-2 mt-2">
            <button className="btn btn-outline btn-sm" onClick={() => setCreating(false)}>Cancel</button>
            <button className="btn btn-primary btn-sm" onClick={createRole} disabled={!newName.trim() || saving}>
              {saving ? 'Creating…' : 'Create role'}
            </button>
          </div>
        </div>
      </Modal>

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

      <ConfirmDialog
        open={pendingRoleId !== null}
        title="Discard unsaved changes?"
        message={`You have ${changeCount} unsaved change${changeCount === 1 ? '' : 's'} to "${selectedRole?.name ?? ''}". Switching roles will discard them.`}
        confirmLabel="Discard and switch"
        danger
        onCancel={() => setPendingRoleId(null)}
        onConfirm={() => { setSelectedId(pendingRoleId); setPendingRoleId(null); }}
      />

      <ConfirmDialog
        open={escalationPrompt !== null}
        title="Grant elevated access?"
        message={
          escalationPrompt
            ? `This grants ${escalationPrompt.map(permissionLabel).join(' and ')}. Anyone with this role will be able to change what other people can do — including their own access.`
            : ''
        }
        confirmLabel="Grant and save"
        loading={saving}
        onCancel={() => setEscalationPrompt(null)}
        onConfirm={persist}
      />
    </DashboardLayout>
  );
};

/**
 * Group parent checkbox. `indeterminate` is a DOM property, not an
 * attribute, and must be set imperatively — using aria-checked="mixed" on a
 * native checkbox does not work, because the host language state wins.
 */
const GroupCheckbox: React.FC<{
  perms: PermissionDef[];
  enabled: Set<string>;
  onChange: (next: boolean) => void;
  label: string;
}> = ({ perms, enabled, onChange, label }) => {
  const ref = useRef<HTMLInputElement>(null);
  const on = perms.filter((p) => enabled.has(p.key)).length;
  const all = on === perms.length && perms.length > 0;
  const some = on > 0 && !all;

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = some;
  }, [some]);

  return (
    <input
      ref={ref}
      type="checkbox"
      className="rp-check"
      checked={all}
      onChange={() => onChange(!all)}
      aria-label={`Toggle all ${label} permissions`}
      style={{ marginTop: 0 }}
    />
  );
};

/**
 * Read-only audit view: permissions as rows, roles as columns. A real
 * <table> (not restyled divs) so row/column headers are announced, wrapped
 * in a focusable region so it can be scrolled by keyboard when it overflows.
 */
const CompareMatrix: React.FC<{
  roles: RoleDetail[];
  grouped: Record<string, PermissionDef[]>;
}> = ({ roles, grouped }) => {
  const sets = useMemo(
    () => new Map(roles.map((r) => [r.id, new Set(r.permissionKeys)])),
    [roles]
  );

  return (
    <div className="card card-pad">
      <p className="text-xs text-secondary mb-3">
        Read-only overview of every role side by side. Switch back to “Edit roles” to make changes.
      </p>
      <div
        className="rp-matrix-wrap"
        role="region"
        aria-label="Role permission comparison"
        tabIndex={0}
      >
        <table className="rp-matrix">
          <thead>
            <tr>
              <th scope="col">Permission</th>
              {roles.map((r) => (
                <th key={r.id} scope="col">{r.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.entries(grouped).map(([category, perms]) => (
              <React.Fragment key={category}>
                <tr className="rp-matrix-group">
                  <th scope="colgroup" colSpan={roles.length + 1}>{category}</th>
                </tr>
                {perms.map((p) => (
                  <tr key={p.key}>
                    <th scope="row">
                      <span className="rp-perm-label">{permissionLabel(p.key)}</span>
                      {SENSITIVE_PERMISSIONS.has(p.key) && (
                        <span className="rp-badge-sensitive"><ShieldAlert size={9} /> Sensitive</span>
                      )}
                    </th>
                    {roles.map((r) => {
                      const has = sets.get(r.id)?.has(p.key);
                      return (
                        <td key={r.id}>
                          {has ? (
                            <Check size={15} className="rp-yes" aria-label="Allowed" />
                          ) : (
                            <Minus size={15} className="rp-no" aria-label="Not allowed" />
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
