import { verifyFixture } from "../e2e/verify-fixture.mjs";
import { randomUUID } from "node:crypto";
import { setupStaffTestDatabase } from "./helpers/staff-database";
import { afterAll, beforeEach, expect, test, vi } from "vitest";
import { getDb } from "../db/client";
import { requestSignInCode, verifySignInCode } from "../staff/codes";
import { listStaff, saveStaffChange } from "../staff/directory";
import { getProfile, readSession, sessionToken } from "../staff/session";

const pool = setupStaffTestDatabase();
const numbers = ["+12125550181", "+12125550182", "+12125550183"];
beforeEach(async () => {
  vi.stubEnv("SESSION_SECRET", "directory-test-only-secret-at-least-32-bytes");
});
afterAll(() => {
  vi.unstubAllEnvs();
});

async function account(role: "staff" | "admin", index: number) {
  const id = randomUUID(),
    sessionId = randomUUID();
  await pool.query("insert into staff(id,name,phone,role,created_at) values ($1,'Casey',$2,$3,now())", [
    id,
    numbers[index],
    role,
  ]);
  await pool.query(
    "insert into sessions(id,staff_id,created_at,last_used_at,expires_at) values ($1,$2,now(),now(),now()+interval '1 day')",
    [sessionId, id],
  );
  return { id, token: sessionToken(sessionId) };
}

test("directory reads and writes reject invalid tokens before accessing Postgres", async () => {
  const db = vi.mocked(getDb);
  db.mockClear();
  const invalidSignature = randomUUID() + "." + "0".repeat(64);
  for (const token of [undefined, "malformed", invalidSignature]) {
    await expect(listStaff(token)).rejects.toMatchObject({ status: 401, code: "DIRECTORY_SIGN_IN_REQUIRED" });
    await expect(saveStaffChange(token, {})).rejects.toMatchObject({ status: 401, code: "DIRECTORY_SIGN_IN_REQUIRED" });
  }
  expect(db).not.toHaveBeenCalled();
});

test("profile redacts phones for staff and directory reads and writes require an admin session", async () => {
  const person = await account("staff", 0);
  const admin = await account("admin", 1);
  expect(await getProfile(person.token)).toMatchObject({ name: "Casey", role: "staff", phone: null });
  expect(await getProfile(admin.token)).toMatchObject({ phone: numbers[1] });
  expect(await listStaff(admin.token)).toEqual(
    expect.arrayContaining([expect.objectContaining({ phone: numbers[0] })]),
  );
  await expect(listStaff(undefined)).rejects.toMatchObject({ status: 401, code: "DIRECTORY_SIGN_IN_REQUIRED" });
  await expect(listStaff(person.token)).rejects.toMatchObject({ status: 403, code: "DIRECTORY_ADMIN_REQUIRED" });
  await expect(
    saveStaffChange(person.token, {
      kind: "disableStaff",
      targetStaffId: admin.id,
      staffId: admin.id,
      role: "admin",
      operationId: randomUUID(),
    }),
  ).rejects.toMatchObject({ status: 403, code: "DIRECTORY_ADMIN_REQUIRED" });
});

test("adds once, rejects operation conflicts and duplicate phones, and records the session actor", async () => {
  const admin = await account("admin", 0);
  const other = await account("admin", 1);
  const add = {
    kind: "addStaff",
    name: "Sam",
    phone: "(212) 555-0183",
    role: "staff",
    operationId: randomUUID(),
    staffId: other.id,
  };
  const both = await Promise.all([saveStaffChange(admin.token, add), saveStaffChange(admin.token, add)]);
  expect(both.map((r) => r.replayed).sort()).toEqual([false, true]);
  expect(both[0].member.id).toBe(both[1].member.id);
  await expect(saveStaffChange(admin.token, { ...add, role: "admin" })).rejects.toMatchObject({
    status: 409, code: "DIRECTORY_OPERATION_ID_CONFLICT",
  });
  await expect(saveStaffChange(other.token, add)).rejects.toMatchObject({
    status: 409, code: "DIRECTORY_OPERATION_ID_CONFLICT",
  });
  await expect(saveStaffChange(admin.token, { ...add, operationId: randomUUID() })).rejects.toMatchObject({
    status: 409, code: "DIRECTORY_PHONE_ALREADY_REGISTERED",
  });
  expect(
    (await pool.query("select staff_id,kind from operations where operation_id=$1", [add.operationId]))
      .rows,
  ).toEqual([{ staff_id: admin.id, kind: "addStaff" }]);
});

test("role changes apply to live sessions and disabling revokes every session", async () => {
  const admin = await account("admin", 0);
  const person = await account("staff", 1);
  await pool.query(
    "insert into sessions(staff_id,created_at,last_used_at,expires_at) values ($1,now(),now(),now()+interval '1 day')",
    [person.id],
  );
  await saveStaffChange(admin.token, {
    kind: "updateStaffRole",
    targetStaffId: person.id,
    role: "admin",
    operationId: randomUUID(),
  });
  expect(await readSession(person.token)).toMatchObject({ role: "admin" });
  await saveStaffChange(admin.token, {
    kind: "disableStaff",
    targetStaffId: person.id,
    operationId: randomUUID(),
  });
  expect(await readSession(person.token)).toBeNull();
  expect(
    (
      await pool.query("select revoked_at from sessions where staff_id=$1 and revoked_at is null", [
        person.id,
      ])
    ).rowCount,
  ).toBe(0);
});

test.each([
  ["disableStaff", "disableStaff"],
  ["updateStaffRole", "updateStaffRole"],
  ["disableStaff", "updateStaffRole"],
])(
  "simultaneous %s and %s preserve the last active admin and roll back the rejected operation",
  async (first, second) => {
    const admins = await Promise.all([account("admin", 0), account("admin", 1)]);
    const attempts = await Promise.allSettled(
      admins.map((actor, i) =>
        saveStaffChange(actor.token, {
          kind: i === 0 ? first : second,
          operationId: randomUUID(),
          targetStaffId: actor.id,
          role: "staff",
        }),
      ),
    );
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.find((result) => result.status === "rejected")).toMatchObject({
      reason: { status: 409, code: "DIRECTORY_LAST_ACTIVE_ADMIN" },
    });
    expect(
      (await pool.query("select id from staff where active and role='admin' and phone=any($1)", [numbers]))
        .rowCount,
    ).toBe(1);
    expect(
      (
        await pool.query("select operation_id from operations where staff_id=any($1::uuid[])", [
          admins.map((a) => a.id),
        ])
      ).rowCount,
    ).toBe(1);
  },
);

test("admins changing each other's roles authorize against the committed directory", async () => {
  const admins = await Promise.all([account("admin", 0), account("admin", 1)]);
  const attempts = await Promise.allSettled(
    admins.map((actor, i) =>
      saveStaffChange(actor.token, {
        kind: "updateStaffRole",
        operationId: randomUUID(),
        targetStaffId: admins[1 - i].id,
        role: "staff",
      }),
    ),
  );
  expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(attempts.find((result) => result.status === "rejected")).toMatchObject({
    reason: { status: 403, code: "DIRECTORY_ADMIN_REQUIRED" },
  });
});

test("admins restore the same account, invalidate old credentials and replay a retry", async () => {
  const admin = await account("admin", 0);
  const member = await account("staff", 1);
  const other = await account("staff", 2);
  const enable = { kind: "enableStaff", targetStaffId: member.id, operationId: randomUUID() };
  await saveStaffChange(admin.token, { ...enable, kind: "disableStaff", operationId: randomUUID() });
  await expect(saveStaffChange(other.token, enable)).rejects.toMatchObject({ status: 403 });
  // Accounts disabled before re-enabling was supported could still have an outstanding code.
  await pool.query(`insert into otp_codes(id,phone,code_hash,created_at,expires_at)
    values ($1,$2,'old',now(),now()+interval '5 minutes')`, [randomUUID(), numbers[1]]);
  const result = await saveStaffChange(admin.token, enable);
  expect(result).toMatchObject({ member: { id: member.id, active: true, role: "staff" }, replayed: false });
  expect(await readSession(member.token)).toBeNull();
  expect((await pool.query("select disabled_at,phone from staff where id=$1", [member.id])).rows)
    .toEqual([{ disabled_at: null, phone: numbers[1] }]);
  expect((await pool.query("select id from otp_codes where phone=$1 and consumed_at is null", [numbers[1]])).rows)
    .toHaveLength(0);
  vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", "test-service");
  vi.stubEnv("TWILIO_ACCOUNT_SID", "test-account");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
  let code = "";
  const sms = vi.spyOn(globalThis, "fetch").mockImplementation(verifyFixture(numbers[1], (value: string) => { code = value; }));
  try {
    const request = await requestSignInCode(numbers[1]);
    if (request.kind !== "accepted" || !request.deliver) throw new Error("Expected a fresh sign-in code");
    await request.deliver();
    const session = await verifySignInCode(numbers[1], code);
    expect(await readSession(session?.token)).toMatchObject({ staffId: member.id, role: "staff" });
  } finally {
    sms.mockRestore();
  }
  await expect(saveStaffChange(admin.token, { ...enable, operationId: randomUUID() }))
    .rejects.toMatchObject({ status: 409, code: "DIRECTORY_MEMBER_ALREADY_ACTIVE" });
  await saveStaffChange(admin.token, { ...enable, kind: "disableStaff", operationId: randomUUID() });
  expect(await saveStaffChange(admin.token, enable)).toEqual({ member: result.member, replayed: true });
  expect((await listStaff(admin.token)).find(person => person.id === member.id)?.active).toBe(false);
});
