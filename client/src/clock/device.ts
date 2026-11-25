/**
 * This device's identity for the staff clock (STAFF_ATTENDANCE_CLOCK_PLAN.md §4).
 *
 * A non-extractable ECDSA P-256 key is made once and kept in IndexedDB: the browser
 * can sign with it but nobody (not even this page) can read the private half, so it
 * cannot be copied to another phone. The server keeps the public key; every tap
 * signs a one-time server nonce. The device token (also here) is useless without it.
 */

const DB_NAME = 'tendo-clock';
const STORE = 'kv';

export interface StoredDevice {
  slug: string;
  keys: CryptoKeyPair;
  publicJwk: JsonWebKey;
  token: string | null;
  registeredAt: string | null;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

const get = <T>(key: string) => idb<T | undefined>('readonly', (s) => s.get(key));
const put = (key: string, value: unknown) => idb<IDBValidKey>('readwrite', (s) => s.put(value, key));
const del = (key: string) => idb<undefined>('readwrite', (s) => s.delete(key));

/** One install id per browser profile (all schools): lets the server recognise "the same phone, re-keyed". */
export async function installUuid(): Promise<string> {
  const existing = await get<string>('install');
  if (existing) return existing;
  const id = crypto.randomUUID();
  await put('install', id);
  return id;
}

export async function loadDevice(slug: string): Promise<StoredDevice | null> {
  return (await get<StoredDevice>(`device:${slug}`)) ?? null;
}

/** The key for this school, made on first use. */
export async function ensureKeys(slug: string): Promise<StoredDevice> {
  const existing = await loadDevice(slug);
  if (existing?.keys) return existing;
  const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair;
  const full = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const device: StoredDevice = { slug, keys, publicJwk: { kty: full.kty, crv: full.crv, x: full.x, y: full.y }, token: null, registeredAt: null };
  await put(`device:${slug}`, device);
  return device;
}

export async function saveToken(slug: string, token: string): Promise<void> {
  const d = await ensureKeys(slug);
  await put(`device:${slug}`, { ...d, token, registeredAt: new Date().toISOString() });
}

/** The school removed this device: forget the token and key, the next registration starts clean. */
export async function forgetDevice(slug: string): Promise<void> {
  await del(`device:${slug}`);
}

export async function signMessage(device: StoredDevice, message: string): Promise<string> {
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, device.keys.privateKey, new TextEncoder().encode(message));
  const bytes = new Uint8Array(sig);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Ask the browser to keep this site's storage (fewer "register again" moments). */
export async function askPersistentStorage(): Promise<void> {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    /* not supported */
  }
}

export function supportsDeviceKeys(): boolean {
  return typeof indexedDB !== 'undefined' && !!window.crypto?.subtle && typeof crypto.randomUUID === 'function';
}

// ---------------------------------------------------------------------------
// What this device is (labels for the school; never used as identity)
// ---------------------------------------------------------------------------

export interface DeviceInfo {
  browser: string;
  os: string;
  model: string;
  formFactor: 'phone' | 'tablet';
}

export function isTabletDevice(): boolean {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return true;
  if (/Android/.test(ua) && !/Mobile/.test(ua)) return true;
  const short = Math.min(window.screen.width, window.screen.height);
  return navigator.maxTouchPoints > 0 && short >= 600;
}

export async function deviceInfo(): Promise<DeviceInfo> {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iOS'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown';
  let model = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : '';
  const uad = (navigator as any).userAgentData;
  if (!model && uad?.getHighEntropyValues) {
    try {
      const v = await uad.getHighEntropyValues(['model']);
      if (v?.model) model = String(v.model);
    } catch {
      /* ignore */
    }
  }
  if (!model) {
    const m = ua.match(/Android [\d.]+; ([^;)]+?)(?: Build|\))/);
    if (m && m[1] !== 'K') model = m[1].trim();
  }
  return { browser, os, model: model || os, formFactor: isTabletDevice() ? 'tablet' : 'phone' };
}

/** The shared Amashuri device id cookie (analytics + device blocks), when present. */
export function ngaDeviceId(): string | null {
  const m = document.cookie.match(/(?:^|;\s*)nga_did=([^;]+)/);
  return m ? decodeURIComponent(m[1]).slice(0, 64) : null;
}
