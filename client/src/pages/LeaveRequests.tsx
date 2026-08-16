import React, { useState, useEffect, useMemo, useRef, useId } from 'react';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { ErrorState } from '../components/common/ErrorState';
import { Pager, clampPage } from '../components/common/Pager';
import { apiGet, apiPost, ApiError } from '../api/client';
import { useToast } from '../context/ToastContext';
import {
  Plus, Calendar, AlertCircle, Inbox, Info, Search, X, RotateCcw,
  CheckCircle2, Clock, XCircle, ChevronDown, Stethoscope, Home, Briefcase, MoreHorizontal,
} from 'lucide-react';

interface Excuse {
  id: number;
  class_name: string;
  session_date: string;
  reason: string;
  description: string;
  status: 'approved' | 'pending' | 'rejected';
  created_at: string;
}

type StatusKey = Excuse['status'];

const STATUS_META: Record<StatusKey, { badge: string; icon: React.ReactNode; label: string }> = {
  pending:  { badge: 'badge-warning', icon: <Clock size={13} />,        label: 'Pending' },
  approved: { badge: 'badge-success', icon: <CheckCircle2 size={13} />, label: 'Approved' },
  rejected: { badge: 'badge-danger',  icon: <XCircle size={13} />,      label: 'Rejected' },
};

const REASONS: Array<{ value: string; icon: React.ReactNode }> = [
  { value: 'Medical',  icon: <Stethoscope size={14} /> },
  { value: 'Family',   icon: <Home size={14} /> },
  { value: 'Official', icon: <Briefcase size={14} /> },
  { value: 'Other',    icon: <MoreHorizontal size={14} /> },
];
const PAGE_SIZE = 6;
const today = () => new Date().toISOString().split('T')[0];
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
};

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/**
 * Course picker.
 *
 * This used to swap between a SearchableSelect (which is a *button*) and a
 * plain input depending on whether the class list had loaded — so whether you
 * could type at all depended on a race with the network, and a list that
 * arrived mid-typing replaced the element under the cursor. It is one control
 * now: always a text input, with the known classes offered as suggestions.
 * Free text stays valid because a student can need to explain an absence from
 * a class they have no attendance record in yet — which is exactly the case
 * where the list comes back empty.
 */
const CourseCombobox: React.FC<{
  value: string;
  onChange: (v: string) => void;
  options: string[];
  invalid: boolean;
}> = ({ value, onChange, options, invalid }) => {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listboxId = `${useId()}-courses`;

  const matches = useMemo(() => {
    const q = value.trim().toLowerCase();
    return options.filter((o) => !q || o.toLowerCase().includes(q)).slice(0, 8);
  }, [options, value]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const commit = (v: string) => { onChange(v); setOpen(false); };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!matches.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((i) => (i + 1) % matches.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); setActive((i) => (i - 1 + matches.length) % matches.length); }
    // Enter picks a highlighted suggestion, but never hijacks submit when the
    // list is closed — typed-in text must be able to go straight through.
    else if (e.key === 'Enter' && open) { e.preventDefault(); commit(matches[active] ?? value); }
    else if (e.key === 'Escape') setOpen(false);
  };

  return (
    <div className="ex-combo" ref={rootRef}>
      <input
        id="excuse-course"
        className={`input${invalid ? ' is-invalid' : ''}`}
        type="text"
        role="combobox"
        autoComplete="off"
        aria-expanded={open && matches.length > 0}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={open && matches.length ? `${listboxId}-${active}` : undefined}
        placeholder={options.length ? 'Type or pick a class…' : 'Type the class name…'}
        value={value}
        onChange={(e) => { onChange(e.target.value); setActive(0); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {options.length > 0 && (
        <button
          type="button"
          className="ex-combo-toggle"
          tabIndex={-1}
          aria-label={open ? 'Hide class suggestions' : 'Show class suggestions'}
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronDown size={15} />
        </button>
      )}
      {open && matches.length > 0 && (
        <ul className="ex-combo-panel" id={listboxId} role="listbox" aria-label="Your classes">
          {matches.map((o, i) => (
            <li
              key={o}
              id={`${listboxId}-${i}`}
              role="option"
              aria-selected={o === value}
              className={`ex-option${i === active ? ' is-active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => { e.preventDefault(); commit(o); }}
            >
              {o}
              {o === value && <CheckCircle2 size={13} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export const LeaveRequests: React.FC = () => {
  const toast = useToast();
  const [requests, setRequests] = useState<Excuse[]>([]);
  const [courses, setCourses] = useState<string[]>([]);
  const [courseListUnavailable, setCourseListUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ className: '', date: today(), reason: 'Medical', details: '' });
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // Per-field messages, so the error appears next to the input that caused it.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [statusFilter, setStatusFilter] = useState<'' | StatusKey>('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const loadExcuses = async () => {
    try {
      const res = await apiGet<Excuse[]>('/api/attendance/excuses/me');
      setRequests(res.data || []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load your excuse requests.');
    }
  };

  useEffect(() => {
    (async () => {
      setLoading(true); setError(null);
      // Course options come from the student's own attendance, so the list
      // only ever offers classes they're actually in.
      try {
        const res = await apiGet<Array<{ class_name: string }>>('/api/attendance/me');
        const names = Array.from(new Set((res.data || []).map((r) => r.class_name))).sort();
        setCourses(names);
        setCourseListUnavailable(names.length === 0);
        if (names.length) setForm((f) => ({ ...f, className: names[0] }));
      } catch { setCourseListUnavailable(true); }
      await loadExcuses();
      setLoading(false);
    })();
  }, []);

  /** Checked before hitting the network so obvious mistakes are caught at
   *  the field rather than as a server error banner. */
  const validate = () => {
    const errs: Record<string, string> = {};
    if (!form.className.trim()) errs.className = 'Choose the class this excuse is for.';
    if (!form.date) errs.date = 'Pick the date you were absent.';
    else {
      const picked = new Date(form.date);
      const limit = new Date(); limit.setFullYear(limit.getFullYear() - 1);
      if (Number.isNaN(picked.getTime())) errs.date = 'That date isn’t valid.';
      else if (picked < limit) errs.date = 'That date is over a year ago — check the year.';
    }
    if (!form.details.trim()) errs.details = 'Add a short explanation so this can be reviewed.';
    else if (form.details.trim().length < 10) errs.details = 'Give a little more detail (at least 10 characters).';
    else if (form.details.length > 2000) errs.details = 'Please keep this under 2000 characters.';
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  };

  // Catch the duplicate locally too, so the user is told before submitting
  // rather than by a 409 afterwards.
  const duplicate = useMemo(
    () => requests.find(
      (r) => r.status === 'pending' && r.class_name === form.className && r.session_date === form.date
    ),
    [requests, form.className, form.date]
  );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!validate()) return;
    setSubmitting(true);
    try {
      await apiPost('/api/attendance/excuse', {
        className: form.className, sessionDate: form.date, reason: form.reason, description: form.details,
      });
      toast.success('Request submitted', `Your ${form.reason.toLowerCase()} excuse for ${form.className} is awaiting review.`);
      setForm((f) => ({ ...f, details: '' }));
      setFieldErrors({});
      setPage(1);
      setStatusFilter('');
      await loadExcuses();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not reach the server — your text is still here, try again.';
      setFormError(msg);
      toast.error('Not submitted', msg);
    } finally {
      setSubmitting(false);
    }
  };

  const counts = useMemo(() => ({
    pending: requests.filter((r) => r.status === 'pending').length,
    approved: requests.filter((r) => r.status === 'approved').length,
    rejected: requests.filter((r) => r.status === 'rejected').length,
  }), [requests]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return requests
      .filter((r) => (statusFilter ? r.status === statusFilter : true))
      .filter((r) => !q || [r.class_name, r.reason, r.description].some((f) => (f || '').toLowerCase().includes(q)));
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
          <p className="page-subtitle">Submit an excuse for an absence and track its review status.</p>
        </div>
        {requests.length > 0 && (
          <div className="excuse-summary">
            {(Object.keys(STATUS_META) as StatusKey[]).map((k) => (
              <button
                key={k}
                className={`excuse-stat is-${k}${statusFilter === k ? ' is-active' : ''}`}
                onClick={() => setStatusFilter(statusFilter === k ? '' : k)}
                aria-pressed={statusFilter === k}
                title={`Show only ${STATUS_META[k].label.toLowerCase()} requests`}
              >
                {STATUS_META[k].icon}
                <strong>{counts[k]}</strong>
                <span>{STATUS_META[k].label}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="excuse-layout">
        {/* ---- Submit ---- */}
        <section className="card excuse-form-card">
          <div className="card-header"><span className="section-title">New request</span></div>
          <div className="card-body">
            <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
              <div className="field">
                <label className="label" htmlFor="excuse-course">Class</label>
                <CourseCombobox
                  value={form.className}
                  options={courses}
                  invalid={!!fieldErrors.className}
                  onChange={(v) => {
                    setForm((p) => ({ ...p, className: v }));
                    setFieldErrors((e) => ({ ...e, className: '' }));
                  }}
                />
                {fieldErrors.className ? (
                  <p className="field-error">{fieldErrors.className}</p>
                ) : courseListUnavailable ? (
                  <p className="ex-hint">
                    <Info size={12} />
                    <span>No attendance records yet, so we can’t suggest your classes — type the name.</span>
                  </p>
                ) : null}
              </div>

              <div className="field">
                <label className="label" htmlFor="excuse-date">Date of absence</label>
                <div className="ex-date-row">
                  <input
                    id="excuse-date"
                    className={`input${fieldErrors.date ? ' is-invalid' : ''}`}
                    type="date"
                    max={today()}
                    value={form.date}
                    onChange={(e) => { setForm((p) => ({ ...p, date: e.target.value })); setFieldErrors((x) => ({ ...x, date: '' })); }}
                  />
                  <div className="ex-quick">
                    {[{ label: 'Today', v: today() }, { label: 'Yesterday', v: daysAgo(1) }].map((q) => (
                      <button
                        key={q.label}
                        type="button"
                        className={`ex-quick-btn${form.date === q.v ? ' is-on' : ''}`}
                        aria-pressed={form.date === q.v}
                        onClick={() => { setForm((p) => ({ ...p, date: q.v })); setFieldErrors((x) => ({ ...x, date: '' })); }}
                      >
                        {q.label}
                      </button>
                    ))}
                  </div>
                </div>
                {fieldErrors.date && <p className="field-error">{fieldErrors.date}</p>}
              </div>

              {/* Four options — chips show them all at once, so picking a
                  reason is one click instead of open-scan-click. */}
              <div className="field">
                <span className="label" id="excuse-reason-label">Reason</span>
                <div className="ex-reasons" role="radiogroup" aria-labelledby="excuse-reason-label">
                  {REASONS.map((r) => (
                    <button
                      key={r.value}
                      type="button"
                      role="radio"
                      aria-checked={form.reason === r.value}
                      className={`ex-reason${form.reason === r.value ? ' is-on' : ''}`}
                      onClick={() => setForm((p) => ({ ...p, reason: r.value }))}
                    >
                      {r.icon}<span>{r.value}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="field">
                <label className="label" htmlFor="excuse-details">Details</label>
                <textarea
                  id="excuse-details"
                  className={`textarea${fieldErrors.details ? ' is-invalid' : ''}`}
                  rows={4}
                  placeholder="Doctor’s name, event code, or anything that helps verify this…"
                  value={form.details}
                  onChange={(e) => { setForm((p) => ({ ...p, details: e.target.value })); setFieldErrors((x) => ({ ...x, details: '' })); }}
                />
                <div className="flex items-center justify-between mt-1">
                  {fieldErrors.details
                    ? <p className="field-error" style={{ margin: 0 }}>{fieldErrors.details}</p>
                    : <span className="text-xs text-secondary">Reviewers see this — be specific.</span>}
                  <span className={`text-xs ${form.details.length > 2000 ? 'text-danger' : 'text-tertiary'}`}>
                    {form.details.length}/2000
                  </span>
                </div>
              </div>

              {duplicate && (
                <div className="alert alert-warning">
                  <Info size={16} />
                  <span>
                    You already have a pending request for <strong>{form.className}</strong> on{' '}
                    <strong>{form.date}</strong>. Wait for it to be reviewed rather than sending another.
                  </span>
                </div>
              )}

              {formError && (
                <div className="alert alert-danger"><AlertCircle size={16} /><span>{formError}</span></div>
              )}

              <button
                type="submit"
                className="btn btn-primary btn-block"
                disabled={submitting || !!duplicate}
              >
                <Plus size={16} /> {submitting ? 'Submitting…' : 'Submit request'}
              </button>
            </form>
          </div>
        </section>

        {/* ---- History ---- */}
        <section className="card">
          <div className="card-header excuse-history-head">
            <div>
              <span className="section-title">Your requests</span>
              <div className="text-xs text-secondary mt-1">
                {requests.length} submitted in this academic term
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {filtering && (
                <button className="rp-chip is-on" onClick={clearFilters}>
                  <X size={12} /> Clear
                </button>
              )}
              <div className="rp-search" style={{ minWidth: 190 }}>
                <Search className="field-icon" size={15} />
                <input
                  className="input"
                  placeholder="Search course or reason…"
                  value={search}
                  aria-label="Search your requests"
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

          {loading ? (
            <div className="flex flex-col gap-2" style={{ padding: '14px 16px' }}>
              {[0, 1, 2].map((i) => <div key={i} className="rp-skeleton" style={{ height: 74 }} />)}
            </div>
          ) : error ? (
            <div style={{ padding: 16 }}><ErrorState message={error} onRetry={loadExcuses} /></div>
          ) : visible.length === 0 ? (
            <div className="empty-state" style={{ padding: '52px 0' }}>
              <Inbox size={28} />
              {filtering ? (
                <>
                  <span className="text-sm">No requests match these filters.</span>
                  <button className="btn btn-outline btn-sm mt-3" onClick={clearFilters}>
                    <RotateCcw size={14} /> Clear filters
                  </button>
                </>
              ) : (
                <>
                  <span className="text-sm">You haven’t submitted any requests yet.</span>
                  <span className="text-xs text-secondary mt-1">
                    Use the form to explain an absence — it’ll appear here with its review status.
                  </span>
                </>
              )}
            </div>
          ) : (
            <ul className="excuse-list">
              {rows.map((req) => {
                const meta = STATUS_META[req.status];
                return (
                  <li key={req.id} className={`excuse-item is-${req.status}`}>
                    <div className="excuse-item-head">
                      <div style={{ minWidth: 0 }}>
                        <div className="excuse-course">{req.class_name}</div>
                        <div className="excuse-meta">
                          <Calendar size={12} />
                          <span>{fmtDate(req.session_date)}</span>
                          <span className="audit-dot">·</span>
                          <span>{req.reason}</span>
                        </div>
                      </div>
                      <span className={`badge ${meta.badge}`}>
                        {meta.icon}<span style={{ marginLeft: 4 }}>{meta.label}</span>
                      </span>
                    </div>
                    {req.description && <p className="excuse-desc">{req.description}</p>}
                    <div className="excuse-foot">
                      Submitted {fmtDate(req.created_at)}
                      {req.status === 'pending' && ' · awaiting review'}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {!loading && !error && visible.length > 0 && (
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
    </DashboardLayout>
  );
};
