import { describe, it, expect } from 'vitest';
import { QueryFilter } from '../shared/queryFilter.js';

describe('shared/queryFilter.ts — QueryFilter', () => {
  it('builds an unconditional WHERE 1=1 with no filters applied', () => {
    const qf = new QueryFilter();
    expect(qf.toSql()).toBe(' WHERE 1=1');
    expect(qf.toParams()).toEqual([]);
  });

  it('skips null/undefined/empty-string values', () => {
    const qf = new QueryFilter().eq('status', undefined).eq('type', null).eq('category', '');
    expect(qf.toSql()).toBe(' WHERE 1=1');
    expect(qf.toParams()).toEqual([]);
  });

  it('chains eq/gte/lte/like into one AND-joined clause with matching params', () => {
    const qf = new QueryFilter()
      .eq('status', 'open')
      .gte('incident_date', '2026-01-01')
      .lte('incident_date', '2026-06-01')
      .like(['student_name', 'student_id'], 'jane');

    expect(qf.toSql()).toBe(
      ' WHERE 1=1 AND status = ? AND incident_date >= ? AND incident_date <= ? AND (student_name LIKE ? OR student_id LIKE ?)'
    );
    expect(qf.toParams()).toEqual(['open', '2026-01-01', '2026-06-01', '%jane%', '%jane%']);
  });

  it('applies the legacy-null escape hatch for academic term scoping', () => {
    const qf = new QueryFilter().academicTerm('academic_term_id', 5);
    expect(qf.toSql()).toBe(' WHERE 1=1 AND (academic_term_id = ? OR academic_term_id IS NULL)');
    expect(qf.toParams()).toEqual([5]);
  });

  it('skips academic term scoping entirely when no term is given', () => {
    const qf = new QueryFilter().academicTerm('academic_term_id', undefined);
    expect(qf.toSql()).toBe(' WHERE 1=1');
  });
});
