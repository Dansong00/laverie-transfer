import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, vi } from "vitest";
import * as client from "../../db/client";

// Concurrent requests need independent connections to the same isolated tables.
export function setupStaffTestDatabase() {
  const parent = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const name = "staff_test_" + randomUUID().replaceAll("-", "");
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = "/" + name;
  url.searchParams.delete("dbname");
  url.searchParams.delete("database");
  const pool = new pg.Pool({ connectionString: url.toString() });
  let created = false;
  beforeAll(async () => {
    await parent.query(`CREATE DATABASE "${name}"`);
    created = true;
    const { rows } = await pool.query("select current_database() as name");
    if (rows[0].name !== name) throw new Error("Expected a disposable staff test database");
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: "./drizzle" });
    vi.spyOn(client, "getDb").mockReturnValue(db);
  });
  beforeEach(async () => {
    await pool.query("truncate staff, otp_codes, otp_requests, otp_failures, otp_traffic cascade");
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    try {
      await pool.end();
      if (created) await parent.query(`DROP DATABASE "${name}"`);
    } finally {
      await parent.end();
    }
  });
  return pool;
}
