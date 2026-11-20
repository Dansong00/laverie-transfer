import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { POST } from "../app/api/cents/webhook/route";
import fixture from "../fixtures/order-created.json";

const exec = promisify(execFile);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
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
beforeEach(async () => {
  await pool.query("delete from cents_orders; delete from cents_raw_events");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
  await pool.end();
});

async function importReport(csv: string, filename = "orders.csv") {
  const path = join(dir, filename);
  await writeFile(path, csv);
  const { stdout } = await exec(process.execPath, ["--import", "tsx", "scripts/cents-backfill.ts", path]);
  return stdout;
}

async function webhook() {
  const response = await POST(new Request("https://example.test/api/cents/webhook", {
    method: "POST", headers: { "X-Cents-Test": "fixture-only" },
    body: JSON.stringify({ ...fixture, order: { ...fixture.order, status: "IN_PROGRESS" } }),
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
      customer_last_initial: "T", due_at: new Date("2026-11-18T05:00:00Z"), is_personal_detergent: null },
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

test("simultaneous webhook and imports keep one webhook snapshot", async () => {
  const csv = [header, open].join("\n");
  await Promise.all([importReport(csv, "a.csv"), importReport(csv, "b.csv"), webhook()]);
  expect(await snapshots()).toMatchObject([{ order_number: "00314", source: "webhook" }]);
});
