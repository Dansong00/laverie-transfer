import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { getDb } from "../db/client";
import { batchOrders, batches, handoffs, operations } from "../db/schema";
import { BatchError, type StoreAction, type BatchChange } from "./commands";

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];
const transitions = {
  receive: ["sent", "received", "BATCH_ORDERS_CANNOT_RECEIVE"],
  startProcessing: ["received", "processing", "BATCH_ORDERS_CANNOT_START_PROCESSING"],
  markReady: ["processing", "ready_for_return", "BATCH_ORDERS_CANNOT_MARK_READY"],
} as const;
export function isStoreAction(change: BatchChange): change is StoreAction {
  return (
    change.kind === "runAction" &&
    (change.action === "sendReturn" ||
      change.action === "acknowledgeReturn" ||
      change.action === "receive" ||
      change.action === "startProcessing" ||
      change.action === "markReady")
  );
}

// A batch can have no retained orders. Use the versioned operations to distinguish
// a current receipt from one reversed by an admin on an earlier trip.
export function travelPhase(batchId: string | typeof batches.id) {
  return sql<string>`coalesce((select case ${operations.kind}
    when 'send' then 'sent' when 'receive' then 'received'
    else ${operations.result} #>> '{result,correction,toPhase}' end
    from ${operations} where ${operations.batchId} = ${batchId}
    and ${operations.kind} in ('send','receive','correctTravelPhase')
    and ${operations.result}->>'ok' = 'true'
    order by (${operations.result} #>> '{result,version}')::integer desc limit 1), 'planned')`;
}

export function receiptRecorded(batchId: string | typeof batches.id) {
  return sql<boolean>`${travelPhase(batchId)} = 'received'`;
}

export async function advanceAtStore(
  tx: Tx,
  batch: typeof batches.$inferSelect,
  change: StoreAction,
  operationId: string,
  staffId: string,
  at: Date,
) {
  if (change.action === "sendReturn" || change.action === "acknowledgeReturn")
    return advanceReturn(tx, batch, change, operationId, staffId, at);
  if (change.store !== batch.destination) throw new BatchError(403, "BATCH_RECEIVING_STORE_REQUIRED");
  const [fromPhase, toPhase, invalidOrdersCode] = transitions[change.action];
  const retained = and(eq(batchOrders.batchId, batch.id), isNull(batchOrders.removedAt));
  const selected = change.action === "receive" ? undefined : change.orderKeys.map((key) => key.orderNumber);
  const members = await tx
    .select({
      id: batchOrders.id,
      number: batchOrders.orderNumber,
      phase: batchOrders.phase,
      active: batchOrders.active,
    })
    .from(batchOrders)
    .where(and(retained, selected ? inArray(batchOrders.orderNumber, selected) : undefined))
    .for("update");
  if (change.action === "receive" && !members.length) {
    const [receipt] = await tx
      .select({ received: receiptRecorded(batch.id) })
      .from(batches)
      .where(eq(batches.id, batch.id));
    if (!batch.contentsChanged || receipt.received)
      throw new BatchError(409, "BATCH_RECEIPT_NOT_PENDING");
    return;
  }
  const eligible = new Set(members.filter((m) => m.active && m.phase === fromPhase).map((m) => m.number));
  const invalid = (selected ?? members.map((m) => m.number)).filter((number) => !eligible.has(number));
  if (invalid.length)
    throw new BatchError(409, invalidOrdersCode, { orders: invalid.join(", ") });
  await tx
    .update(batchOrders)
    .set({ phase: toPhase })
    .where(
      inArray(
        batchOrders.id,
        members.map((m) => m.id),
      ),
    );
  await tx.insert(handoffs).values(
    members.map((m) => ({
      operationId,
      batchId: batch.id,
      storeId: change.origin,
      orderNumber: m.number,
      action: change.action,
      fromPhase,
      toPhase,
      staffId,
      at,
    })),
  );
}

async function advanceReturn(
  tx: Tx,
  batch: typeof batches.$inferSelect,
  change: Extract<StoreAction, { action: "sendReturn" | "acknowledgeReturn" }>,
  operationId: string,
  staffId: string,
  at: Date,
) {
  const acknowledging = change.action === "acknowledgeReturn";
  if (acknowledging && change.store !== batch.origin)
    throw new BatchError(403, "BATCH_RETURN_ORIGIN_REQUIRED");
  if (!acknowledging && change.store !== batch.destination)
    throw new BatchError(403, "BATCH_RETURN_SENDER_REQUIRED");
  if (batch.contentsChanged) throw new BatchError(409, "BATCH_CONTENTS_CONFIRMATION_REQUIRED");
  const fromPhase = acknowledging ? "return_sent" : "ready_for_return";
  const toPhase = acknowledging ? "returned" : "return_sent";
  const retained = and(eq(batchOrders.batchId, batch.id), isNull(batchOrders.removedAt));
  const members = await tx
    .select({ number: batchOrders.orderNumber, active: batchOrders.active, phase: batchOrders.phase })
    .from(batchOrders)
    .where(retained)
    .for("update");
  if (!members.length || members.some((m) => !m.active || m.phase !== fromPhase))
    throw new BatchError(
      409,
      acknowledging
        ? "BATCH_RETURN_NOT_SENT"
        : "BATCH_ORDERS_NOT_READY_FOR_RETURN",
    );
  await tx.insert(handoffs).values(
    members.map((m) => ({
      operationId,
      staffId,
      batchId: batch.id,
      storeId: change.origin,
      orderNumber: m.number,
      at,
      action: change.action,
      fromPhase,
      toPhase,
    })),
  );
  await tx.update(batchOrders).set({ phase: toPhase, active: !acknowledging }).where(retained);
  if (acknowledging)
    await tx.update(batches).set({ returnAcknowledgedAt: at }).where(eq(batches.id, batch.id));
}
