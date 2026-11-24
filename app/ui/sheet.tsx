"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

type Props = { open: boolean; onClose: () => void; title: string; closeLabel: string; children: ReactNode };

export function Sheet({ open, onClose, title, closeLabel, children }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => {
    const element = dialog.current;
    if (open && !element?.open) element?.showModal();
    if (!open && element?.open) element.close();
  }, [open]);

  return <dialog ref={dialog} className="sheet" aria-labelledby={heading}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    }}>
    <h2 id={heading}>{title}</h2>
    {children}
    <button type="button" className="sheet-cancel" onClick={onClose}>{closeLabel}</button>
  </dialog>;
}
