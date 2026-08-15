import { Database } from 'sqlite';

/**
 * Notification dispatcher.
 *
 * In-app notifications are written directly to the `notifications` table by callers.
 * This module handles EXTERNAL channels (email / SMS). Real delivery requires
 * provider credentials (e.g. SENDGRID_API_KEY, TWILIO_*); when those are absent we
 * fall back to a console transport and record every message in `notification_outbox`
 * so the behaviour is fully testable without leaking anything to a third party.
 */

type Channel = 'email' | 'sms';

const emailEnabled = () => Boolean(process.env.SENDGRID_API_KEY || process.env.SMTP_URL);
const smsEnabled = () => Boolean(process.env.TWILIO_AUTH_TOKEN);

interface UserPrefs {
  emailNotifications?: boolean;
  absenceAlerts?: boolean;
  weeklySummary?: boolean;
}

function parsePrefs(raw: unknown): UserPrefs {
  if (!raw || typeof raw !== 'string') return {};
  try { return JSON.parse(raw) as UserPrefs; } catch { return {}; }
}

/**
 * Queue (and best-effort "send") an external message. Records it in the outbox.
 * Returns the outbox row id, or null on failure.
 */
async function enqueue(
  db: Database,
  channel: Channel,
  recipient: string | null,
  subject: string,
  body: string
): Promise<number | null> {
  try {
    const result = await db.run(
      `INSERT INTO notification_outbox (channel, recipient, subject, body, status) VALUES (?, ?, ?, ?, 'queued')`,
      channel, recipient, subject, body
    );
    const id = result.lastID!;

    const live = channel === 'email' ? emailEnabled() : smsEnabled();
    if (live) {
      // Integration point: call the real provider SDK here. Until then we leave the
      // row 'queued' so a future worker/transport can pick it up.
      console.log(`[notifier] ${channel} -> ${recipient} queued for live delivery (id ${id})`);
    } else {
      // No provider configured: console transport. Mark as sent so the outbox
      // reflects that the message was handled in this environment.
      console.log(`[notifier:console] ${channel} to ${recipient || 'n/a'} — ${subject}`);
      await db.run(`UPDATE notification_outbox SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?`, id);
    }
    return id;
  } catch (err) {
    console.error('Failed to enqueue outbox message:', err);
    return null;
  }
}

/**
 * Notify a user on their external channels, honouring their saved preferences.
 * Looks up the user's email; skips silently if they've opted out or have no address.
 */
export async function notifyUserExternal(
  db: Database,
  userId: string,
  subject: string,
  body: string,
  opts: { kind?: 'absence' | 'general' } = {}
): Promise<void> {
  try {
    const user = await db.get('SELECT email, preferences FROM users WHERE id = ?', userId);
    if (!user) return;
    const prefs = parsePrefs(user.preferences);

    // Email notifications default ON; absence-specific alerts respect their own toggle.
    const emailOptIn = prefs.emailNotifications !== false;
    const kindOptIn = opts.kind === 'absence' ? prefs.absenceAlerts !== false : true;

    if (user.email && emailOptIn && kindOptIn) {
      await enqueue(db, 'email', user.email, subject, body);
    }
  } catch (err) {
    console.error('notifyUserExternal failed:', err);
  }
}
