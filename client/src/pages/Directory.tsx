import { UserAvatar } from '../components/common/UserAvatar';
import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { ErrorState } from '../components/common/ErrorState';
import { apiGet, ApiError } from '../api/client';
import { Search, GraduationCap, Briefcase, Mail, Inbox, FileText, ChevronLeft, ChevronRight } from 'lucide-react';

interface DirectoryMember { id: string; name: string; email: string; role?: string; }

const PAGE_SIZE = 20;

export const Directory: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'students' | 'staff'>('students');
  const [members, setMembers] = useState<DirectoryMember[]>([]);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const endpoint = activeTab === 'students' ? '/api/mis/students' : '/api/mis/staff';
      const res = await apiGet<DirectoryMember[]>(endpoint);
      setMembers(res.data || []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Could not load the ${activeTab} directory.`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [activeTab]);

  useEffect(() => { setPage(0); }, [activeTab, search]);

  const filtered = members.filter((m) =>
    [m.name, m.id, m.email].some((f) => f.toLowerCase().includes(search.toLowerCase())));
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  return (
    <DashboardLayout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Directory</h1>
          <p className="page-subtitle">Students and staff registered in Discipline.</p>
        </div>
        <span className="text-sm text-secondary" style={{ marginTop: '6px' }}>{filtered.length} {activeTab}</span>
      </div>

      {/* Toolbar */}
      <div className="card card-body mb-4 flex flex-wrap items-center gap-3">
        <div className="segmented">
          <button className={`segmented-btn${activeTab === 'students' ? ' is-active' : ''}`} onClick={() => { setActiveTab('students'); setSearch(''); }}>
            <GraduationCap size={14} /> Students
          </button>
          <button className={`segmented-btn${activeTab === 'staff' ? ' is-active' : ''}`} onClick={() => { setActiveTab('staff'); setSearch(''); }}>
            <Briefcase size={14} /> Staff
          </button>
        </div>
        <div className="input-with-icon" style={{ flex: 1, minWidth: '220px' }}>
          <Search className="field-icon" size={16} />
          <input className="input" placeholder="Search by name, ID, or email…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      {error && <div className="mb-4"><ErrorState message={error} onRetry={load} /></div>}

      {/* Table */}
      <div className="card">
        {loading ? (
          <div style={{ padding: '48px 0' }}><LoadingSpinner /></div>
        ) : filtered.length === 0 ? (
          <div className="empty-state"><Inbox size={28} /><span className="text-sm">No matching records found.</span></div>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table table--hover">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>{activeTab === 'students' ? 'Student ID' : 'Staff ID'}</th>
                    <th>Email</th>
                    {activeTab === 'staff' && <th>Role</th>}
                    {activeTab === 'students' && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {paged.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <div className="flex items-center gap-3">
                          <UserAvatar decorative userId={m.id} name={m.name} px={28} className="avatar avatar-square avatar-sm" />
                          <span className="font-medium">{m.name}</span>
                        </div>
                      </td>
                      <td className="mono text-sm text-secondary">{m.id}</td>
                      <td>
                        <span className="flex items-center gap-1 text-secondary text-sm"><Mail size={14} /> {m.email}</span>
                      </td>
                      {activeTab === 'staff' && <td>{m.role && <span className="badge badge-primary">{m.role}</span>}</td>}
                      {activeTab === 'students' && (
                        <td className="text-right">
                          <Link to={`/reports/student/${m.id}`} className="btn btn-outline btn-sm"><FileText size={14} /> Report</Link>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card-footer flex items-center justify-between">
              <span className="text-xs text-secondary">Showing {paged.length} of {filtered.length} {activeTab}{filtered.length !== members.length ? ` (filtered from ${members.length})` : ''}</span>
              {pageCount > 1 && (
                <div className="flex gap-2">
                  <button className="btn btn-outline btn-sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}><ChevronLeft size={14} /> Prev</button>
                  <span className="text-xs text-secondary" style={{ alignSelf: 'center' }}>{page + 1} / {pageCount}</span>
                  <button className="btn btn-outline btn-sm" disabled={page >= pageCount - 1} onClick={() => setPage((p) => p + 1)}>Next <ChevronRight size={14} /></button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </DashboardLayout>
  );
};
