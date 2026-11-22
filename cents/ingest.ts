import { createHash, timingSafeEqual } from "node:crypto";
import { getDb } from "../db/client";
import { and, asc, eq, sql } from "drizzle-orm";
import { customerName, mappedStatus, orderCode, orderLock, storeMapping } from "./order-fields";
import { parseOrderDueDate } from "./report-date";
import { applyCentsEvent, sourceTimestamp } from "./snapshot";
import { centsOrders, centsRawEvents } from "../db/schema";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scalarFields(record: Record<string, unknown>, keys: string[]) {
  const result: Record<string, string | number | boolean | null> = {};
  for (const key of keys) {
    const value = record[key];
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      result[key] = value;
    }
  }
  return result;
}

const orderFields = [
  "id", "orderCode", "storeId", "storeName", "status", "orderType", "orderTotal",
  "balanceDue", "placedAt", "updatedAt", "completedAt", "dueDate", "returnMethod",
  "tipAmount", "creditAmount", "promotionAmount", "pickupDeliveryFee",
  "returnDeliveryFee", "recurringDiscountInCents",
];
const serviceFields = [
  "id", "name", "quantity", "unitCost", "totalPrice", "serviceCategory",
  "serviceCategoryType", "customerSelection",
];
const modifierFields = ["id", "name", "quantity", "pricingType", "unitCost", "totalPrice"];

function redactBody(event: string, order: Record<string, unknown>, payload: Record<string, unknown>) {
  // Fixed field order also gives identical fingerprints for reordered input keys.
  return {
    event,
    order: scalarFields(order, orderFields),
    services: Array.isArray(payload.services) ? payload.services.filter(isObject).map(service => ({
      ...scalarFields(service, serviceFields),
      modifiers: Array.isArray(service.modifiers)
        ? service.modifiers.filter(isObject).map(m => scalarFields(m, modifierFields))
        : undefined,
    })) : undefined,
    customer: isObject(payload.customer)
      ? customerName(payload.customer.firstName, payload.customer.lastName) : undefined,
  };
}

export class InvalidCentsEvent extends Error {}
export class UnauthorizedCentsEvent extends Error {}

function verifyHeader(supplied: string | null) {
  const expected = process.env.CENTS_WEBHOOK_HEADER_SECRET;
  if (!expected) throw new Error("Missing Cents webhook configuration");
  if (supplied === null) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(supplied), digest(expected));
}

export async function ingestCentsEvent(rawBody: string, authHeader: string | null, receivedAt: Date) {
  if (!verifyHeader(authHeader)) throw new UnauthorizedCentsEvent();
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new InvalidCentsEvent();
  }
  if (!isObject(payload)) throw new InvalidCentsEvent();
  const event = payload.event ?? payload.action;
  if (typeof event !== "string" || !event) throw new InvalidCentsEvent();
  if (!["order_created", "order_updated", "order_completed"].includes(event)) {
    return { effect: "ignored" } as const;
  }
  if (!isObject(payload.order)) throw new InvalidCentsEvent();

  const body = redactBody(event, payload.order, payload);
  const fingerprint = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const id = body.order.storeId;
  const storeHint = typeof id === "number" || typeof id === "string" ? String(id) : null;
  const stores = storeMapping();
  const store = storeHint === null ? undefined : stores.get(storeHint);
  const order = body.order;
  const orderNumber = orderCode(order.orderCode);
  const status = typeof order.status === "string" ? (mappedStatus(order.status) ?? order.status.trim()) : "";
  const time = sourceTimestamp(order.updatedAt);
  const date = typeof order.dueDate === "string" ? order.dueDate.trim() : "";
  const legacyDate = new Date(date);
  const dueAt = parseOrderDueDate(date) ?? (Number.isFinite(+legacyDate) ? legacyDate : null);

  const result = await getDb().transaction(async tx => {
    // Serialize first inserts too: a row lock cannot lock a missing snapshot.
    // Identical fingerprints also share this key, including malformed receipts.
    await tx.execute(orderLock(storeHint, orderNumber));
    const [original] = await tx.select({ id: centsRawEvents.id })
      .from(centsRawEvents).where(eq(centsRawEvents.fingerprint, fingerprint))
      .orderBy(asc(centsRawEvents.id)).limit(1);

    let reviewReason: string | null = null;
    if (!store) reviewReason = "unknown_store";
    else if (!time) reviewReason = order.updatedAt ? "invalid_updated_at" : "missing_updated_at";
    else if (!orderNumber || !status) reviewReason = "missing_order_fields";

    const [receipt] = await tx.insert(centsRawEvents).values({
      receivedAt, storeHint, fingerprint, body, duplicateOf: original?.id,
      needsReview: reviewReason !== null, reviewReason,
    }).returning({ id: centsRawEvents.id });
    const stored = receipt.id;
    if (original) return { stored, effect: "duplicate", reviewReason };
    if (!store || !time || !orderNumber || !status) return { stored, effect: "needs_review", reviewReason };

    const orderKey = and(eq(centsOrders.storeId, store), sql`cents_order_identity(${centsOrders.orderNumber}) = cents_order_identity(${orderNumber})`);
    const [current] = await tx.select({
      centsOrderId: centsOrders.centsOrderId,
      status: centsOrders.status,
      sourceUpdatedAt: sql<string | null>`to_char(${centsOrders.sourceUpdatedAt} at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    }).from(centsOrders).where(orderKey).for("update");
    const centsOrderId = identifier(order.id);
    if (current?.centsOrderId && centsOrderId && current.centsOrderId !== centsOrderId) {
      await tx.update(centsRawEvents).set({ needsReview: true, reviewReason: "conflicting_order_id" })
        .where(eq(centsRawEvents.id, stored));
      return { stored, effect: "needs_review", reviewReason: "conflicting_order_id" };
    }
    const effect = applyCentsEvent(current, { status, sourceUpdatedAt: time });
    if (effect === "needs_review") {
      reviewReason = "reopen";
      await tx.update(centsRawEvents).set({ needsReview: true, reviewReason })
        .where(eq(centsRawEvents.id, stored));
    }
    if (effect === "applied") {
      const values = {
        status, centsOrderId: centsOrderId ?? current?.centsOrderId ?? null,
        dueAt,
        customerFirstName: body.customer?.firstName ?? null,
        customerLastInitial: body.customer?.lastInitial ?? null,
        source: "webhook", sourceUpdatedAt: sql`${time}::timestamptz`,
        lastEventId: stored, updatedAt: receivedAt,
      };
      if (current) {
        await tx.update(centsOrders).set(values).where(orderKey);
      } else {
        await tx.insert(centsOrders).values({ ...values, storeId: store, orderNumber, createdAt: receivedAt });
      }
    }
    return { stored, effect, reviewReason };
  });
  console.info({ event, fingerprint, store, effect: result.effect, reviewReason: result.reviewReason });
  return { stored: result.stored, effect: result.effect };
}

function identifier(value: unknown) {
  if (typeof value === "string" && value.trim()) return value;
  return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : null;
}
