import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import type { StoreId } from "../db/eligible-orders";
import { batches, batchOrders, handoffs, operations, staff } from "../db/schema";
import { BatchError, type BatchChange, type OrderKey } from "./commands";

import { correctionReason, listEmptyCorrections } from "./corrections";
import { receiptRecorded, travelPhase } from "./processing";

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];
type Batch = typeof batches.$inferSelect;
type ContentsChange = Extract<BatchChange, { kind: "correctSentMembership" | "confirmContents" }>;
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
        sql`not exists (select 1 from ${batchOrders}
          where ${batchOrders.batchId} = ${batches.id} and ${batchOrders.removedAt} is null
            and ${batchOrders.phase} in ('return_sent', 'returned'))`,
        eq(batches.destination, store),
        isNull(batches.cancelledAt),
        sql`${travelPhase(batches.id)} <> 'planned'`,
      ),
    )
    .orderBy(desc(batches.createdAt), asc(batches.id));
}

export async function contentsHistory(batchId: string) {
  const db = getDb();
  const [members, confirmations, custody, emptyCorrections] = await Promise.all([
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
        reason: correctionReason,
        toPhase: handoffs.toPhase,
      })
      .from(handoffs)
      .innerJoin(operations, eq(operations.operationId, handoffs.operationId))
      .innerJoin(staff, eq(staff.id, handoffs.staffId))
      .where(eq(handoffs.batchId, batchId))
      .orderBy(asc(handoffs.at), asc(handoffs.orderNumber)),
    listEmptyCorrections(db, batchId),
  ]);
  return {
    members,
    custody,
    emptyCorrections,
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
    throw new BatchError(409, "BATCH_OUTBOUND_REQUIRED");
  if (change.kind === "correctSentMembership") {
    for (const { orderKey, reason } of change.remove) {
      const member = members.find((m) => m.orderNumber === orderKey.orderNumber);
      if (!member) throw new BatchError(409, "BATCH_ORDER_NOT_IN_BATCH", { orderNumber: orderKey.orderNumber });
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
      if (!departure) throw new BatchError(409, "BATCH_DEPARTURE_NOT_FOUND", { orderNumber: member.orderNumber });
      await tx
        .update(batchOrders)
        .set({ active: false, removedAt: at, removedByOp: operationId, removalNote: reason })
        .where(eq(batchOrders.id, member.id));
      await tx.insert(handoffs).values({
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
  if (change.store !== batch.destination) throw new BatchError(403, "BATCH_WRONG_HOLDING_STORE");
  const orderKeys = members.map((m) => ({ storeId: change.origin, orderNumber: m.orderNumber }));
  const [receipt] = await tx
    .select({ received: receiptRecorded(batch.id) })
    .from(batches)
    .where(eq(batches.id, batch.id));
  if (!receipt.received || members.some((m) => m.phase === "sent"))
    throw new BatchError(409, "BATCH_RECEIPT_REQUIRED");
  if (!batch.contentsChanged) throw new BatchError(409, "BATCH_NO_CONTENTS_CHANGES");
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
