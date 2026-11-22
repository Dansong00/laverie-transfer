import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, expect, test, vi } from "vitest";
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
