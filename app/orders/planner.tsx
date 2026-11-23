"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import type { StoreId } from "../../db/eligible-orders";
import { t, type Locale } from "../../i18n";
import { useBatchChange } from "../use-batch-change";

import { ContentsForm, type SentTrip } from "./contents-form";

type Plan = { id: string; version: number };
type Props = {
  locale: Locale;
  staffId: string;
  origin: StoreId;
  plan?: Plan;
  members: string[];
  children: ReactNode;
  trip?: SentTrip;
  admin: boolean;
};

export function Planner({ locale, staffId, origin, plan, members, children, trip, admin }: Props) {
  const { busy, message, setMessage, uncertain, submit } = useBatchChange(staffId, origin, locale);
  const [removing, setRemoving] = useState<string[]>([]);

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const add = data.getAll("add").map(String);
    if (!plan) {
      if (!add.length && !window.confirm(t(locale, "ordersConfirmEmptyPlan"))) return;
      void submit({ kind: "createBatch", origin, add });
    } else {
      const remove = removing.map((orderNumber) => ({
        orderNumber,
        note: String(data.get("note-" + orderNumber) ?? ""),
      }));
      if (!add.length && !remove.length) {
        setMessage(t(locale, "ordersChooseChanges"));
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
        <ContentsForm
          locale={locale}
          trip={trip}
          store={origin}
          admin={admin}
          disabled={busy || uncertain}
          submit={submit}
        />
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
                          {t(locale, "ordersRemove")}
                        </label>
                        {removing.includes(number) && (
                          <label className="removal-note">
                            {t(locale, "ordersReasonForRemoving", { number })}
                            <input required name={"note-" + number} />
                          </label>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>{t(locale, "emptyPlan")}</p>
                )}
              </section>
            )}
            {children}
            <button className="save-plan" type="submit">
              {t(locale, plan ? "ordersSaveChanges" : "ordersCreatePlan")}
            </button>
            {plan && (
              <button
                type="button"
                disabled={!members.length}
                onClick={(event) => {
                  if (removing.length || event.currentTarget.form?.querySelector("input[name=add]:checked")) {
                    setMessage(t(locale, "ordersSaveBeforeSend"));
                    return;
                  }
                  const prompt = members.length === 1
                    ? t(locale, "ordersConfirmSendOne", { batch: plan.id })
                    : t(locale, "ordersConfirmSendMany", { batch: plan.id, count: members.length });
                  if (!window.confirm(prompt)) return;
                  void submit({
                    kind: "runAction",
                    action: "send",
                    origin,
                    batchId: plan.id,
                    expectedVersion: plan.version,
                  });
                }}
              >
                {t(locale, "ordersMarkSent")}
              </button>
            )}
            {plan && (
              <button
                type="button"
                className="cancel-plan"
                onClick={() => {
                  if (window.confirm(t(locale, "ordersConfirmCancel", { batch: plan.id })))
                    void submit({
                      kind: "deleteBatch",
                      origin,
                      batchId: plan.id,
                      expectedVersion: plan.version,
                    });
                }}
              >
                {t(locale, "ordersCancelBatch")}
              </button>
            )}
          </fieldset>
        </form>
      )}
      <p role="status">{message}</p>
      {uncertain && (
        <button disabled={busy} onClick={() => void submit()}>
          {t(locale, "checkPending")}
        </button>
      )}
      {message && !uncertain && (
        <button onClick={() => window.location.reload()}>{t(locale, "ordersRefresh")}</button>
      )}
    </>
  );
}
