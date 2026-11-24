"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import type { StoreId } from "../../db/eligible-orders";
import { t, type Locale } from "../../i18n";
import type { BatchChange } from "../../transfer/commands";
import { ConfirmSheet } from "../ui/confirm-sheet";
import { useBatchChange } from "../use-batch-change";
import { ContentsForm, type SentTrip } from "./contents-form";

export type OrderConfirmation = {
  title: string;
  prompt: string;
  change: BatchChange;
  details?: ReactNode;
};

type Props = {
  locale: Locale;
  staffId: string;
  origin: StoreId;
  storeName: string;
  plan?: { id: string; version: number };
  members: string[];
  children: ReactNode;
  trip?: SentTrip;
  admin: boolean;
};

export function Planner({ locale, staffId, origin, storeName, plan, members, children, trip, admin }: Props) {
  const { busy, message, setMessage, uncertain, submit } = useBatchChange(staffId, origin, locale);
  const [removing, setRemoving] = useState<string[]>([]);
  const [count, setCount] = useState(0);
  const [confirmation, setConfirmation] = useState<OrderConfirmation | null>(null);
  const disabled = busy || uncertain;

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const add = data.getAll("add").map(String);
    if (!plan) {
      const change = { kind: "createBatch", origin, add } as const;
      if (add.length) void submit(change);
      else setConfirmation({ title: t(locale, "ordersCreatePlan"), prompt: t(locale, "ordersConfirmEmptyPlan"), change });
      return;
    }
    const remove = removing.map(orderNumber => ({ orderNumber, note: String(data.get("note-" + orderNumber) ?? "") }));
    if (!add.length && !remove.length) {
      setMessage(t(locale, "ordersChooseChanges"));
      return;
    }
    setConfirmation({
      title: t(locale, "ordersSaveChanges"), prompt: t(locale, "ordersConfirmSave", { batch: plan.id }),
      change: { kind: "updateBatch", origin, batchId: plan.id, expectedVersion: plan.version, add, remove },
    });
  }

  function send() {
    if (!plan) return;
    if (removing.length || count) {
      setMessage(t(locale, "ordersSaveBeforeSend"));
      return;
    }
    setConfirmation({
      title: t(locale, "ordersMarkSent"),
      prompt: t(locale, members.length === 1 ? "ordersConfirmSendOne" : "ordersConfirmSendMany", { batch: plan.id, count: members.length }),
      change: { kind: "runAction", action: "send", origin, batchId: plan.id, expectedVersion: plan.version },
    });
  }

  return (
    <>
      {trip ? (
        <ContentsForm locale={locale} trip={trip} store={origin} admin={admin} disabled={disabled} confirm={setConfirmation} />
      ) : (
        <form onSubmit={save} onChange={event => setCount(new FormData(event.currentTarget).getAll("add").length)}>
          <fieldset disabled={disabled}>
            {plan && (
              <section className="card orders-card">
                <h2 className="group-label">{t(locale, "boardOrders")}</h2>
                {members.length ? (
                  <ul>
                    {members.map(number => (
                      <li key={number}>
                        <div className="order-row member-row">
                          <strong className="onum">#{number}</strong>
                          <label className="remove-toggle">
                            <input type="checkbox" checked={removing.includes(number)}
                              onChange={event => setRemoving(event.target.checked ? [...removing, number] : removing.filter(n => n !== number))} />
                            {t(locale, "ordersRemove")}
                          </label>
                        </div>
                        {removing.includes(number) && (
                          <label className="removal-note">{t(locale, "ordersReasonForRemoving", { number })}
                            <input required name={"note-" + number} />
                          </label>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : <p className="empty-group">{t(locale, "emptyPlan")}</p>}
              </section>
            )}
            <p className="orders-summary" aria-live="polite">
              {t(locale, count === 0 ? "ordersSelectedNone" : count === 1 ? "ordersSelectedOne" : "ordersSelectedMany", { store: storeName, count })}
            </p>
            {children}
            <div className="btn-row">
              {plan && <button className="btn" type="button" disabled={!members.length} onClick={send}>{t(locale, "ordersMarkSent")}</button>}
              <button className={plan ? "btn btn-outline" : "btn"} type="submit">{t(locale, plan ? "ordersSaveChanges" : "ordersCreatePlan")}</button>
              {plan && <button type="button" className="btn btn-outline btn-danger" onClick={() => setConfirmation({
                title: t(locale, "ordersCancelBatch"), prompt: t(locale, "ordersConfirmCancel", { batch: plan.id }),
                change: { kind: "deleteBatch", origin, batchId: plan.id, expectedVersion: plan.version },
              })}>{t(locale, "ordersCancelBatch")}</button>}
            </div>
          </fieldset>
        </form>
      )}
      {confirmation && (
        <ConfirmSheet open title={confirmation.title} prompt={confirmation.prompt} disabled={disabled}
          cancelLabel={t(locale, "cancel")} onClose={() => setConfirmation(null)} onConfirm={() => void submit(confirmation.change)}>
          {confirmation.details}
        </ConfirmSheet>
      )}
      {message && <p className="banner banner-warn" role="status">{message}</p>}
      {uncertain && <button className="btn btn-outline" disabled={busy} onClick={() => void submit()}>{t(locale, "checkPending")}</button>}
      {message && !uncertain && <button className="btn btn-outline" onClick={() => window.location.reload()}>{t(locale, "ordersRefresh")}</button>}
    </>
  );
}
