import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, ne, notExists, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { eligibleAt, type StoreId } from "../db/eligible-orders";
import { batchCounters, batches, batchOrders, centsOrders, operations } from "../db/schema";
import { getProfile, hasValidSessionToken } from "../staff/session";
import { BatchError, parseBatchCommand, type BatchChange } from "./commands";

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];
type Result = { batchId: string; version: number; cancelled: boolean };
type Outcome = { ok: true; result: Result } | { ok: false; status: number; error: string };

const retained = (batchId: string) => and(eq(batchOrders.batchId, batchId), isNull(batchOrders.removedAt));

export async function plannedBatches(origin: StoreId) {
  const db = getDb();
  return db
    .select({ id: batches.id, version: batches.version })
    .from(batches)
    .where(
      and(
        eq(batches.origin, origin),
        isNull(batches.cancelledAt),
        notExists(
          db
            .select({ id: batchOrders.id })
            .from(batchOrders)
            .where(
              and(
                eq(batchOrders.batchId, batches.id),
                isNull(batchOrders.removedAt),
                ne(batchOrders.phase, "planned"),
              ),
            ),
        ),
      ),
    )
    .orderBy(desc(batches.createdAt), asc(batches.id));
}

export async function plannedMembers(batchId: string) {
  return getDb()
    .select({ orderNumber: batchOrders.orderNumber })
    .from(batchOrders)
    .where(retained(batchId))
    .orderBy(asc(batchOrders.orderNumber));
}

async function addOrders(tx: Tx, id: string, origin: StoreId, numbers: string[], operationId: string) {
  if (!numbers.length) return;
  const requested = inArray(centsOrders.orderNumber, numbers);
  // Lock in a consistent order, then read eligibility in a fresh statement after any wait.
  await tx
    .select({ number: centsOrders.orderNumber })
    .from(centsOrders)
    .where(and(eq(centsOrders.storeId, origin), requested))
    .orderBy(asc(centsOrders.orderNumber))
    .for("update");
  const rows = await tx
    .select({ number: centsOrders.orderNumber })
    .from(centsOrders)
    .where(and(eligibleAt(origin, tx), requested));
  const available = new Set(rows.map((row) => row.number));
  const missing = numbers.filter((number) => !available.has(number));
  if (missing.length) throw new BatchError(409, "Orders no longer eligible: " + missing.join(", "));
  await tx.insert(batchOrders).values(
    numbers.map((orderNumber) => ({
      batchId: id,
      originStoreId: origin,
      storeId: origin,
      orderNumber,
      phase: "planned",
      active: true,
      addedAt: new Date(),
      addedByOp: operationId,
    })),
  );
}

async function createBatch(
  tx: Tx,
  change: Extract<BatchChange, { kind: "createBatch" }>,
  op: string,
  staffId: string,
) {
  const { origin } = change;
  const [counter] = await tx
    .insert(batchCounters)
    .values({ origin, lastNumber: 1 })
    .onConflictDoUpdate({
      target: batchCounters.origin,
      set: { lastNumber: sql`${batchCounters.lastNumber} + 1` },
    })
    .returning({ number: batchCounters.lastNumber });
  const batchId = (origin === "soho" ? "SOHO" : "EV") + "-B" + String(counter.number).padStart(3, "0");
  await tx.insert(batches).values({
    id: batchId,
    origin,
    destination: origin === "soho" ? "east_village" : "soho",
    createdBy: staffId,
    createdAt: new Date(),
  });
  await addOrders(tx, batchId, origin, change.add, op);
  return { batchId, version: 1, cancelled: false };
}

async function updateBatch(tx: Tx, change: Extract<BatchChange, { kind: "updateBatch" }>, op: string) {
  for (const { orderNumber, note } of change.remove) {
    const removed = await tx
      .update(batchOrders)
      .set({
        active: false,
        removedAt: new Date(),
        removedByOp: op,
        removalNote: note,
      })
      .where(and(retained(change.batchId), eq(batchOrders.orderNumber, orderNumber)))
      .returning({ id: batchOrders.id });
    if (!removed.length) throw new BatchError(409, "Order is no longer in this batch: " + orderNumber);
  }
  await addOrders(tx, change.batchId, change.origin, change.add, op);
}

async function deleteBatch(tx: Tx, batchId: string, op: string, now: Date) {
  await tx
    .update(batchOrders)
    .set({ active: false, removedByOp: op, removedAt: now })
    .where(retained(batchId));
}

async function apply(tx: Tx, change: BatchChange, op: string, staffId: string): Promise<Result> {
  if (change.kind === "createBatch") return createBatch(tx, change, op, staffId);
  const [batch] = await tx
    .select()
    .from(batches)
    .where(and(eq(batches.id, change.batchId), eq(batches.origin, change.origin)))
    .for("update");
  if (!batch) throw new BatchError(404, "Batch not found.");
  if (batch.version !== change.expectedVersion) throw new BatchError(409, "This batch changed, refresh.");
  if (batch.cancelledAt) throw new BatchError(409, "This batch was cancelled.");
  const travelling = await tx
    .select({ id: batchOrders.id })
    .from(batchOrders)
    .where(and(retained(batch.id), ne(batchOrders.phase, "planned")))
    .limit(1);
  if (travelling.length) throw new BatchError(409, "Only unsent batches can be changed.");
  const cancelled = change.kind === "deleteBatch";
  const now = new Date();
  if (cancelled) await deleteBatch(tx, batch.id, op, now);
  else await updateBatch(tx, change, op);
  const version = batch.version + 1;
  await tx
    .update(batches)
    .set({ version, cancelledAt: cancelled ? now : null })
    .where(eq(batches.id, batch.id));
  return { batchId: batch.id, version, cancelled };
}

export async function saveBatch(token: string | undefined, input: unknown) {
  if (!hasValidSessionToken(token)) throw new BatchError(401, "Sign in required.");
  const { operationId, change } = parseBatchCommand(input);
  const requestHash = createHash("sha256").update(JSON.stringify(change)).digest("hex");
  return getDb().transaction(async (tx) => {
    const actor = await getProfile(token, tx);
    if (!actor) throw new BatchError(401, "Sign in required.");
    const saved = await tx
      .insert(operations)
      .values({
        operationId,
        kind: change.kind,
        staffId: actor.staffId,
        requestHash,
        batchId: change.kind === "createBatch" ? null : change.batchId,
        result: {},
        createdAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: operations.operationId });
    if (!saved.length) {
      const [previous] = await tx.select().from(operations).where(eq(operations.operationId, operationId));
      if (
        previous.staffId !== actor.staffId ||
        previous.kind !== change.kind ||
        previous.requestHash !== requestHash
      )
        throw new BatchError(409, "This operation ID is already in use.");
      return { ...(previous.result as Outcome), replayed: true };
    }
    let outcome: Outcome;
    try {
      const result = await tx.transaction((inner) => apply(inner, change, operationId, actor.staffId));
      outcome = { ok: true, result };
    } catch (error) {
      if (!(error instanceof BatchError)) throw error;
      outcome = { ok: false, status: error.status, error: error.message };
    }
    await tx
      .update(operations)
      .set({
        result: outcome,
        ...(outcome.ok && { batchId: outcome.result.batchId }),
      })
      .where(eq(operations.operationId, operationId));
    return { ...outcome, replayed: false };
  });
}
