import { batchErrors, type BatchErrorCode } from "../i18n/batch-errors";
import { formatMessage } from "../i18n/format-message";
import type { StoreId } from "../db/eligible-orders";

type Existing = { batchId: string; expectedVersion: number };
type Removal = { orderNumber: string; note: string };
export type OrderKey = { storeId: StoreId; orderNumber: string };
type Correction = { orderKey: OrderKey; reason: string };
export type StoreAction = Existing & { kind: "runAction"; origin: StoreId; store: StoreId } & (
    | { action: "receive" }
    | { action: "sendReturn" }
    | { action: "acknowledgeReturn" }
    | { action: "startProcessing" | "markReady"; orderKeys: OrderKey[] }
  );
export const correctionReasonLimit = 1000;
export type PhaseCorrection = Existing & { origin: StoreId; reason: string } & (
    | { kind: "stepBackOrder"; store: StoreId; orderKey: OrderKey }
    | { kind: "correctTravelPhase" }
  );
export type BatchChange =
  | PhaseCorrection
  | StoreAction
  | { kind: "createBatch"; origin: StoreId; add: string[] }
  | ({ kind: "updateBatch"; origin: StoreId; add: string[]; remove: Removal[] } & Existing)
  | ({ kind: "runAction"; action: "send"; origin: StoreId } & Existing)
  | ({ kind: "confirmContents"; origin: StoreId; store: StoreId } & Existing)
  | ({ kind: "correctSentMembership"; origin: StoreId; remove: Correction[] } & Existing)
  | ({ kind: "deleteBatch"; origin: StoreId } & Existing);

export class BatchError extends Error {
  constructor(
    readonly status: number,
    readonly code: BatchErrorCode,
    readonly values?: Readonly<Record<string, string | number>>,
  ) {
    super(formatMessage(batchErrors[code].en, values));
  }

  payload() {
    return { error: this.code, message: this.message, ...(this.values && { values: this.values }) };
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ticket(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw new BatchError(400, "BATCH_INVALID_ORDER_NUMBER");
  return value;
}

function additions(value: unknown) {
  if (!Array.isArray(value)) throw new BatchError(400, "BATCH_SINGLE_STORE_REQUIRED");
  return value.map(ticket).sort();
}

function removals(value: unknown): Removal[] {
  if (!Array.isArray(value)) throw new BatchError(400, "BATCH_INVALID_REMOVALS");
  return value
    .map((item) => {
      if (!record(item) || typeof item.note !== "string" || !item.note.trim())
        throw new BatchError(400, "BATCH_REMOVAL_NOTE_REQUIRED");
      return { orderNumber: ticket(item.orderNumber), note: item.note.trim() };
    })
    .sort((a, b) => (a.orderNumber < b.orderNumber ? -1 : a.orderNumber > b.orderNumber ? 1 : 0));
}

export function parseBatchCommand(input: unknown): { operationId: string; change: BatchChange } {
  if (
    !record(input) ||
    typeof input.operationId !== "string" ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input.operationId)
  )
    throw new BatchError(400, "BATCH_INVALID_OPERATION_ID");
  const operationId = input.operationId.toLowerCase();
  const { origin, kind, batchId, expectedVersion } = input;
  if (origin !== "soho" && origin !== "east_village") throw new BatchError(400, "BATCH_STORE_REQUIRED");
  if (kind === "createBatch") {
    const add = additions(input.add);
    if (new Set(add).size !== add.length) throw new BatchError(400, "BATCH_DUPLICATE_ADDITION");
    return { operationId, change: { kind, origin, add } };
  }
  if (
    typeof batchId !== "string" ||
    !batchId ||
    typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1
  )
    throw new BatchError(400, "BATCH_INVALID_BATCH_OR_VERSION");
  if (kind === "stepBackOrder" || kind === "correctTravelPhase") {
    if (typeof input.reason !== "string" || !input.reason.trim())
      throw new BatchError(400, "BATCH_CORRECTION_REASON_REQUIRED");
    if (input.reason.trim().length > correctionReasonLimit)
      throw new BatchError(400, "BATCH_CORRECTION_REASON_TOO_LONG", { limit: correctionReasonLimit });
    if ("orderKeys" in input || "remove" in input || "add" in input)
      throw new BatchError(400, "BATCH_INVALID_CORRECTION_SELECTION");
    const common = { origin, batchId, expectedVersion, reason: input.reason.trim() } as const;
    if (kind === "correctTravelPhase") {
      if ("orderKey" in input) throw new BatchError(400, "BATCH_WHOLE_TRAVEL_CORRECTION_REQUIRED");
      return { operationId, change: { kind, ...common } };
    }
    const { store } = input;
    if (store !== "soho" && store !== "east_village") throw new BatchError(400, "BATCH_RECEIVING_STORE_REQUIRED");
    if (!record(input.orderKey) || input.orderKey.storeId !== origin)
      throw new BatchError(400, "BATCH_ORIGIN_ORDER_REQUIRED");
    const orderKey = { storeId: origin, orderNumber: ticket(input.orderKey.orderNumber) } as const;
    return { operationId, change: { kind, ...common, store, orderKey } };
  }
  if (kind === "correctSentMembership") {
    if ("add" in input || !Array.isArray(input.remove) || !input.remove.length)
      throw new BatchError(400, "BATCH_MISSING_ORDER_REQUIRED");
    const remove = input.remove
      .map((entry): Correction => {
        if (!record(entry) || !record(entry.orderKey) || entry.orderKey.storeId !== origin)
          throw new BatchError(400, "BATCH_ORIGIN_ORDERS_REQUIRED");
        if (typeof entry.reason !== "string" || !entry.reason.trim())
          throw new BatchError(400, "BATCH_MISSING_ORDER_REASON_REQUIRED");
        return {
          orderKey: { storeId: origin, orderNumber: ticket(entry.orderKey.orderNumber) },
          reason: entry.reason.trim(),
        };
      })
      .sort((a, b) =>
        a.orderKey.orderNumber < b.orderKey.orderNumber
          ? -1
          : a.orderKey.orderNumber > b.orderKey.orderNumber
            ? 1
            : 0,
      );
    if (new Set(remove.map((r) => r.orderKey.orderNumber)).size !== remove.length)
      throw new BatchError(400, "BATCH_DUPLICATE_ORDER");
    return { operationId, change: { kind, origin, batchId, expectedVersion, remove } };
  }
  if (
    kind === "runAction" &&
    (input.action === "receive" || input.action === "startProcessing" || input.action === "markReady")
  ) {
    const { action, store } = input;
    if (store !== "soho" && store !== "east_village")
      throw new BatchError(400, "BATCH_RECEIVING_STORE_REQUIRED");
    if ("add" in input || "remove" in input)
      throw new BatchError(400, "BATCH_MEMBERSHIP_CHANGE_FORBIDDEN");
    const common = { kind, origin, batchId, expectedVersion, store } as const;
    if (action === "receive") {
      if ("orderKeys" in input) throw new BatchError(400, "BATCH_WHOLE_RECEIPT_REQUIRED");
      return { operationId, change: { ...common, action } };
    }
    if (!Array.isArray(input.orderKeys) || !input.orderKeys.length)
      throw new BatchError(400, "BATCH_ORDER_SELECTION_REQUIRED");
    const numbers = input.orderKeys
      .map((key) => {
        if (!record(key) || key.storeId !== origin)
          throw new BatchError(400, "BATCH_ORIGIN_ORDERS_REQUIRED");
        return ticket(key.orderNumber);
      })
      .sort();
    if (new Set(numbers).size !== numbers.length) throw new BatchError(400, "BATCH_DUPLICATE_ORDER");
    return {
      operationId,
      change: {
        ...common,
        action,
        orderKeys: numbers.map((orderNumber) => ({ storeId: origin, orderNumber })),
      },
    };
  }
  if (
    kind === "confirmContents" ||
    (kind === "runAction" && (input.action === "sendReturn" || input.action === "acknowledgeReturn"))
  ) {
    const store = input.store;
    if (store !== "soho" && store !== "east_village")
      throw new BatchError(400, "BATCH_HOLDING_STORE_REQUIRED");
    if ("orderKeys" in input || "remove" in input || "add" in input)
      throw new BatchError(400, "BATCH_WHOLE_ACTION_REQUIRED");
    return kind === "confirmContents"
      ? { operationId, change: { kind, origin, batchId, expectedVersion, store } }
      : {
          operationId,
          change: {
            kind,
            action: input.action === "sendReturn" ? "sendReturn" : "acknowledgeReturn",
            origin,
            batchId,
            expectedVersion,
            store,
          },
        };
  }
  if (kind === "runAction") {
    if (input.action !== "send") throw new BatchError(400, "BATCH_UNKNOWN_TRANSFER_ACTION");
    if ("orderKeys" in input || "add" in input || "remove" in input)
      throw new BatchError(400, "BATCH_WHOLE_SEND_REQUIRED");
    return { operationId, change: { kind, action: input.action, origin, batchId, expectedVersion } };
  }
  if (kind === "deleteBatch") return { operationId, change: { kind, origin, batchId, expectedVersion } };
  if (kind !== "updateBatch") throw new BatchError(400, "BATCH_UNKNOWN_ACTION");
  const add = additions(input.add ?? []);
  const remove = removals(input.remove ?? []);
  const changed = [...add, ...remove.map((item) => item.orderNumber)];
  if (!changed.length || new Set(changed).size !== changed.length)
    throw new BatchError(400, "BATCH_INVALID_CHANGE_SELECTION");
  return { operationId, change: { kind, origin, batchId, expectedVersion, add, remove } };
}
