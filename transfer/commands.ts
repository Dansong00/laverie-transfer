import type { StoreId } from "../db/eligible-orders";

type Existing = { batchId: string; expectedVersion: number };
type Removal = { orderNumber: string; note: string };
export type BatchChange =
  | { kind: "createBatch"; origin: StoreId; add: string[] }
  | ({ kind: "updateBatch"; origin: StoreId; add: string[]; remove: Removal[] } & Existing)
  | ({ kind: "runAction"; action: "send"; origin: StoreId } & Existing)
  | ({ kind: "deleteBatch"; origin: StoreId } & Existing);

export class BatchError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ticket(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw new BatchError(400, "Invalid order number.");
  return value;
}

function additions(value: unknown) {
  if (!Array.isArray(value)) throw new BatchError(400, "Choose orders from one store.");
  return value.map(ticket).sort();
}

function removals(value: unknown): Removal[] {
  if (!Array.isArray(value)) throw new BatchError(400, "Invalid removals.");
  return value
    .map((item) => {
      if (!record(item) || typeof item.note !== "string" || !item.note.trim())
        throw new BatchError(400, "A note is required for each removed order.");
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
    throw new BatchError(400, "Invalid operation ID.");
  const operationId = input.operationId.toLowerCase();
  const { origin, kind, batchId, expectedVersion } = input;
  if (origin !== "soho" && origin !== "east_village") throw new BatchError(400, "Choose a store.");
  if (kind === "createBatch") {
    const add = additions(input.add);
    if (new Set(add).size !== add.length) throw new BatchError(400, "Select each order only once.");
    return { operationId, change: { kind, origin, add } };
  }
  if (
    typeof batchId !== "string" ||
    !batchId ||
    typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1
  )
    throw new BatchError(400, "Invalid batch or version.");
  if (kind === "runAction") {
    if (input.action !== "send") throw new BatchError(400, "Unknown transfer action.");
    if ("orderKeys" in input || "add" in input || "remove" in input)
      throw new BatchError(400, "Send applies to the whole batch.");
    return { operationId, change: { kind, action: input.action, origin, batchId, expectedVersion } };
  }
  if (kind === "deleteBatch") return { operationId, change: { kind, origin, batchId, expectedVersion } };
  if (kind !== "updateBatch") throw new BatchError(400, "Unknown batch action.");
  const add = additions(input.add ?? []);
  const remove = removals(input.remove ?? []);
  const changed = [...add, ...remove.map((item) => item.orderNumber)];
  if (!changed.length || new Set(changed).size !== changed.length)
    throw new BatchError(400, "Choose a change and select each order only once.");
  return { operationId, change: { kind, origin, batchId, expectedVersion, add, remove } };
}
