import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { readHealth } from "../db/health";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set. See README.md.");
}

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 2,
  allowExitOnIdle: true,
  connectionTimeoutMillis: 10_000,
  query_timeout: 5_000,
});
pool.on("error", () => {
  // The suite closes this pool. An idle disconnect must not crash the run.
});
const db = drizzle(pool);
const migrationsFolder = "./drizzle";

beforeAll(async () => {
  await migrate(db, { migrationsFolder });
});

afterAll(async () => {
  await migrate(db, { migrationsFolder });
  await pool.end();
});

test("reads SELECT 1 and the applied migration version from Postgres", async () => {
  const migrations = readMigrationFiles({ migrationsFolder });
  const migration = migrations.at(-1);
  if (!migration) {
    throw new Error("bootstrap migration is missing");
  }
  const latestId = migrations.length;

  const report = await readHealth(db);

  expect(report).toEqual({
    ok: true,
    database: "up",
    migrationVersion: {
      id: latestId,
      hash: migration.hash,
      createdAt: String(migration.folderMillis),
    },
  });

  await db.execute(
    sql`update drizzle.__drizzle_migrations set created_at = 42 where id = ${latestId}`,
  );
  try {
    const changed = await readHealth(db);
    expect(changed.migrationVersion?.createdAt).toBe("42");
  } finally {
    await db.execute(
      sql`update drizzle.__drizzle_migrations set created_at = ${migration.folderMillis} where id = ${latestId}`,
    );
  }
});

test("reports the database up with no migration version before migrations exist", async () => {
  const saved = rowsOf(
    await db.execute(sql`
      select id, hash, created_at
      from drizzle.__drizzle_migrations
      order by id
    `),
  );
  await db.execute(sql`drop schema if exists drizzle cascade`);
  try {
    const report = await readHealth(db);
    expect(report).toEqual({
      ok: true,
      database: "up",
      migrationVersion: null,
    });
  } finally {
    await db.execute(sql`create schema if not exists drizzle`);
    await db.execute(sql`
      create table if not exists drizzle.__drizzle_migrations (
        id serial primary key,
        hash text not null,
        created_at bigint
      )
    `);
    for (const row of saved) {
      const id = Number(row.id);
      const createdAt = Number(row.created_at);
      await db.execute(sql`
        insert into drizzle.__drizzle_migrations (id, hash, created_at)
        values (${id}, ${String(row.hash)}, ${createdAt})
      `);
    }
    await db.execute(sql`
      select setval(
        pg_get_serial_sequence('drizzle.__drizzle_migrations', 'id'),
        (select max(id) from drizzle.__drizzle_migrations)
      )
    `);
  }
});

test("reports the database down when Postgres refuses the connection", async () => {
  const closed = new pg.Pool({
    connectionString: "postgresql://laverie:laverie@127.0.0.1:1/laverie",
    connectionTimeoutMillis: 1000,
    max: 1,
    allowExitOnIdle: true,
  });
  closed.on("error", () => {
    // Refusal is asserted through readHealth.
  });
  try {
    const report = await readHealth(drizzle(closed));
    expect(report).toEqual({
      ok: false,
      database: "down",
      migrationVersion: null,
    });
  } finally {
    await closed.end();
  }
});

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) {
    return result.filter((row) => row && typeof row === "object") as Record<
      string,
      unknown
    >[];
  }
  if (
    result &&
    typeof result === "object" &&
    "rows" in result &&
    Array.isArray(result.rows)
  ) {
    return result.rows.filter((row) => row && typeof row === "object") as Record<
      string,
      unknown
    >[];
  }
  return [];
}
