"use client";

import { Sheet } from "./sheet";

type Props = { open: boolean; title: string; prompt: string; cancelLabel: string; onClose: () => void; onConfirm: () => void };

export function ConfirmSheet({ open, title, prompt, cancelLabel, onClose, onConfirm }: Props) {
  return <Sheet open={open} title={title} closeLabel={cancelLabel} onClose={onClose}>
    <p>{prompt}</p>
    <button type="button" className="btn" onClick={() => { onClose(); onConfirm(); }}>{title}</button>
  </Sheet>;
}
