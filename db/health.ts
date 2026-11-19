import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export type MigrationVersion = {
  id: number;
  hash: string;
  createdAt: string;
};

export type HealthReport = {
  ok: boolean;
  database: "up" | "down";
  migrationVersion: MigrationVersion | null;
};

const missingRelationCodes = new Set(["42P01", "3F000"]);

export async function readHealth(db: NodePgDatabase): Promise<HealthReport> {
  try {
    const ping = await db.execute(sql`select 1 as ok`);
    const pingRow = firstRow(ping);
    if (Number(pingRow?.ok) !== 1) {
      return down();
    }

    let migrationRow: Record<string, unknown> | undefined;
    try {
      const migrations = await db.execute(sql`
        select id, hash, created_at
        from drizzle.__drizzle_migrations
        order by id desc
        limit 1
      `);
      migrationRow = firstRow(migrations);
    } catch (error) {
      if (missingRelationCodes.has(errorCode(error) ?? "")) {
        return { ok: true, database: "up", migrationVersion: null };
      }
      throw error;
    }

    if (!migrationRow) {
      return { ok: true, database: "up", migrationVersion: null };
    }

    return {
      ok: true,
      database: "up",
      migrationVersion: {
        id: Number(migrationRow.id),
        hash: String(migrationRow.hash),
        createdAt: String(migrationRow.created_at),
      },
    };
  } catch {
    return down();
  }
}

function down(): HealthReport {
  return { ok: false, database: "down", migrationVersion: null };
}

function firstRow(result: unknown): Record<string, unknown> | undefined {
  const rows = Array.isArray(result)
    ? result
    : result &&
        typeof result === "object" &&
        "rows" in result &&
        Array.isArray(result.rows)
      ? result.rows
      : [];
  const row = rows[0];
  if (!row || typeof row !== "object") {
    return undefined;
  }
  return row as Record<string, unknown>;
}

function errorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    if ("code" in current && typeof current.code === "string") {
      return current.code;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}
