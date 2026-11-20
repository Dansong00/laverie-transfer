import { createHash, timingSafeEqual } from "node:crypto";
import { getDb } from "../db/client";
import { centsRawEvents } from "../db/schema";

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
    customer: isObject(payload.customer) ? {
      firstName: typeof payload.customer.firstName === "string" ? payload.customer.firstName : undefined,
      lastInitial: typeof payload.customer.lastName === "string"
        ? Array.from(payload.customer.lastName.trim())[0] : undefined,
    } : undefined,
  };
}

function storeMapping() {
  const raw: unknown = JSON.parse(process.env.CENTS_STORE_ALLOWLIST ?? "");
  if (!isObject(raw)) throw new Error("Invalid Cents store mapping");
  const mapping = new Map<string, string>();
  for (const store of ["soho", "east_village"]) {
    const id = raw[store];
    if ((typeof id !== "string" && typeof id !== "number") || !String(id).trim() || mapping.has(String(id))) {
      throw new Error("Invalid Cents store mapping");
    }
    mapping.set(String(id), store);
  }
  return mapping;
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
  let reviewReason: string | null = null;
  if (!store) reviewReason = "unknown_store";
  else if (!body.order.updatedAt) reviewReason = "missing_updated_at";
  const [row] = await getDb().transaction(async tx => {
    return tx.insert(centsRawEvents).values({
      receivedAt, storeHint, fingerprint, body, needsReview: reviewReason !== null, reviewReason,
    }).returning({ id: centsRawEvents.id });
  });
  console.info({ event, fingerprint, store, effect: reviewReason ? "needs_review" : "stored", reviewReason });
  return { stored: row.id, effect: reviewReason ? "needs_review" : "stored" } as const;
}
