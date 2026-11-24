"use client";

import { useState, type ReactNode } from "react";
import { t, type Locale } from "../../i18n";
import { phaseLabel } from "../../i18n/transfer";
import type { StoreAction, PhaseCorrection } from "../../transfer/commands";
import { useBoardChanges } from "../board/store-actions";
import { Sheet } from "./sheet";
import { StepBackSheet } from "./stepback-sheet";
import { ConfirmSheet } from "./confirm-sheet";

type Props = {
  locale: Locale; number: string; name: string; batch: string; origin: string; phase: string; detergent: boolean;
  advance?: StoreAction; back?: Omit<Extract<PhaseCorrection, { kind: "stepBackOrder" }>, "reason">; children: ReactNode;
};

export function OrderSheet({ locale, number, name, batch, origin, phase, detergent, advance, back, children }: Props) {
  const [view, setView] = useState<"closed" | "order" | "advance" | "back">("closed");
  const { submit, busy, uncertain } = useBoardChanges();
  const disabled = busy || uncertain;
  const close = () => setView("closed");
  const title = ["#" + number, name].filter(Boolean).join(" ");
  const forwardLabel = t(locale, phase === "received" ? "boardStartProcessing" : "boardMarkReady");
  const backLabel = t(locale, phase === "processing" ? "boardBackToReceived" : "boardBackToProcessing");
  const badge = phase === "ready_for_return" ? "ready" : phase.replaceAll("_", "-");
  return <>
    <button className="order-row" aria-label={title} onClick={() => setView("order")}>
      <span className="onum">#{number}</span><span className="name">{name}</span>
      <span className={`badge badge-${badge}`}>{phaseLabel(locale, phase)}</span><span className="chev" aria-hidden="true">›</span>
    </button>
    {view === "order" && <Sheet open title={title} onClose={close} closeLabel={t(locale, phase === "processing" && back ? "cancel" : "close")}>
      <p>{origin} · {batch} · {phaseLabel(locale, phase)} {detergent && <span className="badge badge-hold">{t(locale, "personalDetergent")}</span>}</p>
      <p className="proposal-note">{t(locale, "orderOnePhase")}</p>
      {children}
      {advance && <button className="btn" disabled={disabled} onClick={() => setView("advance")}>{forwardLabel}</button>}
      {back && <button className="btn btn-outline" disabled={disabled} onClick={() => setView("back")}>{backLabel}</button>}
    </Sheet>}
    {view === "advance" && advance && <ConfirmSheet open title={forwardLabel} disabled={disabled}
      prompt={t(locale, "boardConfirmAction", { action: forwardLabel, id: batch })} cancelLabel={t(locale, "cancel")}
      onClose={() => setView("order")} onConfirm={() => { if (!disabled) { close(); void submit(advance); } }} />}
    {view === "back" && back && <StepBackSheet title={backLabel} locale={locale} disabled={disabled}
      description={t(locale, "stepBackBody", { order: title, from: phaseLabel(locale, phase), to: phaseLabel(locale, phase === "processing" ? "received" : "processing") })}
      onClose={() => setView("order")} onSave={reason => { close(); void submit({ ...back, reason }); }} />}
  </>;
}
