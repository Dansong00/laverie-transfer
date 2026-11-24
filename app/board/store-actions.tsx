"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { t, type Locale } from "../../i18n";
import type { StoreId } from "../../db/eligible-orders";
import type { StoreAction, PhaseCorrection } from "../../transfer/commands";
import { ConfirmSheet } from "../ui/confirm-sheet";
import { StepBackSheet } from "../ui/stepback-sheet";
import { Banner } from "../ui/banner";
import { Toast } from "../ui/toast";
import { useBatchChange } from "../use-batch-change";

const Changes = createContext<(ReturnType<typeof useBatchChange> & { locale: Locale }) | null>(null);

export function useBoardChanges() {
  const changes = useContext(Changes);
  if (!changes) throw new Error("Board change controls require BoardChanges");
  return changes;
}

export function BoardChanges({ staffId, store, children, locale, batchId, replayed }: {
  locale: Locale; staffId: string; store: StoreId; children: ReactNode; batchId?: string; replayed: boolean;
}) {
  const changes = useBatchChange(staffId, store, locale);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const key = `board-saved:${staffId}:${store}`;
    const timer = window.setTimeout(() => {
      try {
        const target = sessionStorage.getItem(key);
        sessionStorage.removeItem(key);
        if (target && target === batchId) setSaved(true);
      } catch { /* Tab storage is optional. */ }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [staffId, store, batchId]);
  return <Changes.Provider value={{ ...changes, locale }}>
    {children}
    {changes.message || changes.uncertain ? <Banner>
      <p>{changes.message}</p>
      {changes.uncertain
        ? <button className="btn btn-outline" disabled={changes.busy} onClick={() => void changes.submit()}>{t(locale, "checkPending")}</button>
        : <button className="btn btn-outline" onClick={() => window.location.reload()}>{t(locale, "refreshBatch")}</button>}
    </Banner> : <Toast message={replayed ? t(locale, "alreadySaved") : saved ? t(locale, "saved") : ""} />}
  </Changes.Provider>;
}

export function StoreButton({ command, label, outline = false }: { command: StoreAction; label: string; outline?: boolean }) {
  const { locale, submit, uncertain, busy } = useBoardChanges();
  const [open, setOpen] = useState(false);
  const disabled = uncertain || busy;
  return <>
    <button className={outline ? "btn btn-outline" : "btn"} type="button" disabled={disabled} onClick={() => setOpen(true)}>{label}</button>
    {open && <ConfirmSheet open title={label} prompt={t(locale, "boardConfirmAction", { action: label, id: command.batchId })}
      disabled={disabled} cancelLabel={t(locale, "cancel")} onClose={() => setOpen(false)}
      onConfirm={() => { if (!disabled) void submit(command); }}>
      {"orderKeys" in command && <ul className="confirm-orders">
        {command.orderKeys.map(order => <li key={order.orderNumber}>#{order.orderNumber}</li>)}
      </ul>}
    </ConfirmSheet>}
  </>;
}

export function TravelCorrection({ command, label }: {
  command: Omit<Extract<PhaseCorrection, { kind: "correctTravelPhase" }>, "reason">; label: string;
}) {
  const { locale, uncertain, busy, submit } = useBoardChanges();
  const [open, setOpen] = useState(false);
  return <>
    <button className="btn btn-outline" disabled={uncertain || busy} onClick={() => setOpen(true)}>{label}</button>
    {open && <StepBackSheet locale={locale} title={label} description={t(locale, "boardConfirmAction", { action: label, id: command.batchId })}
      disabled={uncertain || busy} onClose={() => setOpen(false)} onSave={reason => { setOpen(false); void submit({ ...command, reason }); }} />}
  </>;
}
