"use client";

import { useRef, useState } from "react";
import { ConfirmSheet } from "../ui/confirm-sheet";
import { Sheet } from "../ui/sheet";
import { Toast } from "../ui/toast";
import { useRouter } from "next/navigation";
import { t, type Locale } from "../../i18n";
import { translateApiError } from "../../i18n/api-errors";
import type { DirectoryMember, StaffChange } from "../../staff/directory";

export function Directory({ actorId, members, locale }: {
  actorId: string;
  members: DirectoryMember[];
  locale: Locale;
}) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [adding, setAdding] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    title: string; prompt: string; change: Exclude<StaffChange, { kind: "addStaff" }>;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);

  async function save(change: StaffChange) {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      // Preserve only a request fingerprint and its ID so retries survive a refresh
      // without leaving staff names or numbers in browser storage.
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(change)),
      );
      const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
      );
      const key = `staff-change:${actorId}:${hash}`;
      const operationId = localStorage.getItem(key) ?? crypto.randomUUID();
      localStorage.setItem(key, operationId);
      const response = await fetch("/api/staff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...change, operationId }),
      });
      if (response.status >= 500) throw new Error("Unconfirmed");
      const result = await response.json();
      localStorage.removeItem(key);
      if (response.status === 401 || response.status === 403) {
        window.location.replace("/");
        return;
      }
      if (!response.ok) {
        setError(translateApiError(locale, result));
        return;
      }
      setSuccess(t(locale, result.replayed ? "alreadySaved" : "saved"));
      if (change.kind === "addStaff") setAdding(false);
      if (change.kind !== "addStaff" && change.targetStaffId === actorId) window.location.replace("/");
      else router.refresh();
    } catch {
      setError(t(locale, "staffRetryChange"));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  function closeAdd() {
    if (saving.current) return;
    setAdding(false);
    setError("");
  }

  const status = <p role="status" aria-live="polite" className={error ? (adding ? "field-error" : "banner banner-warn") : "sr-only"}>{error}</p>;
  return (
    <>
      <button type="button" className="btn" disabled={busy} onClick={() => { setError(""); setSuccess(""); setAdding(true); }}>
        {t(locale, "staffAdd")}
      </button>
      {!adding && (success ? <Toast message={success} /> : status)}
      {adding && <Sheet open title={t(locale, "staffAdd")} closeLabel={t(locale, "cancel")} onClose={closeAdd}>
        <p>{t(locale, "staffAddNote")}</p>
        <form onSubmit={event => {
          event.preventDefault();
          const fields = new FormData(event.currentTarget);
          void save({
            kind: "addStaff",
            name: String(fields.get("name")).trim(),
            phone: String(fields.get("phone")).trim(),
            role: fields.get("role") === "admin" ? "admin" : "staff",
          });
        }}>
          <fieldset className="add-fields" disabled={busy}>
            <label className="field-label" htmlFor="name">{t(locale, "name")}</label>
            <input className="input" id="name" name="name" required maxLength={120} />
            <label className="field-label" htmlFor="phone">{t(locale, "mobileNumber")}</label>
            <input className="input" id="phone" name="phone" type="tel" required maxLength={40} />
            <label className="field-label" htmlFor="role">{t(locale, "role")}</label>
            <select className="input" id="role" name="role">
              <option value="staff">{t(locale, "staff")}</option>
              <option value="admin">{t(locale, "admin")}</option>
            </select>
            {status}
            <button className="btn">{t(locale, "staffAddMember")}</button>
          </fieldset>
        </form>
      </Sheet>}
      <ul className="card staff-list">
        {members.map(person => {
          const newRole = person.role === "staff" ? "admin" : "staff";
          const roleLabel = t(locale, newRole === "admin" ? "staffMakeAdmin" : "staffMakeStaff");
          const accessLabel = t(locale, person.active ? "staffDisable" : "staffEnable");
          return <li className="staff-row-admin" key={person.id}>
            <div className={person.active ? "staff-summary" : "staff-summary inactive"}>
              <h2 className="staff-name">{person.name}</h2>
              <p className="staff-meta">{t(locale, person.role === "admin" ? "admin" : "staff")} · {person.phone} · {t(locale, person.active ? "staffActive" : "staffDisabled")}</p>
            </div>
            {person.id === actorId ? <span className="badge">{t(locale, "staffYou")}</span>
              : !person.active && <span className="badge">{t(locale, "staffDisabled")}</span>}
            <div className="staff-actions">
              {person.active && <button type="button" className="btn btn-outline" disabled={busy} onClick={() => setConfirmation({
                title: roleLabel, prompt: t(locale, newRole === "admin" ? "staffConfirmMakeAdmin" : "staffConfirmMakeStaff", { name: person.name }),
                change: { kind: "updateStaffRole", targetStaffId: person.id, role: newRole },
              })}>{roleLabel}</button>}
              <button type="button" className={person.active ? "btn btn-destructive" : "btn btn-outline"} disabled={busy}
                onClick={() => setConfirmation({
                  title: accessLabel, prompt: t(locale, person.active ? "staffConfirmDisable" : "staffConfirmEnable", { name: person.name }),
                  change: { kind: person.active ? "disableStaff" : "enableStaff", targetStaffId: person.id },
                })}>{accessLabel}</button>
            </div>
          </li>;
        })}
      </ul>
      {confirmation && <ConfirmSheet open title={confirmation.title} prompt={confirmation.prompt} disabled={busy}
        destructive={confirmation.change.kind === "disableStaff"} cancelLabel={t(locale, "cancel")}
        onClose={() => setConfirmation(null)} onConfirm={() => void save(confirmation.change)} />}
    </>
  );
}
