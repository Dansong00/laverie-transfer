import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, expect, test, vi } from "vitest";
import { POST as receiveCentsWebhook } from "../app/api/cents/webhook/route";
import { listEligibleOrders } from "../db/eligible-orders";
import { sessionToken } from "../staff/session";
import { saveBatch, plannedBatches, plannedMembers } from "../transfer/planned";
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
const confirm = (version: number) => ({ ...trip(version), kind: "confirmContents" });
const sendReturn = (version: number) => ({ ...trip(version), kind: "runAction", action: "sendReturn" });

test("a corrected batch needs a versioned contents confirmation before return, including after a second correction", async () => {
  const admin = await account("+12125550123");
  await pool.query("update staff set role='admin' where id=$1", [admin.id]);
  await saveBatch(token, create(["1", "2", "3"]));
  await saveBatch(token, send());
  // S12 supplies these phases through staff actions; use its mixed-phase starting state here.
  await pool.query(
    "update batch_orders set phase=case when order_number='1' then 'processing' else 'ready_for_return' end",
  );
  const remove = correction(2, "1");
  expect(await saveBatch(token, { ...remove, role: "admin", staffId: admin.id })).toMatchObject({
    ok: false,
    status: 403,
  });
  const fix = { ...remove, operationId: randomUUID() };
  expect(await saveBatch(admin.token, fix)).toMatchObject({ ok: true, result: { version: 3 } });
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
  const blocked = sendReturn(3);
  expect(await saveBatch(token, blocked)).toMatchObject({
    ok: false,
    status: 409,
    error: "Contents changed, confirm before return.",
  });
  expect(await saveBatch(token, { ...confirm(3), store: "soho" })).toMatchObject({ ok: false, status: 403 });
  const cmd = confirm(3);
  const orderKeys = ["2", "3"].map((orderNumber) => ({ storeId: "soho", orderNumber }));
  expect(await saveBatch(token, cmd)).toMatchObject({
    ok: true,
    result: { version: 4, confirmation: { staffId, at: expect.any(String), orderKeys } },
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
  expect(await saveBatch(admin.token, correction(4, "2"))).toMatchObject({
    ok: true,
    result: { version: 5 },
  });
  expect(await saveBatch(token, cmd)).toMatchObject({
    ok: true,
    replayed: true,
    result: { version: 4, confirmation: { orderKeys } },
  });
  expect(await saveBatch(token, sendReturn(5))).toMatchObject({ ok: false, status: 409 });
  expect(await saveBatch(token, confirm(5))).toMatchObject({
    ok: true,
    result: { version: 6, confirmation: { orderKeys: [orderKeys[1]] } },
  });
  expect(await saveBatch(token, sendReturn(6))).toMatchObject({ ok: true, result: { version: 7 } });
  expect((await pool.query("select order_number from handoffs where action='sendReturn'")).rows).toEqual([
    { order_number: "3" },
  ]);
  expect(await saveBatch(admin.token, correction(7, "3"))).toMatchObject({ ok: false, status: 409 });
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
    ok: true,
    result: { confirmation: { orderKeys: [] } },
  });
  expect(await plannedBatches("soho")).toEqual([]);
  expect(await saveBatch(token, sendReturn(4))).toMatchObject({ ok: false });
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
