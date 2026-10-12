/** Types for /api/rfid (server/src/modules/rfid/rfid.routes.ts). */

export type CardStatus = 'unassigned' | 'active' | 'disabled' | 'lost' | 'retired';

export interface CardHolder {
  studentId: string;
  studentName: string;
  className: string | null;
  assignedAt: string;
  assignedByName: string | null;
}

export interface RfidCard {
  id: number;
  uid: string;
  label: string | null;
  status: CardStatus;
  statusReason: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  /** How many times the scanner has read this card. */
  taps: number;
  holder: CardHolder | null;
}

export interface CardCounts { total: number; active: number; unassigned: number; blocked: number }

export interface CardDetail extends Omit<RfidCard, 'taps'> {
  taps: number;
  tapsToday: number;
  assignments: {
    id: number; studentId: string; studentName: string; assignedAt: string;
    assignedByName: string | null; endedAt: string | null; endReason: string | null;
  }[];
  recentScans: {
    id: number; at: string; outcome: ScanOutcome; detail: string | null; message: string;
    studentName: string | null; className: string | null; deviceName: string | null; source: string;
  }[];
}

export interface RosterStudent {
  id: string;
  name: string;
  status: string | null;
  className: string | null;
  card: { label: string | null; uid: string } | null;
}

export interface RosterStatus {
  students: number;
  activeEnrolments: number;
  classGroups: number;
  credentialsConfigured: boolean;
  last: { id: number; started_at: string; finished_at: string | null; error: string | null } | null;
  lastSuccessful: { id: number; finished_at: string; students: number; enrolments: number; slots: number } | null;
  timetableSlots: number;
  classesWithTimetable: number;
}

export type ScanOutcome =
  | 'pending' | 'recorded_present' | 'recorded_late' | 'already_recorded'
  | 'debounced' | 'conflict_record' | 'unknown_card' | 'unassigned_card' | 'disabled_card' | 'malformed_uid'
  | 'device_disabled' | 'no_active_session' | 'not_enrolled' | 'enrolment_ambiguous' | 'error';

export interface ScanEvent {
  id: number;
  at: string;
  receivedAt: string;
  deviceTs: string | null;
  timeSource: 'received' | 'device';
  source: string;
  uid: string | null;
  uidRaw: string;
  cardId: number | null;
  cardLabel: string | null;
  cardStatus: CardStatus | null;
  outcome: ScanOutcome;
  message: string;
  detail: string | null;
  studentId: string | null;
  studentName: string | null;
  classId: string | null;
  className: string | null;
  occurrenceId: number | null;
  deviceName: string | null;
}

export interface RfidDevice {
  id: number; code: string; name: string | null; location: string | null; status: 'active' | 'disabled';
  lastSeenAt: string | null; clockSkewMs: number | null; scans24h: number; createdAt: string;
}

export interface FeedStatus {
  live: boolean;
  reason: string | null;
  secondsSinceCheck: number | null;
  lastScan: {
    uid: string | null; cardId: number | null; outcome: ScanOutcome;
    cardStatus: CardStatus | null; holderName: string | null; studentName: string | null; className: string | null;
    at: string; deviceName: string | null;
  } | null;
}

/** Live events pushed on /api/rfid/stream. */
export interface ScanStreamEvent {
  type: 'scan';
  scanId: number;
  outcome: ScanOutcome;
  at: string;
  studentId: string | null;
  studentName: string | null;
  classId: string | null;
  className: string | null;
  status: string | null;
  /** e.g. "Chemistry: late · Biology: present". */
  detail: string | null;
  sessionDate: string | null;
  period: string | null;
  uid: string | null;
  deviceName: string | null;
}
export interface RegisterStreamEvent {
  type: 'register'; sessionDate: string; period: string; classIds: string[];
}
export type RfidStreamEvent = ScanStreamEvent | RegisterStreamEvent;

/** How each outcome reads in the UI, and which tone it takes. */
export const OUTCOME_META: Record<ScanOutcome, { label: string; tone: 'present' | 'late' | 'absent' | 'excused' | 'neutral' }> = {
  pending: { label: 'Processing', tone: 'neutral' },
  recorded_present: { label: 'Present', tone: 'present' },
  recorded_late: { label: 'Late', tone: 'late' },
  already_recorded: { label: 'Already recorded', tone: 'neutral' },
  debounced: { label: 'Repeat tap', tone: 'neutral' },
  conflict_record: { label: 'Staff mark kept', tone: 'excused' },
  unknown_card: { label: 'Unregistered card', tone: 'absent' },
  unassigned_card: { label: 'Card not assigned', tone: 'absent' },
  disabled_card: { label: 'Disabled card', tone: 'absent' },
  malformed_uid: { label: 'Misread', tone: 'absent' },
  device_disabled: { label: 'Scanner disabled', tone: 'absent' },
  no_active_session: { label: 'No lesson now', tone: 'neutral' },
  not_enrolled: { label: 'Not in a class', tone: 'absent' },
  enrolment_ambiguous: { label: 'Class unclear', tone: 'absent' },
  error: { label: 'Error', tone: 'absent' },
};

