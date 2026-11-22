import { openTransferStatuses } from "../cents/statuses";
import { listEligibleOrders } from "../db/eligible-orders";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

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
  await pool.query("drop schema if exists drizzle cascade");
  await pool.query("drop schema if exists public cascade");
  await pool.query("create schema public");
  await pool.query("grant all on schema public to public");
  await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
});

beforeEach(async () => {
  const present = await pool.query<{ orders: string | null }>(
    "select to_regclass('public.cents_orders') as orders",
  );
  if (!present.rows[0]?.orders) {
    return;
  }
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
  const present = await pool.query<{ orders: string | null }>(
    "select to_regclass('public.cents_orders') as orders",
  );
  if (present.rows[0]?.orders) {
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
  }
  await pool.end();
});

test("migrations apply on an empty database and create the domain tables", async () => {
  const tables = await pool.query<{ tablename: string }>(`
    select tablename
    from pg_tables
    where schemaname = 'public'
    order by tablename
  `);
  expect(tables.rows.map((row) => row.tablename)).toEqual([
    "batch_counters",
    "batch_orders",
    "batches",
    "cents_orders",
    "cents_raw_events",
    "handoffs",
    "operations",
    "otp_codes",
    "otp_requests",
    "sessions",
    "staff",
    "staff_preferences",
  ]);
});

test("order 100 at SoHo and order 100 at East Village are two rows", async () => {
  await insertOrder("soho", "100");
  await insertOrder("east_village", "100");

  const rows = await pool.query(
    `select store_id, order_number
     from cents_orders
     where order_number = '100'
     order by store_id`,
  );

  expect(rows.rows).toEqual([
    { store_id: "east_village", order_number: "100" },
    { store_id: "soho", order_number: "100" },
  ]);
});

test("inserting SoHo order 100 again fails", async () => {
  await insertOrder("soho", "100");
  await expect(insertOrder("soho", "100")).rejects.toMatchObject({
    code: "23505",
  });
});

test("the active-assignment index rejects a second active assignment", async () => {
  await seedOrdersAndBatches();
  await insertMembership({
    batchId: "SOHO-B001",
    originStoreId: "soho",
    storeId: "soho",
    orderNumber: "100",
    active: true,
    removedAt: null,
  });

  await expect(
    insertMembership({
      batchId: "SOHO-B002",
      originStoreId: "soho",
      storeId: "soho",
      orderNumber: "100",
      active: true,
      removedAt: new Date(),
    }),
  ).rejects.toMatchObject({
    code: "23505",
    constraint: "batch_orders_one_active_assignment",
  });
});

test("a released returned membership blocks another retained membership", async () => {
  await seedOrdersAndBatches();
  await insertMembership({
    batchId: "SOHO-B001",
    originStoreId: "soho",
    storeId: "soho",
    orderNumber: "100",
    phase: "returned",
    active: false,
    removedAt: null,
  });

  await expect(
    insertMembership({
      batchId: "SOHO-B002",
      originStoreId: "soho",
      storeId: "soho",
      orderNumber: "100",
      active: true,
      removedAt: null,
    }),
  ).rejects.toMatchObject({
    code: "23505",
    constraint: "batch_orders_one_retained_membership",
  });
});

test("an order removed from a batch can join a different batch", async () => {
  await seedOrdersAndBatches();
  await insertMembership({
    batchId: "SOHO-B001",
    originStoreId: "soho",
    storeId: "soho",
    orderNumber: "100",
    active: false,
    removedAt: new Date(),
  });

  await insertMembership({
    batchId: "SOHO-B002",
    originStoreId: "soho",
    storeId: "soho",
    orderNumber: "100",
    active: true,
    removedAt: null,
  });

  const rows = await pool.query(
    "select batch_id, active from batch_orders order by batch_id",
  );
  expect(rows.rows).toEqual([
    { batch_id: "SOHO-B001", active: false },
    { batch_id: "SOHO-B002", active: true },
  ]);
});

test("a cross-store batch_orders insert is rejected", async () => {
  await seedOrdersAndBatches();

  await expect(
    insertMembership({
      batchId: "SOHO-B001",
      originStoreId: "east_village",
      storeId: "east_village",
      orderNumber: "100",
      active: true,
      removedAt: null,
    }),
  ).rejects.toMatchObject({
    code: "23503",
    constraint: "batch_orders_batch_origin_fkey",
  });
});

test("batch_orders requires the order store to match the batch origin", async () => {
  await seedOrdersAndBatches();

  await expect(
    insertMembership({
      batchId: "SOHO-B001",
      originStoreId: "soho",
      storeId: "east_village",
      orderNumber: "100",
      active: true,
      removedAt: null,
    }),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "batch_orders_origin_matches_store",
  });
});

test("a cents order store id cannot change after insert", async () => {
  await insertOrder("soho", "101");

  await expect(
    pool.query(
      "update cents_orders set store_id = 'east_village' where order_number = '101'",
    ),
  ).rejects.toMatchObject({
    code: "23514",
  });

  const rows = await pool.query(
    "select store_id from cents_orders where order_number = '101'",
  );
  expect(rows.rows).toEqual([{ store_id: "soho" }]);
});

test("other cents order columns can still change", async () => {
  await insertOrder("soho", "102");
  await pool.query(
    "update cents_orders set status = 'COMPLETED' where store_id = 'soho' and order_number = '102'",
  );
  const rows = await pool.query(
    "select status from cents_orders where order_number = '102'",
  );
  expect(rows.rows).toEqual([{ status: "COMPLETED" }]);
});

test("repeated raw event fingerprints are stored as separate rows", async () => {
  await pool.query(
    `insert into cents_raw_events (received_at, fingerprint, body)
     values (now(), 'same-hash', '{"event":"order_updated"}'::jsonb),
            (now(), 'same-hash', '{"event":"order_updated"}'::jsonb)`,
  );
  const rows = await pool.query(
    "select count(*)::int as n from cents_raw_events where fingerprint = 'same-hash'",
  );
  expect(rows.rows[0]?.n).toBe(2);
});

test("staff preferences default to every board section", async () => {
  await pool.query(
    `insert into staff (id, name, phone, role, created_at)
     values ($1, 'Ada', '+15555550199', 'staff', now())`,
    [staffId],
  );
  await pool.query("insert into staff_preferences (staff_id) values ($1)", [
    staffId,
  ]);
  const rows = await pool.query(
    "select board_sections from staff_preferences where staff_id = $1",
    [staffId],
  );
  expect(rows.rows[0]?.board_sections).toEqual([
    "planned",
    "arriving",
    "received",
    "processing",
    "ready_for_return",
    "returning",
    "recently_returned",
  ]);
});

async function insertOrder(storeId: string, orderNumber: string): Promise<void> {
  await pool.query(
    `insert into cents_orders (
       store_id, order_number, status, source, created_at, updated_at
     ) values ($1, $2, 'IN_PROGRESS', 'webhook', now(), now())`,
    [storeId, orderNumber],
  );
}

async function seedOrdersAndBatches(): Promise<void> {
  await pool.query(
    `insert into staff (id, name, phone, role, created_at)
     values ($1, 'Ada', '+15555550100', 'staff', now())`,
    [staffId],
  );
  await pool.query(
    `insert into operations (
       operation_id, staff_id, kind, request_hash, result, created_at
     ) values ($1, $2, 'create_batch', 'hash', '{}'::jsonb, now())`,
    [operationId, staffId],
  );
  await insertOrder("soho", "100");
  await insertOrder("east_village", "100");
  await pool.query(
    `insert into batches (id, origin, destination, created_by, created_at)
     values ('SOHO-B001', 'soho', 'east_village', $1, now()),
            ('SOHO-B002', 'soho', 'east_village', $1, now())`,
    [staffId],
  );
}

async function insertMembership(row: {
  batchId: string;
  originStoreId: string;
  storeId: string;
  orderNumber: string;
  phase?: string;
  active: boolean;
  removedAt: Date | null;
}): Promise<void> {
  await pool.query(
    `insert into batch_orders (
       batch_id, origin_store_id, store_id, order_number, phase,
       added_at, added_by_op, removed_at, active
     ) values ($1, $2, $3, $4, $5, now(), $6, $7, $8)`,
    [
      row.batchId,
      row.originStoreId,
      row.storeId,
      row.orderNumber,
      row.phase ?? "planned",
      operationId,
      row.removedAt,
      row.active,
    ],
  );
}

test("the database accepts the same open Cents statuses as the application", async () => {
  const { rows } = await pool.query("select cents_open_transfer_statuses() as statuses");
  expect(rows[0].statuses).toEqual(openTransferStatuses);
  for (const status of openTransferStatuses) {
    const { rows } = await pool.query("select cents_status_allows_transfer($1) as allowed", [
      " " + status.toLowerCase() + " ",
    ]);
    expect(rows[0].allowed).toBe(true);
  }
});

test.each(["COMPLETED", "CANCELLED", "VOIDED", "completed", "CANCELED"])("a %s order is excluded from listing and batch admission", async status => {
  await seedOrdersAndBatches();
  await pool.query("update cents_orders set status=$1 where store_id='soho' and order_number='100'", [status]);
  expect(await listEligibleOrders("soho")).toEqual([]);
  expect((await listEligibleOrders("east_village")).map(row => row.orderNumber)).toEqual(["100"]);
  await expect(insertMembership({
    batchId: "SOHO-B001", originStoreId: "soho", storeId: "soho", orderNumber: "100", active: true, removedAt: null,
  })).rejects.toMatchObject({ code: "23514", constraint: "batch_orders_nonterminal_order" });
});

test("eligibility is scoped to the selected store and excludes claimed, terminal and returned orders", async () => {
  await seedOrdersAndBatches();
  const membership = { batchId: "SOHO-B001", originStoreId: "soho", storeId: "soho" };
  await insertMembership({ ...membership, orderNumber: "100", active: true, removedAt: null });
  const due = new Date("2026-10-08T17:00:00Z");
  await pool.query(
    `insert into cents_orders (store_id, order_number, status, due_at, source, created_at, updated_at)
     values ('soho','101','COMPLETED',null,'webhook',now(),now()),
            ('soho','102','CANCELLED',null,'webhook',now(),now()),
            ('soho','103','IN_PROGRESS',null,'webhook',now(),now()),
            ('soho','104','IN_PROGRESS',$1,'webhook',now(),now()),
            ('soho','105','IN_PROGRESS',$1,'webhook',now(),now()),
            ('soho','106','IN_PROGRESS',$1::timestamptz - interval '1 day','webhook',now(),now()),
            ('soho','107','IN_PROGRESS',null,'webhook',now(),now())`, [due],
  );
  await insertMembership({ ...membership, orderNumber: "104", active: false, removedAt: new Date() });
  await pool.query("update cents_orders set is_personal_detergent=true where order_number='104'");
  await pool.query(
    `insert into handoffs (operation_id, batch_id, store_id, order_number, action, from_phase, to_phase, staff_id, at)
     values ($1,'SOHO-B001','soho','107','acknowledgeReturn','return_sent','returned',$2,now())`,
    [operationId, staffId],
  );

  const eligible = await listEligibleOrders("soho");
  expect(eligible.map(row => row.orderNumber)).toEqual(["106", "104", "105", "103"]);
  expect(eligible[1]).toMatchObject({ dueAt: due, isPersonalDetergent: true });
  expect((await listEligibleOrders("east_village")).map(row => row.orderNumber)).toEqual(["100"]);
});
