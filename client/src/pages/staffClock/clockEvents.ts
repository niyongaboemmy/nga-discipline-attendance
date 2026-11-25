/** Every staff clock setup card on the page re-reads when this fires (after a save). */
export const CLOCK_CHANGED = 'staff-clock-changed';
export const announceClockChange = () => window.dispatchEvent(new Event(CLOCK_CHANGED));
