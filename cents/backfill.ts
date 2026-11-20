import { sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { centsOrders } from "../db/schema";
import { customerName, orderLock, storeMapping } from "./order-fields";

export class ReportError extends Error {}

export function reportLocations() {
  const locations = new Map<string, { storeId: string; centsId: string }>();
  for (const [centsId, storeId] of storeMapping()) {
    const label = storeId.replaceAll("_", " ");
    for (const alias of [centsId.toLowerCase(), storeId, label, "laverie " + label]) {
      const previous = locations.get(alias);
      if (previous && previous.storeId !== storeId) throw new ReportError("Ambiguous store mapping");
      locations.set(alias, { storeId, centsId });
    }
  }
  return locations;
}

export type ReportRow = {
  orderCode: string;
  location: string;
  status: string;
  dueDate?: string;
  firstName?: string;
  lastName?: string;
};

function dueDateValue(date: string) {
  if (!date) return null;
  // Normalize US report dates before Postgres parses them, independent of DateStyle.
  const iso = date.replace(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?=\s|$)/,
    (_, m: string, d: string, y: string) => `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`);
  if (!/^\d{4}-\d\d-\d\d(?:[ T]\d{1,2}:\d\d(?::\d\d(?:\.\d+)?)?(?:\s?[AP]M|Z|[+-]\d\d:\d\d)?)?$/i.test(iso)) {
    throw new ReportError("Invalid Due Date");
  }
  if (/(?:Z|[+-]\d\d:\d\d)$/i.test(iso)) return sql`${iso}::timestamptz`;
  return sql`${iso}::timestamp at time zone 'America/New_York'`;
}

export async function importBackfillRow(row: ReportRow, locations = reportLocations()) {
  const location = locations.get(row.location.trim().toLowerCase());
  if (!location) throw new ReportError("Unknown Location");
  const orderNumber = row.orderCode.trim();
  if (!orderNumber) throw new ReportError("Missing Order Code");
  let status = row.status.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (!status) throw new ReportError("Missing Status");
  if (status === "CANCELED") status = "CANCELLED";
  if (status === "COMPLETE") status = "COMPLETED";
  const name = customerName(row.firstName?.trim() || undefined, row.lastName);
  const dueAt = dueDateValue(row.dueDate?.trim() ?? "");
  return getDb().transaction(async tx => {
    await tx.execute(orderLock(location.centsId, orderNumber));
    const now = new Date();
    const inserted = await tx.insert(centsOrders).values({
      storeId: location.storeId, orderNumber, status, dueAt,
      customerFirstName: name.firstName, customerLastInitial: name.lastInitial,
      source: "backfill", sourceUpdatedAt: null, createdAt: now, updatedAt: now,
    }).onConflictDoNothing({ target: [centsOrders.storeId, centsOrders.orderNumber] })
      .returning({ orderNumber: centsOrders.orderNumber });
    return inserted.length ? "inserted" : "already_present";
  });
}
