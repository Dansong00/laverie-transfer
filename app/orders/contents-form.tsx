"use client";

import { useState, type FormEvent } from "react";
import type { StoreId } from "../../db/eligible-orders";
import { formatLocalDate } from "../../i18n/dates";
import { t, type Locale } from "../../i18n";
import { phaseLabel } from "../../i18n/transfer";
import type { OrderConfirmation } from "./planner";
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
  confirm,
}: {
  locale: Locale;
  trip: SentTrip;
  store: StoreId;
  admin: boolean;
  disabled: boolean;
  confirm: (confirmation: OrderConfirmation) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const remaining = trip.members.filter((m) => !m.removedAt);
  const removed = trip.members.filter(m => m.removedAt);
  const canCorrect =
    remaining.length > 0 &&
    remaining.every(
      (m) => m.active && ["sent", "received", "processing", "ready_for_return"].includes(m.phase),
    );
  const command = { origin: trip.origin, batchId: trip.id, expectedVersion: trip.version };
  function correct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (!selected.length) return;
    confirm({
      title: t(locale, "ordersRecordCorrection"), prompt: t(locale, "ordersConfirmMissing"),
      change: {
        ...command, kind: "correctSentMembership",
        remove: selected.map(orderNumber => ({
          orderKey: { storeId: trip.origin, orderNumber }, reason: String(data.get("reason-" + orderNumber) ?? ""),
        })),
      },
    });
  }
  return (
    <section>
      {trip.changed && <p className="banner banner-warn" role="status">{t(locale, "contentsChanged")}</p>}
      <form onSubmit={correct}>
        <fieldset disabled={disabled}>
          <section className="card orders-card">
            <h2 className="group-label">{t(locale, "ordersRemaining")}</h2>
            {!remaining.length && <p className="empty-group">{t(locale, "ordersNoneRemaining")}</p>}
            <ul>
              {remaining.map((m) => (
                <li key={m.number}>
                  <div className="order-row member-row"><strong className="onum">#{m.number}</strong> <span>{phaseLabel(locale, m.phase)}</span>
                    {admin && canCorrect && (
                      <label className="remove-toggle">
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
                  </div>
                  {selected.includes(m.number) && (
                    <label className="removal-note">
                      {t(locale, "ordersReasonFor", { number: m.number })}
                      <input name={"reason-" + m.number} required />
                    </label>
                  )}
                </li>
              ))}
            </ul>
          </section>
          {admin && canCorrect && (
            <button className="btn btn-outline btn-danger" disabled={!selected.length}>{t(locale, "ordersRecordCorrection")}</button>
          )}
        </fieldset>
      </form>
      {trip.changed && !trip.received && (
        <p className="btn-hint">{t(locale, "ordersReceiveBeforeConfirm")}</p>
      )}
      {trip.changed && trip.received && !remaining.some((m) => m.phase === "sent") && (
        <button className="btn confirm-contents"
          disabled={disabled || selected.length > 0}
          onClick={() => {
            const prompt = t(locale, "ordersConfirmRemaining", {
              batch: trip.id,
              store: store === "soho" ? "SoHo" : "East Village",
            });
            confirm({
              title: t(locale, "ordersConfirmContents"), prompt,
              change: { ...command, kind: "confirmContents", store },
              details: <dl className="contents-diff">
                <dt>{t(locale, "ordersRemaining")}</dt>
                <dd>{remaining.length ? remaining.map(m => "#" + m.number).join(", ") : t(locale, "ordersNoneRemaining")}</dd>
                {removed.length > 0 && <><dt>{t(locale, "ordersRemoved")}</dt>
                  <dd><del>{removed.map(m => "#" + m.number).join(", ")}</del></dd></>}
              </dl>,
            });
          }}
        >
          {t(locale, "ordersConfirmContents")}
        </button>
      )}
      {removed.length > 0 && (
        <section className="card orders-card">
          <h2 className="group-label">{t(locale, "ordersRemoved")}</h2>
          <ul>
            {removed.map((m) => (
              <li className="history-entry" key={m.number + String(m.removedAt)}>
                <del className="onum">#{m.number}</del> ·{" "}
                {t(locale,
                  m.removalKind === "correctSentMembership" ? "didNotTravel" : "ordersRemovedBeforeDeparture",
                )}
                {" · "}{m.reason} · {m.removedBy} · <HistoryTime locale={locale} at={m.removedAt!} />
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="card history-card">
        <h2 className="group-label">{t(locale, "handoffHistory")}</h2>
        <ol className="timeline">
          {trip.custody.map((h) => (
            <li className="step is-done" key={h.id}>
              <span className="dot" aria-hidden="true" />
              <div className="contents-step">
                <strong className="onum">#{h.number}</strong> ·{" "}
                {h.action === "correctSentMembership"
                  ? t(locale, "ordersDepartureCorrected")
                  : h.action === "send"
                    ? t(locale, "ordersMarkedSent")
                    : h.reason
                      ? t(locale, "ordersMovedBack", { phase: phaseLabel(locale, h.toPhase), reason: h.reason })
                      : phaseLabel(locale, h.toPhase)}{" "}
                <span className="step-who">{h.name} · <HistoryTime locale={locale} at={h.at} /></span>
              </div>
            </li>
          ))}
        </ol>
      </section>
      {trip.emptyCorrections.length > 0 && (
        <>
          <h2 className="group-label">{t(locale, "emptyCorrections")}</h2>
          <ul>
            {trip.emptyCorrections.map((c) => (
              <li className="correction-callout" key={c.operationId}>
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
          <h2 className="group-label">{t(locale, "ordersContentsConfirmations")}</h2>
          <ul>
            {trip.confirmations.map((c) => (
              <li className="stamp" key={c.at}>
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
