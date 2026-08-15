import React, { useState, useEffect } from 'react';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { Plus, FileText, Calendar, AlertCircle, Inbox } from 'lucide-react';

interface Excuse {
  id: number;
  class_name: string;
  session_date: string;
  reason: string;
  description: string;
  status: 'approved' | 'pending' | 'rejected';
  created_at: string;
}

const STATUS: Record<string, string> = { approved: 'badge-success', pending: 'badge-warning', rejected: 'badge-danger' };
const authHeaders = () => ({ Authorization: `Bearer ${localStorage.getItem('sso_token')}` });

export const LeaveRequests: React.FC = () => {
  const [requests, setRequests] = useState<Excuse[]>([]);
  const [courses, setCourses] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ className: '', date: new Date().toISOString().split('T')[0], reason: 'Medical', details: '' });
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const loadExcuses = async () => {
    try {
      const res = await fetch('/api/attendance/excuses/me', { headers: authHeaders() });
      if (!res.ok) throw new Error('Could not load your excuse requests.');
      const result = await res.json();
      if (!result.success) throw new Error(result.message || 'Server error.');
      setRequests(result.data);
    } catch (err) { setError((err as Error).message); }
  };

  useEffect(() => {
    (async () => {
      setLoading(true); setError(null);
      // Derive the course options from the student's own attendance (real data).
      try {
        const res = await fetch('/api/attendance/me', { headers: authHeaders() });
        if (res.ok) {
          const result = await res.json();
          if (result.success) {
            const names = Array.from(new Set((result.data as any[]).map((r) => r.class_name))).sort();
            setCourses(names);
            if (names.length) setForm((f) => ({ ...f, className: names[0] }));
          }
        }
      } catch { /* non-fatal */ }
      await loadExcuses();
      setLoading(false);
    })();
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true); setFormError(null);
    try {
      const res = await fetch('/api/attendance/excuse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ className: form.className, sessionDate: form.date, reason: form.reason, description: form.details }),
      });
      const result = await res.json();
      if (!res.ok || !result.success) throw new Error(result.message || 'Submission failed.');
      setForm((f) => ({ ...f, details: '' }));
      await loadExcuses();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DashboardLayout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Leaves &amp; Excuses</h1>
          <p className="page-subtitle">Submit excuse documents and track their review status.</p>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: '380px 1fr', gap: '20px', alignItems: 'start' }}>
        {/* Form */}
        <section className="card">
          <div className="card-header"><span className="section-title">Submit leave request</span></div>
          <div className="card-body">
            <form onSubmit={submit} className="flex flex-col gap-3">
              <div className="field">
                <label className="label">Course</label>
                {courses.length ? (
                  <select className="select" value={form.className} onChange={(e) => setForm((p) => ({ ...p, className: e.target.value }))} required>
                    {courses.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                ) : (
                  <input className="input" placeholder="Course name" value={form.className} onChange={(e) => setForm((p) => ({ ...p, className: e.target.value }))} required />
                )}
              </div>
              <div className="grid grid-2" style={{ gap: '12px' }}>
                <div className="field">
                  <label className="label">Date</label>
                  <input className="input" type="date" value={form.date} onChange={(e) => setForm((p) => ({ ...p, date: e.target.value }))} required />
                </div>
                <div className="field">
                  <label className="label">Reason</label>
                  <select className="select" value={form.reason} onChange={(e) => setForm((p) => ({ ...p, reason: e.target.value }))}>
                    <option>Medical</option><option>Family</option><option>Official</option><option>Other</option>
                  </select>
                </div>
              </div>
              <div className="field">
                <label className="label">Details</label>
                <textarea className="textarea" placeholder="Doctor names, event codes, verification…" value={form.details} onChange={(e) => setForm((p) => ({ ...p, details: e.target.value }))} required />
              </div>
              {formError && <div className="alert alert-danger"><AlertCircle size={16} /><span>{formError}</span></div>}
              <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
                <Plus size={16} /> {submitting ? 'Submitting…' : 'Submit request'}
              </button>
            </form>
          </div>
        </section>

        {/* History */}
        <div className="flex flex-col gap-3">
          <span className="section-title">Excuse history</span>
          {loading ? (
            <div className="card"><div style={{ padding: '40px 0' }}><LoadingSpinner /></div></div>
          ) : error ? (
            <div className="card"><div className="empty-state"><AlertCircle size={28} /><span className="text-sm">{error}</span></div></div>
          ) : requests.length === 0 ? (
            <div className="card"><div className="empty-state"><Inbox size={28} /><span className="text-sm">No leave requests submitted yet.</span></div></div>
          ) : requests.map((req) => (
            <div key={req.id} className="card card-pad flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3" style={{ minWidth: 0 }}>
                  <div className="login-role-icon tone-brand"><FileText size={18} /></div>
                  <div style={{ minWidth: 0 }}>
                    <div className="text-sm font-semibold">{req.class_name}</div>
                    <div className="text-xs text-secondary">Submitted {new Date(req.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</div>
                  </div>
                </div>
                <span className={`badge ${STATUS[req.status]} capitalize`}>{req.status}</span>
              </div>
              <div className="border rounded" style={{ padding: '12px', background: 'var(--bg-subtle)' }}>
                <div className="flex items-center gap-1 text-xs text-secondary uppercase">
                  <Calendar size={12} /> {req.session_date} · {req.reason}
                </div>
                {req.description && <p className="text-sm mt-1">{req.description}</p>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </DashboardLayout>
  );
};
