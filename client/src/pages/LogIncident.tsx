import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { useToast } from '../context/ToastContext';
import { usePermissions } from '../hooks/usePermissions';
import { Gavel, Award, AlertCircle, Save, Users } from 'lucide-react';

interface ClassData { id: string; name: string; department: string; }
interface Student { id: string; name: string; email: string; }
type RecordType = 'demerit' | 'merit';

// Mirrors server/src/utils/conduct.ts. The server is authoritative for points;
// these maps drive the live preview and the option lists only.
const DEMERIT_POINTS: Record<string, number> = { minor: 2, moderate: 5, major: 10 };
const MERIT_POINTS: Record<string, number> = { small: 3, notable: 5, outstanding: 10 };
const DEMERIT_CATEGORIES = ['Misconduct', 'Tardiness', 'Uniform', 'Disruption', 'Academic Honesty', 'Property Damage', 'Bullying', 'Other'];
const MERIT_CATEGORIES = ['Leadership', 'Helpfulness', 'Academic Excellence', 'Sportsmanship', 'Community Service', 'Improvement', 'Other'];
const SANCTIONS: { value: string; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'warning', label: 'Verbal warning' },
  { value: 'parent_contact', label: 'Parent contact' },
  { value: 'detention', label: 'Detention' },
  { value: 'suspension', label: 'Suspension' },
  { value: 'community_service', label: 'Community service' },
  { value: 'counseling', label: 'Counseling' },
];

const authHeaders = () => ({ Authorization: `Bearer ${localStorage.getItem('sso_token')}` });
const today = () => new Date().toISOString().split('T')[0];

export const LogIncident: React.FC = () => {
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = usePermissions();
  const [classes, setClasses] = useState<ClassData[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [loadingClasses, setLoadingClasses] = useState(true);
  const [loadingStudents, setLoadingStudents] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [bulk, setBulk] = useState(false);
  const [bulkIds, setBulkIds] = useState<string[]>([]);

  const [type, setType] = useState<RecordType>('demerit');
  const [form, setForm] = useState({
    classId: '',
    studentId: '',
    category: DEMERIT_CATEGORIES[0],
    severity: 'minor',
    title: '',
    description: '',
    incidentDate: today(),
    location: '',
    sanction: 'none',
  });

  const categories = type === 'demerit' ? DEMERIT_CATEGORIES : MERIT_CATEGORIES;
  const tiers = type === 'demerit' ? DEMERIT_POINTS : MERIT_POINTS;
  const previewPoints = tiers[form.severity] ?? 0;

  // When type flips, reset category/severity to that type's vocabulary.
  useEffect(() => {
    setForm((f) => ({
      ...f,
      category: (type === 'demerit' ? DEMERIT_CATEGORIES : MERIT_CATEGORIES)[0],
      severity: type === 'demerit' ? 'minor' : 'small',
    }));
  }, [type]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/mis/classes', { headers: authHeaders() });
        if (res.ok) {
          const result = await res.json();
          if (result.success) {
            setClasses(result.data);
            if (result.data.length) setForm((f) => ({ ...f, classId: result.data[0].id }));
          }
        }
      } catch (err) { console.error('Error fetching classes:', err); }
      finally { setLoadingClasses(false); }
    })();
  }, []);

  useEffect(() => {
    if (!form.classId) return;
    (async () => {
      setLoadingStudents(true);
      try {
        const res = await fetch(`/api/mis/students?class_id=${form.classId}`, { headers: authHeaders() });
        if (res.ok) {
          const result = await res.json();
          if (result.success) {
            setStudents(result.data);
            setForm((f) => ({ ...f, studentId: result.data[0]?.id ?? '' }));
            setBulkIds([]);
          }
        }
      } catch (err) { console.error('Error fetching students:', err); }
      finally { setLoadingStudents(false); }
    })();
  }, [form.classId]);

  const update = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  const toggleBulkId = (id: string) =>
    setBulkIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const allSelected = students.length > 0 && bulkIds.length === students.length;
  const toggleAll = () => setBulkIds(allSelected ? [] : students.map((s) => s.id));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);
    const klass = classes.find((c) => c.id === form.classId);
    if (!form.title.trim()) { setMessage({ type: 'error', text: 'A short title is required.' }); return; }

    const shared = {
      className: klass?.name ?? null,
      type,
      category: form.category,
      severity: form.severity,
      title: form.title.trim(),
      description: form.description.trim(),
      incidentDate: form.incidentDate,
      location: form.location.trim() || null,
      sanction: type === 'demerit' ? form.sanction : 'none',
    };

    setSaving(true);
    try {
      let res: Response;
      let label: string;
      if (bulk) {
        const chosen = students.filter((s) => bulkIds.includes(s.id));
        if (chosen.length === 0) { setMessage({ type: 'error', text: 'Select at least one student.' }); setSaving(false); return; }
        label = `${chosen.length} students`;
        res = await fetch('/api/discipline/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ ...shared, students: chosen.map((s) => ({ studentId: s.id, studentName: s.name })) }),
        });
      } else {
        const student = students.find((s) => s.id === form.studentId);
        if (!student) { setMessage({ type: 'error', text: 'Please select a student.' }); setSaving(false); return; }
        label = student.name;
        res = await fetch('/api/discipline', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ ...shared, studentId: student.id, studentName: student.name }),
        });
      }
      const result = await res.json();
      if (res.ok && result.success) {
        toast.success(`${type === 'merit' ? 'Merit' : 'Demerit'} logged`, `For ${label}`);
        setTimeout(() => navigate('/discipline/records'), 800);
      } else {
        setMessage({ type: 'error', text: result.message || 'Failed to save the record.' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Network error. Could not reach the server.' });
    } finally { setSaving(false); }
  };

  if (loadingClasses) {
    return <DashboardLayout><div style={{ padding: '80px 0' }}><LoadingSpinner /></div></DashboardLayout>;
  }

  return (
    <DashboardLayout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Log Conduct Record</h1>
          <p className="page-subtitle">Record a demerit for misconduct or a merit for positive behaviour.</p>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 640px)', gap: '20px' }}>
        <section className="card">
          <div className="card-header"><span className="section-title">Record details</span></div>
          <div className="card-body">
            <form onSubmit={submit} className="flex flex-col gap-3">
              {/* Type toggle */}
              <div className="field">
                <label className="label">Record type</label>
                <div className="segmented">
                  <button type="button" onClick={() => setType('demerit')} className={`segmented-btn is-absent${type === 'demerit' ? ' is-active' : ''}`}>
                    <Gavel size={14} /> Demerit
                  </button>
                  <button type="button" onClick={() => setType('merit')} className={`segmented-btn is-present${type === 'merit' ? ' is-active' : ''}`}>
                    <Award size={14} /> Merit
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3">
                <label className="label" style={{ margin: 0 }}>Apply to</label>
                <label className="flex items-center gap-2 text-sm" style={{ cursor: 'pointer' }}>
                  <input type="checkbox" checked={bulk} onChange={(e) => setBulk(e.target.checked)} />
                  <Users size={14} /> Multiple students
                </label>
              </div>

              <div className="field">
                <label className="label">Class</label>
                <select className="select" value={form.classId} onChange={(e) => update({ classId: e.target.value })}>
                  {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>

              {!bulk ? (
                <div className="field">
                  <label className="label">Student</label>
                  <select className="select" value={form.studentId} onChange={(e) => update({ studentId: e.target.value })} disabled={loadingStudents} required>
                    {students.length === 0 && <option value="">No students</option>}
                    {students.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
              ) : (
                <div className="field">
                  <div className="flex items-center justify-between">
                    <label className="label" style={{ margin: 0 }}>Students ({bulkIds.length} selected)</label>
                    <button type="button" className="btn btn-outline btn-sm" onClick={toggleAll} disabled={!students.length}>
                      {allSelected ? 'Clear all' : 'Select all'}
                    </button>
                  </div>
                  <div className="border rounded mt-2" style={{ maxHeight: '180px', overflowY: 'auto', padding: '4px' }}>
                    {students.length === 0 ? (
                      <div className="text-sm text-secondary" style={{ padding: '12px' }}>No students in this class.</div>
                    ) : students.map((s) => (
                      <label key={s.id} className="flex items-center gap-2 text-sm" style={{ padding: '8px 10px', cursor: 'pointer' }}>
                        <input type="checkbox" checked={bulkIds.includes(s.id)} onChange={() => toggleBulkId(s.id)} />
                        {s.name} <span className="text-tertiary mono text-xs">{s.id}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div className="grid grid-2" style={{ gap: '12px' }}>
                <div className="field">
                  <label className="label">Category</label>
                  <select className="select" value={form.category} onChange={(e) => update({ category: e.target.value })}>
                    {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label className="label">{type === 'demerit' ? 'Severity' : 'Level'}</label>
                  <select className="select" value={form.severity} onChange={(e) => update({ severity: e.target.value })}>
                    {Object.keys(tiers).map((t) => (
                      <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)} ({tiers[t]} pts)</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="field">
                <label className="label">Title</label>
                <input className="input" placeholder={type === 'demerit' ? 'e.g. Late to morning assembly' : 'e.g. Led peer study group'} value={form.title} onChange={(e) => update({ title: e.target.value })} required />
              </div>

              <div className="field">
                <label className="label">Description</label>
                <textarea className="textarea" placeholder="What happened, context, witnesses…" value={form.description} onChange={(e) => update({ description: e.target.value })} />
              </div>

              <div className="grid grid-2" style={{ gap: '12px' }}>
                <div className="field">
                  <label className="label">Date</label>
                  <input className="input" type="date" max={today()} value={form.incidentDate} onChange={(e) => update({ incidentDate: e.target.value })} required />
                </div>
                <div className="field">
                  <label className="label">Location</label>
                  <input className="input" placeholder="e.g. Classroom B2" value={form.location} onChange={(e) => update({ location: e.target.value })} />
                </div>
              </div>

              {type === 'demerit' && (
                <div className="field">
                  <label className="label">Sanction</label>
                  <select className="select" value={form.sanction} onChange={(e) => update({ sanction: e.target.value })}>
                    {SANCTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </div>
              )}

              <div className="flex items-center justify-between gap-3 border rounded" style={{ padding: '12px', background: 'var(--bg-subtle)' }}>
                <span className="text-sm text-secondary">Conduct impact</span>
                <span className={`badge ${type === 'merit' ? 'badge-success' : 'badge-danger'}`}>
                  {type === 'merit' ? '+' : '−'}{previewPoints} pts
                </span>
              </div>

              {message && (
                <div className={`alert ${message.type === 'success' ? 'alert-success' : 'alert-danger'}`}>
                  <AlertCircle size={16} /><span>{message.text}</span>
                </div>
              )}

              <div className="flex gap-2">
                <button type="button" className="btn btn-outline" onClick={() => navigate('/discipline/records')}>Cancel</button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={saving || (bulk ? bulkIds.length === 0 : !form.studentId) || !can('DISCIPLINE_LOG')}
                  title={can('DISCIPLINE_LOG') ? undefined : "You don't have permission to log discipline records."}
                >
                  <Save size={16} /> {saving ? 'Saving…' : bulk ? `Save for ${bulkIds.length || ''} students` : 'Save record'}
                </button>
              </div>
            </form>
          </div>
        </section>
      </div>
    </DashboardLayout>
  );
};
