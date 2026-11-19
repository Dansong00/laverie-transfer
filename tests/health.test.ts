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
  const [migration] = readMigrationFiles({ migrationsFolder });
  if (!migration) {
    throw new Error("bootstrap migration is missing");
  }

  const report = await readHealth(db);

  expect(report).toEqual({
    ok: true,
    database: "up",
    migrationVersion: {
      id: 1,
      hash: migration.hash,
      createdAt: String(migration.folderMillis),
    },
  });

  await db.execute(
    sql`update drizzle.__drizzle_migrations set created_at = 42 where id = 1`,
  );
  try {
    const changed = await readHealth(db);
    expect(changed.migrationVersion?.createdAt).toBe("42");
  } finally {
    await db.execute(
      sql`update drizzle.__drizzle_migrations set created_at = ${migration.folderMillis} where id = 1`,
    );
  }
});

test("reports the database up with no migration version before migrations exist", async () => {
  await db.execute(sql`drop schema if exists drizzle cascade`);
  try {
    const report = await readHealth(db);
    expect(report).toEqual({
      ok: true,
      database: "up",
      migrationVersion: null,
    });
  } finally {
    await migrate(db, { migrationsFolder });
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
