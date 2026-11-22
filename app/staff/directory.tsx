"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { DirectoryMember, StaffChange } from "../../staff/directory";

export function Directory({ actorId, members }: { actorId: string; members: DirectoryMember[] }) {
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
        setMessage(result.error);
        return;
      }
      setMessage(result.replayed ? "Already saved." : "Saved.");
      if (change.kind === "addStaff") addForm.current?.reset();
      if (change.kind !== "addStaff" && change.targetStaffId === actorId) window.location.replace("/");
      else router.refresh();
    } catch {
      setMessage("Not confirmed yet. Retry the same change to check.");
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
        <summary>Add staff</summary>
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
          <label htmlFor="name">Name</label>
          <input id="name" name="name" required maxLength={120} />
          <label htmlFor="phone">Mobile number</label>
          <input id="phone" name="phone" type="tel" required maxLength={40} />
          <label htmlFor="role">Role</label>
          <select id="role" name="role">
            <option value="staff">Staff</option>
            <option value="admin">Admin</option>
          </select>
          <button className="primary" disabled={busy}>
            Add staff member
          </button>
        </form>
      </details>
      <ul className="staff-list">
        {members.map((person) => (
          <li key={person.id}>
            <h2>{person.name}</h2>
            <p>{person.phone}</p>
            <p>
              {person.role === "admin" ? "Admin" : "Staff"} · {person.active ? "Active" : "Disabled"}
            </p>
            {person.active && (
              <div className="controls">
                <button
                  disabled={busy}
                  onClick={() => {
                    const role = person.role === "staff" ? "admin" : "staff";
                    if (window.confirm(`Change ${person.name}’s role to ${role}?`)) {
                      void save({ kind: "updateStaffRole", targetStaffId: person.id, role });
                    }
                  }}
                >
                  {person.role === "staff" ? "Make admin" : "Make staff"}
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Disable ${person.name} and sign them out of all devices?`)) {
                      void save({ kind: "disableStaff", targetStaffId: person.id });
                    }
                  }}
                >
                  Disable
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
