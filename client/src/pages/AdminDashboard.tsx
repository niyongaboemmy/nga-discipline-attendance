import React, { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { Users, GraduationCap, Briefcase, ShieldCheck, HelpCircle, Search, Check, AlertCircle, Inbox, KeyRound } from 'lucide-react';
import { useAuth, type Role } from '../context/AuthContext';
import { usePermissions } from '../hooks/usePermissions';
import { ConfirmDialog } from '../components/common/ConfirmDialog';
import { HeroBanner } from '../components/common/HeroBanner';
import { useToast } from '../context/ToastContext';

interface ManagedUser {
  id: string;
  name: string;
  email: string | null;
  role: Role;
  role_id: number | null;
  status: string;
  source: string;
  last_login: string | null;
}
interface Overview { total: number; students: number; teachers: number; admins: number; unassigned: number; }
interface RoleOption { id: number; name: string; level: 'STUDENT' | 'TEACHER' | 'ADMIN'; is_system: number; }

const roleBadge = (r: Role) =>
  r === 'admin' ? 'badge-primary' : r === 'teacher' ? 'badge-info' : r === 'student' ? 'badge-success' : 'badge-warning';

const authHeaders = () => ({ Authorization: `Bearer ${localStorage.getItem('sso_token')}` });
const initials = (name: string) => name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2);

export const AdminDashboard: React.FC = () => {
  const toast = useToast();
  const { user } = useAuth();
  const { can } = usePermissions();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  // A role change requested via the dropdown, awaiting confirmation.
  const [pending, setPending] = useState<{ id: string; name: string; fromRoleId: number | null; toRoleId: number; toName: string } | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const requests = [
        fetch('/api/admin/overview', { headers: authHeaders() }),
        fetch('/api/admin/users', { headers: authHeaders() }),
        fetch('/api/roles-permissions/roles', { headers: authHeaders() }),
      ];
      const [oRes, uRes, rRes] = await Promise.all(requests);
      if (!oRes.ok || !uRes.ok) throw new Error('Failed to load admin data.');
      const o = await oRes.json();
      const u = await uRes.json();
      if (!o.success || !u.success) throw new Error('Server returned an error.');
      setOverview(o.data);
      setUsers(u.data);
      if (rRes.ok) {
        const r = await rRes.json();
        if (r.success) setRoles(r.data);
      }
    } catch (err) {
      setError((err as Error).message || 'Could not reach the server.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const changeRole = async (id: string, roleId: number) => {
    setSavingId(id);
    setSavedId(null);
    const prev = users;
    const targetRole = roles.find((r) => r.id === roleId);
    setUsers((list) => list.map((u) => (u.id === id
      ? { ...u, role_id: roleId, role: (targetRole?.level.toLowerCase() as Role) ?? u.role }
      : u)));
    try {
      const res = await fetch(`/api/admin/users/${id}/role`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ role_id: roleId }),
      });
      const result = await res.json();
      if (!res.ok || !result.success) throw new Error(result.message || 'Update failed.');
      setSavedId(id);
      toast.success('Role updated', `${result.data?.name || 'User'} is now ${targetRole?.name || 'updated'}`);
      setTimeout(() => setSavedId((s) => (s === id ? null : s)), 2000);
      // refresh counts to reflect the change
      const oRes = await fetch('/api/admin/overview', { headers: authHeaders() });
      if (oRes.ok) { const o = await oRes.json(); if (o.success) setOverview(o.data); }
    } catch (err) {
      setUsers(prev); // revert optimistic update
      toast.error('Could not update role', (err as Error).message);
    } finally {
      setSavingId(null);
    }
  };

  // Open the confirm dialog when a different role is chosen.
  const requestRoleChange = (u: ManagedUser, toRoleId: number) => {
    if (toRoleId === u.role_id) return;
    const toName = roles.find((r) => r.id === toRoleId)?.name || 'this role';
    setPending({ id: u.id, name: u.name, fromRoleId: u.role_id, toRoleId, toName });
  };

  const visible = useMemo(
    () => users.filter((u) =>
      [u.name, u.email || '', u.id].some((f) => f.toLowerCase().includes(search.toLowerCase()))),
    [users, search],
  );

  const currentRoleName = (u: ManagedUser) => roles.find((r) => r.id === u.role_id)?.name || (u.role === 'unassigned' ? 'Unassigned' : u.role);

  const cards = overview ? [
    { label: 'Total Users', value: overview.total, icon: <Users size={18} />, accent: 'var(--primary)', tag: 'Roster' },
    { label: 'Students', value: overview.students, icon: <GraduationCap size={18} />, accent: 'var(--success)', tag: 'Role' },
    { label: 'Teachers', value: overview.teachers, icon: <Briefcase size={18} />, accent: 'var(--info)', tag: 'Role' },
    { label: 'Admins', value: overview.admins, icon: <ShieldCheck size={18} />, accent: 'var(--accent)', tag: 'Role' },
    { label: 'Unassigned', value: overview.unassigned, icon: <HelpCircle size={18} />, accent: 'var(--warning)', tag: 'Action Needed' },
  ] : [];

  return (
    <DashboardLayout>
      {user && (
        <HeroBanner name={user.name} role={user.role} title={`Welcome back, ${user.name.split(' ')[0]}!`}>
          {overview ? (
            <>
              <strong>{overview.total} users</strong> in the system
              {overview.unassigned > 0
                ? <> · <strong>{overview.unassigned} awaiting</strong> a role assignment</>
                : <> · every account has a role assigned 🎉</>}
            </>
          ) : (
            <>Manage user roles and review system membership.</>
          )}
        </HeroBanner>
      )}

      {can(['ROLES_PERMISSIONS_VIEW', 'ROLES_PERMISSIONS_MANAGE']) && (
        <div className="card card-pad mb-4 flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <KeyRound size={20} color="var(--accent)" />
            <div>
              <div className="font-semibold text-sm">Roles &amp; Permissions</div>
              <div className="text-xs text-secondary">Create custom roles and fine-tune what each one can do.</div>
            </div>
          </div>
          <Link to="/admin/roles" className="btn btn-outline btn-sm">Manage roles</Link>
        </div>
      )}

      {loading ? (
        <div style={{ padding: '80px 0' }}><LoadingSpinner /></div>
      ) : error && !users.length ? (
        <div className="card"><div className="empty-state"><AlertCircle size={28} /><span className="text-sm">{error}</span>
          <button className="btn btn-outline btn-sm mt-2" onClick={load}>Retry</button></div></div>
      ) : (
        <>
          {/* System overview */}
          <div className="grid mb-6" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '16px' }}>
            {cards.map((c) => (
              <div key={c.label} className="stat-card" style={{ ['--accent-color' as string]: c.accent }}>
                <div className="flex items-center justify-between">
                  <span className="stat-icon">{c.icon}</span>
                  <span className="stat-tag">{c.tag}</span>
                </div>
                <div className="stat-value">{c.value}</div>
                <span className="stat-label">{c.label}</span>
              </div>
            ))}
          </div>

          {error && <div className="alert alert-danger mb-4"><AlertCircle size={16} /><span>{error}</span></div>}

          {/* User management */}
          <section className="card">
            <div className="card-header">
              <span className="section-title">User management</span>
              <div className="input-with-icon" style={{ width: '260px', maxWidth: '50%' }}>
                <Search className="field-icon" size={16} />
                <input className="input" placeholder="Search users…" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
            </div>

            {visible.length === 0 ? (
              <div className="empty-state"><Inbox size={28} /><span className="text-sm">No users found.</span></div>
            ) : (
              <div className="table-wrap">
                <table className="table table--hover">
                  <thead>
                    <tr><th>User</th><th>Email</th><th>Status</th><th>Role</th><th></th></tr>
                  </thead>
                  <tbody>
                    {visible.map((u) => (
                      <tr key={u.id}>
                        <td>
                          <div className="flex items-center gap-3">
                            <div className="avatar avatar-square avatar-sm">{initials(u.name)}</div>
                            <div>
                              <div className="font-medium">{u.name}</div>
                              <div className="text-xs text-secondary mono">{u.id}</div>
                            </div>
                          </div>
                        </td>
                        <td className="text-secondary">{u.email || '—'}</td>
                        <td><span className={`badge ${u.status === 'active' ? 'badge-success' : 'badge-neutral'}`}>{u.status}</span></td>
                        <td><span className={`badge ${roleBadge(u.role)}`}>{currentRoleName(u)}</span></td>
                        <td className="text-right">
                          <div className="flex items-center gap-2 justify-end">
                            {savedId === u.id && <span className="text-success flex items-center gap-1 text-xs"><Check size={14} /> Saved</span>}
                            <select
                              className="select"
                              style={{ width: 'auto', height: '34px' }}
                              value={u.role_id ?? ''}
                              disabled={savingId === u.id || !can('USERS_MANAGE')}
                              onChange={(e) => requestRoleChange(u, Number(e.target.value))}
                            >
                              {u.role_id == null && <option value="" disabled>Unassigned</option>}
                              {roles.map((r) => <option key={r.id} value={r.id}>{r.level} — {r.name}</option>)}
                            </select>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="card-footer flex justify-between text-xs text-secondary">
              <span>{visible.length} of {users.length} users</span>
              <span>Backend access updates immediately; the user's own screen refreshes on next sign-in</span>
            </div>
          </section>
        </>
      )}

      <ConfirmDialog
        open={!!pending}
        title="Change user role?"
        message={pending ? `${pending.name} will be assigned "${pending.toName}". This takes effect on the backend immediately.` : ''}
        confirmLabel="Change role"
        loading={!!pending && savingId === pending.id}
        onCancel={() => setPending(null)}
        onConfirm={async () => {
          if (!pending) return;
          const { id, toRoleId } = pending;
          setPending(null);
          await changeRole(id, toRoleId);
        }}
      />
    </DashboardLayout>
  );
};
