/**
 * Location for the staff clock (plan §5.2). Read only while the page is open and
 * only to check the school zone: the first fix is often coarse, so we watch for a
 * few seconds and keep the most precise reading, plus a few samples for the
 * server's "does this look real" checks.
 */

export interface Fix {
  lat: number;
  lng: number;
  accuracy: number;
  ts: number;
}

export type GeoErrorKind = 'denied' | 'unavailable' | 'timeout' | 'unsupported';

export class GeoError extends Error {
  kind: GeoErrorKind;
  constructor(kind: GeoErrorKind) {
    super(kind);
    this.kind = kind;
  }
}

export async function permissionState(): Promise<'granted' | 'denied' | 'prompt' | 'unknown'> {
  try {
    const r = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
    return r.state as 'granted' | 'denied' | 'prompt';
  } catch {
    return 'unknown';
  }
}

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * Which Apple browser this is, if any. Safari (and every iPhone/iPad browser, all
 * WebKit) handles location differently from Chrome:
 *  - `navigator.permissions.query` is not reliable for location (it can say "prompt"
 *    after a refusal, "denied" for a site that is allowed, and never "granted" for a
 *    one-day grant: WebKit bugs 258726, 275479, 275950), so only a real attempt tells;
 *  - it asks again on most visits, and the question can stay open for a long time;
 *  - a refusal lasts for the life of the page: it asks again only after a reload;
 *  - a Mac can answer "position unavailable" (location unknown) before it finds itself.
 */
export type AppleBrowser = 'ios-safari' | 'ios-other' | 'ios-app' | 'mac-safari' | null;
export function appleBrowser(ua: string = navigator.userAgent, touchPoints: number = navigator.maxTouchPoints ?? 0, standalone: boolean = isStandalone()): AppleBrowser {
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
  if (ios) {
    if (standalone) return 'ios-app';
    return /CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(ua) ? 'ios-other' : 'ios-safari';
  }
  return /Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\/|OPR\/|Firefox\//.test(ua) ? 'mac-safari' : null;
}
function isStandalone(): boolean {
  try {
    return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

/** A refusal Safari will not reconsider on this page: reload so it can ask again. */
export function reloadToAskAgain(): boolean {
  if (!appleBrowser()) return false;
  window.location.reload();
  return true;
}

/** Extra time for the person to answer the browser's "allow location?" question. */
export const PROMPT_WAIT_MS = 25_000;

/**
 * Watch up to `maxMs` (default 8 s) or until a fix of `goodEnough` metres arrives.
 * Resolves with the best fix and up to 5 samples; rejects with a GeoError.
 *
 * The `maxMs` clock starts once the browser is actually looking (permission already
 * given, or the first reading or error arrives), not while its question is on screen:
 * Safari asks on most visits, and a person who took longer than `maxMs` to tap Allow
 * used to get "location not found" with the question still open.
 */
export function sampleLocation(opts: {
  maxMs?: number;
  goodEnough?: number;
  /** Keep waiting (up to maxMs) while the best reading is vaguer than this many metres:
   *  a phone on mobile data starts with a cell-tower guess and needs GPS to settle. */
  patientUntil?: number;
  onProgress?: (best: Fix) => void;
} = {}): Promise<{ best: Fix; samples: Fix[] }> {
  const maxMs = opts.maxMs ?? 8000;
  const goodEnough = opts.goodEnough ?? 20;
  if (!('geolocation' in navigator)) return Promise.reject(new GeoError('unsupported'));
  return new Promise((resolve, reject) => {
    const samples: Fix[] = [];
    let best: Fix | null = null;
    let done = false;
    let looking = false;
    let lastErr: GeoError | null = null;
    let coarse = false;
    const ids: number[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settle: ReturnType<typeof setTimeout> | undefined;
    // A reading that stops improving (a laptop's Wi-Fi estimate never does) ends the wait.
    let stall: ReturnType<typeof setTimeout> | undefined;
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const finish = (err?: GeoError) => {
      if (done) return;
      done = true;
      for (const id of ids) navigator.geolocation.clearWatch(id);
      clearTimeout(timer);
      clearTimeout(settle);
      clearTimeout(stall);
      clearTimeout(giveUp);
      if (best) resolve({ best, samples: samples.slice(-5) });
      else reject(err ?? lastErr ?? new GeoError('timeout'));
    };
    /** The browser is looking for the position now: the real wait starts here. */
    const startClock = () => {
      if (looking || done) return;
      looking = true;
      clearTimeout(timer);
      timer = setTimeout(() => finish(), maxMs);
    };
    const onFix = (p: GeolocationPosition) => {
      if (done) return;
      startClock();
      clearTimeout(giveUp);
      const fix: Fix = { lat: round(p.coords.latitude, 7), lng: round(p.coords.longitude, 7), accuracy: round(p.coords.accuracy, 1), ts: p.timestamp };
      samples.push(fix);
      if (!best || fix.accuracy < best.accuracy - 1) {
        best = !best || fix.accuracy < best.accuracy ? fix : best;
        clearTimeout(stall);
        // Usable already: stop once it no longer improves. Still too vague: give GPS the full time.
        if (opts.patientUntil == null || best.accuracy <= opts.patientUntil) stall = setTimeout(() => finish(), 3000);
        opts.onProgress?.(best);
      } else if (fix.accuracy < best.accuracy) best = fix;
      // A good reading: take one more if it comes quickly, else go with this one.
      if (fix.accuracy <= goodEnough) {
        if (samples.length >= 2) finish();
        else if (!settle) settle = setTimeout(() => finish(), 1500);
      }
    };
    const onError = (fromCoarse: boolean) => (e: GeolocationPositionError) => {
      if (done) return;
      // 1 = PERMISSION_DENIED (the numbers, not e.PERMISSION_DENIED: safe on every engine).
      if (e.code === 1) return finish(new GeoError('denied'));
      lastErr = new GeoError(e.code === 3 ? 'timeout' : 'unavailable');
      startClock();
      if (best) return; // a reading is in hand; the watch may still improve it
      if (fromCoarse) return finish(lastErr); // neither way can place this device
      // "Position unavailable" from the precise watch (a Mac that has not found itself yet,
      // GPS off): the watch keeps trying; meanwhile ask for any reading, and do not wait long.
      if (!coarse) {
        coarse = true;
        watch(false);
        giveUp = setTimeout(() => finish(), Math.min(maxMs, 6000));
      }
    };
    const watch = (precise: boolean) => {
      try {
        // No `timeout`: our own clock decides (WebKit's can run while its question is open).
        const id = navigator.geolocation.watchPosition(onFix, onError(!precise), precise ? { enableHighAccuracy: true, maximumAge: 0 } : { enableHighAccuracy: false, maximumAge: 10_000 });
        if (done) navigator.geolocation.clearWatch(id);
        else ids.push(id);
      } catch {
        finish(new GeoError('unavailable'));
      }
    };
    // Until we know the question is answered, allow time to answer it.
    timer = setTimeout(() => finish(), maxMs + PROMPT_WAIT_MS);
    watch(true);
    void permissionState().then((st) => {
      if (st === 'granted') startClock();
    });
  });
}

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface ZoneHint {
  inside: boolean;
  preciseEnough: boolean;
  distance: number;
  /** metres to walk before the zone */
  outsideBy: number;
  /** metres from the reading to the zone's edge before any tolerance (0 inside) */
  edge: number;
}

/** A reading too vague for the normal rule that the school still accepts (and reviews): same rule as the server. */
export function weakButPlausible(fix: Fix, hint: ZoneHint | null, rules: { maxAccuracy: number; weakMaxAccuracy?: number }): boolean {
  const cap = rules.weakMaxAccuracy ?? 0;
  return !!hint && cap > 0 && fix.accuracy > rules.maxAccuracy && fix.accuracy <= cap && hint.edge <= fix.accuracy;
}

/** A school area: a circle (centre + radius) or an outline of [lng, lat] corners. */
export interface ZoneShape {
  lat: number | null;
  lng: number | null;
  radius: number | null;
  kind?: string;
  polygon?: Array<[number, number]> | null;
}

/** Ray casting on [lng, lat] corners. */
export function insideOutline(p: { lat: number; lng: number }, ring: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p.lat !== yj > p.lat && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Metres from a point to the nearest wall of an outline (same maths as the server). */
export function outlineEdgeDistance(p: { lat: number; lng: number }, ring: Array<[number, number]>): number {
  const kx = (Math.PI / 180) * R * Math.cos(rad(p.lat));
  const ky = (Math.PI / 180) * R;
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const ax = (ring[i][0] - p.lng) * kx, ay = (ring[i][1] - p.lat) * ky;
    const b = ring[(i + 1) % ring.length];
    const bx = (b[0] - p.lng) * kx, by = (b[1] - p.lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

/**
 * How far a reading is from an area: `distance` from the centre (circle) or the
 * nearest wall (outline, 0 inside); `outsideBy` beyond the edge after the tolerance
 * (the phone's own error, capped by the school's edge tolerance). Null: no shape.
 */
export function zoneGap(fix: Fix, z: ZoneShape, allowance: number): { distance: number; outsideBy: number; edge: number } | null {
  const credit = Math.min(fix.accuracy, allowance);
  if (z.kind === 'polygon' && z.polygon && z.polygon.length >= 3) {
    const within = insideOutline(fix, z.polygon);
    const d = within ? 0 : outlineEdgeDistance(fix, z.polygon);
    return { distance: d, outsideBy: within ? 0 : Math.max(0, d - credit), edge: within ? 0 : d };
  }
  if (z.lat == null || z.lng == null || !z.radius) return null;
  const d = distanceM(fix, { lat: z.lat, lng: z.lng });
  return { distance: d, outsideBy: Math.max(0, d - (z.radius + credit)), edge: Math.max(0, d - z.radius) };
}

/** The same rule as the server (only for the hint chip; the server decides). */
export function zoneHint(fix: Fix, zones: ZoneShape[], rules: { maxAccuracy: number; allowance?: number }, allowance = rules.allowance ?? 50): ZoneHint | null {
  let best: ZoneHint | null = null;
  for (const z of zones) {
    const g = zoneGap(fix, z, allowance);
    if (!g) continue;
    if (!best || g.outsideBy < best.outsideBy || (g.outsideBy === best.outsideBy && g.distance < best.distance)) {
      best = { inside: g.outsideBy === 0 && fix.accuracy <= rules.maxAccuracy, preciseEnough: fix.accuracy <= rules.maxAccuracy, distance: g.distance, outsideBy: g.outsideBy, edge: g.edge };
    }
  }
  return best;
}

export function formatDistance(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(m >= 10_000 ? 0 : 1)} km`;
  return `${Math.max(1, Math.round(m / 5) * 5)} m`;
}
