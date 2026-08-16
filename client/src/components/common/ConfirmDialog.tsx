import React from 'react';
import { Dialog } from './Dialog';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Use the danger style for destructive actions. */
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Fixed title/message/confirm-cancel shape used across the app, built on
 *  the shared `Dialog` primitive so its overlay behaviour can't drift from
 *  `Modal`'s. While an action is in flight the dialog stops being
 *  dismissible — Escape or a stray backdrop click shouldn't close a
 *  half-finished delete. */
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open, title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel',
  danger = false, loading = false, onConfirm, onCancel,
}) => (
  <Dialog
    open={open}
    onClose={onCancel}
    title={title}
    maxWidth={420}
    dismissible={!loading}
    hideClose
    footer={
      <>
        <button className="btn btn-outline" onClick={onCancel} disabled={loading}>
          {cancelLabel}
        </button>
        <button
          className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
          onClick={onConfirm}
          disabled={loading}
        >
          {loading ? 'Working…' : confirmLabel}
        </button>
      </>
    }
  >
    <p className="modal-message">{message}</p>
  </Dialog>
);
