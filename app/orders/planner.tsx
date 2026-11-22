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
    async (change?: BatchChange, checkOnly = false) => {
      if (pending.current) return;
      pending.current = true;
      let navigating = false;
      try {
        const outstanding = Object.keys(localStorage).find((item) => item.startsWith(prefix));
        if (change && outstanding) {
          setUncertain(true);
          setMessage("Check the pending change before starting another.");
          return;
        }
        const key = outstanding ?? prefix + crypto.randomUUID();
        const body = change
          ? JSON.stringify({ operationId: key.slice(prefix.length), ...change })
          : localStorage.getItem(key);
        if (!body) {
          setUncertain(false);
          setMessage("");
          return;
        }
        const isSend = JSON.parse(body).action === "send";
        if (change) localStorage.setItem(key, body);
        setBusy(true);
        async function request(statusOnly: boolean) {
          const response = await fetch(statusOnly ? "/api/batches?check=1" : "/api/batches", {
            method: "POST",
            signal: AbortSignal.timeout(15_000),
            headers: { "content-type": "application/json" },
            body,
          });
          if (response.status >= 500) throw new Error("Unconfirmed");
          return response;
        }
        let response: Response;
        try {
          response = await request(checkOnly);
        } catch (error) {
          if (!isSend || checkOnly) throw error;
          setUncertain(true);
          setMessage("Not confirmed yet, checking…");
          checkOnly = true;
          response = await request(true);
        }
        if (response.status === 202) {
          setUncertain(true);
          setMessage("Departure is still unconfirmed. Retry to check and finish marking this batch sent.");
          return;
        }
        if (response.status === 401) {
          // A status check can follow a committed write even when the initial response was lost.
          if (change && !checkOnly) localStorage.removeItem(key);
          navigating = true;
          window.location.replace("/");
          return;
        }
        const result = await response.json();
        localStorage.removeItem(key);
        setUncertain(false);
        if (!response.ok) {
          setMessage(result.error);
          return;
        }
        const params = new URLSearchParams({ store: origin });
        if (result.result.sent) params.set("sent", result.result.batchId);
        else if (!result.result.cancelled) params.set("batch", result.result.batchId);
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
    [origin, prefix],
  );

  useEffect(() => {
    const recovery = window.setTimeout(() => {
      const key = Object.keys(localStorage).find((item) => item.startsWith(prefix));
      if (!key) return;
      setUncertain(true);
      const body = localStorage.getItem(key);
      if (body && JSON.parse(body).action === "send") {
        setMessage("Not confirmed yet, checking…");
        void submit(undefined, true);
      } else {
        setMessage("A previous batch change is unconfirmed. Checking it can finish the save.");
      }
    }, 0);
    return () => window.clearTimeout(recovery);
  }, [prefix, submit]);

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
              disabled={!members.length}
              onClick={(event) => {
                if (removing.length || event.currentTarget.form?.querySelector("input[name=add]:checked")) {
                  setMessage("Save or discard your membership changes before marking this batch sent.");
                  return;
                }
                if (window.confirm("Mark " + plan.id + " and all " + members.length + " orders as sent?"))
                  void submit({
                    kind: "runAction",
                    action: "send",
                    origin,
                    batchId: plan.id,
                    expectedVersion: plan.version,
                  });
              }}
            >
              Mark sent
            </button>
          )}
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
