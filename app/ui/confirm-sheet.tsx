"use client";

import type { ReactNode } from "react";
import { Sheet } from "./sheet";

type Props = { children?: ReactNode; disabled?: boolean; destructive?: boolean; open: boolean; title: string; prompt: string; cancelLabel: string; onClose: () => void; onConfirm: () => void };

export function ConfirmSheet({ open, title, prompt, cancelLabel, onClose, onConfirm, children, disabled, destructive }: Props) {
  return <Sheet open={open} title={title} closeLabel={cancelLabel} onClose={onClose}>
    <p>{prompt}</p>
    {children}
    <button disabled={disabled} type="button" className={destructive ? "btn btn-destructive" : "btn"} onClick={() => { onClose(); onConfirm(); }}>{title}</button>
  </Sheet>;
}
