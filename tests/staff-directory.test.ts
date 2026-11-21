import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, expect, test, vi } from "vitest";
import { listStaff, saveStaffChange } from "../staff/directory";
import { getProfile, readSession, sessionToken } from "../staff/session";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const numbers = ["+12125550181", "+12125550182", "+12125550183"];
async function clean() {
  const targets = "select id from staff where phone=any($1)";
  await pool.query(`delete from operations where staff_id in (${targets})`, [numbers]);
  await pool.query(`delete from sessions where staff_id in (${targets})`, [numbers]);
  await pool.query("delete from staff where phone=any($1)", [numbers]);
}
beforeEach(async () => {
  await clean();
  vi.stubEnv("SESSION_SECRET", "directory-test-only-secret-at-least-32-bytes");
});
afterAll(async () => {
  await clean();
  await pool.end();
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

test("profile redacts phones for staff and directory reads and writes require an admin session", async () => {
  const person = await account("staff", 0);
  const admin = await account("admin", 1);
  expect(await getProfile(person.token)).toMatchObject({ name: "Casey", role: "staff", phone: null });
  expect(await getProfile(admin.token)).toMatchObject({ phone: numbers[1] });
  expect(await listStaff(admin.token)).toEqual(
    expect.arrayContaining([expect.objectContaining({ phone: numbers[0] })]),
  );
  await expect(listStaff(undefined)).rejects.toMatchObject({ status: 401 });
  await expect(listStaff(person.token)).rejects.toMatchObject({ status: 403 });
  await expect(
    saveStaffChange(person.token, {
      kind: "disableStaff",
      targetStaffId: admin.id,
      staffId: admin.id,
      role: "admin",
      operationId: randomUUID(),
    }),
  ).rejects.toMatchObject({ status: 403 });
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
    status: 409,
  });
  await expect(saveStaffChange(other.token, add)).rejects.toMatchObject({ status: 409 });
  await expect(saveStaffChange(admin.token, { ...add, operationId: randomUUID() })).rejects.toMatchObject({
    status: 409,
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
      reason: { status: 409, message: expect.stringMatching(/last active admin/i) },
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
    reason: { status: 403 },
  });
});
