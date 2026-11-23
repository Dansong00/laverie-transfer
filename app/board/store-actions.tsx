"use client";

import { createContext, useContext, type ReactNode } from "react";
import { t, type Locale } from "../../i18n";
import type { StoreId } from "../../db/eligible-orders";
import { correctionReasonLimit, type PhaseCorrection, type StoreAction } from "../../transfer/commands";
import { useBatchChange } from "../use-batch-change";

const Changes = createContext<(ReturnType<typeof useBatchChange> & { locale: Locale }) | null>(null);

export function BoardChanges({
  staffId,
  store,
  children,
  locale,
}: {
  locale: Locale;
  staffId: string;
  store: StoreId;
  children: ReactNode;
}) {
  const changes = useBatchChange(staffId, store, locale);
  return (
    <Changes.Provider value={{ ...changes, locale }}>
      {children}
      <p role="status">{changes.message}</p>
      {changes.uncertain && (
        <button disabled={changes.busy} onClick={() => void changes.submit()}>
          {t(locale, "checkPending")}
        </button>
      )}
      {changes.message && !changes.uncertain && (
        <button onClick={() => window.location.reload()}>{t(locale, "refreshBatch")}</button>
      )}
    </Changes.Provider>
  );
}

export function StoreButton({ command, label }: { command: StoreAction; label: string }) {
  const changes = useContext(Changes);
  if (!changes) throw new Error("Board change controls require BoardChanges");
  return (
    <button
      type="button"
      disabled={changes.uncertain || changes.busy}
      onClick={() => {
        const prompt = t(changes.locale, "boardConfirmAction", { action: label, id: command.batchId });
        if (window.confirm(prompt)) void changes.submit(command);
      }}
    >
      {label}
    </button>
  );
}

type CorrectionInput = Omit<PhaseCorrection, "kind" | "reason"> &
  (
    | { kind: "correctTravelPhase" }
    | Pick<Extract<PhaseCorrection, { kind: "stepBackOrder" }>, "kind" | "store" | "orderKey">
  );

export function CorrectionForm({ command, label }: { command: CorrectionInput; label: string }) {
  const changes = useContext(Changes);
  if (!changes) throw new Error("Correction controls require BoardChanges");
  return (
    <details>
      <summary>{label}</summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const reason = String(new FormData(event.currentTarget).get("reason") ?? "").trim();
          if (reason) void changes.submit({ ...command, reason });
        }}
      >
        <fieldset disabled={changes.busy || changes.uncertain}>
          <label>
            {t(changes.locale, "boardCorrectionReason")}{" "}
            <input name="reason" required maxLength={correctionReasonLimit} pattern=".*\S.*" />
          </label>
          <button>{t(changes.locale, "boardSaveCorrection")}</button>
        </fieldset>
      </form>
    </details>
  );
}
