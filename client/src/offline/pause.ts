/**
 * Outbox pause switch (TENANT_SWITCHING_PLAN.md §4.5 step 1): while a school
 * switch is under way no queued register is sent. A switch always ends in a
 * full page load (the MIS SSO redirect), which starts unpaused.
 */
let paused = false;

export const pauseOutbox = () => {
  paused = true;
};
export const resumeOutbox = () => {
  paused = false;
};
export const outboxPaused = () => paused;
