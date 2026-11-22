import { and, asc, desc, eq, exists, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import type { StoreId } from "../db/eligible-orders";
import { batches, batchOrders, handoffs, operations, staff } from "../db/schema";
import { BatchError, type BatchChange, type OrderKey } from "./commands";

import { receiptRecorded } from "./processing";

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];
type Batch = typeof batches.$inferSelect;
type ContentsChange = Extract<
  BatchChange,
  { kind: "correctSentMembership" | "confirmContents" } | { action: "sendReturn" }
>;
export type Confirmation = { staffId: string; at: string; orderKeys: OrderKey[] };

export async function sentBatchesAt(store: StoreId) {
  const db = getDb();
  return db
    .select({
      id: batches.id,
      origin: batches.origin,
      version: batches.version,
      changed: batches.contentsChanged,
      received: receiptRecorded(batches.id),
      confirmedEmpty: sql<boolean>`${batches.contentsConfirmedAt} is not null and ${batches.contentsConfirmedOrderKeys} = '[]'::jsonb`,
    })
    .from(batches)
    .where(
      and(
        eq(batches.destination, store),
        isNull(batches.cancelledAt),
        exists(
          db
            .select({ id: handoffs.id })
            .from(handoffs)
            .where(and(eq(handoffs.batchId, batches.id), eq(handoffs.action, "send"))),
        ),
      ),
    )
    .orderBy(desc(batches.createdAt), asc(batches.id));
}

export async function contentsHistory(batchId: string) {
  const db = getDb();
  const [members, confirmations, custody] = await Promise.all([
    db
      .select({
        number: batchOrders.orderNumber,
        phase: batchOrders.phase,
        active: batchOrders.active,
        removedAt: batchOrders.removedAt,
        removalKind: operations.kind,
        reason: batchOrders.removalNote,
        removedBy: staff.name,
      })
      .from(batchOrders)
      .leftJoin(operations, eq(operations.operationId, batchOrders.removedByOp))
      .leftJoin(staff, eq(staff.id, operations.staffId))
      .where(eq(batchOrders.batchId, batchId))
      .orderBy(asc(batchOrders.orderNumber), asc(batchOrders.addedAt)),
    db
      .select({ name: staff.name, result: operations.result })
      .from(operations)
      .innerJoin(staff, eq(staff.id, operations.staffId))
      .where(and(eq(operations.batchId, batchId), eq(operations.kind, "confirmContents")))
      .orderBy(asc(operations.createdAt)),
    db
      .select({
        id: handoffs.id,
        number: handoffs.orderNumber,
        action: handoffs.action,
        at: handoffs.at,
        name: staff.name,
        corrects: handoffs.corrects,
      })
      .from(handoffs)
      .innerJoin(staff, eq(staff.id, handoffs.staffId))
      .where(eq(handoffs.batchId, batchId))
      .orderBy(asc(handoffs.at), asc(handoffs.orderNumber)),
  ]);
  return {
    members,
    custody,
    confirmations: confirmations.flatMap((row) => {
      const record = row.result as { ok: boolean; result?: { confirmation?: Confirmation } };
      return record.ok && record.result?.confirmation
        ? [{ ...record.result.confirmation, name: row.name }]
        : [];
    }),
  };
}

const tripPhases = ["sent", "received", "processing", "ready_for_return"];

// The caller holds the batch row lock, serializing these checks with every versioned batch write.
export async function changeContents(
  tx: Tx,
  batch: Batch,
  change: ContentsChange,
  operationId: string,
  staffId: string,
  at: Date,
) {
  const members = await tx
    .select()
    .from(batchOrders)
    .where(and(eq(batchOrders.batchId, batch.id), isNull(batchOrders.removedAt)))
    .orderBy(asc(batchOrders.orderNumber))
    .for("update");
  if (members.some((m) => !m.active || !tripPhases.includes(m.phase)))
    throw new BatchError(409, "This action requires an outbound batch.");
  if (change.kind === "correctSentMembership") {
    for (const { orderKey, reason } of change.remove) {
      const member = members.find((m) => m.orderNumber === orderKey.orderNumber);
      if (!member) throw new BatchError(409, "Order is no longer in this batch: " + orderKey.orderNumber);
      const [departure] = await tx
        .select({ id: handoffs.id })
        .from(handoffs)
        .where(
          and(
            eq(handoffs.batchId, batch.id),
            eq(handoffs.storeId, orderKey.storeId),
            eq(handoffs.orderNumber, member.orderNumber),
            eq(handoffs.action, "send"),
          ),
        )
        .orderBy(desc(handoffs.at))
        .limit(1);
      if (!departure) throw new BatchError(409, "No departure recorded for order " + member.orderNumber);
      await tx
        .update(batchOrders)
        .set({ active: false, removedAt: at, removedByOp: operationId, removalNote: reason })
        .where(eq(batchOrders.id, member.id));
      await tx
        .insert(handoffs)
        .values({
          operationId,
          batchId: batch.id,
          ...orderKey,
          action: "correctSentMembership",
          fromPhase: member.phase,
          toPhase: "did_not_travel",
          staffId,
          at,
          corrects: departure.id,
        });
    }
    await tx
      .update(batches)
      .set({
        contentsChanged: true,
        contentsConfirmedAt: null,
        contentsConfirmedBy: null,
        contentsConfirmedOrderKeys: null,
      })
      .where(eq(batches.id, batch.id));
    return;
  }
  if (change.store !== batch.destination) throw new BatchError(403, "Select the store holding this batch.");
  const orderKeys = members.map((m) => ({ storeId: change.origin, orderNumber: m.orderNumber }));
  if (change.kind === "confirmContents") {
    const [receipt] = await tx
      .select({ received: receiptRecorded(batch.id) })
      .from(batches)
      .where(eq(batches.id, batch.id));
    if (!receipt.received || members.some((m) => m.phase === "sent"))
      throw new BatchError(409, "Receive the batch before confirming its contents.");
    if (!batch.contentsChanged) throw new BatchError(409, "There are no changed contents to confirm.");
    await tx
      .update(batches)
      .set({
        contentsChanged: false,
        contentsConfirmedAt: at,
        contentsConfirmedBy: staffId,
        contentsConfirmedOrderKeys: orderKeys,
      })
      .where(eq(batches.id, batch.id));
    return { staffId, at: at.toISOString(), orderKeys };
  }
  if (batch.contentsChanged) throw new BatchError(409, "Contents changed, confirm before return.");
  if (!members.length || members.some((m) => m.phase !== "ready_for_return"))
    throw new BatchError(409, "All remaining orders must be ready for return.");
  await tx
    .insert(handoffs)
    .values(
      orderKeys.map((key) => ({
        operationId,
        batchId: batch.id,
        ...key,
        action: "sendReturn",
        fromPhase: "ready_for_return",
        toPhase: "return_sent",
        staffId,
        at,
      })),
    );
  await tx
    .update(batchOrders)
    .set({ phase: "return_sent" })
    .where(and(eq(batchOrders.batchId, batch.id), isNull(batchOrders.removedAt)));
}
