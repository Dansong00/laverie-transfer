"use client";

import { useState, type FormEvent } from "react";
import type { StoreId } from "../../db/eligible-orders";
import type { BatchChange } from "../../transfer/commands";
import type { contentsHistory } from "../../transfer/contents";

export type SentTrip = Awaited<ReturnType<typeof contentsHistory>> & {
  id: string;
  origin: StoreId;
  version: number;
  changed: boolean;
  received: boolean;
};

export function ContentsForm({
  trip,
  store,
  admin,
  disabled,
  submit,
}: {
  trip: SentTrip;
  store: StoreId;
  admin: boolean;
  disabled: boolean;
  submit: (change: BatchChange) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const remaining = trip.members.filter((m) => !m.removedAt);
  const canCorrect =
    remaining.length > 0 &&
    remaining.every(
      (m) => m.active && ["sent", "received", "processing", "ready_for_return"].includes(m.phase),
    );
  const command = { origin: trip.origin, batchId: trip.id, expectedVersion: trip.version };
  function correct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (!selected.length || !window.confirm("Record that the selected orders did not travel?")) return;
    submit({
      ...command,
      kind: "correctSentMembership",
      remove: selected.map((orderNumber) => ({
        orderKey: { storeId: trip.origin, orderNumber },
        reason: String(data.get("reason-" + orderNumber) ?? ""),
      })),
    });
  }
  return (
    <section>
      <h2>{trip.id}</h2>
      {trip.changed && <p role="status">Contents changed, confirm before return</p>}
      <h3>Remaining orders</h3>
      {!remaining.length && <p>No orders remain in this batch.</p>}
      <form onSubmit={correct}>
        <fieldset disabled={disabled}>
          <ul>
            {remaining.map((m) => (
              <li key={m.number}>
                <strong>#{m.number}</strong> {m.phase.replaceAll("_", " ")}
                {admin && canCorrect && (
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.includes(m.number)}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked ? [...selected, m.number] : selected.filter((n) => n !== m.number),
                        )
                      }
                    />{" "}
                    Did not travel
                  </label>
                )}
                {selected.includes(m.number) && (
                  <label>
                    Reason for #{m.number}
                    <input name={"reason-" + m.number} required />
                  </label>
                )}
              </li>
            ))}
          </ul>
          {admin && canCorrect && <button disabled={!selected.length}>Record correction</button>}
        </fieldset>
      </form>
      {trip.changed && !trip.received && (
        <p>Receive the batch on the transfer board before confirming contents.</p>
      )}
      {trip.changed && trip.received && !remaining.some((m) => m.phase === "sent") && (
        <button
          disabled={disabled || selected.length > 0}
          onClick={() => {
            if (
              window.confirm(
                "Have you checked the remaining contents of " +
                  trip.id +
                  " at " +
                  (store === "soho" ? "SoHo" : "East Village") +
                  "?",
              )
            )
              submit({ ...command, kind: "confirmContents", store });
          }}
        >
          Confirm contents
        </button>
      )}
      {trip.members.some((m) => m.removedAt) && (
        <>
          <h3>Removed orders</h3>
          <ul>
            {trip.members
              .filter((m) => m.removedAt)
              .map((m) => (
                <li key={m.number + String(m.removedAt)}>
                  #{m.number} ·{" "}
                  {m.removalKind === "correctSentMembership" ? "Did not travel" : "Removed before departure"}{" "}
                  · {m.reason} · {m.removedBy} · {new Date(m.removedAt!).toISOString()}
                </li>
              ))}
          </ul>
        </>
      )}
      <h3>Handoff history</h3>
      <ul>
        {trip.custody.map((h) => (
          <li key={h.id}>
            #{h.number} ·{" "}
            {h.action === "correctSentMembership"
              ? "Departure corrected"
              : h.action === "send"
                ? "Marked sent"
                : h.reason
                  ? `Moved back to ${h.toPhase.replaceAll("_", " ")} · ${h.reason}`
                  : h.action}{" "}
            · {h.name} · {h.at.toISOString()}
          </li>
        ))}
      </ul>
      {trip.confirmations.length > 0 && (
        <>
          <h3>Contents confirmations</h3>
          <ul>
            {trip.confirmations.map((c) => (
              <li key={c.at}>
                {c.name} confirmed{" "}
                {c.orderKeys.map((key) => "#" + key.orderNumber).join(", ") || "no remaining orders"} · {c.at}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
