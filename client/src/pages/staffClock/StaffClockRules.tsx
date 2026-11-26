import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Info } from 'lucide-react';
import type { ClockRules } from '../../api/staffClock';

/**
 * The check-in rules (Zone & settings > Rules), written so that each one says what
 * it does: a picture of the day (closed, on time, late, leaving early), three
 * groups, one plain line under every rule, and a tip on request (hover, focus or
 * tap the "i"). Values save with the areas, as before.
 */

const mins = (t: string) => (/^\d\d:\d\d/.test(t) ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : 0);

/** The day, drawn: before "opens" the button is closed; until "late after" a check-in is on time; a check-out before "early before" is early. */
const DayStrip: React.FC<{ rules: ClockRules }> = ({ rules }) => {
  const opens = mins(rules.opens);
  const late = Math.max(opens, mins(rules.lateAfter));
  const early = Math.max(late, mins(rules.earlyLeaveBefore));
  const start = Math.max(0, opens - 60);
  const end = Math.min(24 * 60, early + 60);
  return (
    <figure className="zr-day" aria-label={`The day: check-in opens at ${rules.opens}; a check-in after ${rules.lateAfter} is late; a check-out before ${rules.earlyLeaveBefore} is leaving early.`}>
      <div className="zr-day-bar" aria-hidden="true">
        <i className="zr-seg zr-seg-closed" style={{ flex: Math.max(1, opens - start) }} />
        <i className="zr-seg zr-seg-ok" style={{ flex: Math.max(1, late - opens) }} />
        <i className="zr-seg zr-seg-mid" style={{ flex: Math.max(1, early - late) }} />
        <i className="zr-seg zr-seg-out" style={{ flex: Math.max(1, end - early) }} />
      </div>
      <figcaption>
        <span><i className="zr-key zr-seg-closed" />Closed before <b>{rules.opens}</b></span>
        <span><i className="zr-key zr-seg-ok" />On time until <b>{rules.lateAfter}</b></span>
        <span><i className="zr-key zr-seg-mid" />Late after <b>{rules.lateAfter}</b></span>
        <span><i className="zr-key zr-seg-out" />Early before <b>{rules.earlyLeaveBefore}</b></span>
      </figcaption>
    </figure>
  );
};

/** One rule: its name, an "i" for the longer tip, a plain line of help, and its control. */
const Field: React.FC<{
  id: string; label: string; help: string; tip: string;
  open: string | null; setOpen: (id: string | null) => void;
  wide?: boolean; children: React.ReactNode;
}> = ({ id, label, help, tip, open, setOpen, wide, children }) => {
  const shown = open === id;
  const pinned = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  /** The tip floats over the panel (it never pushes the rules down). Near the bottom it opens upwards. */
  const [up, setUp] = useState(false);
  const show = () => {
    const el = box.current;
    const scroller = el?.closest('.zc-drawer-body');
    if (el && scroller) setUp(scroller.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom < 120);
    setOpen(id);
  };
  return (
    <div className={`zr-field${wide ? ' zr-wide' : ''}${shown ? ' is-tip' : ''}`} data-rule={id} ref={box}>
      <div className="zr-text">
        <span className="zr-label">
          <b id={`zr-l-${id}`}>{label}</b>
          <button
            type="button" className={`zr-info${shown ? ' on' : ''}`} aria-label={`About ${label}`} aria-expanded={shown} aria-controls={`zr-t-${id}`}
            onMouseEnter={() => { if (!pinned.current) show(); }}
            onMouseLeave={() => { if (!pinned.current) setOpen(null); }}
            onFocus={() => { if (!pinned.current) show(); }}
            onBlur={() => { pinned.current = false; setOpen(null); }}
            onClick={() => { pinned.current = !(pinned.current && shown); if (pinned.current) show(); else setOpen(null); }}
          ><Info size={15} /></button>
        </span>
        <small>{help}</small>
      </div>
      <div className="zr-control">{children}</div>
      {shown && <div className={`zr-tip${up ? ' zr-tip-up' : ''}`} role="tooltip" id={`zr-t-${id}`}>{tip}</div>}
    </div>
  );
};

export const RulesPanel: React.FC<{ rules: ClockRules; canEdit: boolean; onChange: (p: Partial<ClockRules>) => void }> = ({ rules, canEdit, onChange }) => {
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [open]);

  const f = { open, setOpen };
  const time = (key: 'opens' | 'lateAfter' | 'earlyLeaveBefore', label: string) => (
    <input className="zr-input" type="time" aria-label={label} disabled={!canEdit} value={rules[key]} onChange={(e) => onChange({ [key]: e.target.value } as Partial<ClockRules>)} />
  );
  const num = (key: 'minShiftMinutes' | 'remindMinutes' | 'maxAccuracy' | 'allowance' | 'selfReplaceDays', label: string, unit: string) => (
    <span className="zr-num">
      <input className="zr-input" type="number" inputMode="numeric" min={0} aria-label={label} disabled={!canEdit} value={String(rules[key] ?? 0)} onChange={(e) => onChange({ [key]: Number(e.target.value) } as Partial<ClockRules>)} />
      <small>{unit}</small>
    </span>
  );
  const pick = <T extends string>(label: string, value: T, options: Array<[T, string, string?]>, set: (v: T) => void) => (
    <div className="zr-seg-pick" role="group" aria-label={label}>
      {options.map(([v, text, testid]) => <button key={v} type="button" aria-pressed={value === v} disabled={!canEdit} onClick={() => set(v)} data-testid={testid}>{text}</button>)}
    </div>
  );

  return (
    <div className="zr">
      <DayStrip rules={rules} />

      <section className="zr-group" aria-label="The day">
        <h3>The day</h3>
        <Field id="opens" label="Check-in opens" {...f}
          help="Earliest check-in."
          tip="Yes: nobody can check in before this time. It only blocks very early taps and never makes anyone late. Set it just before your earliest staff arrive.">
          {time('opens', 'Check-in opens')}
        </Field>
        <Field id="lateAfter" label="Late after" {...f}
          help="Later is late."
          tip="Between “opens” and this time a check-in is on time. People with their own working hours use their own start.">
          {time('lateAfter', 'Late after')}
        </Field>
        <Field id="earlyLeaveBefore" label="Early leave before" {...f}
          help="Earlier is leaving early."
          tip="From this time on, leaving is on time. People with their own working hours use their own end.">
          {time('earlyLeaveBefore', 'Early leave before')}
        </Field>
        <Field id="minShiftMinutes" label="Check-out opens after" {...f}
          help="Wait after check-in."
          tip="Stops a second tap from ending the day by accident. 60 = check-out is possible one hour after check-in.">
          {num('minShiftMinutes', 'Check-out opens after', 'min')}
        </Field>
        <Field id="remindMinutes" label="Reminders" {...f}
          help="Before start and end. 0 = off."
          tip="Staff with reminders on get a notification this many minutes before their own start and end. 0 turns reminders off for the school.">
          {num('remindMinutes', 'Reminders', 'min before')}
        </Field>
        <Field id="nonSchoolDays" label="Check-in on a day off" wide {...f}
          help="Weekend, own day off, school closed."
          tip="Closed: no check-in on a day off; the person sees their next working day. Allowed: it counts and is flagged for you.">
          {pick('Check-in on a day off', rules.nonSchoolDays === 'allow_flag' ? 'allow_flag' : 'refuse', [['refuse', 'Closed'], ['allow_flag', 'Allowed, flagged', 'dayoff-allow']], (v) => onChange({ nonSchoolDays: v }))}
        </Field>
      </section>

      <section className="zr-group" aria-label="Location">
        <h3>Location</h3>
        <Field id="maxAccuracy" label="Location precision" {...f}
          help="Vaguer readings are not trusted."
          tip="How sure the phone must be of its position. 100 m suits most schools; a smaller number refuses more indoor readings.">
          {num('maxAccuracy', 'Location precision', 'm')}
        </Field>
        <Field id="allowance" label="Edge tolerance" {...f}
          help="Just outside still counts."
          tip="A phone just outside the area counts, within its own error, up to this distance. 50 m forgives the gate; 0 is the exact edge.">
          {num('allowance', 'Edge tolerance', 'm')}
        </Field>
        <Field id="weakLocation" label="Weak GPS on own network" wide {...f}
          help="Vague GPS on mobile data."
          tip="Accept: it counts if the reading still reaches the school, and waits in “Needs review”. Refuse: only precise readings count.">
          {pick('Weak GPS on a person’s own network', rules.weakLocation === 'refuse' ? 'refuse' : 'review', [['review', 'Accept, review'], ['refuse', 'Refuse', 'weak-refuse']], (v) => onChange({ weakLocation: v }))}
        </Field>
        <Field id="schoolNetworks" label="School Wi-Fi" wide {...f}
          help="Optional. Counts as at school."
          tip="The school’s fixed internet address or range, for example 41.186.10.0/24. Leave empty if it changes.">
          <input className="zr-input zr-input-text" aria-label="School network" placeholder="41.186.10.0/24" disabled={!canEdit} value={rules.schoolNetworks} onChange={(e) => onChange({ schoolNetworks: e.target.value })} />
        </Field>
      </section>

      <section className="zr-group" aria-label="Accounts and phones">
        <h3>Accounts and phones</h3>
        <Field id="googleDomains" label="Google accounts" wide {...f}
          help="Empty = any linked account."
          tip="To limit sign-in, list endings such as gmail.com, school.rw. The address must also be on the person’s Amashuri profile.">
          <input className="zr-input zr-input-text" aria-label="Allowed Google domains" placeholder="Any" disabled={!canEdit} value={rules.googleDomains} onChange={(e) => onChange({ googleDomains: e.target.value })} />
        </Field>
        <Field id="selfReplaceDays" label="New phone approval" {...f}
          help="A second phone waits for approval."
          tip="A person may change phone once in this period by themselves. Another change waits under Phones & cards.">
          {num('selfReplaceDays', 'New phone approval', 'days')}
        </Field>
      </section>

      <p className="zr-note">Different hours for one person? <Link to="/staff/clock/people">Staff</Link> › Working hours.</p>
    </div>
  );
};
