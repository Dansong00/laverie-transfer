import { setupCentsTestDatabase } from "./helpers/cents-database";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { POST } from "../app/api/cents/webhook/route";
import fixture from "../fixtures/order-created.json";

const pool = setupCentsTestDatabase();
const secret = "fixture-only";
const request = (body: unknown, key: string | null = secret) =>
  new Request("https://example.test/api/cents/webhook", {
    method: "POST",
    headers: key === null ? {} : { "X-Cents-Test": key },
    body: JSON.stringify(body),
  });
const rows = async () => (await pool.query("select * from cents_raw_events order by id")).rows;

beforeAll(() => {
  vi.stubEnv("CENTS_WEBHOOK_HEADER_NAME", "X-Cents-Test");
  vi.stubEnv("CENTS_WEBHOOK_HEADER_SECRET", secret);
  vi.stubEnv("CENTS_STORE_ALLOWLIST", '{"soho":101,"east_village":102}');
});
afterAll(async () => {
  vi.unstubAllEnvs();
});

test.each([null, "wrong"])("rejects invalid header %s before storing", async key => {
  expect((await POST(request(fixture, key))).status).toBe(401);
  expect(await rows()).toHaveLength(0);
});

test("stores the projected order and fingerprints only its redacted fields", async () => {
  expect((await POST(request(fixture))).status).toBe(200);
  const changed = {
    ...fixture, event: undefined, action: fixture.event,
    order: Object.fromEntries(Object.entries(fixture.order).reverse()),
    customer: { ...fixture.customer, email: "other@example.test", lastName: "Tester" },
    services: [{ ...fixture.services[0], extra: { phone: "123456" } }],
  };
  expect((await POST(request(changed))).status).toBe(200);
  const [first, second] = await rows();
  expect(first.body).toEqual({
    event: fixture.event, order: fixture.order, services: fixture.services,
    customer: {firstName: "Maya", lastInitial: "T"},
  });
  expect(first.store_hint).toBe("101");
  expect(first.needs_review).toBe(false);
  expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(second.fingerprint).toBe(first.fingerprint);
  expect(second.body).toEqual(first.body);
});

test("acknowledges an unknown store and flags its redacted event for review", async () => {
  const body = { ...fixture, order: { ...fixture.order, storeId: 999 } };
  expect((await POST(request(body))).status).toBe(200);
  expect(await rows()).toMatchObject([{store_hint: "999", needs_review: true, review_reason: "unknown_store"}]);
});

test("ignores customer events and rejects malformed order envelopes", async () => {
  expect((await POST(request({ event: "customer_created" }))).status).toBe(200);
  expect((await POST(request({ event: "order_created", order: [] }))).status).toBe(400);
  expect(await rows()).toHaveLength(0);
});

test("returns a retryable failure and stores nothing when commit fails", async () => {
  await pool.query(`
    create function reject_s2_test_event() returns trigger language plpgsql as $$
    begin raise exception 'forced failure'; end $$;
    create constraint trigger s2_test_commit after insert on cents_raw_events
    deferrable initially deferred for each row execute function reject_s2_test_event()
  `);
  try {
    expect((await POST(request(fixture))).status).toBe(503);
    expect(await rows()).toHaveLength(0);
  } finally {
    await pool.query("drop function reject_s2_test_event() cascade");
  }
});

async function deliver(order: Record<string, unknown>, event = "order_updated") {
  const response = await POST(request({ ...fixture, event, order: { ...fixture.order, ...order } }));
  expect(response.status).toBe(200);
}

const snapshots = async () => (await pool.query("select * from cents_orders order by store_id")).rows;

test("three concurrent deliveries record three receipts, two duplicates and one snapshot", async () => {
  await Promise.all([deliver({}, fixture.event), deliver({}, fixture.event), deliver({}, fixture.event)]);
  const [original, second, third] = await rows();
  expect(original.duplicate_of).toBeNull();
  expect([second.duplicate_of, third.duplicate_of]).toEqual([original.id, original.id]);
  expect(await snapshots()).toMatchObject([{
    store_id: "soho", order_number: "00314", cents_order_id: "5500314", status: "SUBMITTED",
    source: "webhook", last_event_id: original.id, customer_first_name: "Maya", customer_last_initial: "T",
    due_at: new Date(fixture.order.dueDate), source_updated_at: new Date(fixture.order.updatedAt),
  }]);
});

test("concurrent and late events preserve the latest snapshot independently per store", async () => {
  await Promise.all([
    deliver({ status: "IN_PROGRESS", updatedAt: "2026-11-17T00:00:00.000002Z" }),
    deliver({ status: "SUBMITTED", updatedAt: "2026-11-17T00:00:00.000001Z" }),
    deliver({ storeId: 102, status: "READY_FOR_PICKUP" }),
  ]);
  await deliver({ status: "COMPLETED" }, "order_completed"); // older, despite terminal status
  expect(await snapshots()).toMatchObject([
    { store_id: "east_village", status: "READY_FOR_PICKUP" },
    { store_id: "soho", status: "IN_PROGRESS" },
  ]);
});

test.each(["COMPLETED", "CANCELLED"])("equal-time %s wins and a later reopen is flagged", async status => {
  await deliver({});
  await deliver({ status }, status === "COMPLETED" ? "order_completed" : "order_updated");
  const [terminal] = await snapshots();
  expect(terminal.status).toBe(status);
  await deliver({ status: "IN_PROGRESS", updatedAt: "2026-11-17T00:00:00Z" });
  expect(await snapshots()).toEqual([terminal]);
  expect((await rows()).at(-1)).toMatchObject({ needs_review: true, review_reason: "reopen" });
});

test("equal-time nonterminal keeps the first event; missing time is retained for review", async () => {
  await deliver({});
  const first = await snapshots();
  await deliver({ status: "IN_PROGRESS" });
  await deliver({ status: "COMPLETED", updatedAt: undefined });
  expect(await snapshots()).toEqual(first);
  expect((await rows()).at(-1)).toMatchObject({ needs_review: true, review_reason: "missing_updated_at" });
});

test("a Cents completion leaves an existing transfer phase and handoff history intact", async () => {
  await deliver({});
  const staff = "22222222-2222-4222-8222-222222222230";
  const op = "22222222-2222-4222-8222-222222222231";
  try {
    await pool.query("insert into staff(id,name,phone,role,created_at) values ($1,'Test','+15555550111','staff',now())", [staff]);
    await pool.query("insert into operations(operation_id,staff_id,kind,request_hash,result,created_at) values ($1,$2,'send','test','{}',now())", [op, staff]);
    await pool.query("insert into batches(id,origin,destination,created_by,created_at) values ('S3-test','soho','east_village',$1,now())", [staff]);
    await pool.query(`
      insert into batch_orders(batch_id,origin_store_id,store_id,order_number,phase,added_at,added_by_op,active)
      values ('S3-test','soho','soho','00314','sent',now(),$1,true)
    `, [op]);
    await deliver({ status: "COMPLETED" }, "order_completed");
    expect(await snapshots()).toMatchObject([{status: "COMPLETED"}]);
    expect((await pool.query("select phase,active from batch_orders where batch_id='S3-test'")).rows)
      .toEqual([{phase: "sent", active: true}]);
    expect((await pool.query("select 1 from handoffs where batch_id='S3-test'")).rowCount).toBe(0);
  } finally {
    await pool.query("delete from batch_orders where batch_id='S3-test'; delete from batches where id='S3-test'");
    await pool.query("delete from operations where operation_id=$1", [op]);
    await pool.query("delete from staff where id=$1", [staff]);
  }
});
