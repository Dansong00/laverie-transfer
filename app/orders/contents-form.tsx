"use client";

import { useState, type FormEvent } from "react";
import type { StoreId } from "../../db/eligible-orders";
import { formatLocalDate } from "../../i18n/dates";
import { t, type Locale } from "../../i18n";
import { phaseLabel } from "../../i18n/transfer";
import type { BatchChange } from "../../transfer/commands";
import type { contentsHistory } from "../../transfer/contents";

export type SentTrip = Awaited<ReturnType<typeof contentsHistory>> & {
  id: string;
  origin: StoreId;
  version: number;
  changed: boolean;
  received: boolean;
};

function HistoryTime({ locale, at }: { locale: Locale; at: Date | string }) {
  const date = new Date(at);
  return (
    <time dateTime={date.toISOString()} suppressHydrationWarning>
      {formatLocalDate(locale, date, "medium")}
    </time>
  );
}

export function ContentsForm({
  locale,
  trip,
  store,
  admin,
  disabled,
  submit,
}: {
  locale: Locale;
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
    if (!selected.length || !window.confirm(t(locale, "ordersConfirmMissing"))) return;
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
      {trip.changed && <p role="status">{t(locale, "contentsChanged")}</p>}
      <h3>{t(locale, "ordersRemaining")}</h3>
      {!remaining.length && <p>{t(locale, "ordersNoneRemaining")}</p>}
      <form onSubmit={correct}>
        <fieldset disabled={disabled}>
          <ul>
            {remaining.map((m) => (
              <li key={m.number}>
                <strong>#{m.number}</strong> {phaseLabel(locale, m.phase)}
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
                    {t(locale, "didNotTravel")}
                  </label>
                )}
                {selected.includes(m.number) && (
                  <label>
                    {t(locale, "ordersReasonFor", { number: m.number })}
                    <input name={"reason-" + m.number} required />
                  </label>
                )}
              </li>
            ))}
          </ul>
          {admin && canCorrect && (
            <button disabled={!selected.length}>{t(locale, "ordersRecordCorrection")}</button>
          )}
        </fieldset>
      </form>
      {trip.changed && !trip.received && (
        <p>{t(locale, "ordersReceiveBeforeConfirm")}</p>
      )}
      {trip.changed && trip.received && !remaining.some((m) => m.phase === "sent") && (
        <button
          disabled={disabled || selected.length > 0}
          onClick={() => {
            const prompt = t(locale, "ordersConfirmRemaining", {
              batch: trip.id,
              store: store === "soho" ? "SoHo" : "East Village",
            });
            if (window.confirm(prompt)) submit({ ...command, kind: "confirmContents", store });
          }}
        >
          {t(locale, "ordersConfirmContents")}
        </button>
      )}
      {trip.members.some((m) => m.removedAt) && (
        <>
          <h3>{t(locale, "ordersRemoved")}</h3>
          <ul>
            {trip.members
              .filter((m) => m.removedAt)
              .map((m) => (
                <li key={m.number + String(m.removedAt)}>
                  #{m.number} ·{" "}
                  {t(locale,
                    m.removalKind === "correctSentMembership" ? "didNotTravel" : "ordersRemovedBeforeDeparture",
                  )}
                  {" · "}{m.reason} · {m.removedBy} · <HistoryTime locale={locale} at={m.removedAt!} />
                </li>
              ))}
          </ul>
        </>
      )}
      <h3>{t(locale, "handoffHistory")}</h3>
      <ul>
        {trip.custody.map((h) => (
          <li key={h.id}>
            #{h.number} ·{" "}
            {h.action === "correctSentMembership"
              ? t(locale, "ordersDepartureCorrected")
              : h.action === "send"
                ? t(locale, "ordersMarkedSent")
                : h.reason
                  ? t(locale, "ordersMovedBack", { phase: phaseLabel(locale, h.toPhase), reason: h.reason })
                  : phaseLabel(locale, h.toPhase)}{" "}
            · {h.name} · <HistoryTime locale={locale} at={h.at} />
          </li>
        ))}
      </ul>
      {trip.emptyCorrections.length > 0 && (
        <>
          <h3>{t(locale, "emptyCorrections")}</h3>
          <ul>
            {trip.emptyCorrections.map((c) => (
              <li key={c.operationId}>
                {phaseLabel(locale, c.fromPhase)} → {phaseLabel(locale, c.toPhase)} · {c.reason} · {c.staffName}
                {" · "}<HistoryTime locale={locale} at={c.at} />
                {" · "}{t(locale, "operationIdLabel", { id: c.operationId })}
              </li>
            ))}
          </ul>
        </>
      )}
      {trip.confirmations.length > 0 && (
        <>
          <h3>{t(locale, "ordersContentsConfirmations")}</h3>
          <ul>
            {trip.confirmations.map((c) => (
              <li key={c.at}>
                {c.orderKeys.length
                  ? t(locale, "ordersConfirmed", {
                      name: c.name,
                      numbers: c.orderKeys.map((key) => "#" + key.orderNumber).join(", "),
                    })
                  : t(locale, "ordersConfirmedEmpty", { name: c.name })}
                {" · "}<HistoryTime locale={locale} at={c.at} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
