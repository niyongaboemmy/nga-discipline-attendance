import { pauseOutbox } from '../offline/pause';
import { startMisSignIn } from '../utils/ssoStart';
import {
  allowSwitchAttempt, clearSessionSlot, guardDecision, parseSchoolCookie, sessionTid, switchAttemptsExhausted,
} from './school.ts';

/**
 * The re-sign-in sequence (TENANT_SWITCHING_PLAN.md §4.5), browser side:
 * pause the outbox, show the "Switching…" overlay, drop the session slot
 * without a sign-out, and run MIS SSO again. SSOCallback then lands on the
 * app home. At most 3 automatic tries per 2 minutes, then the manual sign-in.
 */

/** AuthContext shows the overlay on this event. */
export const SCHOOL_SWITCH_EVENT = 'tendo:school-switch';

let underway = false;

export function restartSignIn(reason: string) {
  if (underway) return;
  underway = true;
  pauseOutbox();
  window.dispatchEvent(new CustomEvent(SCHOOL_SWITCH_EVENT, { detail: { reason } }));
  clearSessionSlot(localStorage);
  if (!allowSwitchAttempt(localStorage)) {
    window.location.assign('/?signin=manual');
    return;
  }
  startMisSignIn();
}

/** The school guard: compare `nga_school` with this session; restart sign-in on a mismatch. */
export function checkSchool(): boolean {
  let cookie: string;
  try {
    cookie = document.cookie;
  } catch {
    return false;
  }
  const c = parseSchoolCookie(cookie);
  if (guardDecision(c?.tid ?? null, sessionTid(localStorage)) !== 'switch') return false;
  // Loop guard spent: stay put (a manual sign-in is not undone right away).
  if (switchAttemptsExhausted(localStorage)) return false;
  restartSignIn('school-cookie');
  return true;
}

/** Does the cookie name another school than this session? (used by the 401 handler) */
export function cookieSaysOtherSchool(): boolean {
  try {
    const c = parseSchoolCookie(document.cookie);
    return guardDecision(c?.tid ?? null, sessionTid(localStorage)) === 'switch';
  } catch {
    return false;
  }
}
