import { getDb } from "../db/client";
import { centsOrders } from "../db/schema";
import { customerName, mappedStatus, orderCode, orderLock, storeMapping } from "./order-fields";
import { parseOrderDueDate } from "./report-date";

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

export function prepareBackfillRow(row: ReportRow, locations = reportLocations()) {
  const location = locations.get(row.location.trim().toLowerCase());
  if (!location) throw new ReportError("Unknown Location");
  const orderNumber = orderCode(row.orderCode);
  if (!orderNumber) throw new ReportError("Missing Order Code");
  const status = mappedStatus(row.status);
  if (!status) throw new ReportError("Unrecognized Status");
  const date = row.dueDate?.trim();
  const dueAt = date ? parseOrderDueDate(date) : null;
  if (date && !dueAt) throw new ReportError("Invalid Due Date");
  const name = customerName(row.firstName?.trim() || undefined, row.lastName);
  return { location, orderNumber, status, dueAt, name };
}

export async function insertBackfillRow(prepared: ReturnType<typeof prepareBackfillRow>) {
  const { location, orderNumber, status, dueAt, name } = prepared;
  return getDb().transaction(async tx => {
    await tx.execute(orderLock(location.centsId, orderNumber));
    const now = new Date();
    const inserted = await tx.insert(centsOrders).values({
      storeId: location.storeId, orderNumber, status, dueAt,
      customerFirstName: name.firstName, customerLastInitial: name.lastInitial,
      source: "backfill", sourceUpdatedAt: null, createdAt: now, updatedAt: now,
    }).onConflictDoNothing()
      .returning({ orderNumber: centsOrders.orderNumber });
    return inserted.length ? "inserted" : "already_present";
  });
}

export function importBackfillRow(row: ReportRow, locations = reportLocations()) {
  return insertBackfillRow(prepareBackfillRow(row, locations));
}
