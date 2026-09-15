import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Plus, Calendar, Inbox, Search, X, RotateCcw, ChevronRight, BookOpen, Sun, CheckCircle2, AlertCircle,
} from 'lucide-react';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { ErrorState } from '../components/common/ErrorState';
import { Pager, clampPage } from '../components/common/Pager';
import { ApiError } from '../api/client';
import { getMyExcuses, getMyAbsences, excuseTarget, newExcuseLink, type Excuse, type Absence, type ExcuseStatus } from '../api/excuses';
import { STATUS_META, fmtDate } from '../components/excuses/excuseMeta';
import { ExcuseStatusBadge } from '../components/excuses/ExcuseStatusBadge';

/**
 * Excuses, for a student. Two questions, in order:
 *   1. Which of my absences still need explaining?  → "Absences to explain"
 *   2. What happened to the ones I've sent?          → "Your requests"
 * Each request opens its own page (/excuses/:id); submitting is its own page
 * too (/excuses/new), pre-filled from the absence you clicked.
 */

const PAGE_SIZE = 8;

const AbsenceRow: React.FC<{ a: Absence }> = ({ a }) => (
  <li className="ex-absence">
    <span className="ex-absence-icon">{a.sessionType === 'subject' ? <BookOpen size={15} /> : <Sun size={15} />}</span>
    <div className="ex-absence-body">
      <div className="ex-absence-title">{a.sessionType === 'subject' ? (a.subjectName || 'Lesson') : 'Morning check'}</div>
      <div className="ex-absence-meta">
        <span><Calendar size={12} /> {fmtDate(a.date)}</span>
        <span>{a.className}</span>
      </div>
    </div>
    {a.excuse ? (
      <Link to={`/excuses/${a.excuse.id}`} className="ex-absence-action">
        <ExcuseStatusBadge status={a.excuse.status} /> <ChevronRight size={14} />
      </Link>
    ) : (
      <Link to={newExcuseLink(a)} className="btn btn-primary btn-sm">
        <Plus size={14} /> Submit excuse
      </Link>
    )}
  </li>
);

export const Excuses: React.FC = () => {
  const [requests, setRequests] = useState<Excuse[]>([]);
  const [absences, setAbsences] = useState<Absence[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<'' | ExcuseStatus>('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [showAllAbsences, setShowAllAbsences] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [ex, ab] = await Promise.all([getMyExcuses(), getMyAbsences()]);
      setRequests(ex);
      setAbsences(ab);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load your excuses.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const counts = useMemo(() => ({
    pending: requests.filter((r) => r.status === 'pending').length,
    approved: requests.filter((r) => r.status === 'approved').length,
    rejected: requests.filter((r) => r.status === 'rejected').length,
  }), [requests]);

  // Absences with no excuse yet come first — that's the to-do list. Covered
  // ones are still worth a glance (status at a glance), but folded away.
  const unexcused = useMemo(() => absences.filter((a) => !a.excuse), [absences]);
  const covered = useMemo(() => absences.filter((a) => a.excuse), [absences]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return requests
      .filter((r) => (statusFilter ? r.status === statusFilter : true))
      .filter((r) => !q || [r.class_name, r.subject_name, r.reason, r.description].some((f) => (f || '').toLowerCase().includes(q)));
  }, [requests, statusFilter, search]);

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const current = clampPage(page, pageCount);
  const rows = visible.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  useEffect(() => { setPage(1); }, [statusFilter, search]);

  const filtering = !!(statusFilter || search);
  const clearFilters = () => { setStatusFilter(''); setSearch(''); };

  return (
    <DashboardLayout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Leaves &amp; Excuses</h1>
          <p className="page-subtitle">Explain an absence and follow what the reviewer decided.</p>
        </div>
        <Link to="/excuses/new" className="btn btn-primary"><Plus size={16} /> New request</Link>
      </div>

      {loading ? (
        <div className="flex flex-col gap-3">
          <div className="rp-skeleton" style={{ height: 120 }} />
          <div className="rp-skeleton" style={{ height: 320 }} />
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <div className="ex-page">
          {/* ---- Absences to explain ---- */}
          <section className="card">
            <div className="card-header">
              <div>
                <div className="section-title flex items-center gap-2">
                  <AlertCircle size={15} style={{ color: unexcused.length ? 'var(--warning)' : 'var(--text-secondary)' }} />
                  Absences to explain
                  {unexcused.length > 0 && <span className="count-badge">{unexcused.length}</span>}
                </div>
                <div className="card-subtitle">Every lesson you were marked absent for this term.</div>
              </div>
              {covered.length > 0 && (
                <button className="btn btn-ghost btn-sm" onClick={() => setShowAllAbsences((v) => !v)}>
                  {showAllAbsences ? 'Hide explained' : `Show explained (${covered.length})`}
                </button>
              )}
            </div>
            {unexcused.length === 0 && (!showAllAbsences || covered.length === 0) ? (
              <div className="ex-clear">
                <CheckCircle2 size={22} />
                <div>
                  <div className="font-semibold text-sm">
                    {absences.length === 0 ? 'No absences recorded this term.' : 'Every absence has an excuse on file.'}
                  </div>
                  <div className="text-xs text-secondary">
                    {absences.length === 0
                      ? 'If you’re marked absent for a lesson, it will show up here with a button to explain it.'
                      : 'Open a request below to see where it stands.'}
                  </div>
                </div>
              </div>
            ) : (
              <ul className="ex-absences">
                {unexcused.map((a) => <AbsenceRow key={a.recordId} a={a} />)}
                {showAllAbsences && covered.map((a) => <AbsenceRow key={a.recordId} a={a} />)}
              </ul>
            )}
          </section>

          {/* ---- Requests ---- */}
          <section className="card">
            <div className="card-header excuse-history-head">
              <div>
                <span className="section-title">Your requests</span>
                <div className="text-xs text-secondary mt-1">{requests.length} submitted this academic term</div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {(Object.keys(STATUS_META) as ExcuseStatus[]).map((k) => (
                  <button
                    key={k}
                    className={`excuse-stat is-${k}${statusFilter === k ? ' is-active' : ''}`}
                    onClick={() => setStatusFilter(statusFilter === k ? '' : k)}
                    aria-pressed={statusFilter === k}
                    title={`Show only ${STATUS_META[k].label.toLowerCase()} requests`}
                  >
                    {STATUS_META[k].icon}<strong>{counts[k]}</strong><span>{STATUS_META[k].label}</span>
                  </button>
                ))}
                <div className="rp-search" style={{ minWidth: 190 }}>
                  <Search className="field-icon" size={15} />
                  <input
                    className="input"
                    placeholder="Search class, subject or reason…"
                    value={search}
                    aria-label="Search your requests"
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  {search && (
                    <button className="rp-search-clear" onClick={() => setSearch('')} aria-label="Clear search"><X size={13} /></button>
                  )}
                </div>
              </div>
            </div>

            {visible.length === 0 ? (
              <div className="empty-state" style={{ padding: '48px 0' }}>
                <Inbox size={28} />
                {filtering ? (
                  <>
                    <span className="text-sm">No requests match these filters.</span>
                    <button className="btn btn-outline btn-sm mt-3" onClick={clearFilters}><RotateCcw size={14} /> Clear filters</button>
                  </>
                ) : (
                  <>
                    <span className="text-sm">You haven’t submitted any requests yet.</span>
                    <span className="text-xs text-secondary mt-1">Pick an absence above, or start a new request.</span>
                  </>
                )}
              </div>
            ) : (
              <ul className="excuse-list">
                {rows.map((r) => (
                  <li key={r.id} className={`excuse-item is-${r.status} is-link`}>
                    <Link to={`/excuses/${r.id}`} className="excuse-item-link" aria-label={`${excuseTarget(r)} on ${fmtDate(r.session_date)} — ${STATUS_META[r.status].label}`}>
                      <div className="excuse-item-head">
                        <div style={{ minWidth: 0 }}>
                          <div className="excuse-course">
                            {excuseTarget(r)} <span className="text-secondary font-normal">· {r.class_name}</span>
                          </div>
                          <div className="excuse-meta">
                            <Calendar size={12} />
                            <span>{fmtDate(r.session_date)}</span>
                            <span className="audit-dot">·</span>
                            <span>{r.reason}</span>
                            {r.supersedes_id && <><span className="audit-dot">·</span><span>Appeal</span></>}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <ExcuseStatusBadge status={r.status} />
                          <ChevronRight size={15} className="text-tertiary" />
                        </div>
                      </div>
                      {r.description && <p className="excuse-desc">{r.description}</p>}
                      <div className="excuse-foot">
                        Submitted {fmtDate(r.created_at)}
                        {r.status === 'pending' && ' · awaiting review'}
                        {r.status !== 'pending' && r.reviewed_by_name && ` · reviewed by ${r.reviewed_by_name}`}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}

            {visible.length > 0 && (
              <Pager
                page={current}
                pageCount={pageCount}
                total={visible.length}
                pageSize={PAGE_SIZE}
                onChange={setPage}
                label="Excuse request pages"
                unfilteredTotal={requests.length}
              />
            )}
          </section>
        </div>
      )}
    </DashboardLayout>
  );
};

export default Excuses;
