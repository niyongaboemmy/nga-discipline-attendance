import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, BookOpen, Sun, Calendar, Users, Tag, Send, CheckCircle2, XCircle, Clock, Trash2,
  RotateCcw, MessageSquare, UserCheck, ExternalLink, CalendarDays, Info,
} from 'lucide-react';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { ErrorState } from '../components/common/ErrorState';
import { ConfirmDialog } from '../components/common/ConfirmDialog';
import { StatusChip } from '../components/attendance/StatusChip';
import { ApiError } from '../api/client';
import { useToast } from '../context/ToastContext';
import { getMyExcuse, withdrawExcuse, excuseTarget, type ExcuseDetail as ExcuseDetailData } from '../api/excuses';
import { STATUS_META, fmtLongDate, fmtDate } from '../components/excuses/excuseMeta';
import { ExcuseStatusBadge } from '../components/excuses/ExcuseStatusBadge';
import { fmtWhen } from '../utils/time';

/**
 * One excuse request in full: where it is in review, what was said, what
 * the reviewer decided, and what that did to the attendance record. The
 * actions a student has — withdraw while pending, appeal once rejected —
 * live here and nowhere else.
 */

const Timeline: React.FC<{ e: ExcuseDetailData }> = ({ e }) => {
  const decided = e.status !== 'pending';
  const steps = [
    { key: 'sent', label: 'Submitted', when: fmtWhen(e.created_at), done: true, icon: <Send size={13} /> },
    { key: 'review', label: 'Under review', when: decided ? fmtWhen(e.updated_at) : 'Waiting for a teacher', done: decided, current: !decided, icon: <Clock size={13} /> },
    {
      key: 'decision',
      label: e.status === 'approved' ? 'Approved' : e.status === 'rejected' ? 'Rejected' : 'Decision',
      when: decided ? `${fmtWhen(e.updated_at)}${e.reviewed_by_name ? ` · ${e.reviewed_by_name}` : ''}` : 'Not yet',
      done: decided, tone: e.status,
      icon: e.status === 'approved' ? <CheckCircle2 size={13} /> : e.status === 'rejected' ? <XCircle size={13} /> : <Clock size={13} />,
    },
  ];
  return (
    <ol className="ex-timeline">
      {steps.map((s) => (
        <li key={s.key} className={`ex-step${s.done ? ' is-done' : ''}${s.current ? ' is-current' : ''}${s.tone ? ` is-${s.tone}` : ''}`}>
          <span className="ex-step-dot">{s.icon}</span>
          <div className="ex-step-body">
            <div className="ex-step-label">{s.label}</div>
            <div className="ex-step-when">{s.when}</div>
          </div>
        </li>
      ))}
    </ol>
  );
};

export const ExcuseDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const [data, setData] = useState<ExcuseDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);

  const load = useCallback(async () => {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) { setError('That link doesn’t point at a request.'); setLoading(false); return; }
    setLoading(true); setError(null);
    try {
      setData(await getMyExcuse(n));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this request.');
    } finally {
      setLoading(false);
    }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const withdraw = async () => {
    if (!data) return;
    setWithdrawing(true);
    try {
      await withdrawExcuse(data.id);
      toast.success('Request withdrawn', 'It has been removed from the review queue.');
      navigate('/excuses', { replace: true });
    } catch (err) {
      toast.error('Not withdrawn', err instanceof ApiError ? err.message : 'Could not withdraw the request.');
      setWithdrawing(false);
      setConfirmWithdraw(false);
    }
  };

  const e = data;
  const meta = e ? STATUS_META[e.status] : null;
  const canAppeal = !!e && e.status === 'rejected' && !e.supersededBy;

  return (
    <DashboardLayout>
      <div className="page-header">
        <div>
          <h1 className="page-title">{e ? `${excuseTarget(e)} · ${fmtDate(e.session_date)}` : 'Excuse request'}</h1>
          <p className="page-subtitle">{e ? `${e.class_name} · ${e.reason}` : 'Loading…'}</p>
        </div>
        <div className="flex gap-2 flex-wrap" style={{ marginTop: 6 }}>
          <Link to="/excuses" className="btn btn-outline"><ArrowLeft size={16} /> All requests</Link>
          {e?.status === 'pending' && (
            <button className="btn btn-danger" onClick={() => setConfirmWithdraw(true)}><Trash2 size={15} /> Withdraw</button>
          )}
          {canAppeal && (
            <Link to={`/excuses/new?appeal=${e!.id}`} className="btn btn-primary"><RotateCcw size={15} /> Appeal</Link>
          )}
        </div>
      </div>

      {loading ? (
        <div className="rp-skeleton" style={{ height: 320 }} />
      ) : error || !e || !meta ? (
        <ErrorState message={error || 'Request not found.'} onRetry={load} />
      ) : (
        <div className="ex-detail">
          {/* ---- Status ---- */}
          <section className={`card card-pad ex-status is-${e.status}`}>
            <div className="ex-status-head">
              <ExcuseStatusBadge status={e.status} size="md" />
              <span className="text-sm text-secondary">{meta.blurb}</span>
            </div>
            <Timeline e={e} />
            {e.status === 'rejected' && e.supersededBy && (
              <div className="alert alert-info mt-2">
                <Info size={16} />
                <span>
                  You appealed this on {fmtDate(e.supersededBy.created_at)} —{' '}
                  <Link to={`/excuses/${e.supersededBy.id}`} className="ex-alert-link">open the appeal</Link> ({STATUS_META[e.supersededBy.status].label.toLowerCase()}).
                </span>
              </div>
            )}
            {e.supersedes && (
              <div className="alert alert-info mt-2">
                <Info size={16} />
                <span>
                  This is an appeal of a request rejected on {fmtDate(e.supersedes.created_at)} —{' '}
                  <Link to={`/excuses/${e.supersedes.id}`} className="ex-alert-link">see the original</Link>.
                </span>
              </div>
            )}
          </section>

          <div className="ex-detail-grid">
            {/* ---- The absence ---- */}
            <section className="card">
              <div className="card-header"><span className="section-title">The absence</span></div>
              <div className="card-body">
                <dl className="sd-meta" style={{ margin: 0 }}>
                  <div>
                    <dt>{e.session_type === 'subject' ? <BookOpen size={13} /> : <Sun size={13} />} Lesson</dt>
                    <dd>{excuseTarget(e)}</dd>
                  </div>
                  <div><dt><Calendar size={13} /> Date</dt><dd>{fmtLongDate(e.session_date)}</dd></div>
                  <div><dt><Users size={13} /> Class</dt><dd>{e.class_name}</dd></div>
                  {e.period && <div><dt><Clock size={13} /> Session</dt><dd>{e.period}</dd></div>}
                  <div>
                    <dt><UserCheck size={13} /> On your record now</dt>
                    <dd>
                      {e.attendanceStatus
                        ? <StatusChip kind={e.attendanceStatus} />
                        : <span className="text-secondary font-normal">No register found for this lesson</span>}
                    </dd>
                  </div>
                </dl>
                {e.session_type === 'subject' && e.class_id && (
                  <Link
                    to={`/attendance/session?date=${e.session_date}&classId=${encodeURIComponent(e.class_id)}&sessionType=subject${e.subject_id != null ? `&subjectId=${e.subject_id}` : ''}`}
                    className="btn btn-ghost btn-sm mt-3"
                  >
                    <CalendarDays size={14} /> View the lesson <ExternalLink size={12} />
                  </Link>
                )}
              </div>
            </section>

            {/* ---- Your request ---- */}
            <section className="card">
              <div className="card-header">
                <span className="section-title">Your explanation</span>
                <span className="badge badge-neutral"><Tag size={11} /> {e.reason}</span>
              </div>
              <div className="card-body">
                {e.description
                  ? <p className="ex-body-text">{e.description}</p>
                  : <p className="text-sm text-secondary">No explanation was written.</p>}
                <div className="text-xs text-tertiary mt-3">Submitted {fmtWhen(e.created_at)}</div>
              </div>
            </section>
          </div>

          {/* ---- Reviewer ---- */}
          <section className={`card ex-review${e.status === 'pending' ? ' is-waiting' : ''}`}>
            <div className="card-header">
              <span className="section-title flex items-center gap-2"><MessageSquare size={15} /> Reviewer’s response</span>
              {e.reviewed_by_name && <span className="text-xs text-secondary">{e.reviewed_by_name} · {fmtWhen(e.updated_at)}</span>}
            </div>
            <div className="card-body">
              {e.status === 'pending' ? (
                <p className="text-sm text-secondary">Nothing yet — a teacher hasn’t reviewed this request.</p>
              ) : (
                <>
                  <div className="flex items-center gap-2 mb-2">
                    {e.status === 'approved'
                      ? <><CheckCircle2 size={16} style={{ color: 'var(--success)' }} /><span className="font-semibold text-sm">Approved</span></>
                      : <><XCircle size={16} style={{ color: 'var(--danger)' }} /><span className="font-semibold text-sm">Rejected</span></>}
                  </div>
                  {e.reviewer_note
                    ? <p className="ex-body-text">“{e.reviewer_note}”</p>
                    : <p className="text-sm text-secondary">No note was left.</p>}
                  {e.status === 'approved' && (
                    <p className="text-xs text-secondary mt-3">
                      {e.attendanceStatus === 'excused'
                        ? 'Your attendance for this lesson now shows as excused.'
                        : 'Your attendance record for this lesson will show as excused once the register reflects it.'}
                    </p>
                  )}
                  {canAppeal && (
                    <div className="mt-3">
                      <Link to={`/excuses/new?appeal=${e.id}`} className="btn btn-outline btn-sm">
                        <RotateCcw size={14} /> Appeal with new information
                      </Link>
                    </div>
                  )}
                </>
              )}
            </div>
          </section>
        </div>
      )}

      {confirmWithdraw && e && (
        <ConfirmDialog
          open
          title="Withdraw this request?"
          message={`Your ${e.reason.toLowerCase()} excuse for ${excuseTarget(e)} on ${fmtDate(e.session_date)} will be removed from the review queue. You can submit a new one later.`}
          confirmLabel="Withdraw"
          danger
          loading={withdrawing}
          onConfirm={withdraw}
          onCancel={() => setConfirmWithdraw(false)}
        />
      )}
    </DashboardLayout>
  );
};

export default ExcuseDetail;
