import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Send, Info, AlertCircle, BookOpen, Sun, Calendar, PenLine, ChevronDown } from 'lucide-react';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { ApiError } from '../api/client';
import { useToast } from '../context/ToastContext';
import {
  getMyAbsences, getMyExcuses, getMyExcuse, submitExcuse, excuseTarget,
  type Absence, type Excuse, type ExcuseDetail, type ExcuseSessionType, type ExcuseTarget,
} from '../api/excuses';
import { CourseCombobox } from '../components/excuses/CourseCombobox';
import { REASONS, fmtDate, fmtLongDate } from '../components/excuses/excuseMeta';

/**
 * Submit an excuse. Three ways in, one form:
 *   - from an absence (query carries date/class/lesson): the "what" is fixed
 *     and shown as a summary, the student only explains why;
 *   - as an appeal (`?appeal=<id>`): same, pre-filled from the rejected
 *     request and linked to it via supersedesId;
 *   - blank (/excuses/new): pick one of your recorded absences from a list,
 *     or describe the class and date by hand when nothing was recorded yet.
 */

const today = () => new Date().toISOString().split('T')[0];
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().split('T')[0]; };

type Target = ExcuseTarget;

const targetFromAbsence = (a: Absence): Target => ({
  date: a.date, classId: a.classId, className: a.className, period: a.period,
  sessionType: a.sessionType, subjectId: a.subjectId, subjectName: a.subjectName,
});
const targetFromExcuse = (e: Excuse): Target => ({
  date: e.session_date, classId: e.class_id, className: e.class_name, period: e.period,
  sessionType: e.session_type, subjectId: e.subject_id, subjectName: e.subject_name,
});
const targetKey = (t: Target) => `${t.date}|${t.sessionType}|${t.classId ?? t.className.toLowerCase()}|${t.subjectId ?? '-'}`;

const TargetSummary: React.FC<{ t: Target }> = ({ t }) => (
  <div className="ex-target">
    <span className="ex-absence-icon">{t.sessionType === 'subject' ? <BookOpen size={16} /> : <Sun size={16} />}</span>
    <div>
      <div className="ex-target-title">{t.sessionType === 'subject' ? (t.subjectName || 'Lesson') : 'Morning check'}</div>
      <div className="ex-target-meta"><Calendar size={12} /> {fmtLongDate(t.date)} · {t.className}</div>
    </div>
  </div>
);

export const ExcuseNew: React.FC = () => {
  const navigate = useNavigate();
  const toast = useToast();
  const [params] = useSearchParams();
  const appealId = params.get('appeal') ? Number(params.get('appeal')) : null;

  const fromQuery: Target | null = useMemo(() => {
    const date = params.get('date');
    const className = params.get('className');
    if (!date || !className) return null;
    const sessionType: ExcuseSessionType = params.get('sessionType') === 'subject' ? 'subject' : 'homeroom';
    return {
      date, className,
      classId: params.get('classId'),
      period: params.get('period'),
      sessionType,
      subjectId: sessionType === 'subject' && params.get('subjectId') ? Number(params.get('subjectId')) : null,
      subjectName: params.get('subjectName'),
    };
  }, [params]);

  const [absences, setAbsences] = useState<Absence[]>([]);
  const [existing, setExisting] = useState<Excuse[]>([]);
  const [appealing, setAppealing] = useState<ExcuseDetail | null>(null);
  const [loading, setLoading] = useState(true);

  // Which absence to explain — locked when we arrived from one (or an appeal),
  // otherwise chosen here; "manual" falls back to free-text class + date.
  const locked = !!fromQuery || !!appealId;
  const [pickedKey, setPickedKey] = useState<string>('');
  const [manual, setManual] = useState(false);
  const [manualClass, setManualClass] = useState('');
  const [manualDate, setManualDate] = useState(today());

  const [reason, setReason] = useState('Medical');
  const [details, setDetails] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [ab, ex] = await Promise.all([getMyAbsences(), getMyExcuses()]);
        setAbsences(ab);
        setExisting(ex);
        if (appealId) {
          const prev = await getMyExcuse(appealId);
          setAppealing(prev);
          setReason(prev.reason);
        }
      } catch (err) {
        setFormError(err instanceof ApiError ? err.message : 'Could not load your absences.');
      } finally {
        setLoading(false);
      }
    })();
  }, [appealId]);

  const unexcused = useMemo(() => absences.filter((a) => !a.excuse), [absences]);
  const courseOptions = useMemo(() => Array.from(new Set(absences.map((a) => a.className))).sort(), [absences]);

  const target: Target | null = useMemo(() => {
    if (appealing) return targetFromExcuse(appealing);
    if (fromQuery) return fromQuery;
    if (manual) {
      return manualClass.trim() && manualDate
        ? { date: manualDate, classId: null, className: manualClass.trim(), period: null, sessionType: 'homeroom', subjectId: null, subjectName: null }
        : null;
    }
    const a = unexcused.find((x) => targetKey(targetFromAbsence(x)) === pickedKey);
    return a ? targetFromAbsence(a) : null;
  }, [appealing, fromQuery, manual, manualClass, manualDate, unexcused, pickedKey]);

  // Warn before the server's 409 does: an existing request for this exact
  // absence (unless that's the one we're appealing).
  const duplicate = useMemo(() => {
    if (!target) return null;
    const key = targetKey(target);
    return existing.find((e) => targetKey(targetFromExcuse(e)) === key && e.id !== appealId) ?? null;
  }, [existing, target, appealId]);

  const validate = () => {
    const errs: Record<string, string> = {};
    if (!target) errs.target = manual ? 'Enter the class and the date you were absent.' : 'Choose the absence this excuse is for.';
    if (manual && manualDate) {
      const picked = new Date(manualDate);
      const limit = new Date(); limit.setFullYear(limit.getFullYear() - 1);
      if (Number.isNaN(picked.getTime())) errs.target = 'That date isn’t valid.';
      else if (picked < limit) errs.target = 'That date is over a year ago — check the year.';
    }
    if (!details.trim()) errs.details = 'Add a short explanation so this can be reviewed.';
    else if (details.trim().length < 10) errs.details = 'Give a little more detail (at least 10 characters).';
    else if (details.length > 2000) errs.details = 'Please keep this under 2000 characters.';
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!validate() || !target) return;
    setSubmitting(true);
    try {
      const created = await submitExcuse({
        className: target.className, classId: target.classId, period: target.period, sessionDate: target.date,
        sessionType: target.sessionType, subjectId: target.subjectId, subjectName: target.subjectName,
        reason, description: details.trim(), supersedesId: appealId,
      });
      toast.success(appealId ? 'Appeal submitted' : 'Request submitted', `Your ${reason.toLowerCase()} excuse is awaiting review.`);
      navigate(`/excuses/${created.id}`, { replace: true });
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not reach the server — your text is still here, try again.';
      setFormError(msg);
      toast.error('Not submitted', msg);
    } finally {
      setSubmitting(false);
    }
  };

  const title = appealId ? 'Appeal a decision' : 'New excuse request';

  return (
    <DashboardLayout>
      <div className="page-header">
        <div>
          <h1 className="page-title">{title}</h1>
          <p className="page-subtitle">
            {appealId
              ? 'Add what the reviewer didn’t have the first time. This goes back into the review queue.'
              : 'Say which absence this is for and why you were away. A teacher reviews it.'}
          </p>
        </div>
        <Link to={appealId ? `/excuses/${appealId}` : '/excuses'} className="btn btn-outline"><ArrowLeft size={16} /> Back</Link>
      </div>

      <div className="ex-form-page">
        <form onSubmit={submit} className="card card-pad flex flex-col gap-4" noValidate>
          {loading ? (
            <div className="rp-skeleton" style={{ height: 180 }} />
          ) : (
            <>
              {/* ---- What ---- */}
              <div className="field">
                <span className="label">Absence</span>
                {appealing ? (
                  <>
                    <TargetSummary t={targetFromExcuse(appealing)} />
                    {appealing.reviewer_note && (
                      <div className="alert alert-info mt-2">
                        <Info size={16} />
                        <span>Reviewer’s note on the rejected request: “{appealing.reviewer_note}”</span>
                      </div>
                    )}
                  </>
                ) : fromQuery ? (
                  <TargetSummary t={fromQuery} />
                ) : manual ? (
                  <div className="ex-manual">
                    <div className="field">
                      <label className="label" htmlFor="excuse-course">Class</label>
                      <CourseCombobox
                        value={manualClass}
                        options={courseOptions}
                        invalid={!!fieldErrors.target && !manualClass.trim()}
                        onChange={(v) => { setManualClass(v); setFieldErrors((x) => ({ ...x, target: '' })); }}
                      />
                    </div>
                    <div className="field">
                      <label className="label" htmlFor="excuse-date">Date of absence</label>
                      <div className="ex-date-row">
                        <input
                          id="excuse-date"
                          className={`input${fieldErrors.target && !manualDate ? ' is-invalid' : ''}`}
                          type="date"
                          max={today()}
                          value={manualDate}
                          onChange={(e) => { setManualDate(e.target.value); setFieldErrors((x) => ({ ...x, target: '' })); }}
                        />
                        <div className="ex-quick">
                          {[{ label: 'Today', v: today() }, { label: 'Yesterday', v: daysAgo(1) }].map((q) => (
                            <button
                              key={q.label}
                              type="button"
                              className={`ex-quick-btn${manualDate === q.v ? ' is-on' : ''}`}
                              aria-pressed={manualDate === q.v}
                              onClick={() => setManualDate(q.v)}
                            >
                              {q.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                    <p className="ex-hint">
                      <Info size={12} />
                      <span>
                        A manual request covers the morning check for that day. If the lesson is already in your absences,{' '}
                        <button type="button" className="ex-linkbtn" onClick={() => setManual(false)}>pick it from the list</button> instead.
                      </span>
                    </p>
                  </div>
                ) : (
                  <>
                    {unexcused.length > 0 ? (
                      <div className="ex-select-wrap">
                        <select
                          id="excuse-absence"
                          className={`select${fieldErrors.target ? ' is-invalid' : ''}`}
                          value={pickedKey}
                          onChange={(e) => { setPickedKey(e.target.value); setFieldErrors((x) => ({ ...x, target: '' })); }}
                          aria-label="Which absence is this for?"
                        >
                          <option value="">Choose an absence…</option>
                          {unexcused.map((a) => {
                            const t = targetFromAbsence(a);
                            return (
                              <option key={a.recordId} value={targetKey(t)}>
                                {fmtDate(a.date)} — {a.sessionType === 'subject' ? (a.subjectName || 'Lesson') : 'Morning check'} · {a.className}
                              </option>
                            );
                          })}
                        </select>
                        <ChevronDown size={15} className="ex-select-caret" />
                      </div>
                    ) : (
                      <p className="ex-hint">
                        <Info size={12} />
                        <span>No unexplained absences on record this term.</span>
                      </p>
                    )}
                    <button type="button" className="ex-linkbtn mt-1" onClick={() => setManual(true)}>
                      <PenLine size={12} /> The absence isn’t listed — enter it manually
                    </button>
                  </>
                )}
                {fieldErrors.target && <p className="field-error">{fieldErrors.target}</p>}
                {target && !locked && !manual && <TargetSummary t={target} />}
              </div>

              {/* ---- Why ---- */}
              <div className="field">
                <span className="label" id="excuse-reason-label">Reason</span>
                <div className="ex-reasons" role="radiogroup" aria-labelledby="excuse-reason-label">
                  {REASONS.map((r) => (
                    <button
                      key={r.value}
                      type="button"
                      role="radio"
                      aria-checked={reason === r.value}
                      className={`ex-reason${reason === r.value ? ' is-on' : ''}`}
                      title={r.hint}
                      onClick={() => setReason(r.value)}
                    >
                      {r.icon}<span>{r.value}</span>
                    </button>
                  ))}
                </div>
                <span className="text-xs text-secondary">{REASONS.find((r) => r.value === reason)?.hint}</span>
              </div>

              <div className="field">
                <label className="label" htmlFor="excuse-details">Explanation</label>
                <textarea
                  id="excuse-details"
                  className={`textarea${fieldErrors.details ? ' is-invalid' : ''}`}
                  rows={5}
                  placeholder={appealId
                    ? 'What’s new since the last decision? A doctor’s name, a reference number, who can confirm…'
                    : 'What happened, and anything that helps verify it — a doctor’s name, an event code, who can confirm…'}
                  value={details}
                  onChange={(e) => { setDetails(e.target.value); setFieldErrors((x) => ({ ...x, details: '' })); }}
                />
                <div className="flex items-center justify-between mt-1">
                  {fieldErrors.details
                    ? <p className="field-error" style={{ margin: 0 }}>{fieldErrors.details}</p>
                    : <span className="text-xs text-secondary">The reviewer reads exactly this — be specific.</span>}
                  <span className={`text-xs ${details.length > 2000 ? 'text-danger' : 'text-tertiary'}`}>{details.length}/2000</span>
                </div>
              </div>

              {duplicate && (
                <div className="alert alert-warning">
                  <Info size={16} />
                  <span>
                    You already have a <strong>{duplicate.status}</strong> request for {excuseTarget(duplicate)} on {fmtDate(duplicate.session_date)}.{' '}
                    <Link to={`/excuses/${duplicate.id}`} className="ex-alert-link">Open it</Link>
                    {duplicate.status === 'rejected' ? ' to appeal instead.' : '.'}
                  </span>
                </div>
              )}
              {formError && <div className="alert alert-danger"><AlertCircle size={16} /><span>{formError}</span></div>}

              <div className="flex items-center justify-end gap-2 flex-wrap">
                <Link to={appealId ? `/excuses/${appealId}` : '/excuses'} className="btn btn-ghost">Cancel</Link>
                <button type="submit" className="btn btn-primary" disabled={submitting || !!duplicate} data-track="tendo.excuse.submit">
                  <Send size={15} /> {submitting ? 'Submitting…' : appealId ? 'Submit appeal' : 'Submit request'}
                </button>
              </div>
            </>
          )}
        </form>

        <aside className="ex-aside">
          <div className="card card-pad">
            <div className="section-title mb-2">What happens next</div>
            <ol className="ex-steps">
              <li><strong>Pending</strong> — a teacher sees it in their review queue.</li>
              <li><strong>Approved</strong> — the absence becomes <em>excused</em> on your record.</li>
              <li><strong>Rejected</strong> — you’ll see the reviewer’s note and can appeal once with new information.</li>
            </ol>
            <div className="text-xs text-secondary mt-2">You can withdraw a request while it’s still pending.</div>
          </div>
        </aside>
      </div>
    </DashboardLayout>
  );
};

export default ExcuseNew;
