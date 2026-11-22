import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { getDb } from "../db/client";
import { batches, batchOrders, handoffs, operations, staff } from "../db/schema";
import { BatchError, type PhaseCorrection } from "./commands";
import { travelPhase } from "./processing";

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];
export type CorrectionRecord = { fromPhase: string; toPhase: string; reason: string; orderCount: number };

export const correctionReason = sql<string | null>`${operations.result} #>> '{result,correction,reason}'`;

// The batch lock and expected version are checked before any correction runs.
export async function reversePhase(
  tx: Tx,
  batch: typeof batches.$inferSelect,
  change: PhaseCorrection,
  operationId: string,
  staffId: string,
  at: Date,
): Promise<CorrectionRecord> {
  const single = change.kind === "stepBackOrder";
  if (single && change.store !== batch.destination) throw new BatchError(403, "Select the receiving store.");
  const members = await tx
    .select()
    .from(batchOrders)
    .where(
      and(
        eq(batchOrders.batchId, batch.id),
        isNull(batchOrders.removedAt),
        single ? eq(batchOrders.orderNumber, change.orderKey.orderNumber) : undefined,
      ),
    )
    .for("update");

  let fromPhase = members[0]?.phase;
  if (!members.length) {
    if (single) throw new BatchError(409, "This order is no longer in the batch.");
    const [row] = await tx
      .select({ phase: travelPhase(batch.id) })
      .from(batches)
      .where(eq(batches.id, batch.id));
    fromPhase = row.phase;
  }
  if (members.some((m) => !m.active || m.phase !== fromPhase))
    throw new BatchError(409, "All remaining orders must be active and in the same travel phase.");

  let toPhase: string;
  if (single && fromPhase === "ready_for_return") toPhase = "processing";
  else if (single && fromPhase === "processing") toPhase = "received";
  else if (!single && fromPhase === "received") toPhase = "sent";
  else if (!single && fromPhase === "sent") toPhase = "planned";
  else
    throw new BatchError(
      409,
      single
        ? "Only processing or ready orders can step back."
        : "Only sent or received batches can step back.",
    );

  if (members.length) {
    // Link each reversal to the latest forward move across the same two phases.
    const originals = await tx
      .selectDistinctOn([handoffs.orderNumber], { number: handoffs.orderNumber, id: handoffs.id })
      .from(handoffs)
      .innerJoin(operations, eq(operations.operationId, handoffs.operationId))
      .where(
        and(
          eq(handoffs.batchId, batch.id),
          eq(handoffs.fromPhase, toPhase),
          eq(handoffs.toPhase, fromPhase),
          inArray(
            handoffs.orderNumber,
            members.map((m) => m.orderNumber),
          ),
        ),
      )
      .orderBy(asc(handoffs.orderNumber), desc(sql`(${operations.result} #>> '{result,version}')::integer`));
    if (originals.length !== members.length)
      throw new BatchError(409, "The original handoff could not be found.");
    await tx.insert(handoffs).values(
      originals.map((original) => ({
        batchId: batch.id,
        storeId: change.origin,
        orderNumber: original.number,
        staffId,
        operationId,
        at,
        action: change.kind,
        fromPhase,
        toPhase,
        corrects: original.id,
      })),
    );
    await tx
      .update(batchOrders)
      .set({ phase: toPhase })
      .where(
        inArray(
          batchOrders.id,
          members.map((m) => m.id),
        ),
      );
  }
  if (!single) {
    // A receipt confirmation belongs to the trip on which staff checked the contents.
    const needsConfirmation =
      toPhase === "sent" && (batch.contentsChanged || batch.contentsConfirmedAt !== null);
    await tx
      .update(batches)
      .set({
        contentsChanged: needsConfirmation,
        contentsConfirmedAt: null,
        contentsConfirmedOrderKeys: null,
        contentsConfirmedBy: null,
      })
      .where(eq(batches.id, batch.id));
  }
  return { fromPhase, toPhase, reason: change.reason, orderCount: members.length };
}

export function listEmptyCorrections(db: Pick<Tx, "select">, batchId: string) {
  // Empty batches have no order handoffs. Keep their corrections visible too.
  return db
    .select({
      operationId: operations.operationId,
      at: operations.createdAt,
      staffName: staff.name,
      reason: correctionReason,
      fromPhase: sql<string>`${operations.result} #>> '{result,correction,fromPhase}'`,
      toPhase: sql<string>`${operations.result} #>> '{result,correction,toPhase}'`,
    })
    .from(operations)
    .innerJoin(staff, eq(staff.id, operations.staffId))
    .where(
      and(
        eq(operations.batchId, batchId),
        eq(operations.kind, "correctTravelPhase"),
        sql`${operations.result} #>> '{result,correction,orderCount}' = '0'`,
      ),
    )
    .orderBy(asc(operations.createdAt));
}
