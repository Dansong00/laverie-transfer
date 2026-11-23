import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { isLocale } from "../i18n";
import { getDb } from "../db/client";
import { boardSections, operations, staffPreferences } from "../db/schema";
import { BatchError } from "../transfer/commands";
import { getProfile, hasValidSessionToken } from "./session";

export async function getStaffPreferences(staffId: string) {
  const [row] = await getDb()
    .select({ sections: staffPreferences.boardSections })
    .from(staffPreferences)
    .where(eq(staffPreferences.staffId, staffId));
  return row ? boardSections.filter((section) => row.sections.includes(section)) : [...boardSections];
}

export async function updateStaffPreferences(token: string | undefined, input: unknown) {
  if (!hasValidSessionToken(token)) throw new BatchError(401, "BATCH_SIGN_IN_REQUIRED");
  return getDb().transaction(async (tx) => {
    const actor = await getProfile(token, tx);
    if (!actor) throw new BatchError(401, "BATCH_SIGN_IN_REQUIRED");
    if (!Array.isArray(input) || !input.every((s) => boardSections.includes(s)))
      throw new BatchError(400, "BATCH_INVALID_BOARD_SECTIONS");
    const sections = boardSections.filter((s) => input.includes(s));
    const saved = await tx
      .insert(staffPreferences)
      .values({ staffId: actor.staffId, boardSections: sections })
      .onConflictDoUpdate({
        target: staffPreferences.staffId,
        set: { boardSections: sections },
        setWhere: sql`${staffPreferences.boardSections} is distinct from excluded.board_sections`,
      })
      .returning({ id: staffPreferences.staffId });
    if (saved.length)
      await tx.insert(operations).values({
        operationId: randomUUID(),
        staffId: actor.staffId,
        kind: "updateStaffPreferences",
        requestHash: createHash("sha256")
          .update(JSON.stringify({ kind: "updateStaffPreferences", sections }))
          .digest("hex"),
        result: { sections },
        createdAt: new Date(),
      });
    return sections;
  });
}

export async function getStaffLocale(staffId: string, db: Pick<ReturnType<typeof getDb>, "select"> = getDb()) {
  const [row] = await db.select({ locale: staffPreferences.locale })
    .from(staffPreferences).where(eq(staffPreferences.staffId, staffId));
  return row?.locale ?? "en";
}

export async function updateStaffLocale(token: string | undefined, value: unknown) {
  return getDb().transaction(async tx => {
    const actor = await getProfile(token, tx);
    if (!actor) throw new BatchError(401, "BATCH_SIGN_IN_REQUIRED");
    if (!isLocale(value)) throw new BatchError(400, "BATCH_UNSUPPORTED_LANGUAGE");
    const saved = await tx.insert(staffPreferences).values({ staffId: actor.staffId, locale: value })
      .onConflictDoUpdate({
        target: staffPreferences.staffId,
        set: { locale: value },
        setWhere: sql`${staffPreferences.locale} is distinct from excluded.locale`,
      }).returning({ staffId: staffPreferences.staffId });
    if (saved.length) {
      await tx.insert(operations).values({
        operationId: randomUUID(),
        staffId: actor.staffId,
        kind: "updateStaffLocale",
        requestHash: createHash("sha256").update(JSON.stringify({ locale: value })).digest("hex"),
        result: { locale: value },
        createdAt: new Date(),
      });
    }
    return value;
  });
}
