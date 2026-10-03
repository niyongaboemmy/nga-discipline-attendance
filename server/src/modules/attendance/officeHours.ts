import { config } from '../../config.js';
import { misGetOrNullObject } from '../../services/misClient.js';

/**
 * Office hours on the attendance calendar (MIS OFFICE_HOURS_IMPLEMENTATION_PLAN.md §17.1).
 * The MIS is the system of record: this app only shows the sessions and
 * deep-links to the MIS register. Read with the user's own MIS token; any MIS
 * failure (not configured, 403, network) yields an empty lane, never an error.
 */
export interface OfficeHoursEntry {
  sessionId: number;
  scheduleId: number;
  date: string;
  title: string;
  startTime: string;
  endTime: string;
  room: string | null;
  state: string;
  expected: number | null;
  marked: number | null;
  ownStatus: string | null;
  link: string;
}

const inRange = (d: string, from: string, to: string) => d >= from && d <= to;

export async function fetchOfficeHours(misToken: string | undefined, from: string, to: string, isStudent: boolean): Promise<OfficeHoursEntry[]> {
  if (!misToken) return [];
  try {
    if (isStudent) {
      const me = await misGetOrNullObject(misToken, '/office-hours/me');
      if (!me) return [];
      const all = [...(me.upcoming ?? []), ...(me.history ?? [])];
      const seen = new Set<number>();
      return all
        .filter((s: any) => inRange(String(s.session_date), from, to) && s.state !== 'cancelled' && !seen.has(s.session_id) && seen.add(s.session_id))
        .map((s: any) => ({
          sessionId: Number(s.session_id),
          scheduleId: Number(s.schedule_id),
          date: String(s.session_date),
          title: String(s.title ?? 'Office hours'),
          startTime: String(s.start_time).slice(0, 5),
          endTime: String(s.end_time).slice(0, 5),
          room: s.location ?? null,
          state: String(s.state),
          expected: null,
          marked: null,
          ownStatus: s.status ?? null,
          link: `${config.ngaMisFrontendUrl}/my-office-hours`,
        }));
    }
    const data = await misGetOrNullObject(misToken, '/office-hours/sessions', { from, to });
    const sessions: any[] = data?.sessions ?? [];
    return sessions
      .filter((s) => s.state !== 'cancelled')
      .map((s) => ({
        sessionId: Number(s.session_id),
        scheduleId: Number(s.schedule_id),
        date: String(s.session_date),
        title: String(s.title ?? 'Office hours'),
        startTime: String(s.start_time).slice(0, 5),
        endTime: String(s.end_time).slice(0, 5),
        room: s.location ?? null,
        state: String(s.state),
        expected: Number(s.expected ?? 0),
        marked: Number(s.marked ?? 0),
        ownStatus: null,
        link: `${config.ngaMisFrontendUrl}/office-hours/schedules/${s.schedule_id}`,
      }));
  } catch (error) {
    console.warn('Office hours unavailable from the MIS:', (error as Error).message);
    return [];
  }
}
