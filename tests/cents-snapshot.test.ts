import { expect, test } from "vitest";
import { applyCentsEvent, sourceTimestamp } from "../cents/snapshot";

const time = "2026-11-16T14:02:00.000000Z";
const later = "2026-11-16T14:02:00.000001Z";

test.each([
  ["IN_PROGRESS", later, "COMPLETED", time, "stale"],
  ["IN_PROGRESS", time, "CANCELLED", time, "applied"],
  ["COMPLETED", time, "CANCELLED", time, "stale"],
  ["COMPLETED", time, "IN_PROGRESS", later, "needs_review"],
  ["CANCELLED", null, "IN_PROGRESS", later, "needs_review"],
  ["IN_PROGRESS", null, "COMPLETED", time, "applied"],
] as const)("orders %s at %s against %s at %s", (status, sourceUpdatedAt, incoming, timestamp, expected) => {
  expect(applyCentsEvent({ status, sourceUpdatedAt }, { status: incoming, sourceUpdatedAt: timestamp }))
    .toBe(expected);
});

test("normalizes source offsets without losing microseconds", () => {
  expect(sourceTimestamp("2026-11-16T09:02:00.000001-05:00")).toBe(later);
});
