import React, { useMemo, useState } from 'react';
import { CalendarClock, Copy, RotateCcw, School, UserCog } from 'lucide-react';
import { ApiError } from '../../api/client';
import { staffClockApi, type DayPlan, type StaffPlan, type WeekPlan } from '../../api/staffClock';
import { useToast } from '../../context/ToastContext';
import { Spinner } from './StaffClockHeader';

/**
 * One person's working week (inside the staff history window). By default a person
 * follows the school's hours; here an admin gives them their own days and times,
 * from a chosen day on. Late, early, days off and absences then follow this week
 * on the staff page, the dashboard and every report.
 */

const ORDER = ['1', '2', '3', '4', '5', '6', '0'];
const NAMES: Record<string, string> = { '1': 'Monday', '2': 'Tuesday', '3': 'Wednesday', '4': 'Thursday', '5': 'Friday', '6': 'Saturday', '0': 'Sunday' };
const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const fmtDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const same = (a: WeekPlan, b: WeekPlan) => ORDER.every((d) => a[d].works === b[d].works && (!a[d].works || (a[d].start === b[d].start && a[d].end === b[d].end)));
const clone = (w: WeekPlan): WeekPlan => Object.fromEntries(ORDER.map((d) => [d, { ...w[d] }]));
const dayError = (d: DayPlan) => (d.works && (!d.start || !d.end) ? 'Set both times' : d.works && mins(d.end) <= mins(d.start) ? 'End must be after start' : null);

function weekSummary(w: WeekPlan): string {
  const on = ORDER.filter((d) => w[d].works);
  if (!on.length) return 'No working days';
  const total = on.reduce((n, d) => n + Math.max(0, mins(w[d].end) - mins(w[d].start)), 0);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${on.length} day${on.length === 1 ? '' : 's'} a week · ${h} h${m ? ` ${String(m).padStart(2, '0')}` : ''}`;
}

export const StaffPlanPanel: React.FC<{
  personId: string;
  name: string;
  plan: StaffPlan;
  today: string;
  canEdit: boolean;
  /** the saved plan: the caller reloads what depends on it */
  onSaved: (plan: StaffPlan) => void;
}> = ({ personId, name, plan, today, canEdit, onSaved }) => {
  const toast = useToast();
  const [days, setDays] = useState<WeekPlan>(() => clone(plan.days));
  const [from, setFrom] = useState(today);
  const [note, setNote] = useState(plan.own ? plan.note ?? '' : '');
  const [busy, setBusy] = useState<'save' | 'reset' | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const first = name.trim().split(/\s+/)[0] || 'This person';
  const isSchool = useMemo(() => same(days, plan.school), [days, plan.school]);
  const dirty = useMemo(() => !same(days, plan.days) || (plan.own && note.trim() !== (plan.note ?? '')), [days, plan, note]);
  const errors = ORDER.map((d) => dayError(days[d]));
  const invalid = errors.some(Boolean);
  const set = (d: string, patch: Partial<DayPlan>) => setDays((w) => ({ ...w, [d]: { ...w[d], ...patch } }));
  const firstOn = ORDER.find((d) => days[d].works);

  const save = async (next: WeekPlan | null) => {
    setBusy(next ? 'save' : 'reset');
    try {
      const res = await staffClockApi.savePlan(personId, { days: next, effectiveFrom: from, note: next ? note.trim() || undefined : undefined });
      const saved = res.data!;
      toast.success(res.message || 'Saved', saved.rejudged ? `${saved.rejudged} recorded day${saved.rejudged === 1 ? ' was' : 's were'} judged again with these hours.` : `${first}'s attendance now follows these hours.`);
      setDays(clone(saved.plan.days));
      setNote(saved.plan.own ? saved.plan.note ?? '' : '');
      setConfirmReset(false);
      onSaved(saved.plan);
    } catch (e) {
      toast.error('Hours not saved', e instanceof ApiError ? e.message : 'Check the connection and try again.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="sp" data-testid="staff-plan">
      <div className="sp-state">
        <span className={`sp-badge${plan.own ? ' own' : ''}`}>{plan.own ? <UserCog size={16} /> : <School size={16} />}</span>
        <div className="sp-state-text">
          <b>{plan.own ? 'Own hours' : "Follows the school's hours"}</b>
          <small>
            {plan.own
              ? `Since ${plan.effectiveFrom ? fmtDate(plan.effectiveFrom) : '—'}${plan.updatedByName ? ` · set by ${plan.updatedByName}` : ''}${plan.note ? ` · ${plan.note}` : ''}`
              : canEdit ? `Change a day below to give ${first} their own hours.` : 'The same days and times as the rest of the staff.'}
          </small>
        </div>
        <span className="sp-sum">{weekSummary(plan.days)}</span>
      </div>
      {plan.upcoming && (
        <div className="sp-note"><CalendarClock size={16} />
          {plan.upcoming.days ? `New hours start on ${fmtDate(plan.upcoming.effectiveFrom)}: ${weekSummary(plan.upcoming.days)}.` : `Back to the school's hours on ${fmtDate(plan.upcoming.effectiveFrom)}.`}
        </div>
      )}

      <div className="sp-week" role="group" aria-label={`${name}: working week`}>
        <div className="sp-row sp-row-head" aria-hidden="true"><span>Day</span><span>Works</span><span>Starts</span><span>Ends</span><span /></div>
        {ORDER.map((d, i) => {
          const day = days[d];
          const sch = plan.school[d];
          const differs = day.works !== sch.works || (day.works && (day.start !== sch.start || day.end !== sch.end));
          return (
            <div key={d} className={`sp-row${day.works ? '' : ' off'}`} data-day={d}>
              <b>{NAMES[d]}</b>
              <button className="sc-switch" role="switch" aria-checked={day.works} aria-label={`${NAMES[d]}: ${day.works ? 'working day' : 'day off'}`} disabled={!canEdit} onClick={() => set(d, { works: !day.works })}><span /></button>
              {day.works ? (
                <>
                  <input className="sp-time" type="time" value={day.start} disabled={!canEdit} aria-label={`${NAMES[d]} starts`} aria-invalid={!!errors[i]} onChange={(e) => set(d, { start: e.target.value })} />
                  <input className="sp-time" type="time" value={day.end} disabled={!canEdit} aria-label={`${NAMES[d]} ends`} aria-invalid={!!errors[i]} onChange={(e) => set(d, { end: e.target.value })} />
                </>
              ) : (
                <span className="sp-off">Day off</span>
              )}
              <small className={errors[i] ? 'sp-err' : ''}>
                {errors[i] ?? (differs ? (sch.works ? `School: ${sch.start} – ${sch.end}` : 'School: day off') : '')}
              </small>
            </div>
          );
        })}
      </div>
      <p className="sp-help">Checking in after the start is late. Checking out before the end is leaving early. On a day off {first} is not expected and is never counted absent.</p>

      {canEdit && (
        <div className="sp-foot">
          {firstOn && (
            <button className="sc-btn sc-btn-sm" disabled={!!busy} onClick={() => setDays((w) => Object.fromEntries(ORDER.map((d) => [d, w[d].works ? { ...w[d], start: w[firstOn].start, end: w[firstOn].end } : w[d]])))} title={`Give every working day ${NAMES[firstOn]}'s times`}>
              <Copy size={14} /> Same times every day
            </button>
          )}
          <label className="sp-field">
            <span>Starts from</span>
            <input className="sp-time sp-date" type="date" value={from} onChange={(e) => setFrom(e.target.value || today)} aria-label="Hours start from" />
          </label>
          <label className="sp-field sp-grow">
            <span>Note</span>
            <input className="sp-time sp-text" maxLength={200} placeholder="Why, e.g. part time" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
          </label>
          <div className="sp-actions">
            {plan.own && (confirmReset ? (
              <span className="sp-confirm">Use the school's hours from {from === today ? 'today' : fmtDate(from)}?
                <button className="sc-btn sc-btn-sm" disabled={!!busy} onClick={() => setConfirmReset(false)}>Cancel</button>
                <button className="sc-btn sc-btn-primary sc-btn-sm" disabled={!!busy} onClick={() => void save(null)} data-testid="plan-reset-yes">{busy === 'reset' ? <Spinner /> : null} Yes</button>
              </span>
            ) : (
              <button className="sc-btn sc-btn-sm" disabled={!!busy} onClick={() => setConfirmReset(true)} data-testid="plan-reset"><RotateCcw size={14} /> School's hours</button>
            ))}
            {!confirmReset && (
              <button className="sc-btn sc-btn-primary sc-btn-sm" disabled={!!busy || invalid || !dirty} onClick={() => void save(isSchool ? null : days)} data-testid="plan-save">
                {busy === 'save' ? <Spinner /> : null} {busy === 'save' ? 'Saving…' : 'Save hours'}
              </button>
            )}
          </div>
          {from < today && <p className="sp-help sp-wide">Days already recorded since {fmtDate(from)} will be judged again with these hours.</p>}
        </div>
      )}
    </div>
  );
};
