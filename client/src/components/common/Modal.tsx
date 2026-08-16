import React from 'react';
import { Dialog } from './Dialog';

interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /** Rendered right-aligned below the body, e.g. Cancel/Save buttons. */
  footer?: React.ReactNode;
  maxWidth?: number;
  subtitle?: React.ReactNode;
}

/** Generic modal shell. A thin wrapper over the shared `Dialog` primitive,
 *  which owns the scrim, portal, focus trap, scroll lock and z-index —
 *  this keeps the existing call sites unchanged. */
export const Modal: React.FC<ModalProps> = ({
  open, title, onClose, children, footer, maxWidth, subtitle,
}) => (
  <Dialog
    open={open}
    onClose={onClose}
    title={title}
    subtitle={subtitle}
    footer={footer}
    maxWidth={maxWidth}
  >
    {children}
  </Dialog>
);
