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
 * Watch up to `maxMs` (default 8 s) or until a fix of `goodEnough` metres arrives.
 * Resolves with the best fix and up to 5 samples; rejects with a GeoError.
 */
export function sampleLocation(opts: { maxMs?: number; goodEnough?: number } = {}): Promise<{ best: Fix; samples: Fix[] }> {
  const maxMs = opts.maxMs ?? 8000;
  const goodEnough = opts.goodEnough ?? 20;
  if (!('geolocation' in navigator)) return Promise.reject(new GeoError('unsupported'));
  return new Promise((resolve, reject) => {
    const samples: Fix[] = [];
    let best: Fix | null = null;
    let done = false;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const finish = (err?: GeoError) => {
      if (done) return;
      done = true;
      navigator.geolocation.clearWatch(id);
      clearTimeout(timer);
      clearTimeout(settle);
      if (best) resolve({ best, samples: samples.slice(-5) });
      else reject(err ?? new GeoError('timeout'));
    };
    const id = navigator.geolocation.watchPosition(
      (p) => {
        const fix: Fix = { lat: round(p.coords.latitude, 7), lng: round(p.coords.longitude, 7), accuracy: round(p.coords.accuracy, 1), ts: p.timestamp };
        samples.push(fix);
        if (!best || fix.accuracy < best.accuracy) best = fix;
        // A good reading: take one more if it comes quickly, else go with this one.
        if (fix.accuracy <= goodEnough) {
          if (samples.length >= 2) finish();
          else if (!settle) settle = setTimeout(() => finish(), 1500);
        }
      },
      (e) => finish(new GeoError(e.code === e.PERMISSION_DENIED ? 'denied' : e.code === e.TIMEOUT ? 'timeout' : 'unavailable')),
      { enableHighAccuracy: true, maximumAge: 0, timeout: maxMs },
    );
    const timer = setTimeout(() => finish(), maxMs);
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
}

/** The same rule as the server (only for the hint chip; the server decides). */
export function zoneHint(fix: Fix, zones: Array<{ lat: number | null; lng: number | null; radius: number | null }>, rules: { maxAccuracy: number }, allowance = 50): ZoneHint | null {
  let best: ZoneHint | null = null;
  for (const z of zones) {
    if (z.lat == null || z.lng == null || !z.radius) continue;
    const d = distanceM(fix, { lat: z.lat, lng: z.lng });
    const outsideBy = Math.max(0, d - (z.radius + Math.min(fix.accuracy, allowance)));
    if (!best || outsideBy < best.outsideBy || (outsideBy === best.outsideBy && d < best.distance)) {
      best = { inside: outsideBy === 0 && fix.accuracy <= rules.maxAccuracy, preciseEnough: fix.accuracy <= rules.maxAccuracy, distance: d, outsideBy };
    }
  }
  return best;
}

export function formatDistance(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(m >= 10_000 ? 0 : 1)} km`;
  return `${Math.max(1, Math.round(m / 5) * 5)} m`;
}
