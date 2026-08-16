/** Shared list-endpoint pagination — one clamp implementation instead of the
 *  five ad hoc copies previously scattered across routes/*.ts. */
export interface PaginationOptions {
  defaultLimit?: number;
  maxLimit?: number;
}

export interface Pagination {
  limit: number;
  offset: number;
}

export function clampPagination(
  query: Record<string, any>,
  { defaultLimit = 25, maxLimit = 200 }: PaginationOptions = {}
): Pagination {
  const rawLimit = parseInt(query.limit, 10);
  const rawOffset = parseInt(query.offset, 10);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : defaultLimit, 1), maxLimit);
  const offset = Math.max(Number.isFinite(rawOffset) ? rawOffset : 0, 0);
  return { limit, offset };
}
