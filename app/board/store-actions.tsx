"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { StoreId } from "../../db/eligible-orders";
import type { StoreAction } from "../../transfer/commands";
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
