"use client";

import { useId, useState } from "react";
import { correctionReasonLimit } from "../../transfer/commands";
import { t, type Locale } from "../../i18n";
import { Sheet } from "./sheet";

type Props = {
  locale: Locale; title: string; description: string; disabled: boolean;
  onClose: () => void; onSave: (reason: string) => void;
};

export function StepBackSheet({ locale, title, description, disabled, onClose, onSave }: Props) {
  const [reason, setReason] = useState("");
  const field = useId();
  return <Sheet open title={title} closeLabel={t(locale, "cancel")} onClose={onClose}>
    <p>{description}</p>
    <form onSubmit={event => {
      event.preventDefault();
      if (reason.trim() && !disabled) onSave(reason.trim());
    }}>
      <label className="field-label" htmlFor={field}>{t(locale, "boardCorrectionReason")}</label>
      <textarea id={field} required maxLength={correctionReasonLimit} value={reason}
        onChange={event => setReason(event.target.value)} />
      <button className="btn" disabled={disabled || !reason.trim()}>{t(locale, "boardSaveCorrection")}</button>
    </form>
  </Sheet>;
}
