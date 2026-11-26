import { EventEmitter } from 'events';
import { effectiveTid } from '../../tenancy/index.js';

/**
 * Live staff clock (the Gate view): every change to today's staff attendance is
 * announced here, and the stream (/api/staff/clock/stream) forwards it to the
 * leaders of the same school, so their screen updates the moment someone checks in.
 *
 * In-process fan-out, like the card-scan stream: one server process. Several
 * processes would need a shared broker here instead.
 */
export type ClockLiveKind = 'check_in' | 'check_out' | 'changed';
export interface ClockLiveEvent { type: ClockLiveKind; userId: string | null; at: string; tid: number }

export const clockLive = new EventEmitter();
clockLive.setMaxListeners(500);

/** Announce a change in the current school. Never throws: a live view must not break a check-in. */
export function announceClock(type: ClockLiveKind, userId: string | number | null = null): void {
  try {
    const evt: ClockLiveEvent = { type, userId: userId == null ? null : String(userId), at: new Date().toISOString(), tid: effectiveTid('staff clock event') };
    clockLive.emit('event', evt);
  } catch (err) {
    console.error('[clock] live event not sent:', (err as Error).message);
  }
}
