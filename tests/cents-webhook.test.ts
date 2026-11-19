import pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { POST } from "../app/api/cents/webhook/route";
import fixture from "../fixtures/order-created.json";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
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
beforeEach(async () => { await pool.query("delete from cents_raw_events"); });
afterAll(async () => {
  vi.unstubAllEnvs();
  await pool.end();
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
