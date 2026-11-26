import type { Overview, OverviewRow } from '../../api/staffClock';
import type { SheetPerson } from './StaffClockAttention';

/** The groups of the dashboard's "Right now" board and the people behind each number. */

export type NowGroup = 'should' | 'here' | 'notHere' | 'late' | 'later' | 'left' | 'missed' | 'dayOff' | 'expected';

const hours = (r: OverviewRow) => (r.plan?.works && r.plan.start && r.plan.end ? `${r.plan.start} – ${r.plan.end}` : 'Day off');
const inOut = (r: OverviewRow) => (r.checkIn ? `in ${r.checkIn}${r.checkOut ? ` · out ${r.checkOut}` : ''}` : '');
const person = (r: OverviewRow, meta: string, tag?: string): SheetPerson => ({ id: r.userId, personId: r.userId, name: r.name, meta, tag });

/** The people behind a number, with the words for its side sheet. */
export function nowList(group: NowGroup, ov: Overview): { title: string; subtitle: string; empty: string; people: SheetPerson[]; remind?: 'in' | 'out' } {
  const at = ov.now?.at ?? '';
  const rows = ov.rows;
  const is = (...m: Array<NonNullable<OverviewRow['moment']>>) => (r: OverviewRow) => !!r.moment && m.includes(r.moment);
  const withTimes = (r: OverviewRow) => [hours(r), inOut(r)].filter(Boolean).join(' · ');
  switch (group) {
    case 'should':
      return { title: 'Should be here now', subtitle: `Their hours cover ${at}`, empty: 'Nobody is expected at this minute',
        people: rows.filter(is('here', 'due_now', 'left_early')).map((r) => person(r, withTimes(r), r.moment === 'due_now' ? 'Not here' : r.moment === 'left_early' ? 'Left early' : undefined)) };
    case 'here':
      return { title: 'Here now', subtitle: `Checked in and not out · ${at}`, empty: 'Nobody is checked in right now', remind: undefined,
        people: rows.filter(is('here')).map((r) => person(r, withTimes(r), r.status === 'late' ? 'Late' : undefined)) };
    case 'notHere':
      return { title: 'Not here yet', subtitle: `Should be here at ${at}, no check-in`, empty: 'Everyone who should be here is in', remind: 'in',
        people: rows.filter(is('due_now')).map((r) => person(r, `${hours(r)}${r.reminders ? '' : ' · no reminders on their phone'}`)) };
    case 'late':
      return { title: 'Late today', subtitle: 'Checked in after their start', empty: 'Nobody is late',
        people: rows.filter((r) => r.status === 'late').map((r) => person(r, withTimes(r))) };
    case 'later':
      return { title: 'Start later today', subtitle: 'Expected today, their day has not started', empty: 'Nobody starts later',
        people: rows.filter(is('due_later')).map((r) => person(r, `from ${r.plan?.start ?? ''} · ${hours(r)}`)) };
    case 'left':
      return { title: 'Left', subtitle: 'Checked out today', empty: 'Nobody has checked out yet',
        people: rows.filter(is('left', 'left_early')).map((r) => person(r, withTimes(r), r.moment === 'left_early' ? 'Before their end' : undefined)) };
    case 'missed':
      return { title: 'Absent today', subtitle: 'Their day ended with no check-in', empty: 'Nobody was absent',
        people: rows.filter(is('missed')).map((r) => person(r, hours(r))) };
    case 'dayOff':
      return { title: 'Day off today', subtitle: ov.holiday ? 'The school is closed today' : 'Not expected today (their working week)', empty: 'Nobody has a day off',
        people: rows.filter(is('day_off')).map((r) => person(r, r.plan?.own ? 'Own hours: day off' : 'Day off')) };
    default:
      return { title: 'Expected today', subtitle: 'Everyone with a working day today', empty: 'Nobody is expected today',
        people: rows.filter((r) => r.expected).map((r) => person(r, withTimes(r), r.status === 'late' ? 'Late' : undefined)) };
  }
}
