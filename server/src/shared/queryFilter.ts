/** Small incremental WHERE-clause builder — replaces the repeated
 *  `query += ' AND x = ?'; params.push(x)` pattern duplicated across
 *  attendance.ts, discipline.ts, staff.ts, reports.ts. Not a query DSL —
 *  just enough structure to stop re-deriving the same string-concat bugs. */
export class QueryFilter {
  private clauses: string[] = [];
  private params: any[] = [];

  /** Add `AND <clause>` with one bound param, only if `value` is present (not
   *  null/undefined/empty-string). Returns `this` for chaining. */
  eq(column: string, value: unknown): this {
    if (value === undefined || value === null || value === '') return this;
    this.clauses.push(`${column} = ?`);
    this.params.push(value);
    return this;
  }

  gte(column: string, value: unknown): this {
    if (value === undefined || value === null || value === '') return this;
    this.clauses.push(`${column} >= ?`);
    this.params.push(value);
    return this;
  }

  lte(column: string, value: unknown): this {
    if (value === undefined || value === null || value === '') return this;
    this.clauses.push(`${column} <= ?`);
    this.params.push(value);
    return this;
  }

  /** `AND (col1 LIKE ? OR col2 LIKE ? ...)` against a single search term. */
  like(columns: string[], value: unknown): this {
    if (value === undefined || value === null || value === '') return this;
    this.clauses.push(`(${columns.map((c) => `${c} LIKE ?`).join(' OR ')})`);
    for (const _ of columns) this.params.push(`%${value}%`);
    return this;
  }

  /** Academic-term scoping with the legacy-row escape hatch used throughout
   *  this codebase: pre-migration rows have a NULL term id and stay visible
   *  under any period filter. */
  academicTerm(column: string, academicTermId: number | undefined): this {
    if (academicTermId == null) return this;
    this.clauses.push(`(${column} = ? OR ${column} IS NULL)`);
    this.params.push(academicTermId);
    return this;
  }

  /** Raw escape hatch for anything not covered above. */
  raw(clause: string, ...values: any[]): this {
    this.clauses.push(clause);
    this.params.push(...values);
    return this;
  }

  /** Render as ` WHERE 1=1 AND ...` (always valid to append `ORDER BY`/`LIMIT` to). */
  toSql(): string {
    return this.clauses.length ? ` WHERE 1=1 AND ${this.clauses.join(' AND ')}` : ' WHERE 1=1';
  }

  toParams(): any[] {
    return this.params;
  }
}
