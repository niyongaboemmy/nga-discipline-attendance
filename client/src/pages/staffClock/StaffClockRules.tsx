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
  const span = Math.max(1, end - start);
  const at = (m: number) => `${Math.max(0, Math.min(100, ((m - start) / span) * 100))}%`;
  return (
    <figure className="zr-day" aria-label={`The day: check-in opens at ${rules.opens}; a check-in after ${rules.lateAfter} is late; a check-out before ${rules.earlyLeaveBefore} is leaving early.`}>
      <div className="zr-day-bar" aria-hidden="true">
        <i className="zr-seg zr-seg-closed" style={{ flex: Math.max(1, opens - start) }} />
        <i className="zr-seg zr-seg-ok" style={{ flex: Math.max(1, late - opens) }} />
        <i className="zr-seg zr-seg-mid" style={{ flex: Math.max(1, early - late) }} />
        <i className="zr-seg zr-seg-out" style={{ flex: Math.max(1, end - early) }} />
      </div>
      <div className="zr-day-ticks" aria-hidden="true">
        <span style={{ left: at(opens) }}><b>{rules.opens}</b>opens</span>
        <span style={{ left: at(late) }}><b>{rules.lateAfter}</b>late after</span>
        <span style={{ left: at(early) }}><b>{rules.earlyLeaveBefore}</b>early before</span>
      </div>
      <figcaption>
        <span><i className="zr-key zr-seg-closed" />Before {rules.opens}: check-in is closed</span>
        <span><i className="zr-key zr-seg-ok" />{rules.opens} – {rules.lateAfter}: check-in is on time</span>
        <span><i className="zr-key zr-seg-mid" />After {rules.lateAfter}: check-in is late · leaving before {rules.earlyLeaveBefore} is early</span>
        <span><i className="zr-key zr-seg-out" />From {rules.earlyLeaveBefore}: leaving is on time</span>
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
  return (
    <div className={`zr-field${wide ? ' zr-wide' : ''}`} data-rule={id}>
      <div className="zr-text">
        <span className="zr-label">
          <b id={`zr-l-${id}`}>{label}</b>
          <button
            type="button" className={`zr-info${shown ? ' on' : ''}`} aria-label={`About ${label}`} aria-expanded={shown} aria-controls={`zr-t-${id}`}
            onMouseEnter={() => { if (!pinned.current) setOpen(id); }}
            onMouseLeave={() => { if (!pinned.current) setOpen(null); }}
            onFocus={() => { if (!pinned.current) setOpen(id); }}
            onBlur={() => { pinned.current = false; setOpen(null); }}
            onClick={() => { pinned.current = !(pinned.current && shown); setOpen(pinned.current ? id : null); }}
          ><Info size={15} /></button>
        </span>
        <small>{help}</small>
      </div>
      <div className="zr-control">{children}</div>
      {shown && <div className="zr-tip" role="tooltip" id={`zr-t-${id}`}>{tip}</div>}
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
          help="Before this time the check-in button is closed."
          tip="Yes: nobody can check in before this time. It only stops very early taps (for example at midnight). Set it a little before your earliest staff arrive. It does not make anyone late.">
          {time('opens', 'Check-in opens')}
        </Field>
        <Field id="lateAfter" label="Late after" {...f}
          help="A check-in after this time is marked late."
          tip="From “Check-in opens” until this time a check-in is on time. One minute later it is late. Someone with their own working hours is judged by their own start instead.">
          {time('lateAfter', 'Late after')}
        </Field>
        <Field id="earlyLeaveBefore" label="Early leave before" {...f}
          help="A check-out before this time is marked as leaving early."
          tip="From this time on, leaving is on time. Someone with their own working hours is judged by their own end instead.">
          {time('earlyLeaveBefore', 'Early leave before')}
        </Field>
        <Field id="minShiftMinutes" label="Check-out opens after" {...f}
          help="Minutes after check-in before the same person can check out."
          tip="Stops an accidental second tap from ending the day straight after check-in. 60 means: check-out is possible one hour after check-in.">
          {num('minShiftMinutes', 'Check-out opens after', 'min')}
        </Field>
        <Field id="remindMinutes" label="Reminders" {...f}
          help="Phones are reminded this long before the start and the end."
          tip="Staff who turned reminders on get a notification this many minutes before their own start (to check in) and their own end (to check out). 0 turns reminders off for the school.">
          {num('remindMinutes', 'Reminders', 'min before')}
        </Field>
        <Field id="nonSchoolDays" label="Check-in on a day off" wide {...f}
          help="A day off: a weekend, a person’s own day off, or a day the school is closed."
          tip="Closed: on a day off the button is closed and the person sees when their next working day starts. Allowed: the check-in counts and is flagged “not a working day” for you to see.">
          {pick('Check-in on a day off', rules.nonSchoolDays === 'allow_flag' ? 'allow_flag' : 'refuse', [['refuse', 'Closed'], ['allow_flag', 'Allowed, flagged', 'dayoff-allow']], (v) => onChange({ nonSchoolDays: v }))}
        </Field>
      </section>

      <section className="zr-group" aria-label="Location">
        <h3>Location</h3>
        <Field id="maxAccuracy" label="Location precision" {...f}
          help="A phone reading vaguer than this is not trusted on its own."
          tip="Every phone says how sure it is of its position, in metres. 100 m suits most schools. A smaller number is stricter and refuses more readings taken indoors.">
          {num('maxAccuracy', 'Location precision', 'm')}
        </Field>
        <Field id="allowance" label="Edge tolerance" {...f}
          help="How far outside the school’s edge still counts."
          tip="A phone standing just outside the drawn area still counts when it is within its own error, up to this many metres. 50 m forgives a phone at the gate; 0 means the drawn edge exactly.">
          {num('allowance', 'Edge tolerance', 'm')}
        </Field>
        <Field id="weakLocation" label="Weak GPS on own network" wide {...f}
          help="On mobile data indoors, GPS can be vaguer than the precision above."
          tip="Accept, review: the check-in counts while the reading still reaches the school, and waits in “Needs review” for you to confirm. Refuse: only precise readings count, so some staff on mobile data must step outside.">
          {pick('Weak GPS on a person’s own network', rules.weakLocation === 'refuse' ? 'refuse' : 'review', [['review', 'Accept, review'], ['refuse', 'Refuse', 'weak-refuse']], (v) => onChange({ weakLocation: v }))}
        </Field>
        <Field id="schoolNetworks" label="School Wi-Fi" wide {...f}
          help="Optional. A check-in from the school’s own internet address counts as at school."
          tip="Type the school’s fixed public address or range, for example 41.186.10.0/24 (ask your internet provider). Leave it empty if the address changes: location alone is then used.">
          <input className="zr-input zr-input-text" aria-label="School network" placeholder="41.186.10.0/24" disabled={!canEdit} value={rules.schoolNetworks} onChange={(e) => onChange({ schoolNetworks: e.target.value })} />
        </Field>
      </section>

      <section className="zr-group" aria-label="Accounts and phones">
        <h3>Accounts and phones</h3>
        <Field id="googleDomains" label="Google accounts" wide {...f}
          help="Which Google accounts may sign in. Empty: any account linked to a staff profile."
          tip="To allow only some accounts, list their endings, for example: gmail.com, school.rw. A person still needs that Google address on their Amashuri profile.">
          <input className="zr-input zr-input-text" aria-label="Allowed Google domains" placeholder="Any" disabled={!canEdit} value={rules.googleDomains} onChange={(e) => onChange({ googleDomains: e.target.value })} />
        </Field>
        <Field id="selfReplaceDays" label="New phone approval" {...f}
          help="A second new phone within this many days waits for your approval."
          tip="A person may move to a new phone by themselves once in this period. Another change inside it shows under Phones & cards for you to approve. This stops a phone being passed around.">
          {num('selfReplaceDays', 'New phone approval', 'days')}
        </Field>
      </section>

      <p className="zr-note">These rules are for everyone. Someone with different days or times? Open them on the <Link to="/staff/clock/people">Staff</Link> tab, then Working hours.</p>
    </div>
  );
};
