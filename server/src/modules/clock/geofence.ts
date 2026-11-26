/**
 * The school zone test and the "does this location look real?" flags (plan §5.3-5.5).
 * Pure functions: the routes pass in zones, settings and the last fix.
 */

export interface Fix {
  lat: number;
  lng: number;
  /** metres, ~68% confidence, as the browser reports it */
  accuracy: number;
  /** ms epoch from the device's Position.timestamp (device clock: only compared loosely) */
  ts?: number;
}

export interface Zone {
  id: number;
  name: string;
  kind: 'circle' | 'polygon';
  center_lat: number | null;
  center_lng: number | null;
  radius_m: number | null;
  polygon_geojson: string | null;
  active: number;
}

const R = 6371008.8; // mean Earth radius, metres
const rad = (d: number) => (d * Math.PI) / 180;

export function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function validFix(raw: any): Fix | null {
  if (!raw || typeof raw !== 'object') return null;
  const lat = Number(raw.lat), lng = Number(raw.lng), accuracy = Number(raw.accuracy);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(accuracy)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180 || accuracy < 0 || accuracy > 100_000) return null;
  const ts = Number(raw.ts);
  return { lat, lng, accuracy, ts: Number.isFinite(ts) ? ts : undefined };
}

/** Ray casting on [lng, lat] rings (GeoJSON order). */
function insidePolygon(p: { lat: number; lng: number }, ring: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p.lat !== yj > p.lat && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polygonRing(z: Zone): Array<[number, number]> | null {
  try {
    const g = JSON.parse(z.polygon_geojson || 'null');
    const ring = g?.type === 'Polygon' ? g.coordinates?.[0] : Array.isArray(g) ? g : null;
    return Array.isArray(ring) && ring.length >= 3 ? ring : null;
  } catch {
    return null;
  }
}

/** Distance from a point to a polygon's nearest vertex/centroid -- only used for the "you are X m away" hint. */
function polygonDistance(p: { lat: number; lng: number }, ring: Array<[number, number]>): number {
  return Math.min(...ring.map(([lng, lat]) => haversine(p, { lat, lng })));
}

export interface ZoneVerdict {
  inside: boolean;
  /** precise enough to judge at all */
  preciseEnough: boolean;
  zoneId: number | null;
  zoneName: string | null;
  /** metres from the nearest zone's centre (circle) or edge vertex (polygon) */
  distance: number | null;
  /** metres outside the nearest zone's edge, 0 when inside */
  outsideBy: number;
}

export function judge(fix: Fix, zones: Zone[], opts: { maxAccuracy: number; allowance: number }): ZoneVerdict {
  const active = zones.filter((z) => z.active);
  const preciseEnough = fix.accuracy <= opts.maxAccuracy;
  const credit = Math.min(fix.accuracy, opts.allowance);
  let best: ZoneVerdict = { inside: false, preciseEnough, zoneId: null, zoneName: null, distance: null, outsideBy: Infinity };
  for (const z of active) {
    if (z.kind === 'polygon') {
      const ring = polygonRing(z);
      if (!ring) continue;
      const d = polygonDistance(fix, ring);
      const inside = insidePolygon(fix, ring);
      const outsideBy = inside ? 0 : Math.max(0, d - credit);
      if (outsideBy < best.outsideBy) best = { inside: inside && preciseEnough, preciseEnough, zoneId: z.id, zoneName: z.name, distance: Math.round(d), outsideBy };
      continue;
    }
    if (z.center_lat == null || z.center_lng == null || !z.radius_m) continue;
    const d = haversine(fix, { lat: z.center_lat, lng: z.center_lng });
    const outsideBy = Math.max(0, d - (z.radius_m + credit));
    if (outsideBy < best.outsideBy || (outsideBy === best.outsideBy && (best.distance ?? Infinity) > d)) {
      best = { inside: outsideBy === 0 && preciseEnough, preciseEnough, zoneId: z.id, zoneName: z.name, distance: Math.round(d), outsideBy };
    }
  }
  if (best.outsideBy === Infinity) best.outsideBy = 0;
  return best;
}

// ---------------------------------------------------------------------------
// Plausibility flags: saved with the record for admin review, never a refusal.
// ---------------------------------------------------------------------------

export type ClockFlag =
  | 'suspicious_accuracy'
  | 'no_jitter'
  | 'stale_fix'
  | 'impossible_travel'
  | 'twin_punch'
  | 'clock_skew'
  | 'non_school_day'
  | 'on_school_network'
  | 'phone_location';

export function plausibilityFlags(input: {
  fix: Fix;
  samples: Fix[];
  serverNow: number;
  clientSkewMs: number | null;
  last?: { lat: number; lng: number; at: number } | null;
}): ClockFlag[] {
  const flags: ClockFlag[] = [];
  const { fix, samples } = input;
  const all = [fix, ...samples];
  if (fix.accuracy === 0 || (all.length >= 3 && all.every((s) => s.accuracy === all[0].accuracy && Number.isInteger(s.accuracy)))) {
    flags.push('suspicious_accuracy');
  }
  if (samples.length >= 3 && samples.every((s) => s.lat === samples[0].lat && s.lng === samples[0].lng)) flags.push('no_jitter');
  // The fix time is the device's clock: compare it to the device's own reported time
  // when we know the skew, so a phone whose clock is wrong is not flagged for that.
  if (fix.ts !== undefined) {
    const corrected = input.clientSkewMs != null ? fix.ts - input.clientSkewMs : fix.ts;
    if (input.serverNow - corrected > 2 * 60_000 || corrected - input.serverNow > 60_000) flags.push('stale_fix');
  }
  if (input.last) {
    const km = haversine(fix, input.last) / 1000;
    const hours = Math.max((input.serverNow - input.last.at) / 3600_000, 1 / 60);
    if (km > 2 && km / hours > 150) flags.push('impossible_travel');
  }
  if (input.clientSkewMs != null && Math.abs(input.clientSkewMs) > 5 * 60_000) flags.push('clock_skew');
  return flags;
}

// ---------------------------------------------------------------------------
// School networks (STAFF_CLOCK_SCHOOL_NETWORKS, IPv4 CIDR list)
// ---------------------------------------------------------------------------

function ipv4ToInt(ip: string): number | null {
  const m = ip.replace(/^::ffff:/, '').match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

export function onSchoolNetwork(ip: string | null | undefined, cidrs: string): boolean {
  if (!ip) return false;
  const addr = ipv4ToInt(ip);
  if (addr === null) return false;
  for (const raw of cidrs.split(/[,\s]+/).map((c) => c.trim()).filter(Boolean)) {
    const [base, bitsRaw] = raw.split('/');
    const baseInt = ipv4ToInt(base);
    const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
    if (baseInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((addr & mask) >>> 0 === (baseInt & mask) >>> 0) return true;
  }
  return false;
}

export function validCidrList(value: string): boolean {
  return value
    .split(/[,\s]+/)
    .map((c) => c.trim())
    .filter(Boolean)
    .every((c) => {
      const [base, bits] = c.split('/');
      return ipv4ToInt(base) !== null && (bits === undefined || (/^\d+$/.test(bits) && Number(bits) <= 32));
    });
}
