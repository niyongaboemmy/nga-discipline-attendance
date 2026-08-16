import { describe, it, expect } from 'vitest';
import { clampPagination } from '../shared/pagination.js';

describe('shared/pagination.ts — clampPagination', () => {
  it('uses defaults when query params are absent', () => {
    expect(clampPagination({}, { defaultLimit: 25, maxLimit: 200 })).toEqual({ limit: 25, offset: 0 });
  });

  it('parses valid limit/offset from query strings', () => {
    expect(clampPagination({ limit: '10', offset: '20' })).toEqual({ limit: 10, offset: 20 });
  });

  it('clamps limit to maxLimit', () => {
    expect(clampPagination({ limit: '99999' }, { maxLimit: 200 }).limit).toBe(200);
  });

  it('clamps limit to a minimum of 1', () => {
    expect(clampPagination({ limit: '0' }).limit).toBe(1);
    expect(clampPagination({ limit: '-5' }).limit).toBe(1);
  });

  it('clamps offset to a minimum of 0', () => {
    expect(clampPagination({ offset: '-10' }).offset).toBe(0);
  });

  it('ignores garbage input and falls back to defaults', () => {
    expect(clampPagination({ limit: 'abc', offset: 'xyz' }, { defaultLimit: 25 })).toEqual({ limit: 25, offset: 0 });
  });
});
