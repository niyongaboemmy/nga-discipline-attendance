import React, { useCallback, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name. Rendered as the heading unless `header` is supplied. */
  title: string;
  /** Optional supporting line under the title. */
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  /** Right-aligned action row pinned below the body. */
  footer?: React.ReactNode;
  maxWidth?: number;
  /** Set false for flows that must not be dismissed by scrim/Escape (e.g.
   *  something is mid-flight and cancelling would leave it inconsistent). */
  dismissible?: boolean;
  /** Hides the corner close button without disabling Escape/scrim. */
  hideClose?: boolean;
}

/** Focusable descendants, in DOM order, for the focus trap. */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The single dialog primitive for the app. `Modal` and `ConfirmDialog` are
 * thin wrappers over this, so behaviour can't drift between them.
 *
 * Rendered through a portal onto document.body. That matters for more than
 * tidiness: a dialog rendered inline sits inside whatever stacking context
 * its ancestors create — a sticky toolbar, a transformed card — and no
 * z-index can lift it out of one. Portalling plus the top of the shared
 * z-index scale (--z-modal) is what actually guarantees it renders above
 * everything else.
 *
 * Adds what the two previous hand-rolled copies both lacked: a focus trap,
 * focus restoration on close, background scroll lock, and title/description
 * wiring for screen readers.
 */
export const Dialog: React.FC<DialogProps> = ({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  maxWidth,
  dismissible = true,
  hideClose = false,
}) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const subtitleId = useId();

  const requestClose = useCallback(() => {
    if (dismissible) onClose();
  }, [dismissible, onClose]);

  // Escape to close + Tab cycling kept inside the dialog.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        requestClose();
        return;
      }
      if (e.key !== 'Tab' || !cardRef.current) return;

      const items = Array.from(
        cardRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, requestClose]);

  // Move focus in on open, and hand it back to the trigger on close so
  // keyboard users don't get dumped at the top of the document.
  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    const id = window.setTimeout(() => {
      const target =
        cardRef.current?.querySelector<HTMLElement>(FOCUSABLE) ?? cardRef.current;
      target?.focus();
    }, 0);
    return () => {
      window.clearTimeout(id);
      restoreFocusRef.current?.focus?.();
    };
  }, [open]);

  // Lock background scroll, compensating for the scrollbar so the page
  // behind doesn't shift sideways as it disappears.
  useEffect(() => {
    if (!open) return;
    const { body, documentElement } = document;
    const prevOverflow = body.style.overflow;
    const prevPadding = body.style.paddingRight;
    const gap = window.innerWidth - documentElement.clientWidth;
    body.style.overflow = 'hidden';
    if (gap > 0) body.style.paddingRight = `${gap}px`;
    return () => {
      body.style.overflow = prevOverflow;
      body.style.paddingRight = prevPadding;
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="modal-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div
        ref={cardRef}
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle ? subtitleId : undefined}
        tabIndex={-1}
        style={maxWidth ? { maxWidth } : undefined}
      >
        <div className="modal-head">
          <div style={{ minWidth: 0 }}>
            <h2 className="modal-title" id={titleId}>{title}</h2>
            {subtitle && (
              <p className="modal-subtitle" id={subtitleId}>{subtitle}</p>
            )}
          </div>
          {dismissible && !hideClose && (
            <button
              type="button"
              className="modal-close"
              onClick={onClose}
              aria-label="Close dialog"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        <div className="modal-body">{children}</div>

        {footer && <div className="modal-actions">{footer}</div>}
      </div>
    </div>,
    document.body
  );
};
