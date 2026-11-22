"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import type { StoreId } from "../../db/eligible-orders";
import { useBatchChange } from "../use-batch-change";

import { ContentsForm, type SentTrip } from "./contents-form";

type Plan = { id: string; version: number };
type Props = {
  staffId: string;
  origin: StoreId;
  plan?: Plan;
  members: string[];
  children: ReactNode;
  trip?: SentTrip;
  admin: boolean;
};

export function Planner({ staffId, origin, plan, members, children, trip, admin }: Props) {
  const { busy, message, setMessage, uncertain, submit } = useBatchChange(staffId, origin);
  const [removing, setRemoving] = useState<string[]>([]);

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
      {trip ? (
        <ContentsForm trip={trip} store={origin} admin={admin} disabled={busy || uncertain} submit={submit} />
      ) : (
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
                                e.target.checked
                                  ? [...removing, number]
                                  : removing.filter((n) => n !== number),
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
      )}
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
