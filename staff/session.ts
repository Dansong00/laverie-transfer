import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { sessions, staff } from "../db/schema";
import { setting } from "./settings";
import { matches, sign } from "./signature";

export const sessionCookie = "laverie_session";

export function sessionToken(id: string) {
  return id + "." + sign("session:" + id);
}

function sessionId(token: string | undefined) {
  const parts = token?.match(/^([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.([0-9a-f]{64})$/);
  if (!parts || !matches(parts[2], sign("session:" + parts[1]))) return null;
  return parts[1];
}

export async function readSession(token: string | undefined) {
  const id = sessionId(token);
  if (!id) return null;
  const idleDays = Math.min(7, setting("SESSION_IDLE_DAYS", 7));
  const [actor] = await getDb().update(sessions).set({ lastUsedAt: sql`now()` })
    .from(staff).where(and(
      eq(sessions.id, id), eq(sessions.staffId, staff.id), eq(staff.active, true),
      isNull(staff.disabledAt), isNull(sessions.revokedAt), gt(sessions.expiresAt, sql`now()`),
      gt(sessions.lastUsedAt, sql`now() - ${idleDays} * interval '1 day'`),
    )).returning({ staffId: staff.id, name: staff.name, role: staff.role });
  return actor ?? null;
}

export async function revokeSession(token: string | undefined) {
  const id = sessionId(token);
  if (id) await getDb().update(sessions).set({ revokedAt: sql`now()` }).where(eq(sessions.id, id));
}
