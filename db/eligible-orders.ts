import { and, asc, eq, isNull, notExists, or, sql } from "drizzle-orm";
import { getDb } from "./client";
import { batchOrders, centsOrders, handoffs } from "./schema";

export const stores = { soho: "SoHo", east_village: "East Village" } as const;
export type StoreId = keyof typeof stores;

export function eligibleAt(store: StoreId, db: Pick<ReturnType<typeof getDb>, "select">) {
  const membership = db.select({ id: batchOrders.id }).from(batchOrders).where(and(
    eq(batchOrders.storeId, centsOrders.storeId),
    eq(batchOrders.orderNumber, centsOrders.orderNumber),
    or(eq(batchOrders.active, true), isNull(batchOrders.removedAt)),
  ));
  const acknowledged = db.select({ id: handoffs.id }).from(handoffs).where(and(
    eq(handoffs.storeId, centsOrders.storeId),
    eq(handoffs.orderNumber, centsOrders.orderNumber),
    eq(handoffs.toPhase, "returned"),
  ));

  return and(
    eq(centsOrders.storeId, store),
    sql`cents_status_allows_transfer(${centsOrders.status})`,
    notExists(membership),
    notExists(acknowledged),
  );
}

export function listEligibleOrders(store: StoreId) {
  const db = getDb();
  return db.select({
    storeId: centsOrders.storeId,
    orderNumber: centsOrders.orderNumber,
    dueAt: centsOrders.dueAt,
    customerFirstName: centsOrders.customerFirstName,
    customerLastInitial: centsOrders.customerLastInitial,
    isPersonalDetergent: centsOrders.isPersonalDetergent,
  }).from(centsOrders).where(eligibleAt(store, db)).orderBy(asc(centsOrders.dueAt), asc(centsOrders.orderNumber));
}
