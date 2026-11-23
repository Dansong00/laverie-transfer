import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, ne, notExists, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { eligibleAt, type StoreId } from "../db/eligible-orders";
import { batchCounters, batches, batchOrders, centsOrders, handoffs, operations } from "../db/schema";
import { getProfile, hasValidSessionToken } from "../staff/session";
import { BatchError, parseBatchCommand, type BatchChange } from "./commands";

import { reversePhase, type CorrectionRecord } from "./corrections";
import { advanceAtStore, isStoreAction } from "./processing";
import { changeContents, type Confirmation } from "./contents";

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];
type Result = {
  batchId: string;
  version: number;
  cancelled: boolean;
  sent?: true;
  board?: true;
  contents?: true;
  confirmation?: Confirmation;
  correction?: CorrectionRecord;
};
type Outcome =
  | { ok: true; result: Result }
  | {
      ok: false;
      status: number;
      error: BatchError["code"] | "BATCH_LEGACY_ERROR";
      message: string;
      values?: BatchError["values"];
    };
type LegacyFailure = { ok: false; status: number; error: string };

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
        eq(batches.contentsChanged, false),
        isNull(batches.contentsConfirmedAt),
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
  if (missing.length) throw new BatchError(409, "BATCH_ORDERS_INELIGIBLE", { orders: missing.join(", ") });
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
    if (!removed.length) throw new BatchError(409, "BATCH_ORDER_NOT_IN_BATCH", { orderNumber });
  }
  await addOrders(tx, change.batchId, change.origin, change.add, op);
}

async function deleteBatch(tx: Tx, batchId: string, op: string, now: Date) {
  await tx
    .update(batchOrders)
    .set({ active: false, removedByOp: op, removedAt: now })
    .where(retained(batchId));
}

// The caller holds the batch lock and has checked its expected version.
async function runAction(
  tx: Tx,
  change: Extract<BatchChange, { action: "send" }>,
  operationId: string,
  staffId: string,
  at: Date,
) {
  const members = await tx
    .select({
      orderNumber: batchOrders.orderNumber,
      phase: batchOrders.phase,
      active: batchOrders.active,
      open: sql<boolean>`cents_status_allows_transfer(${centsOrders.status})`,
    })
    .from(batchOrders)
    .innerJoin(
      centsOrders,
      and(eq(batchOrders.storeId, centsOrders.storeId), eq(batchOrders.orderNumber, centsOrders.orderNumber)),
    )
    .where(retained(change.batchId))
    .orderBy(asc(batchOrders.orderNumber))
    .for("update");
  if (!members.length) throw new BatchError(409, "BATCH_EMPTY_SEND");
  const invalid = members.filter((m) => !m.active || m.phase !== "planned" || !m.open);
  if (invalid.length)
    throw new BatchError(409, "BATCH_ORDERS_CANNOT_SEND", {
      orders: invalid.map((m) => m.orderNumber).join(", "),
    });
  await tx.insert(handoffs).values(
    members.map(({ orderNumber }) => ({
      operationId,
      staffId,
      at,
      batchId: change.batchId,
      storeId: change.origin,
      orderNumber,
      action: change.action,
      fromPhase: "planned",
      toPhase: "sent",
    })),
  );
  await tx.update(batchOrders).set({ phase: "sent" }).where(retained(change.batchId));
}

function isSend(change: BatchChange): change is Extract<BatchChange, { action: "send" }> {
  return change.kind === "runAction" && change.action === "send";
}

async function apply(tx: Tx, change: BatchChange, op: string, staffId: string): Promise<Result> {
  if (change.kind === "createBatch") return createBatch(tx, change, op, staffId);
  const [batch] = await tx
    .select()
    .from(batches)
    .where(and(eq(batches.id, change.batchId), eq(batches.origin, change.origin)))
    .for("update");
  if (!batch) throw new BatchError(404, "BATCH_NOT_FOUND");
  if (batch.version !== change.expectedVersion) throw new BatchError(409, "BATCH_VERSION_CONFLICT");
  if (batch.cancelledAt) throw new BatchError(409, "BATCH_CANCELLED");
  const cancelled = change.kind === "deleteBatch";
  const now = new Date();
  let correction: CorrectionRecord | undefined;
  let confirmation: Confirmation | undefined;
  const sent = isSend(change);
  const planning = change.kind === "updateBatch" || change.kind === "deleteBatch";
  const board = isStoreAction(change);
  if (change.kind === "stepBackOrder" || change.kind === "correctTravelPhase") {
    correction = await reversePhase(tx, batch, change, op, staffId, now);
  } else if (board) {
    await advanceAtStore(tx, batch, change, op, staffId, now);
  } else if (sent) {
    await runAction(tx, change, op, staffId, now);
  } else if (planning) {
    const travelling = await tx
      .select({ id: batchOrders.id })
      .from(batchOrders)
      .where(and(retained(batch.id), ne(batchOrders.phase, "planned")))
      .limit(1);
    if (travelling.length || batch.contentsChanged || batch.contentsConfirmedAt)
      throw new BatchError(409, "BATCH_UNSENT_REQUIRED");
    if (cancelled) await deleteBatch(tx, batch.id, op, now);
    else await updateBatch(tx, change, op);
  } else {
    confirmation = await changeContents(tx, batch, change, op, staffId, now);
  }
  const version = batch.version + 1;
  await tx
    .update(batches)
    .set({ version, cancelledAt: cancelled ? now : null })
    .where(eq(batches.id, batch.id));
  return {
    batchId: batch.id,
    version,
    cancelled,
    ...((board || correction) && { board: true as const }),
    ...(correction && { correction }),
    ...(!correction && !board && !planning && !sent && { contents: true as const, confirmation }),
    ...(sent && { sent: true as const }),
  };
}

type Saved = Outcome & { replayed: boolean };

export function saveBatch(token: string | undefined, input: unknown): Promise<Saved>;
export function saveBatch(
  token: string | undefined,
  input: unknown,
  checkOnly: boolean,
): Promise<Saved | null>;
export async function saveBatch(token: string | undefined, input: unknown, checkOnly = false) {
  if (!hasValidSessionToken(token)) throw new BatchError(401, "BATCH_SIGN_IN_REQUIRED");
  return getDb().transaction(async (tx) => {
    const actor = await getProfile(token, tx);
    if (!actor) throw new BatchError(401, "BATCH_SIGN_IN_REQUIRED");
    const { operationId, change } = parseBatchCommand(input);
    const kind = change.kind === "runAction" ? change.action : change.kind;
    const requestHash = createHash("sha256").update(JSON.stringify(change)).digest("hex");

    const staffId = actor.staffId;
    async function replay(): Promise<Saved | null> {
      const [previous] = await tx.select().from(operations).where(eq(operations.operationId, operationId));
      if (!previous) return null;
      if (previous.staffId !== staffId || previous.kind !== kind || previous.requestHash !== requestHash)
        throw new BatchError(409, "BATCH_OPERATION_CONFLICT");
      const outcome = previous.result as Outcome | LegacyFailure;
      if (!outcome.ok && !("message" in outcome)) {
        return { ...outcome, error: "BATCH_LEGACY_ERROR", message: outcome.error, replayed: true };
      }
      return { ...outcome, replayed: true };
    }
    const previous = await replay();
    if (previous || checkOnly) return previous;
    const allowed = actor.role === "staff" || actor.role === "admin";
    const saved = await tx
      .insert(operations)
      .values({
        operationId,
        kind,
        staffId: actor.staffId,
        requestHash,
        batchId: change.kind === "createBatch" ? null : change.batchId,
        result: {},
        createdAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: operations.operationId });
    if (!saved.length) return replay();
    let outcome: Outcome;
    try {
      if (
        (change.kind === "correctSentMembership" || change.kind === "correctTravelPhase") &&
        actor.role !== "admin"
      )
        throw new BatchError(403, "BATCH_ADMIN_REQUIRED");
      if (!allowed) throw new BatchError(403, "BATCH_STAFF_REQUIRED");
      const result = await tx.transaction((inner) => apply(inner, change, operationId, actor.staffId));
      outcome = { ok: true, result };
    } catch (error) {
      if (!(error instanceof BatchError)) throw error;
      outcome = { ok: false, status: error.status, ...error.payload() };
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
