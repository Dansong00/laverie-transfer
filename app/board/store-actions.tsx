"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { StoreId } from "../../db/eligible-orders";
import type { PhaseCorrection, StoreAction } from "../../transfer/commands";
import { useBatchChange } from "../use-batch-change";

const Changes = createContext<ReturnType<typeof useBatchChange> | null>(null);

export function BoardChanges({
  staffId,
  store,
  children,
}: {
  staffId: string;
  store: StoreId;
  children: ReactNode;
}) {
  const changes = useBatchChange(staffId, store);
  return (
    <Changes.Provider value={changes}>
      {children}
      <p role="status">{changes.message}</p>
      {changes.uncertain && (
        <button disabled={changes.busy} onClick={() => void changes.submit()}>
          Check pending change
        </button>
      )}
      {changes.message && !changes.uncertain && (
        <button onClick={() => window.location.reload()}>Refresh batch</button>
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
        if (window.confirm(label + " for " + command.batchId + "?")) void changes.submit(command);
      }}
    >
      {label}
    </button>
  );
}

type CorrectionInput = Omit<PhaseCorrection, "kind" | "reason"> &
  (
    | { kind: "correctTravelPhase" }
    | Pick<Extract<PhaseCorrection, { kind: "stepBackOrder" }>, "kind" | "orderKey">
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
            Reason for correction <input name="reason" required pattern=".*\S.*" />
          </label>
          <button>Save correction</button>
        </fieldset>
      </form>
    </details>
  );
}
