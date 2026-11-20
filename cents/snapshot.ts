// Compare UTC timestamps at the same six-digit precision as Postgres timestamptz.
export function sourceTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const iso = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.(\d+))?(?:Z|[+-]\d\d:\d\d)$/i.exec(value);
  if (!iso) return null;
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return null;
  const micros = (iso[1] ?? "").padEnd(6, "0").slice(3, 6);
  return instant.toISOString().slice(0, -1) + micros + "Z";
}

type SnapshotVersion = { status: string; sourceUpdatedAt: string | null };
type EventVersion = { status: string; sourceUpdatedAt: string };

function terminal(status: string) {
  return status === "COMPLETED" || status === "CANCELLED";
}

export function applyCentsEvent(current: SnapshotVersion | undefined, event: EventVersion) {
  if (!current) return "applied";
  const previous = current.sourceUpdatedAt;
  if (previous !== null && event.sourceUpdatedAt < previous) return "stale";
  if (previous === event.sourceUpdatedAt) {
    return terminal(event.status) && !terminal(current.status) ? "applied" : "stale";
  }
  if (terminal(current.status) && !terminal(event.status)) return "needs_review";
  return "applied";
}
