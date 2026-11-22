"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { StoreId } from "../../db/eligible-orders";
import type { BatchChange } from "../../transfer/commands";

type Plan = { id: string; version: number };
type Props = {
  staffId: string;
  origin: StoreId;
  plan?: Plan;
  members: string[];
  children: ReactNode;
};

export function Planner({ staffId, origin, plan, members, children }: Props) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [removing, setRemoving] = useState<string[]>([]);
  const pending = useRef(false);
  const prefix = `planned-batch:${staffId}:${origin}:`;

  const submit = useCallback(
    async (change?: BatchChange) => {
      if (pending.current) return;
      pending.current = true;
      let navigating = false;
      try {
        // Each operation owns its storage entry, including when two tabs submit together.
        const outstanding = Object.keys(localStorage).find((item) => item.startsWith(prefix));
        if (change && outstanding) {
          setUncertain(true);
          setMessage("Check the pending change before starting another.");
          return;
        }
        const operationId = crypto.randomUUID();
        const key = outstanding ?? prefix + operationId;
        const body = change ? JSON.stringify({ operationId, ...change }) : localStorage.getItem(key);
        if (!body) return;
        if (change) localStorage.setItem(key, body);
        setBusy(true);
        const response = await fetch("/api/batches", {
          method: "POST",
          signal: AbortSignal.timeout(15_000),
          headers: { "content-type": "application/json" },
          body,
        });
        if (response.status >= 500) throw new Error("Unconfirmed");
        const result = await response.json();
        if (response.status === 401) {
          navigating = true;
          window.location.replace("/");
          return;
        }
        localStorage.removeItem(key);
        setUncertain(false);
        if (!response.ok) {
          setMessage(result.error);
          return;
        }
        const params = new URLSearchParams({ store: origin });
        if (!result.result.cancelled) params.set("batch", result.result.batchId);
        if (result.replayed) params.set("saved", "again");
        navigating = true;
        window.location.replace("/orders?" + params);
      } catch {
        setUncertain(true);
        setMessage("Not confirmed yet. Retry to check this change.");
      } finally {
        if (!navigating) {
          pending.current = false;
          setBusy(false);
        }
      }
    },
    [prefix, origin],
  );

  useEffect(() => {
    const recovery = window.setTimeout(() => void submit(), 0);
    return () => window.clearTimeout(recovery);
  }, [submit]);

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const add = data.getAll("add").map(String);
    if (!plan) {
      if (!add.length && !window.confirm("Create an empty planned batch?")) return;
      void submit({ kind: "createBatch", origin, add });
    } else {
      const remove = removing.map((orderNumber) => ({
        orderNumber,
        note: String(data.get("note-" + orderNumber) ?? ""),
      }));
      if (!add.length && !remove.length) {
        setMessage("Choose orders to add or remove.");
        return;
      }
      void submit({
        kind: "updateBatch",
        origin,
        batchId: plan.id,
        expectedVersion: plan.version,
        add,
        remove,
      });
    }
  }

  return (
    <>
      <form onSubmit={save}>
        <fieldset disabled={busy || uncertain}>
          {plan && (
            <section>
              <h2>{plan.id}</h2>
              {members.length ? (
                <ul>
                  {members.map((number) => (
                    <li key={number}>
                      <strong>#{number}</strong>
                      <label>
                        <input
                          type="checkbox"
                          checked={removing.includes(number)}
                          onChange={(e) =>
                            setRemoving(
                              e.target.checked ? [...removing, number] : removing.filter((n) => n !== number),
                            )
                          }
                        />{" "}
                        Remove
                      </label>
                      {removing.includes(number) && (
                        <label className="removal-note">
                          Reason for removing #{number}
                          <input required name={"note-" + number} />
                        </label>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>Planned (empty)</p>
              )}
            </section>
          )}
          {children}
          <button className="save-plan" type="submit">
            {plan ? "Save changes" : "Create planned batch"}
          </button>
          {plan && (
            <button
              type="button"
              className="cancel-plan"
              onClick={() => {
                if (window.confirm("Cancel " + plan.id + " and release its orders?"))
                  void submit({
                    kind: "deleteBatch",
                    origin,
                    batchId: plan.id,
                    expectedVersion: plan.version,
                  });
              }}
            >
              Cancel batch
            </button>
          )}
        </fieldset>
      </form>
      <p role="status">{message}</p>
      {uncertain && (
        <button disabled={busy} onClick={() => void submit()}>
          Check pending change
        </button>
      )}
      {message && !uncertain && <button onClick={() => window.location.reload()}>Refresh orders</button>}
    </>
  );
}
