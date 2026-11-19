import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

const checks = [
  {
    name: "an order has two active batch assignments",
    sql: `
      select store_id, order_number
      from batch_orders
      where active
      group by store_id, order_number
      having count(*) > 1
      union all
      select 'missing', 'batch_orders_one_active_assignment'
      where not exists (
        select 1 from pg_indexes
        where schemaname = 'public'
          and indexname = 'batch_orders_one_active_assignment'
      )
    `,
  },
  {
    name: "an order has two retained memberships",
    sql: `
      select store_id, order_number
      from batch_orders
      where removed_at is null
      group by store_id, order_number
      having count(*) > 1
      union all
      select 'missing', 'batch_orders_one_retained_membership'
      where not exists (
        select 1 from pg_indexes
        where schemaname = 'public'
          and indexname = 'batch_orders_one_retained_membership'
      )
    `,
  },
  {
    name: "a batch contains an order from another store",
    sql: `
      select bo.id::text
      from batch_orders bo
      join batches b on b.id = bo.batch_id
      where bo.store_id <> b.origin
         or bo.origin_store_id <> b.origin
         or bo.store_id <> bo.origin_store_id
      union all
      select 'missing batch_orders_origin_matches_store'
      where not exists (
        select 1 from pg_constraint
        where conname = 'batch_orders_origin_matches_store'
      )
      union all
      select 'missing batch_orders_batch_origin_fkey'
      where not exists (
        select 1 from pg_constraint
        where conname = 'batch_orders_batch_origin_fkey'
      )
    `,
  },
  {
    name: "a cents order store id can change",
    sql: `
      select 'missing cents_orders_store_id_immutable'
      where not exists (
        select 1 from pg_trigger
        where tgname = 'cents_orders_store_id_immutable'
          and not tgisinternal
      )
    `,
  },
  {
    name: "a handoff is missing a staff member or an operation",
    sql: `
      select id::text
      from handoffs
      where staff_id is null or operation_id is null
      union all
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'handoffs'
        and column_name in ('staff_id', 'operation_id')
        and is_nullable = 'YES'
    `,
  },
  {
    name: "an order is returned without a SoHo acknowledgment",
    sql: `
      select bo.id::text
      from batch_orders bo
      join batches b on b.id = bo.batch_id
      where bo.phase = 'returned'
        and bo.removed_at is null
        and (
          b.origin <> 'soho'
          or not exists (
            select 1
            from handoffs h
            where h.batch_id = bo.batch_id
              and h.store_id = bo.store_id
              and h.order_number = bo.order_number
              and h.to_phase = 'returned'
              and h.staff_id is not null
              and h.operation_id is not null
          )
        )
    `,
  },
  {
    name: "a returned batch still has an active membership",
    sql: `
      select bo.id::text
      from batch_orders bo
      where bo.active
        and (
          bo.phase = 'returned'
          or exists (
            select 1
            from batch_orders returned_membership
            where returned_membership.batch_id = bo.batch_id
              and returned_membership.phase = 'returned'
              and returned_membership.removed_at is null
          )
        )
    `,
  },
  {
    name: "a write is missing its operations row",
    sql: `
      select h.id::text
      from handoffs h
      left join operations o on o.operation_id = h.operation_id
      where o.operation_id is null
      union all
      select bo.id::text
      from batch_orders bo
      left join operations o on o.operation_id = bo.added_by_op
      where o.operation_id is null
      union all
      select bo.id::text
      from batch_orders bo
      left join operations removed on removed.operation_id = bo.removed_by_op
      where bo.removed_by_op is not null
        and removed.operation_id is null
    `,
  },
];

export async function findInvariantViolations(pool) {
  const violations = [];
  for (const check of checks) {
    const result = await pool.query(check.sql);
    if (result.rows.length > 0) {
      violations.push(check.name);
    }
  }
  return violations;
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (invokedDirectly()) {
  for (const file of [".env.local", ".env"]) {
    if (existsSync(file)) {
      process.loadEnvFile(file);
    }
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  const pool = new pg.Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 10_000,
  });
  pool.on("error", (error) => {
    console.error("idle postgres client error", error.code ?? "unknown");
  });

  try {
    const violations = await findInvariantViolations(pool);
    if (violations.length > 0) {
      for (const violation of violations) {
        console.error(violation);
      }
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}
