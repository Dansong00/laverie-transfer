import { and, asc, count, desc, eq, isNull, or, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import type { StoreId } from "../db/eligible-orders";
import { batches, batchOrders, boardSections, centsOrders, handoffs, operations, staff } from "../db/schema";

import { correctionReason, listEmptyCorrections } from "./corrections";
import { receiptRecorded, travelPhase } from "./processing";

export type Section = (typeof boardSections)[number];
export const sectionNames: Record<Section, string> = {
  planned: "Planned",
  arriving: "Arriving",
  received: "Received",
  processing: "Processing",
  ready_for_return: "Ready for return",
  returning: "Returning",
  recently_returned: "Recently returned",
};

type Batch = typeof batches.$inferSelect;
type Counts = Record<string, number>;
const phasesInOrder = [
  "planned",
  "sent",
  "received",
  "processing",
  "ready_for_return",
  "return_sent",
  "returned",
] as const;

function summarize(batch: Batch, phaseCounts: Counts, received: boolean) {
  const total = Object.values(phaseCounts).reduce((a, b) => a + b, 0);
  const ready = phaseCounts.ready_for_return ?? 0;
  let section: Section | null;
  if (batch.cancelledAt) section = null;
  else if (!total)
    section = batch.contentsChanged
      ? received
        ? "received"
        : "arriving"
      : batch.contentsConfirmedAt
        ? null
        : "planned";
  else if (phaseCounts.planned) section = "planned";
  else if (phaseCounts.sent) section = "arriving";
  else if (ready === total) section = "ready_for_return";
  else if (phaseCounts.processing) section = "processing";
  else if (phaseCounts.received) section = "received";
  else if (phaseCounts.return_sent) section = "returning";
  else if (phaseCounts.returned) section = "recently_returned";
  else section = null;
  const derivedPhase =
    phasesInOrder.find((phase) => phaseCounts[phase] > 0) ?? (section === "planned" ? "planned" : null);
  return {
    derivedPhase,
    id: batch.id,
    origin: batch.origin,
    destination: batch.destination,
    version: batch.version,
    contentsChanged: batch.contentsChanged,
    section,
    phaseCounts,
    total,
    ready,
  };
}
export type BoardCard = ReturnType<typeof summarize>;

const recentlyReturnedDays = 7;

export async function listBatchesForStore(store: StoreId) {
  const rows = await getDb()
    .select({
      batch: batches,
      received: receiptRecorded(batches.id),
      phase: batchOrders.phase,
      members: count(batchOrders.id),
    })
    .from(batches)
    .leftJoin(batchOrders, and(eq(batchOrders.batchId, batches.id), isNull(batchOrders.removedAt)))
    .where(
      and(
        isNull(batches.cancelledAt),
        or(eq(batches.origin, store), eq(batches.destination, store)),
        or(
          isNull(batches.returnAcknowledgedAt),
          sql`${batches.returnAcknowledgedAt} >= now() - ${recentlyReturnedDays} * interval '1 day'`,
        ),
      ),
    )
    .groupBy(batches.id, batchOrders.phase)
    .orderBy(desc(batches.returnAcknowledgedAt), desc(batches.createdAt), asc(batches.id));
  const counts = new Map<string, { batch: Batch; received: boolean; phases: Counts }>();
  for (const { batch, received, phase, members } of rows) {
    const item = counts.get(batch.id) ?? { batch, received, phases: {} };
    if (phase) item.phases[phase] = members;
    counts.set(batch.id, item);
  }
  const cards: BoardCard[] = [];
  for (const { batch, received, phases } of counts.values()) {
    const card = summarize(batch, phases, received);
    if (!card.section) continue;
    if (card.section === "planned" && card.origin !== store) continue;
    if (
      card.section !== "planned" &&
      card.section !== "recently_returned" &&
      card.section !== "returning" &&
      card.destination !== store
    )
      continue;
    cards.push(card);
  }
  return cards;
}

export async function getBatch(batchId: string) {
  return getDb().transaction(
    async (tx) => {
      const [row] = await tx
        .select({ batch: batches, travel: travelPhase(batches.id) })
        .from(batches)
        .where(eq(batches.id, batchId));
      if (!row) return null;
      const { batch, travel } = row;
      const orders = await tx
        .select({ membership: batchOrders, order: centsOrders })
        .from(batchOrders)
        .innerJoin(
          centsOrders,
          and(
            eq(batchOrders.storeId, centsOrders.storeId),
            eq(batchOrders.orderNumber, centsOrders.orderNumber),
          ),
        )
        .where(and(eq(batchOrders.batchId, batchId), isNull(batchOrders.removedAt)))
        .orderBy(asc(batchOrders.orderNumber));
      const history = await tx
        .select({
          handoff: handoffs,
          staffName: staff.name,
          reason: correctionReason,
        })
        .from(handoffs)
        .innerJoin(operations, eq(operations.operationId, handoffs.operationId))
        .innerJoin(staff, eq(staff.id, handoffs.staffId))
        .where(eq(handoffs.batchId, batchId))
        .orderBy(asc(handoffs.at), asc(handoffs.orderNumber), asc(handoffs.id));
      const emptyCorrections = await listEmptyCorrections(tx, batchId);
      const phases: Counts = {};
      for (const { membership } of orders) phases[membership.phase] = (phases[membership.phase] ?? 0) + 1;
      return {
        batch,
        orders,
        history,
        emptyCorrections,
        travel,
        ...summarize(batch, phases, travel === "received"),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
