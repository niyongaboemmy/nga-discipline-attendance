import React, { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { Users, GraduationCap, Briefcase, ShieldCheck, HelpCircle, Search, Check, AlertCircle, Inbox, KeyRound, RefreshCw, X, ArrowUpDown, ChevronRight } from 'lucide-react';
import { useAuth, type Role } from '../context/AuthContext';
import { usePermissions } from '../hooks/usePermissions';
import { ConfirmDialog } from '../components/common/ConfirmDialog';
import { HeroBanner } from '../components/common/HeroBanner';
import { SearchableSelect } from '../components/common/SearchableSelect';
import { useToast } from '../context/ToastContext';
import { apiPost, ApiError } from '../api/client';

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
  // 'all' | a role level | 'unassigned' — also what the stat cards set.
  const [segment, setSegment] = useState<'all' | 'student' | 'teacher' | 'admin' | 'unassigned'>('all');
  const [sortAsc, setSortAsc] = useState(true);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 12;
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  // A role change requested via the dropdown, awaiting confirmation.
  const [pending, setPending] = useState<{ id: string; name: string; fromRoleId: number | null; toRoleId: number; toName: string } | null>(null);
  const [syncing, setSyncing] = useState(false);

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

  // Populates the local subjects/timetable/academic-period cache from the
  // MIS (server/src/modules/academics/academicsSync.service.ts). Without
  // this, class_subject_assignments and subjects stay empty forever and
  // MarkAttendance's "Subject / course" mode has nothing to select from —
  // this is the only place that call is wired up to a UI action.
  const syncFromMis = async () => {
    setSyncing(true);
    try {
      const res = await apiPost<{ years: number; terms: number; subjects: number; assignments: number }>('/api/academics/sync');
      const d = res.data!;
      toast.success('Synced from MIS', `${d.years} years, ${d.terms} terms, ${d.subjects} subjects, ${d.assignments} timetable entries.`);
    } catch (err) {
      toast.error('Sync failed', err instanceof ApiError ? err.message : 'Could not reach the server.');
    } finally {
      setSyncing(false);
    }
  };

  // Open the confirm dialog when a different role is chosen.
  const requestRoleChange = (u: ManagedUser, toRoleId: number) => {
    if (toRoleId === u.role_id) return;
    const toName = roles.find((r) => r.id === toRoleId)?.name || 'this role';
    setPending({ id: u.id, name: u.name, fromRoleId: u.role_id, toRoleId, toName });
  };

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users
      .filter((u) => (segment === 'all' ? true : u.role === segment))
      .filter((u) =>
        !q || [u.name, u.email || '', u.id].some((f) => f.toLowerCase().includes(q)))
      .sort((a, b) => {
        // Accounts still awaiting a role are the actionable ones, so they
        // lead regardless of the name sort direction.
        const aPending = a.role === 'unassigned' ? 0 : 1;
        const bPending = b.role === 'unassigned' ? 0 : 1;
        if (aPending !== bPending) return aPending - bPending;
        return (sortAsc ? 1 : -1) * a.name.localeCompare(b.name);
      });
  }, [users, search, segment, sortAsc]);

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const paged = useMemo(
    () => visible.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [visible, page]
  );

  // Any change to the filters can shrink the list past the current page.
  useEffect(() => { setPage(1); }, [search, segment, sortAsc]);
  useEffect(() => { if (page > pageCount) setPage(pageCount); }, [page, pageCount]);

  const currentRoleName = (u: ManagedUser) => roles.find((r) => r.id === u.role_id)?.name || (u.role === 'unassigned' ? 'Unassigned' : u.role);

  // Each card doubles as a filter for the table below — the counts were
  // previously decorative, so seeing "3 unassigned" meant then hunting for
  // them by hand.
  const cards: Array<{
    key: typeof segment; label: string; value: number; icon: React.ReactNode; accent: string;
  }> = overview ? [
    { key: 'all', label: 'Total users', value: overview.total, icon: <Users size={18} />, accent: 'var(--primary)' },
    { key: 'student', label: 'Students', value: overview.students, icon: <GraduationCap size={18} />, accent: 'var(--success)' },
    { key: 'teacher', label: 'Teachers', value: overview.teachers, icon: <Briefcase size={18} />, accent: 'var(--info)' },
    { key: 'admin', label: 'Admins', value: overview.admins, icon: <ShieldCheck size={18} />, accent: 'var(--accent)' },
    { key: 'unassigned', label: 'Unassigned', value: overview.unassigned, icon: <HelpCircle size={18} />, accent: 'var(--warning)' },
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

      {(can(['ROLES_PERMISSIONS_VIEW', 'ROLES_PERMISSIONS_MANAGE']) || can('ROSTER_SYNC')) && (
        <div className="admin-tools mb-5">
          {can(['ROLES_PERMISSIONS_VIEW', 'ROLES_PERMISSIONS_MANAGE']) && (
            <Link to="/admin/roles" className="admin-tool">
              <span className="admin-tool-icon"><KeyRound size={17} /></span>
              <span className="admin-tool-body">
                <span className="admin-tool-title">Roles &amp; Permissions</span>
                <span className="admin-tool-desc">Create custom roles and fine-tune what each one can do.</span>
              </span>
              <ChevronRight size={16} className="admin-tool-go" />
            </Link>
          )}
          {can('ROSTER_SYNC') && (
            <button className="admin-tool" onClick={syncFromMis} disabled={syncing}>
              <span className="admin-tool-icon">
                <RefreshCw size={17} style={syncing ? { animation: 'spin 1s linear infinite' } : undefined} />
              </span>
              <span className="admin-tool-body">
                <span className="admin-tool-title">{syncing ? 'Syncing from MIS…' : 'Sync roster & academic period'}</span>
                <span className="admin-tool-desc">Pull years, terms and the subject timetable — needed for subject attendance.</span>
              </span>
              <ChevronRight size={16} className="admin-tool-go" />
            </button>
          )}
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
          <div className="grid mb-5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(168px, 1fr))', gap: '14px' }}>
            {cards.map((c) => (
              <button
                key={c.label}
                className={`stat-card admin-stat${segment === c.key ? ' is-selected' : ''}`}
                style={{ ['--accent-color' as string]: c.accent }}
                onClick={() => setSegment(c.key)}
                aria-pressed={segment === c.key}
                title={c.key === 'all' ? 'Show all users' : `Show only ${c.label.toLowerCase()}`}
              >
                <div className="flex items-center justify-between">
                  <span className="stat-icon">{c.icon}</span>
                  {c.key === 'unassigned' && c.value > 0 && (
                    <span className="badge badge-warning">Needs action</span>
                  )}
                </div>
                <div className="stat-value">{c.value}</div>
                <span className="stat-label">{c.label}</span>
              </button>
            ))}
          </div>

          {error && <div className="alert alert-danger mb-4"><AlertCircle size={16} /><span>{error}</span></div>}

          {/* User management */}
          <section className="card">
            <div className="card-header admin-users-head">
              <div>
                <span className="section-title">User management</span>
                <div className="text-xs text-secondary mt-1">
                  {segment === 'all'
                    ? `${users.length} account${users.length === 1 ? '' : 's'}`
                    : `Filtered to ${segment}`}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {(segment !== 'all' || search) && (
                  <button className="rp-chip is-on" onClick={() => { setSegment('all'); setSearch(''); }}>
                    <X size={12} /> Clear filters
                  </button>
                )}
                <div className="rp-search" style={{ minWidth: 220 }}>
                  <Search className="field-icon" size={15} />
                  <input
                    className="input"
                    placeholder="Search name, email or ID…"
                    value={search}
                    aria-label="Search users"
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  {search && (
                    <button className="rp-search-clear" onClick={() => setSearch('')} aria-label="Clear search">
                      <X size={13} />
                    </button>
                  )}
                </div>
              </div>
            </div>

            {visible.length === 0 ? (
              <div className="empty-state" style={{ padding: '52px 0' }}>
                <Inbox size={28} />
                <span className="text-sm">No users match these filters.</span>
                <button className="btn btn-outline btn-sm mt-3" onClick={() => { setSegment('all'); setSearch(''); }}>
                  Clear filters
                </button>
              </div>
            ) : (
              <div className="table-wrap">
                <table className="table table--hover">
                  <thead>
                    <tr>
                      <th>
                        <button
                          className="admin-sort"
                          onClick={() => setSortAsc((v) => !v)}
                          aria-label={`Sort by name, currently ${sortAsc ? 'ascending' : 'descending'}`}
                        >
                          User <ArrowUpDown size={12} />
                        </button>
                      </th>
                      <th>Email</th><th>Status</th><th>Role</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {paged.map((u) => (
                      <tr key={u.id} className={u.role === 'unassigned' ? 'is-unassigned' : undefined}>
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
                            <div style={{ width: '200px' }}>
                              <SearchableSelect
                                value={u.role_id != null ? String(u.role_id) : ''}
                                onChange={(v) => requestRoleChange(u, Number(v))}
                                options={roles.map((r) => ({ value: String(r.id), label: r.name, hint: r.level }))}
                                placeholder="Unassigned"
                                disabled={savingId === u.id || !can('USERS_MANAGE')}
                                aria-label={`Role for ${u.name}`}
                              />
                            </div>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="card-footer admin-pager">
              <span className="text-xs text-secondary">
                {visible.length === 0
                  ? 'No users'
                  : `Showing ${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, visible.length)} of ${visible.length}`}
                {visible.length !== users.length && ` (filtered from ${users.length})`}
              </span>

              {pageCount > 1 && (
                <nav className="admin-pager-nav" aria-label="User list pages">
                  <button
                    className="btn btn-outline btn-sm"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page === 1}
                  >
                    Previous
                  </button>
                  <span className="text-xs text-secondary" aria-live="polite">
                    Page {page} of {pageCount}
                  </span>
                  <button
                    className="btn btn-outline btn-sm"
                    onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                    disabled={page === pageCount}
                  >
                    Next
                  </button>
                </nav>
              )}
            </div>
            <div className="card-footer text-xs text-secondary">
              Backend access updates immediately; the user’s own screen refreshes on next sign-in.
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
