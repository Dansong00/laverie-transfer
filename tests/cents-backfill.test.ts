import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setupCentsTestDatabase } from "./helpers/cents-database";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { POST } from "../app/api/cents/webhook/route";
import fixture from "../fixtures/order-created.json";

const exec = promisify(execFile);
const pool = setupCentsTestDatabase();
const header = "Order Code,Location,Status,Modifiers,Due Date,First Name,Last Name,Email";
const open = '00314,Laverie SoHo,In Progress,"Wash, Fold",11/18/2026,Maya,Testwell,maya@example.test';
const cancelled = open.replace("In Progress", "Canceled");
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "laverie-report-"));
  vi.stubEnv("CENTS_STORE_ALLOWLIST", '{"soho":101,"east_village":102}');
  vi.stubEnv("CENTS_WEBHOOK_HEADER_NAME", "X-Cents-Test");
  vi.stubEnv("CENTS_WEBHOOK_HEADER_SECRET", "fixture-only");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

async function importReport(csv: string | Buffer, filename = "orders.csv", dryRun = false) {
  const path = join(dir, filename);
  await writeFile(path, csv);
  const { stdout } = await exec(process.execPath, ["--import", "tsx", "scripts/cents-backfill.ts", ...(dryRun ? ["--dry-run"] : []), path]);
  return stdout;
}

async function webhook(order: Record<string, unknown> = {}) {
  const response = await POST(new Request("https://example.test/api/cents/webhook", {
    method: "POST", headers: { "X-Cents-Test": "fixture-only" },
    body: JSON.stringify({ ...fixture, order: { ...fixture.order, status: "IN_PROGRESS", ...order } }),
  }));
  expect(response.status).toBe(200);
}

const snapshots = async () => (await pool.query(
  "select *, cents_status_allows_transfer(status) as eligible from cents_orders order by store_id",
)).rows;

test("imports quoted CSV, preserves store-scoped order codes, and is idempotent", async () => {
  const east = '00314,102,Completed,"Wash,\r\nFold",2026-11-18,,,';
  const csv = "\uFEFF" + [header, open, east].join("\r\n");
  await importReport(csv);
  const initial = await snapshots();
  expect(initial).toMatchObject([
    { order_number: "00314", store_id: "east_village", status: "COMPLETED", eligible: false },
    { order_number: "00314", store_id: "soho", status: "IN_PROGRESS", source: "backfill",
      source_updated_at: null, last_event_id: null, customer_first_name: "Maya",
      customer_last_initial: "T", due_at: new Date("2026-11-18T00:00:00Z"), is_personal_detergent: null },
  ]);
  expect(JSON.stringify(initial)).not.toContain("Testwell");
  expect(JSON.stringify(initial)).not.toContain("maya@example.test");
  await importReport(csv);
  expect(await snapshots()).toEqual(initial);
  expect((await pool.query("select id from cents_raw_events")).rowCount).toBe(0);
});

test("a webhook supersedes open backfill and later imports leave webhook data intact", async () => {
  await importReport([header, open].join("\n"));
  await webhook();
  const current = await snapshots();
  expect(current).toMatchObject([{ source: "webhook", last_event_id: expect.any(String) }]);
  await importReport([header, cancelled].join("\n"));
  expect(await snapshots()).toEqual(current);
});

test.each(["Canceled", "Completed"])("late webhook preserves a backfilled %s order", async status => {
  await importReport([header, open.replace("In Progress", status)].join("\n"));
  const current = await snapshots();
  expect(current).toMatchObject([{ source: "backfill", eligible: false }]);
  await webhook();
  expect(await snapshots()).toEqual(current);
  expect((await pool.query("select review_reason from cents_raw_events")).rows).toEqual([{review_reason:"reopen"}]);
});

test("an invalid location identifies the record, keeps prior progress and permits a retry", async () => {
  const invalid = open.replace("Laverie SoHo", "private@example.test");
  await expect(importReport([header, open, invalid].join("\n"))).rejects.toMatchObject({
    stderr: expect.stringMatching(/record 3.*location/i),
  });
  expect(await snapshots()).toHaveLength(1);
  await importReport([header, open, open.replace("Laverie SoHo", "East Village")].join("\n"));
  expect(await snapshots()).toHaveLength(2);
});

test("padded and numeric codes share a store identity in both arrival orders", async () => {
  await importReport([header, open].join("\n"));
  await webhook({ orderCode: 314, dueDate: "2026-11-18" });
  expect(await snapshots()).toMatchObject([{ order_number: "00314", source: "webhook",
    due_at: new Date("2026-11-18T00:00:00Z") }]);
  await webhook({ orderCode: "  314 ", id: 987654 });
  expect((await pool.query("select review_reason from cents_raw_events order by id desc limit 1")).rows[0])
    .toEqual({ review_reason: "conflicting_order_id" });
  await webhook({ orderCode: 314, storeId: 102 });
  await importReport([header, open.replace("Laverie SoHo", "East Village")].join("\n"));
  expect(await snapshots()).toMatchObject([
    { store_id: "east_village", order_number: "314", source: "webhook" },
    { store_id: "soho", order_number: "00314", cents_order_id: "5500314" },
  ]);
});

test("dry run counts valid records across invalid rows and never writes", async () => {
  const csv = [header, open, open.replace("In Progress","Refunded"), "Total", open.replace("11/18/2026","2/30/2026"),
    open.replace("Laverie SoHo","East Village").replace("In Progress","Complete")].join("\n");
  await expect(importReport(csv, "check.csv", true)).rejects.toMatchObject({
    stdout: expect.stringContaining("Checked 5 records. 3 invalid. No writes."),
    stderr: expect.stringMatching(/record 3: Unrecognized Status[\s\S]+record 4: Wrong number[\s\S]+record 5: Invalid Due Date/),
  });
  const good = await importReport([header,open,open.replace("Laverie SoHo","East Village").replace("In Progress","Complete")].join("\n"), "good.csv", true);
  expect(good).toContain("soho IN_PROGRESS 1");
  expect(good).toContain("east_village COMPLETED 1");
  expect(await snapshots()).toHaveLength(0);
  await expect(importReport([header, open.replace("In Progress","Voided")].join("\n")))
    .rejects.toMatchObject({stderr: expect.stringContaining("Unrecognized Status")});
  expect(await snapshots()).toHaveLength(0);
});

test.each([
  ["11/18/2026 2:30 PM", "2026-11-18T19:30:00.000Z"],
  ["2026-07-01T10:15:00", "2026-07-01T14:15:00.000Z"],
  ["2026-11-18T10:15:00-07:00", "2026-11-18T17:15:00.000Z"],
])("both writers interpret %s consistently", async (date, expected) => {
  await importReport([header, open.replace("11/18/2026", date)].join("\n"));
  expect((await snapshots())[0].due_at.toISOString()).toBe(expected);
  await webhook({ dueDate: date });
  expect((await snapshots())[0]).toMatchObject({ source: "webhook", due_at: new Date(expected) });
});

test("rejects invalid UTF-8 without echoing customer fields", async () => {
  const csv = Buffer.concat([Buffer.from(header + "\n" + open), Buffer.from([0xff])]);
  await expect(importReport(csv, "encoding.csv", true)).rejects.toMatchObject({
    stderr: expect.stringContaining("Expected a UTF-8 CSV"),
  });
  expect(await snapshots()).toHaveLength(0);
});

test("both writers wait on the same order lock before the first insert", async () => {
  const holder = await pool.connect();
  await holder.query("begin");
  const { rows: [lock] } = await holder.query(`select pg_backend_pid() as pid,
    pg_advisory_xact_lock(hashtextextended(jsonb_build_array('101'::text, cents_order_identity('314'))::text, 0))`);
  const writes = Promise.allSettled([importReport([header,open].join("\n")), webhook({orderCode: 314})]);
  try {
    await vi.waitFor(async () => {
      // A queued exclusive waiter can block the next waiter, so match the
      // actual advisory lock held by this backend, not just its direct blockers.
      const {rowCount} = await pool.query(`select w.pid from pg_locks held join pg_locks w
        using(locktype, database, classid, objid, objsubid)
        where held.pid=$1 and held.locktype='advisory' and held.granted and not w.granted`, [lock.pid]);
      expect(rowCount).toBe(2);
    }, { timeout: 8000, interval: 40 });
    expect(await snapshots()).toHaveLength(0);
  } finally {
    await holder.query("rollback");
    holder.release();
    expect((await writes).map(result => result.status)).toEqual(["fulfilled","fulfilled"]);
  }
  expect(await snapshots()).toMatchObject([{ source: "webhook" }]);
}, 15000);
