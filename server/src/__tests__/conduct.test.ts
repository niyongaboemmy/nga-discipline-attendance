import { describe, it, expect } from 'vitest';
import { derivePoints, isValidCategory, computeConductScore } from '../utils/conduct.js';

describe('conduct.ts — legacy point/category rules', () => {
  it('derives the correct point magnitude per severity tier', () => {
    expect(derivePoints('demerit', 'minor')).toBe(2);
    expect(derivePoints('demerit', 'major')).toBe(10);
    expect(derivePoints('merit', 'outstanding')).toBe(10);
  });

  it('throws on an unrecognized severity tier', () => {
    expect(() => derivePoints('demerit', 'catastrophic')).toThrow(/Invalid severity/);
  });

  it('validates category against the type-specific vocabulary', () => {
    expect(isValidCategory('demerit', 'Tardiness')).toBe(true);
    expect(isValidCategory('demerit', 'Leadership')).toBe(false); // merit-only category
    expect(isValidCategory('merit', 'Leadership')).toBe(true);
  });

  it('computes a conduct score starting at 100, net of merits/demerits, clamped [0,100]', () => {
    expect(computeConductScore([])).toBe(100);
    expect(computeConductScore([{ type: 'demerit', points: 10 }])).toBe(90);
    expect(computeConductScore([{ type: 'merit', points: 10 }])).toBe(100); // clamped, can't exceed 100
    expect(computeConductScore([{ type: 'demerit', points: 200 }])).toBe(0); // clamped at 0
  });
});
