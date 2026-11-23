"use client";

import { useRef, useState } from "react";
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
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const addForm = useRef<HTMLFormElement>(null);

  async function save(change: StaffChange) {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setMessage("");
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
        setMessage(translateApiError(locale, result));
        return;
      }
      setMessage(t(locale, result.replayed ? "alreadySaved" : "saved"));
      if (change.kind === "addStaff") addForm.current?.reset();
      if (change.kind !== "addStaff" && change.targetStaffId === actorId) window.location.replace("/");
      else router.refresh();
    } catch {
      setMessage(t(locale, "staffRetryChange"));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <p role="status" aria-live="polite">
        {message}
      </p>
      <details className="add-staff">
        <summary>{t(locale, "staffAdd")}</summary>
        <form
          ref={addForm}
          onSubmit={(event) => {
            event.preventDefault();
            const fields = new FormData(event.currentTarget);
            void save({
              kind: "addStaff",
              name: String(fields.get("name")).trim(),
              phone: String(fields.get("phone")).trim(),
              role: fields.get("role") === "admin" ? "admin" : "staff",
            });
          }}
        >
          <label htmlFor="name">{t(locale, "name")}</label>
          <input id="name" name="name" required maxLength={120} />
          <label htmlFor="phone">{t(locale, "mobileNumber")}</label>
          <input id="phone" name="phone" type="tel" required maxLength={40} />
          <label htmlFor="role">{t(locale, "role")}</label>
          <select id="role" name="role">
            <option value="staff">{t(locale, "staff")}</option>
            <option value="admin">{t(locale, "admin")}</option>
          </select>
          <button className="primary" disabled={busy}>
            {t(locale, "staffAddMember")}
          </button>
        </form>
      </details>
      <ul className="staff-list">
        {members.map((person) => (
          <li key={person.id}>
            <h2>{person.name}</h2>
            <p>{person.phone}</p>
            <p>
              {t(locale, person.role === "admin" ? "admin" : "staff")} · {t(locale, person.active ? "staffActive" : "staffDisabled")}
            </p>
            <div className="controls">
              {person.active && (
                <button
                  disabled={busy}
                  onClick={() => {
                    const role = person.role === "staff" ? "admin" : "staff";
                    const prompt = t(locale, role === "admin" ? "staffConfirmMakeAdmin" : "staffConfirmMakeStaff", {
                      name: person.name,
                    });
                    if (window.confirm(prompt)) {
                      void save({ kind: "updateStaffRole", targetStaffId: person.id, role });
                    }
                  }}
                >
                  {t(locale, person.role === "staff" ? "staffMakeAdmin" : "staffMakeStaff")}
                </button>
              )}
              <button
                disabled={busy}
                onClick={() => {
                  const prompt = t(locale, person.active ? "staffConfirmDisable" : "staffConfirmEnable", {
                    name: person.name,
                  });
                  if (window.confirm(prompt)) {
                    void save({ kind: person.active ? "disableStaff" : "enableStaff", targetStaffId: person.id });
                  }
                }}
              >
                {t(locale, person.active ? "staffDisable" : "staffEnable")}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
