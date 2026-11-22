import { sql } from "drizzle-orm";

export function storeMapping() {
  const raw: unknown = JSON.parse(process.env.CENTS_STORE_ALLOWLIST ?? "");
  if (!raw || typeof raw !== "object" || !("soho" in raw) || !("east_village" in raw)) {
    throw new Error("Invalid Cents store mapping");
  }
  const mapping = new Map<string, string>();
  for (const store of ["soho", "east_village"] as const) {
    const id = raw[store];
    if ((typeof id !== "string" && typeof id !== "number") || !String(id).trim() || mapping.has(String(id))) {
      throw new Error("Invalid Cents store mapping");
    }
    mapping.set(String(id), store);
  }
  return mapping;
}

// Both writers use the external store ID so a webhook can race the first import.
export function orderLock(storeHint: string | null, orderNumber: string | null) {
  return sql`select pg_advisory_xact_lock(hashtextextended(
    jsonb_build_array(${storeHint}::text, cents_order_identity(${orderNumber}::text))::text, 0))`;
}

export function orderCode(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value !== "string") return null;
  return value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "") || null;
}

export function customerName(first: unknown, last: unknown) {
  return {
    firstName: typeof first === "string" ? first : undefined,
    lastInitial: typeof last === "string" ? Array.from(last.trim())[0] : undefined,
  };
}

// Start with statuses covered by webhook fixtures/tests. Extend only with a
// confirmed mapping from a Cents export to a webhook status.
const statuses = new Map(Object.entries({
  SUBMITTED: "SUBMITTED", IN_PROGRESS: "IN_PROGRESS", READY_FOR_PICKUP: "READY_FOR_PICKUP",
  COMPLETED: "COMPLETED", COMPLETE: "COMPLETED", CANCELLED: "CANCELLED", CANCELED: "CANCELLED",
}));

export function mappedStatus(value: string) {
  return statuses.get(value.trim().toUpperCase().replace(/[\s-]+/g, "_"));
}
