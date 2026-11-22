import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { getDb } from "../db/client";
import { batchOrders, batches, handoffs, operations } from "../db/schema";
import { BatchError, type StoreAction, type BatchChange } from "./commands";

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];
const transitions = {
  receive: ["sent", "received"],
  startProcessing: ["received", "processing"],
  markReady: ["processing", "ready_for_return"],
} as const;
export function isStoreAction(change: BatchChange): change is StoreAction {
  return (
    change.kind === "runAction" &&
    (change.action === "receive" || change.action === "startProcessing" || change.action === "markReady")
  );
}

// A fully corrected batch has no retained order on which to record a receipt handoff.
export function receiptRecorded(batchId: string | typeof batches.id) {
  return sql<boolean>`exists (select 1 from ${operations} where ${operations.batchId} = ${batchId} and ${operations.kind}='receive' and ${operations.result}->>'ok'='true')`;
}

export async function advanceAtStore(
  tx: Tx,
  batch: typeof batches.$inferSelect,
  change: StoreAction,
  operationId: string,
  staffId: string,
  at: Date,
) {
  if (change.store !== batch.destination) throw new BatchError(403, "Select the receiving store.");
  const [fromPhase, toPhase] = transitions[change.action];
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
      throw new BatchError(409, "This batch is not awaiting receipt.");
    return;
  }
  const eligible = new Set(members.filter((m) => m.active && m.phase === fromPhase).map((m) => m.number));
  const invalid = (selected ?? members.map((m) => m.number)).filter((number) => !eligible.has(number));
  if (invalid.length)
    throw new BatchError(409, "Orders cannot move from " + fromPhase + ": " + invalid.join(", "));
  await tx
    .update(batchOrders)
    .set({ phase: toPhase })
    .where(
      inArray(
        batchOrders.id,
        members.map((m) => m.id),
      ),
    );
  await tx
    .insert(handoffs)
    .values(
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
