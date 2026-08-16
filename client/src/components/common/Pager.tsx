import React from 'react';

interface PagerProps {
  page: number;
  pageCount: number;
  /** Total rows after filtering — drives the "Showing x–y of n" readout. */
  total: number;
  pageSize: number;
  onChange: (page: number) => void;
  /** Announced label, e.g. "Demerit rules pages". */
  label: string;
  /** Optional note shown when the list is filtered down from a larger set. */
  unfilteredTotal?: number;
}

/**
 * Shared list footer: a range readout plus prev/next. The controls only
 * render when there's more than one page, so a short list doesn't carry
 * dead chrome, but the count stays either way — it's useful on its own.
 */
export const Pager: React.FC<PagerProps> = ({
  page, pageCount, total, pageSize, onChange, label, unfilteredTotal,
}) => (
  <div className="card-footer pager">
    <span className="text-xs text-secondary">
      {total === 0
        ? 'Nothing to show'
        : `Showing ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}`}
      {unfilteredTotal !== undefined && unfilteredTotal !== total && ` (filtered from ${unfilteredTotal})`}
    </span>

    {pageCount > 1 && (
      <nav className="pager-nav" aria-label={label}>
        <button
          className="btn btn-outline btn-sm"
          onClick={() => onChange(Math.max(1, page - 1))}
          disabled={page === 1}
        >
          Previous
        </button>
        <span className="text-xs text-secondary" aria-live="polite">
          Page {page} of {pageCount}
        </span>
        <button
          className="btn btn-outline btn-sm"
          onClick={() => onChange(Math.min(pageCount, page + 1))}
          disabled={page === pageCount}
        >
          Next
        </button>
      </nav>
    )}
  </div>
);

/** Clamp helper so a page never points past the end after a list shrinks. */
export const clampPage = (page: number, pageCount: number) => Math.min(Math.max(1, page), Math.max(1, pageCount));
