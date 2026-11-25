import { distanceM, type Fix } from '../../clock/geo';

/**
 * "Test from where I stand", shared by the setup guide and the zone page.
 *
 * A phone has GPS (a few metres). A laptop or desktop -- every Mac, most PCs -- has
 * none: the browser estimates its position from nearby Wi-Fi, often only to within
 * 100-300 m. Staff check-ins keep the strict precision rule; the admin's setup test
 * on a computer instead explains what the computer can and cannot tell, gives its
 * best guess against the zone, and lets the admin confirm or test on a phone.
 */

export type TestKind = 'inside' | 'outside' | 'vague-inside' | 'vague-outside' | 'no-zone';

export interface TestOutcome {
  kind: TestKind;
  ok: boolean;
  /** precise result, or a vague one the admin may confirm */
  vague: boolean;
  title: string;
  text: string;
  accuracy: number;
}

export interface TestZone {
  name: string;
  lat: number;
  lng: number;
  radius: number;
}

/** No touch-first mobile browser: a laptop or desktop (no GPS to rely on). */
export function isComputer(): boolean {
  const ua = navigator.userAgent;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  return !mobile;
}

export function evaluateTest(fix: Fix, zones: TestZone[], opts: { maxAccuracy: number; allowance: number; computer: boolean }): TestOutcome {
  const acc = Math.round(fix.accuracy);
  if (!zones.length) return { kind: 'no-zone', ok: false, vague: false, title: 'No zone yet', text: 'Draw the school zone first.', accuracy: acc };

  let best: { z: TestZone; d: number; gap: number } | null = null;
  for (const z of zones) {
    const d = distanceM(fix, z);
    const gap = d - (z.radius + Math.min(fix.accuracy, opts.allowance));
    if (!best || gap < best.gap) best = { z, d, gap };
  }
  const b = best!;

  if (fix.accuracy <= opts.maxAccuracy) {
    return b.gap <= 0
      ? { kind: 'inside', ok: true, vague: false, title: `Inside ${b.z.name}`, text: `You are inside ${b.z.name} (precision ± ${acc} m). Staff standing here can check in.`, accuracy: acc }
      : { kind: 'outside', ok: false, vague: false, title: `${Math.round(b.gap)} m outside`, text: `You are ${Math.round(b.gap)} m outside ${b.z.name}. Make the circle bigger or move it, then test again.`, accuracy: acc };
  }

  // Too vague to judge like a check-in: say why, and give the best guess.
  const why = opts.computer
    ? `This computer has no GPS, so it only knows where it is to within ± ${acc} m (from nearby Wi-Fi).`
    : `This phone’s location is only precise to ± ${acc} m. Step outside or turn on GPS for a real test.`;
  const centreInside = b.d <= b.z.radius;
  return centreInside
    ? { kind: 'vague-inside', ok: false, vague: true, title: 'Probably inside', text: `${why} Its best guess is inside ${b.z.name}. If the circle covers the school on the map, the zone is right; a phone gives a precise test.`, accuracy: acc }
    : { kind: 'vague-outside', ok: false, vague: true, title: 'Not sure', text: `${why} Its best guess is ${Math.round(b.d - b.z.radius)} m outside ${b.z.name}, which is within that uncertainty. Check the circle covers the school on the map, or test on a phone.`, accuracy: acc };
}
