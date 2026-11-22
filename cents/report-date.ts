import { sql } from "drizzle-orm";

// Date-only report values use midnight UTC, matching ISO date-only webhooks.
// Keep local wall times distinct from instants until Postgres applies store time.
export function parseOrderDueDate(value: string) {
  const iso = value.replace(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?=\s|$)/,
    (_, m: string, d: string, y: string) => `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`);
  const match = /^(\d{4}-\d\d-\d\d)(?:[ T](\d{1,2}):(\d\d)(?::(\d\d)(\.\d+)?)?(?:\s?([AP]M)|(Z|[+-]\d\d:\d\d))?)?$/i.exec(iso);
  if (!match) return null;
  const [, day, hours, minutes = "00", seconds = "00", fraction = "", meridiem, offset] = match;
  const midnight = new Date(day + "T00:00:00Z");
  if (day.startsWith("0000") || !Number.isFinite(+midnight) || midnight.toISOString().slice(0, 10) !== day) return null;
  if (!hours) return midnight;
  let hour = Number(hours);
  if (Number(minutes) > 59 || Number(seconds) > 59 || hour > 23) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = hour % 12 + (meridiem.toUpperCase() === "PM" ? 12 : 0);
  }
  const stamp = `${day}T${String(hour).padStart(2, "0")}:${minutes}:${seconds}${fraction}`;
  if (!offset) return sql`${stamp}::timestamp at time zone 'America/New_York'`;
  const instant = new Date(stamp + offset.toUpperCase());
  return Number.isFinite(+instant) ? instant : null;
}
