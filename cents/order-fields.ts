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
  const key = JSON.stringify([storeHint, orderNumber]);
  return sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

export function customerName(first: unknown, last: unknown) {
  return {
    firstName: typeof first === "string" ? first : undefined,
    lastInitial: typeof last === "string" ? Array.from(last.trim())[0] : undefined,
  };
}
