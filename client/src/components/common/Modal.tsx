import React, { useEffect } from 'react';

interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /** Rendered right-aligned below the body, e.g. Cancel/Save buttons. */
  footer?: React.ReactNode;
  maxWidth?: number;
}

/** Generic modal shell — the scrim/card/escape-to-close/backdrop-click-to-close
 *  behavior that ConfirmDialog already implements, extracted so other pages
 *  (e.g. RolesPermissions' "New role" form) don't hand-roll their own copy
 *  of the same markup. ConfirmDialog keeps its own specialized layout since
 *  it's a fixed title/message/confirm-cancel shape used everywhere as-is. */
export const Modal: React.FC<ModalProps> = ({ open, title, onClose, children, footer, maxWidth }) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={maxWidth ? { maxWidth } : undefined}
      >
        <div className="modal-title">{title}</div>
        <div style={{ marginTop: '12px' }}>{children}</div>
        {footer && <div className="modal-actions">{footer}</div>}
      </div>
    </div>
  );
};
