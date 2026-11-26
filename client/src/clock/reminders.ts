/**
 * Check-in / check-out reminders on this phone (Web Push). The server decides when
 * (from the person's own hours); this file only asks the browser for a push
 * subscription and hands it over. iPhones give notifications to a web page only
 * once it is on the Home Screen.
 */

export type ReminderSupport = 'ok' | 'needs_install' | 'unsupported';

export function reminderSupport(): ReminderSupport {
  const hasPush = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (hasPush) return 'ok';
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return ios && !standalone ? 'needs_install' : 'unsupported';
}

export const notificationsBlocked = (): boolean => 'Notification' in window && Notification.permission === 'denied';

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/');
  const reg = existing ?? (await navigator.serviceWorker.register('/sw.js'));
  // A first visit: wait for the worker to be ready to receive pushes.
  await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(r, 8000))]);
  return reg;
}

export class ReminderError extends Error {
  kind: 'blocked' | 'failed';
  constructor(kind: 'blocked' | 'failed') {
    super(kind);
    this.kind = kind;
  }
}

/** Ask for permission (must run from a tap) and return this phone's subscription. */
export async function subscribeReminders(publicKey: string): Promise<PushSubscriptionJSON> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new ReminderError('blocked');
  try {
    const reg = await registration();
    let sub = await reg.pushManager.getSubscription();
    // A subscription made with another key (the server's keys changed) cannot be reused.
    if (sub) {
      const current = sub.options.applicationServerKey ? btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : '';
      if (current && current !== publicKey.replace(/=+$/, '')) {
        await sub.unsubscribe();
        sub = null;
      }
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
    return sub.toJSON();
  } catch {
    throw new ReminderError('failed');
  }
}

export async function unsubscribeReminders(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    await (await reg?.pushManager.getSubscription())?.unsubscribe();
  } catch {
    /* the server forgets it anyway */
  }
}
