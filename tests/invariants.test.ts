import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { findInvariantViolations } from "../scripts/check-invariants.mjs";

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

const staffId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";

beforeAll(async () => {
  await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
});

beforeEach(async () => {
  await pool.query(`
    truncate
      handoffs,
      batch_orders,
      operations,
      batches,
      batch_counters,
      staff_preferences,
      sessions,
      otp_codes,
      otp_requests,
      cents_orders,
      cents_raw_events,
      staff
    restart identity cascade
  `);
});

afterAll(async () => {
  await pool.query(`
    truncate
      handoffs,
      batch_orders,
      operations,
      batches,
      batch_counters,
      staff_preferences,
      sessions,
      otp_codes,
      otp_requests,
      cents_orders,
      cents_raw_events,
      staff
    restart identity cascade
  `);
  await pool.end();
});

test("a migrated database has no invariant violations", async () => {
  await expect(findInvariantViolations(pool)).resolves.toEqual([]);
});

test("a returned order without a SoHo acknowledgment is a violation", async () => {
  await seedBatch();
  await insertMembership({
    orderNumber: "100",
    phase: "returned",
    active: false,
  });

  await expect(findInvariantViolations(pool)).resolves.toContain(
    "an order is returned without a SoHo acknowledgment",
  );
});

test("a SoHo acknowledgment clears the returned-order violation", async () => {
  await seedBatch();
  await insertMembership({
    orderNumber: "100",
    phase: "returned",
    active: false,
  });
  await pool.query(
    `insert into handoffs (
       operation_id, batch_id, store_id, order_number, action,
       from_phase, to_phase, staff_id, at
     ) values ($1, 'SOHO-B001', 'soho', '100', 'acknowledgeReturn',
               'return_sent', 'returned', $2, now())`,
    [operationId, staffId],
  );

  await expect(findInvariantViolations(pool)).resolves.toEqual([]);
});

test("an active membership on a returned batch is a violation", async () => {
  await seedBatch();
  await insertOrder("200");
  await insertMembership({
    orderNumber: "100",
    phase: "returned",
    active: false,
  });
  await pool.query(
    `insert into handoffs (
       operation_id, batch_id, store_id, order_number, action,
       from_phase, to_phase, staff_id, at
     ) values ($1, 'SOHO-B001', 'soho', '100', 'acknowledgeReturn',
               'return_sent', 'returned', $2, now())`,
    [operationId, staffId],
  );
  await insertMembership({
    orderNumber: "200",
    phase: "processing",
    active: true,
  });

  await expect(findInvariantViolations(pool)).resolves.toContain(
    "a returned batch still has an active membership",
  );
});

async function seedBatch(): Promise<void> {
  await pool.query(
    `insert into staff (id, name, phone, role, created_at)
     values ($1, 'Ada', '+15555550100', 'staff', now())`,
    [staffId],
  );
  await pool.query(
    `insert into operations (
       operation_id, staff_id, kind, batch_id, request_hash, result, created_at
     ) values ($1, $2, 'acknowledgeReturn', 'SOHO-B001', 'hash', '{}'::jsonb, now())`,
    [operationId, staffId],
  );
  await insertOrder("100");
  await pool.query(
    `insert into batches (id, origin, destination, created_by, created_at)
     values ('SOHO-B001', 'soho', 'east_village', $1, now())`,
    [staffId],
  );
}

async function insertOrder(orderNumber: string): Promise<void> {
  await pool.query(
    `insert into cents_orders (
       store_id, order_number, status, source, created_at, updated_at
     ) values ('soho', $1, 'IN_PROGRESS', 'webhook', now(), now())`,
    [orderNumber],
  );
}

async function insertMembership(row: {
  orderNumber: string;
  phase: string;
  active: boolean;
}): Promise<void> {
  await pool.query(
    `insert into batch_orders (
       batch_id, origin_store_id, store_id, order_number, phase,
       added_at, added_by_op, active
     ) values ('SOHO-B001', 'soho', 'soho', $1, $2, now(), $3, $4)`,
    [row.orderNumber, row.phase, operationId, row.active],
  );
}
