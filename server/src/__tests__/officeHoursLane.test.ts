import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchOfficeHours } from '../modules/attendance/officeHours.js';

// The attendance calendar's office-hours lane (MIS OFFICE_HOURS_IMPLEMENTATION_PLAN.md §17.1):
// read from the MIS with the user's token; any failure is an empty lane.
const respond = (status: number, body: unknown) =>
  vi.fn(async () => ({ ok: status < 400, status, json: async () => body }) as any);

describe('office-hours lane', () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps a teacher's MIS sessions with a deep link to the register", async () => {
    const fetchMock = respond(200, {
      success: true,
      data: {
        sessions: [
          { session_id: 5, schedule_id: 9, session_date: '2026-03-02', title: 'Maths support', start_time: '16:20', end_time: '17:20', location: 'B4', state: 'held', expected: 12, marked: 12 },
          { session_id: 6, schedule_id: 9, session_date: '2026-03-04', title: 'Maths support', start_time: '16:20', end_time: '17:20', location: 'B4', state: 'cancelled', expected: 12, marked: 0 },
        ],
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    const out = await fetchOfficeHours('tok', '2026-03-02', '2026-03-06', false);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ sessionId: 5, title: 'Maths support', expected: 12, state: 'held' });
    expect(out[0].link).toMatch(/\/office-hours\/schedules\/9$/);
    const url = String((fetchMock.mock.calls[0] as any)[0]);
    expect(url).toContain('/office-hours/sessions');
    expect(url).toContain('from=2026-03-02');
    expect((fetchMock.mock.calls[0] as any)[1].headers.Authorization).toBe('Bearer tok');
  });

  it("shows a student their own sessions in range with their mark", async () => {
    vi.stubGlobal(
      'fetch',
      respond(200, {
        data: {
          upcoming: [{ session_id: 7, schedule_id: 9, session_date: '2026-03-04', title: 'Maths support', start_time: '16:20', end_time: '17:20', location: null, state: 'upcoming', status: null }],
          history: [
            { session_id: 5, schedule_id: 9, session_date: '2026-03-02', title: 'Maths support', start_time: '16:20', end_time: '17:20', location: 'B4', state: 'held', status: 'PRESENT' },
            { session_id: 1, schedule_id: 9, session_date: '2026-02-23', title: 'Maths support', start_time: '16:20', end_time: '17:20', location: 'B4', state: 'held', status: 'ABSENT' },
          ],
        },
      }),
    );
    const out = await fetchOfficeHours('tok', '2026-03-02', '2026-03-06', true);
    expect(out.map((o) => [o.date, o.ownStatus])).toEqual([
      ['2026-03-04', null],
      ['2026-03-02', 'PRESENT'],
    ]);
    expect(out[0].link).toMatch(/\/my-office-hours$/);
  });

  it('degrades to an empty lane when the MIS refuses or is down', async () => {
    vi.stubGlobal('fetch', respond(403, {}));
    expect(await fetchOfficeHours('tok', '2026-03-02', '2026-03-06', false)).toEqual([]);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await fetchOfficeHours('tok', '2026-03-02', '2026-03-06', false)).toEqual([]);
    expect(await fetchOfficeHours(undefined, '2026-03-02', '2026-03-06', false)).toEqual([]);
  });
});
