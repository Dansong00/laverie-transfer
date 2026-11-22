import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, expect, test, vi } from "vitest";
import { POST as receiveCentsWebhook } from "../app/api/cents/webhook/route";
import { listEligibleOrders } from "../db/eligible-orders";
import { sessionToken } from "../staff/session";
import { saveBatch, plannedBatches, plannedMembers } from "../transfer/planned";
import { getBatch, listBatchesForStore } from "../transfer/board";
import { contentsHistory, sentBatchesAt } from "../transfer/contents";
import { boardSections } from "../db/schema";
import { getStaffPreferences, updateStaffPreferences } from "../staff/preferences";
import { setupStaffTestDatabase } from "./helpers/staff-database";

const pool = setupStaffTestDatabase();
let token: string;
let staffId: string;

async function account(phone: string) {
  const id = randomUUID(),
    session = randomUUID();
  await pool.query("insert into staff(id,name,phone,role,created_at) values ($1,'Taylor',$2,'staff',now())", [
    id,
    phone,
  ]);
  await pool.query(
    "insert into sessions(id,staff_id,created_at,last_used_at,expires_at) values ($1,$2,now(),now(),now()+interval '1 day')",
    [session, id],
  );
  return { id, token: sessionToken(session) };
}
beforeEach(async () => {
  vi.stubEnv("SESSION_SECRET", "planned-batch-test-secret-of-at-least-32-bytes");
  const staff = await account("+12125550120");
  token = staff.token;
  staffId = staff.id;
  await pool.query("truncate cents_orders, batch_counters cascade");
  await pool.query(`insert into cents_orders(store_id,order_number,status,source,created_at,updated_at)
    select 'soho', n::text,'SUBMITTED','webhook',now(),now() from generate_series(1,5) n`);
});
afterAll(() => vi.unstubAllEnvs());

const create = (add: string[]) => ({ operationId: randomUUID(), kind: "createBatch", origin: "soho", add });
const edit = (batchId: string, expectedVersion: number) => ({
  operationId: randomUUID(),
  kind: "updateBatch",
  origin: "soho",
  batchId,
  expectedVersion,
});
const eligible = async () => (await listEligibleOrders("soho")).map((order) => order.orderNumber);

test("cancel releases only otherwise eligible orders and retains stamped membership history", async () => {
  const cmd = create(["1", "2", "3", "4"]);
  const id = "SOHO-B001";
  expect(await saveBatch(token, cmd)).toMatchObject({ ok: true, result: { batchId: id, version: 1 } });
  expect(await eligible()).toEqual(["5"]);
  await pool.query("update cents_orders set status='COMPLETED' where order_number='3'");
  await pool.query("update cents_orders set status='CANCELLED' where order_number='4'");
  const cancel = { ...edit(id, 1), kind: "deleteBatch" };
  expect(await saveBatch(token, cancel)).toMatchObject({ ok: true, result: { cancelled: true, version: 2 } });
  expect(await eligible()).toEqual(["1", "2", "5"]);
  expect(await plannedBatches("soho")).toEqual([]);
  const { rows } = await pool.query(
    "select added_by_op, removed_by_op, active, removed_at from batch_orders",
  );
  expect(rows).toHaveLength(4);
  for (const row of rows)
    expect(row).toMatchObject({
      active: false,
      removed_at: expect.any(Date),
      added_by_op: cmd.operationId,
      removed_by_op: cancel.operationId,
    });
  expect(await saveBatch(token, cancel)).toMatchObject({ ok: true, replayed: true });
  expect(await saveBatch(token, { ...edit(id, 2), add: ["5"] })).toMatchObject({ ok: false });
});

test("edits require a note, check version, and roll back removals if an addition fails", async () => {
  await saveBatch(token, create(["1"]));
  const cmd = edit("SOHO-B001", 1);
  await expect(saveBatch(token, { ...cmd, remove: [{ orderNumber: "1", note: " " }] })).rejects.toMatchObject(
    { status: 400 },
  );
  const remove = [{ orderNumber: "1", note: "Customer collecting here" }];
  await pool.query("update cents_orders set status='VOIDED' where order_number='2'");
  const rejected = { ...cmd, remove, add: ["2"] };
  expect(await saveBatch(token, rejected)).toMatchObject({ ok: false, status: 409 });
  expect(await plannedMembers(cmd.batchId)).toEqual([{ orderNumber: "1" }]);
  await pool.query("update cents_orders set status='IN_PROGRESS' where order_number='2'");
  expect(await saveBatch(token, rejected)).toMatchObject({ ok: false, replayed: true });
  expect(await saveBatch(token, { ...rejected, operationId: randomUUID() })).toMatchObject({
    ok: true,
    result: { version: 2 },
  });
  expect(
    (await pool.query("select removal_note from batch_orders where order_number='1'")).rows[0].removal_note,
  ).toBe(remove[0].note);
  expect(await saveBatch(token, { ...edit(cmd.batchId, 1), add: ["5"] })).toMatchObject({
    ok: false,
    status: 409,
  });
  expect(await plannedMembers(cmd.batchId)).toEqual([{ orderNumber: "2" }]);
});

test("retries replay across later versions, conflicts reject changed actors or orders", async () => {
  const cmd = create(["1", "2"]);
  const responses = await Promise.all([saveBatch(token, cmd), saveBatch(token, cmd)]);
  expect(responses.map((result) => result.replayed).sort()).toEqual([false, true]);
  const other = await account("+12125550121");
  await expect(saveBatch(other.token, cmd)).rejects.toMatchObject({ status: 409 });
  await expect(saveBatch(token, { ...cmd, add: ["3"] })).rejects.toMatchObject({ status: 409 });
  expect(await saveBatch(token, { ...edit("SOHO-B001", 1), add: ["3"] })).toMatchObject({ ok: true });
  expect(await saveBatch(token, { ...cmd, add: ["2", "1"] })).toMatchObject({
    replayed: true,
    result: { version: 1 },
  });
  await expect(saveBatch(undefined, cmd)).rejects.toMatchObject({ status: 401 });
});

test("concurrent plans cannot claim the same order, and failed plans leave no batch or counter increment", async () => {
  const other = await account("+12125550121");
  const outcomes = await Promise.all([
    saveBatch(token, create(["1"])),
    saveBatch(other.token, create(["1"])),
  ]);
  expect(outcomes.map((r) => r.ok).sort()).toEqual([false, true]);
  expect(await plannedBatches("soho")).toEqual([{ id: "SOHO-B001", version: 1 }]);
  expect(await saveBatch(token, create([]))).toMatchObject({ result: { batchId: "SOHO-B002" } });
});

test("an empty plan cannot record a send and a sent batch cannot be edited or cancelled", async () => {
  const cmd = { ...create([]), origin: "east_village" };
  expect(await saveBatch(token, cmd)).toMatchObject({ result: { batchId: "EV-B001" } });
  await expect(
    pool.query(
      `insert into handoffs(operation_id,batch_id,store_id,order_number,action,from_phase,to_phase,staff_id,at)
    values ($1,'EV-B001','east_village','1','send','planned','sent',$2,now())`,
      [cmd.operationId, staffId],
    ),
  ).rejects.toMatchObject({ constraint: "handoffs_send_requires_membership" });
  expect(await saveBatch(token, { ...create(["1"]), origin: "east_village" })).toMatchObject({ ok: false });
  const withOrder = create(["1"]);
  await saveBatch(token, withOrder);
  await pool.query("update batch_orders set phase='sent' where batch_id='SOHO-B001'");
  expect(await saveBatch(token, { ...edit("SOHO-B001", 1), add: ["2"] })).toMatchObject({ ok: false });
  expect(await saveBatch(token, { ...edit("SOHO-B001", 1), kind: "deleteBatch" })).toMatchObject({
    ok: false,
  });
  expect(await plannedBatches("soho")).toEqual([]);
  await pool.query(
    `insert into handoffs(operation_id,batch_id,store_id,order_number,action,from_phase,to_phase,staff_id,at)
    values ($1,'SOHO-B001','soho','5','acknowledgeReturn','return_sent','returned',$2,now())`,
    [withOrder.operationId, staffId],
  );
  expect(await saveBatch(token, create(["5"]))).toMatchObject({ ok: false });
});

test("two staff editing the same version commit one change, and the other sees a stale version", async () => {
  const other = await account("+12125550121");
  await saveBatch(token, create(["1"]));
  const first = { ...edit("SOHO-B001", 1), add: ["2"] };
  const second = { ...edit("SOHO-B001", 1), add: ["3"] };
  const results = await Promise.all([saveBatch(token, first), saveBatch(other.token, second)]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results.find((r) => !r.ok)).toMatchObject({ status: 409, error: "This batch changed, refresh." });
  expect(await plannedMembers(first.batchId)).toHaveLength(2);
  expect(await plannedBatches("soho")).toEqual([{ id: first.batchId, version: 2 }]);
});

const send = (expectedVersion = 1) => ({
  ...edit("SOHO-B001", expectedVersion),
  kind: "runAction",
  action: "send",
});

test("send moves retained orders together and returns the saved departure after a lost confirmation", async () => {
  await saveBatch(token, create(["1", "2", "3"]));
  await saveBatch(token, { ...edit("SOHO-B001", 1), remove: [{ orderNumber: "2", note: "Collect here" }] });
  const cmd = send(2);
  expect(await saveBatch(token, cmd, true)).toBeNull();
  expect(
    (await pool.query("select * from operations where operation_id=$1", [cmd.operationId])).rowCount,
  ).toBe(0);
  const results = await Promise.all([saveBatch(token, cmd), saveBatch(token, cmd)]);
  expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
  for (const result of results)
    expect(result).toMatchObject({ ok: true, result: { version: 3, sent: true } });
  expect(await saveBatch(token, cmd, true)).toMatchObject({ replayed: true, result: { version: 3 } });
  expect((await pool.query("select phase,active from batch_orders order by order_number")).rows).toEqual([
    { phase: "sent", active: true },
    { phase: "planned", active: false },
    { phase: "sent", active: true },
  ]);
  const history = (await pool.query("select * from handoffs order by order_number")).rows;
  expect(history.map((h) => h.order_number)).toEqual(["1", "3"]);
  for (const row of history)
    expect(row).toMatchObject({
      staff_id: staffId,
      operation_id: cmd.operationId,
      from_phase: "planned",
      to_phase: "sent",
      at: history[0].at,
    });
  expect((await pool.query("select version from batches")).rows).toEqual([{ version: 3 }]);
  expect((await pool.query("select * from operations where kind='send'")).rowCount).toBe(1);
  expect(await plannedBatches("soho")).toEqual([]);
  await expect(saveBatch(token, { ...cmd, expectedVersion: 3 })).rejects.toMatchObject({ status: 409 });
  const other = await account("+12125550121");
  await expect(saveBatch(other.token, cmd, true)).rejects.toMatchObject({ status: 409 });
  await expect(saveBatch(token, { ...cmd, orderKeys: ["1"] })).rejects.toMatchObject({ status: 400 });
});

test("two staff sending the same version record one departure and replay the original outcomes", async () => {
  await saveBatch(token, create(["1"]));
  const other = await account("+12125550121");
  const requests = [
    [token, send()],
    [other.token, send()],
  ] as const;
  const outcomes = await Promise.all(requests.map(([session, cmd]) => saveBatch(session, cmd)));
  expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
  expect(outcomes.find((r) => !r.ok)).toMatchObject({ status: 409 });
  for (const [i, [session, cmd]] of requests.entries())
    expect(await saveBatch(session, cmd)).toEqual({ ...outcomes[i], replayed: true });
  expect((await pool.query("select * from handoffs")).rowCount).toBe(1);
  expect((await pool.query("select version from batches")).rows).toEqual([{ version: 2 }]);
});

test("send rejects the whole batch when Cents closes members after planning", async () => {
  await saveBatch(token, create(["1", "2", "3"]));
  vi.stubEnv("CENTS_WEBHOOK_HEADER_NAME", "X-Cents-Test");
  vi.stubEnv("CENTS_WEBHOOK_HEADER_SECRET", "fixture-only");
  vi.stubEnv("CENTS_STORE_ALLOWLIST", '{"soho":101,"east_village":102}');
  async function closeOrder(orderCode: string, status: string) {
    const response = await receiveCentsWebhook(
      new Request("https://example.test/api/cents/webhook", {
        method: "POST",
        headers: { "X-Cents-Test": "fixture-only" },
        body: JSON.stringify({
          event: "order_updated",
          order: { storeId: 101, orderCode, status, updatedAt: new Date().toISOString() },
        }),
      }),
    );
    expect(response.status).toBe(200);
  }
  await closeOrder("1", "CANCELLED");
  await closeOrder("3", "COMPLETED");
  const cmd = send();
  expect(await saveBatch(token, cmd)).toMatchObject({
    ok: false,
    status: 409,
    error: "Orders cannot be sent: 1, 3",
  });
  expect((await pool.query("select from handoffs")).rowCount).toBe(0);
  expect((await pool.query("select from batch_orders where phase='planned' and active")).rowCount).toBe(3);
  expect(await plannedBatches("soho")).toEqual([{ id: cmd.batchId, version: 1 }]);
  await saveBatch(token, {
    ...edit(cmd.batchId, 1),
    remove: ["1", "3"].map((orderNumber) => ({ orderNumber, note: "Closed in Cents" })),
  });
  expect(await saveBatch(token, cmd)).toMatchObject({ ok: false, replayed: true });
  expect(await saveBatch(token, send(2))).toMatchObject({ ok: true, result: { version: 3 } });
  await closeOrder("2", "COMPLETED");
  expect((await pool.query("select phase,active from batch_orders where order_number='2'")).rows).toEqual([
    { phase: "sent", active: true },
  ]);
});

test("send sees a cancellation committed while waiting for the Cents row lock", async () => {
  await saveBatch(token, create(["1"]));
  const writer = await pool.connect();
  const cmd = send();
  try {
    await writer.query("begin");
    const [{ pid }] = (await writer.query("select pg_backend_pid() as pid")).rows;
    await writer.query("update cents_orders set status='CANCELLED' where order_number='1'");
    const sending = saveBatch(token, cmd);
    try {
      await vi.waitFor(async () => {
        const waiting = await pool.query(
          "select from pg_stat_activity where $1 = any(pg_blocking_pids(pid))",
          [pid],
        );
        expect(waiting.rowCount).toBeGreaterThan(0);
      });
    } finally {
      await writer.query("commit");
    }
    expect(await sending).toMatchObject({ ok: false, status: 409, error: "Orders cannot be sent: 1" });
    expect((await pool.query("select from handoffs")).rowCount).toBe(0);
  } finally {
    writer.release();
  }
});

test("send rejects an empty or cancelled batch", async () => {
  await saveBatch(token, create([]));
  expect(await saveBatch(token, send())).toMatchObject({ ok: false, status: 409 });
  await saveBatch(token, { ...edit("SOHO-B001", 1), kind: "deleteBatch" });
  expect(await saveBatch(token, send(2))).toMatchObject({
    ok: false,
    status: 409,
    error: "This batch was cancelled.",
  });
  expect((await pool.query("select from handoffs")).rowCount).toBe(0);
});

test("a database error rolls back the whole departure and leaves the same request retryable", async () => {
  await saveBatch(token, create(["1"]));
  const cmd = send();
  await pool.query("alter table batches add constraint test_version check (version=1)");
  await expect(saveBatch(token, cmd)).rejects.toThrow();
  expect(await saveBatch(token, cmd, true)).toBeNull();
  expect((await pool.query("select from handoffs")).rowCount).toBe(0);
  expect((await pool.query("select phase from batch_orders")).rows).toEqual([{ phase: "planned" }]);
  await pool.query("alter table batches drop constraint test_version");
  expect(await saveBatch(token, cmd)).toMatchObject({ ok: true, result: { version: 2 } });
});

const trip = (version: number) => ({ ...edit("SOHO-B001", version), store: "east_village" });
const correction = (version: number, ...numbers: string[]) => ({
  ...trip(version),
  kind: "correctSentMembership",
  remove: numbers.map((orderNumber) => ({
    orderKey: { storeId: "soho", orderNumber },
    reason: "Stayed at SoHo",
  })),
});
const receive = (version: number) => ({ ...trip(version), kind: "runAction", action: "receive" });
const storeOrders = (version: number, action: "startProcessing" | "markReady", ...numbers: string[]) => ({
  ...trip(version),
  kind: "runAction",
  action,
  orderKeys: numbers.map((orderNumber) => ({ storeId: "soho", orderNumber })),
});
const confirm = (version: number) => ({ ...trip(version), kind: "confirmContents" });
const sendReturn = (version: number) => ({ ...trip(version), kind: "runAction", action: "sendReturn" });

test("a corrected batch needs a versioned contents confirmation before return, including after a second correction", async () => {
  const admin = await account("+12125550123");
  await pool.query("update staff set role='admin' where id=$1", [admin.id]);
  await saveBatch(token, create(["1", "2", "3"]));
  await saveBatch(token, send());
  await saveBatch(token, receive(2));
  await saveBatch(token, storeOrders(3, "startProcessing", "1", "2", "3"));
  await saveBatch(token, storeOrders(4, "markReady", "2", "3"));
  const remove = correction(5, "1");
  expect(await saveBatch(token, { ...remove, role: "admin", staffId: admin.id })).toMatchObject({
    ok: false,
    status: 403,
  });
  const fix = { ...remove, operationId: randomUUID() };
  expect(await saveBatch(admin.token, fix)).toMatchObject({ ok: true, result: { version: 6 } });
  const rows = await pool.query(
    "select c.corrects=s.id linked,c.staff_id,c.operation_id,bo.removal_note,bo.active from handoffs c join handoffs s on s.action='send' and s.order_number=c.order_number join batch_orders bo on bo.removed_by_op=c.operation_id where c.action='correctSentMembership'",
  );
  expect(rows.rows).toEqual([
    {
      linked: true,
      staff_id: admin.id,
      operation_id: fix.operationId,
      removal_note: "Stayed at SoHo",
      active: false,
    },
  ]);
  const blocked = sendReturn(6);
  expect(await saveBatch(token, blocked)).toMatchObject({
    ok: false,
    status: 409,
    error: "Contents changed, confirm before return.",
  });
  expect(await saveBatch(token, { ...confirm(6), store: "soho" })).toMatchObject({ ok: false, status: 403 });
  const cmd = confirm(6);
  const orderKeys = ["2", "3"].map((orderNumber) => ({ storeId: "soho", orderNumber }));
  expect(await saveBatch(token, cmd)).toMatchObject({
    ok: true,
    result: { version: 7, confirmation: { staffId, at: expect.any(String), orderKeys } },
  });
  expect(
    (
      await pool.query(
        "select contents_changed,contents_confirmed_by,contents_confirmed_at,contents_confirmed_order_keys from batches",
      )
    ).rows[0],
  ).toEqual({
    contents_changed: false,
    contents_confirmed_by: staffId,
    contents_confirmed_at: expect.any(Date),
    contents_confirmed_order_keys: orderKeys,
  });
  expect(await saveBatch(admin.token, correction(7, "2"))).toMatchObject({
    ok: true,
    result: { version: 8 },
  });
  expect(await saveBatch(token, cmd)).toMatchObject({
    ok: true,
    replayed: true,
    result: { version: 7, confirmation: { orderKeys } },
  });
  expect(await saveBatch(token, sendReturn(8))).toMatchObject({ ok: false, status: 409 });
  expect(await saveBatch(token, confirm(8))).toMatchObject({
    ok: true,
    result: { version: 9, confirmation: { orderKeys: [orderKeys[1]] } },
  });
  expect(await saveBatch(token, sendReturn(9))).toMatchObject({ ok: true, result: { version: 10 } });
  expect((await pool.query("select order_number from handoffs where action='sendReturn'")).rows).toEqual([
    { order_number: "3" },
  ]);
  expect(await saveBatch(admin.token, correction(10, "3"))).toMatchObject({ ok: false, status: 409 });
});

test("sent corrections are remove-only, validate every member and never reopen a fully corrected batch", async () => {
  await pool.query("update staff set role='admin' where id=$1", [staffId]);
  await saveBatch(token, create(["1", "2"]));
  expect(await saveBatch(token, correction(1, "1"))).toMatchObject({ ok: false });
  await saveBatch(token, send());
  const cmd = correction(2, "1", "2");
  await expect(saveBatch(token, { ...cmd, add: ["3"] })).rejects.toMatchObject({ status: 400 });
  await expect(
    saveBatch(token, { ...cmd, remove: [{ ...cmd.remove[0], reason: " " }] }),
  ).rejects.toMatchObject({ status: 400 });
  expect(await saveBatch(token, correction(2, "1", "5"))).toMatchObject({ ok: false });
  expect((await pool.query("select from handoffs where corrects is not null")).rowCount).toBe(0);
  expect(await saveBatch(token, cmd)).toMatchObject({ ok: true });
  expect(await saveBatch(token, { ...cmd, remove: [...cmd.remove].reverse() })).toMatchObject({
    replayed: true,
  });
  expect(await plannedBatches("soho")).toEqual([]);
  expect(await saveBatch(token, { ...edit("SOHO-B001", 3), add: ["3"] })).toMatchObject({ ok: false });
  expect(await saveBatch(token, confirm(3))).toMatchObject({
    ok: false,
    error: "Receive the batch before confirming its contents.",
  });
  expect(await saveBatch(token, receive(3))).toMatchObject({ ok: true });
  expect(await saveBatch(token, receive(4))).toMatchObject({ ok: false });
  expect(await saveBatch(token, confirm(4))).toMatchObject({
    ok: true,
    result: { confirmation: { orderKeys: [] } },
  });
  expect(await plannedBatches("soho")).toEqual([]);
  expect(await saveBatch(token, sendReturn(5))).toMatchObject({ ok: false });
});

test("a session with an unsupported role cannot send and its rejection is replayed after a role change", async () => {
  await saveBatch(token, create(["1"]));
  await pool.query("update staff set role='viewer' where id=$1", [staffId]);
  const cmd = send();
  expect(await saveBatch(token, cmd)).toMatchObject({ ok: false, status: 403 });
  await pool.query("update staff set role='staff' where id=$1", [staffId]);
  expect(await saveBatch(token, cmd)).toMatchObject({ ok: false, status: 403, replayed: true });
  expect((await pool.query("select from handoffs")).rowCount).toBe(0);
});

test("the two stores see the right sections, including retained orders after assignments end", async () => {
  const id = "SOHO-B001";
  await saveBatch(token, create(["1", "2", "3"]));
  await saveBatch(token, { ...edit(id, 1), remove: [{ orderNumber: "3", note: "Staying here" }] });
  expect(await listBatchesForStore("soho")).toMatchObject([{ id, section: "planned", total: 2 }]);
  expect(await listBatchesForStore("east_village")).toEqual([]);
  const departure = send(2);
  await saveBatch(token, departure);
  expect(await listBatchesForStore("soho")).toEqual([]);
  expect(await listBatchesForStore("east_village")).toMatchObject([
    { section: "arriving", version: 3, total: 2 },
  ]);
  await saveBatch(token, receive(3));
  expect(await listBatchesForStore("east_village")).toMatchObject([{ section: "received" }]);
  await saveBatch(token, storeOrders(4, "startProcessing", "1", "2"));
  await saveBatch(token, storeOrders(5, "markReady", "2"));
  expect(await listBatchesForStore("east_village")).toMatchObject([
    { section: "processing", ready: 1, total: 2 },
  ]);
  await saveBatch(token, storeOrders(6, "markReady", "1"));
  expect(await listBatchesForStore("east_village")).toMatchObject([
    { section: "ready_for_return", ready: 2 },
  ]);
  await saveBatch(token, sendReturn(7));
  for (const store of ["soho", "east_village"] as const)
    expect(await listBatchesForStore(store)).toMatchObject([{ section: "returning", total: 2 }]);
  // S14 supplies acknowledgment; simulate its released assignments without removing their memberships.
  await pool.query("update batch_orders set phase='returned',active=false where removed_at is null");
  await pool.query("update cents_orders set status='COMPLETED' where order_number='2'");
  for (const store of ["soho", "east_village"] as const)
    expect(await listBatchesForStore(store)).toMatchObject([{ section: "recently_returned", total: 2 }]);
  const detail = await getBatch(id);
  expect(detail).toMatchObject({ derivedPhase: "returned", phaseCounts: { returned: 2 }, version: 8 });
  expect(detail?.orders.map((row) => row.order.orderNumber)).toEqual(["1", "2"]);
  expect(detail?.history[0]).toMatchObject({
    staffName: "Taylor",
    handoff: { action: "send", operationId: departure.operationId },
  });
});

test("empty plans stay at the origin, and a confirmed empty departure leaves the live board", async () => {
  await saveBatch(token, create([]));
  expect(await listBatchesForStore("soho")).toMatchObject([{ section: "planned", total: 0 }]);
  await saveBatch(token, { ...edit("SOHO-B001", 1), kind: "deleteBatch" });
  await saveBatch(token, create(["1"]));
  const id = "SOHO-B002";
  await saveBatch(token, { ...send(), batchId: id });
  await pool.query("update staff set role='admin' where id=$1", [staffId]);
  await saveBatch(token, { ...correction(2, "1"), batchId: id });
  expect(await listBatchesForStore("east_village")).toMatchObject([
    { section: "arriving", contentsChanged: true, total: 0 },
  ]);
  await saveBatch(token, { ...receive(3), batchId: id });
  expect(await listBatchesForStore("east_village")).toMatchObject([{ section: "received", total: 0 }]);
  await saveBatch(token, { ...confirm(4), batchId: id });
  expect(await listBatchesForStore("east_village")).toEqual([]);
  expect(await listBatchesForStore("soho")).toEqual([]);
  expect(await getBatch(id)).toMatchObject({
    id,
    section: null,
    history: [{ handoff: { action: "send" } }, { handoff: { action: "correctSentMembership" } }],
  });
});

test("board preferences default to all, accept none and only write for the authenticated staff member", async () => {
  const other = await account("+12125550124");
  expect(await getStaffPreferences(staffId)).toEqual(boardSections);
  expect(await updateStaffPreferences(token, ["processing", "planned"])).toEqual(["planned", "processing"]);
  expect(await getStaffPreferences(staffId)).toEqual(["planned", "processing"]);
  expect(await updateStaffPreferences(token, [])).toEqual([]);
  await updateStaffPreferences(token, []);
  await expect(updateStaffPreferences(token, ["invalid"])).rejects.toMatchObject({ status: 400 });
  await expect(updateStaffPreferences(undefined, ["planned"])).rejects.toMatchObject({ status: 401 });
  expect(await getStaffPreferences(staffId)).toEqual([]);
  expect(await getStaffPreferences(other.id)).toEqual(boardSections);
  expect(
    (await pool.query("select staff_id from operations where kind='updateStaffPreferences'")).rows,
  ).toEqual([{ staff_id: staffId }, { staff_id: staffId }]);
});

test("store actions use one version and one operation for the selected orders, including retries", async () => {
  await saveBatch(token, create(["1", "2", "3", "4"]));
  await saveBatch(token, send());
  expect(await saveBatch(token, { ...receive(2), store: "soho" })).toMatchObject({ ok: false, status: 403 });
  expect(await saveBatch(token, storeOrders(2, "startProcessing", "1"))).toMatchObject({ ok: false });
  const receipt = receive(2);
  expect(await saveBatch(token, receipt)).toMatchObject({ ok: true, result: { version: 3 } });
  const skip = storeOrders(3, "markReady", "1");
  expect(await saveBatch(token, skip)).toMatchObject({ ok: false, status: 409 });
  const one = storeOrders(3, "startProcessing", "1");
  await saveBatch(token, one);
  await saveBatch(token, storeOrders(4, "markReady", "1"));
  expect(await listBatchesForStore("east_village")).toMatchObject([
    { section: "received", ready: 1, total: 4 },
  ]);
  const start = storeOrders(5, "startProcessing", "4", "3", "2");
  expect(await saveBatch(token, start)).toMatchObject({ ok: true, result: { version: 6 } });
  expect(await listBatchesForStore("east_village")).toMatchObject([
    { section: "processing", ready: 1, total: 4 },
  ]);
  for (const [cmd, error] of [
    [storeOrders(6, "markReady", "1", "2"), "Orders cannot move from processing: 1"],
    [storeOrders(6, "markReady", "2", "5"), "Orders cannot move from processing: 5"],
    [storeOrders(5, "markReady", "2", "3"), "This batch changed, refresh."],
  ] as const) {
    expect(await saveBatch(token, cmd)).toMatchObject({ ok: false, status: 409, error });
    expect((await pool.query("select from handoffs where operation_id=$1", [cmd.operationId])).rowCount).toBe(
      0,
    );
  }
  expect(await getBatch("SOHO-B001")).toMatchObject({
    version: 6,
    phaseCounts: { processing: 3, ready_for_return: 1 },
  });
  const bulk = storeOrders(6, "markReady", "4", "2", "3");
  expect(await saveBatch(token, bulk)).toMatchObject({ ok: true, result: { version: 7 } });
  expect(await saveBatch(token, { ...bulk, orderKeys: [...bulk.orderKeys].reverse() })).toMatchObject({
    replayed: true,
    result: { version: 7 },
  });
  await expect(saveBatch(token, { ...bulk, orderKeys: [bulk.orderKeys[0]] })).rejects.toMatchObject({
    status: 409,
  });
  await expect(
    saveBatch(token, { ...bulk, orderKeys: [bulk.orderKeys[0], bulk.orderKeys[0]] }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    saveBatch(token, { ...bulk, orderKeys: [{ storeId: "east_village", orderNumber: "2" }] }),
  ).rejects.toMatchObject({ status: 400 });
  for (const [cmd, count] of [
    [receipt, 4],
    [one, 1],
    [start, 3],
    [bulk, 3],
  ] as const) {
    const rows = await pool.query(
      "select count(*)::int as n,count(distinct at)::int as times from handoffs where operation_id=$1 and staff_id=$2",
      [cmd.operationId, staffId],
    );
    expect(rows.rows).toEqual([{ n: count, times: 1 }]);
  }
  expect(await listBatchesForStore("east_village")).toMatchObject([
    { section: "ready_for_return", ready: 4, total: 4, version: 7 },
  ]);
});

const travelBack = (version: number) => ({
  ...trip(version),
  kind: "correctTravelPhase",
  reason: "Departure recorded early",
});
const orderBack = (version: number, orderNumber = "1") => ({
  ...trip(version),
  kind: "stepBackOrder",
  orderKey: { storeId: "soho", orderNumber },
  reason: "Marked the wrong ticket",
});

test("staff reverse one store phase at a time with a reason and keep both handoffs", async () => {
  await saveBatch(token, create(["1", "2"]));
  await saveBatch(token, send());
  await saveBatch(token, receive(2));
  await saveBatch(token, storeOrders(3, "startProcessing", "1", "2"));
  await saveBatch(token, storeOrders(4, "markReady", "1"));
  await expect(saveBatch(token, { ...orderBack(5), reason: "  " })).rejects.toMatchObject({ status: 400 });
  await expect(saveBatch(token, { ...orderBack(5), orderKeys: [] })).rejects.toMatchObject({ status: 400 });
  expect(await saveBatch(token, orderBack(4))).toMatchObject({ ok: false, status: 409 });
  expect(await saveBatch(token, orderBack(5, "missing"))).toMatchObject({ ok: false, status: 409 });
  await expect(saveBatch(token, { ...orderBack(5), store: undefined })).rejects.toMatchObject({
    status: 400,
  });
  await expect(saveBatch(token, { ...orderBack(5), reason: "x".repeat(1001) })).rejects.toMatchObject({
    status: 400,
  });
  const wrongStore = { ...orderBack(5), store: "soho" };
  expect(await saveBatch(token, wrongStore)).toMatchObject({ ok: false, status: 403 });
  expect(await getBatch("SOHO-B001")).toMatchObject({
    version: 5,
    phaseCounts: { processing: 1, ready_for_return: 1 },
  });
  expect(
    (await pool.query("select id from handoffs where operation_id=$1", [wrongStore.operationId])).rowCount,
  ).toBe(0);
  const undo = orderBack(5);
  expect(await saveBatch(token, undo)).toMatchObject({ ok: true, result: { version: 6 } });
  expect(await saveBatch(token, undo)).toMatchObject({ ok: true, replayed: true });
  await expect(saveBatch(token, { ...undo, reason: "Different reason" })).rejects.toMatchObject({
    status: 409,
  });
  expect(await saveBatch(token, orderBack(6))).toMatchObject({ ok: true });
  expect(await saveBatch(token, orderBack(7))).toMatchObject({ ok: false, status: 409 });
  const detail = await getBatch("SOHO-B001");
  expect(detail).toMatchObject({ version: 7, phaseCounts: { processing: 1, received: 1 } });
  for (const [action, toPhase] of [
    ["markReady", "processing"],
    ["startProcessing", "received"],
  ]) {
    const original = detail?.history.find(({ handoff: h }) => h.orderNumber === "1" && h.action === action);
    expect(detail?.history).toContainEqual(
      expect.objectContaining({
        reason: undo.reason,
        handoff: expect.objectContaining({
          action: "stepBackOrder",
          orderNumber: "1",
          staffId,
          corrects: original!.handoff.id,
          toPhase,
        }),
      }),
    );
  }
});

test("only admins can undo a uniform travel phase, invalidating receipt and reopening the plan", async () => {
  await saveBatch(token, create(["1", "2"]));
  await saveBatch(token, send());
  await expect(saveBatch(token, { ...travelBack(2), reason: "" })).rejects.toMatchObject({ status: 400 });
  expect(await saveBatch(token, { ...travelBack(2), role: "admin" })).toMatchObject({
    ok: false,
    status: 403,
  });
  await saveBatch(token, receive(2));
  expect(await saveBatch(token, travelBack(3))).toMatchObject({ ok: false, status: 403 });
  await pool.query("update staff set role='admin' where id=$1", [staffId]);
  await saveBatch(token, storeOrders(3, "startProcessing", "1"));
  expect(await saveBatch(token, travelBack(4))).toMatchObject({ ok: false, status: 409 });
  await saveBatch(token, orderBack(4));
  await saveBatch(token, correction(5, "2"));
  await saveBatch(token, confirm(6));
  const cmd = travelBack(7);
  expect(await saveBatch(token, cmd)).toMatchObject({ ok: true, result: { version: 8 } });
  expect(await saveBatch(token, cmd)).toMatchObject({ ok: true, replayed: true });
  expect(await saveBatch(token, confirm(8))).toMatchObject({ ok: false, status: 409 });
  expect(await getBatch("SOHO-B001")).toMatchObject({ section: "arriving", contentsChanged: true });
  expect(await saveBatch(token, travelBack(8))).toMatchObject({ ok: true });
  expect(await plannedBatches("soho")).toMatchObject([{ id: "SOHO-B001", version: 9 }]);
  expect(await plannedMembers("SOHO-B001")).toEqual([{ orderNumber: "1" }]);
  expect(await sentBatchesAt("east_village")).toEqual([]);
  const detail = await getBatch("SOHO-B001");
  for (const [action, toPhase] of [
    ["receive", "sent"],
    ["send", "planned"],
  ]) {
    const original = detail?.history.find(({ handoff: h }) => h.action === action && h.orderNumber === "1");
    expect(detail?.history).toContainEqual(
      expect.objectContaining({
        reason: cmd.reason,
        handoff: expect.objectContaining({
          action: "correctTravelPhase",
          toPhase,
          corrects: original!.handoff.id,
        }),
      }),
    );
  }
  expect(await saveBatch(token, send(9))).toMatchObject({ ok: true });
  expect(await sentBatchesAt("east_village")).toMatchObject([{ received: false }]);
});

test("an empty outbound batch can reverse receipt without inventing an order handoff", async () => {
  await pool.query("update staff set role='admin' where id=$1", [staffId]);
  await saveBatch(token, create(["1"]));
  await saveBatch(token, send());
  await saveBatch(token, correction(2, "1"));
  await saveBatch(token, receive(3));
  expect(await saveBatch(token, travelBack(4))).toMatchObject({ ok: true });
  expect(await saveBatch(token, confirm(5))).toMatchObject({ ok: false });
  expect(await getBatch("SOHO-B001")).toMatchObject({
    section: "arriving",
    history: [{ handoff: { action: "send" } }, { handoff: { action: "correctSentMembership" } }],
    emptyCorrections: [{ fromPhase: "received", toPhase: "sent", reason: "Departure recorded early" }],
  });
  expect((await contentsHistory("SOHO-B001")).emptyCorrections).toMatchObject([
    { fromPhase: "received", toPhase: "sent", reason: "Departure recorded early", staffName: "Taylor" },
  ]);
  expect(await saveBatch(token, receive(5))).toMatchObject({ ok: true });
  expect(await saveBatch(token, confirm(6))).toMatchObject({ ok: true });
});

test("each batch-wide reversal links all retained orders to the current trip", async () => {
  await pool.query("update staff set role='admin' where id=$1", [staffId]);
  await saveBatch(token, create(["1", "2"]));
  await saveBatch(token, send());
  await saveBatch(token, travelBack(2));
  const second = send(3);
  await saveBatch(token, second);
  const undo = travelBack(4);
  expect(await saveBatch(token, undo)).toMatchObject({ ok: true, result: { version: 5 } });
  expect(
    (
      await pool.query(
        "select h.order_number, original.operation_id from handoffs h join handoffs original on original.id=h.corrects where h.operation_id=$1 order by h.order_number",
        [undo.operationId],
      )
    ).rows,
  ).toEqual(["1", "2"].map((order_number) => ({ order_number, operation_id: second.operationId })));
});
