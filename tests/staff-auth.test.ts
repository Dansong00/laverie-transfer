import pg from "pg";
import { afterAll, beforeEach, expect, test, vi } from "vitest";
import { requestSignInCode, verifySignInCode } from "../staff/codes";
import { readSession, revokeSession } from "../staff/session";
import { bootstrapFirstAdmin } from "../scripts/bootstrap-admin.mjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const phone = "+12125550171";
const unknown = "+12125550172";
let code = "";
const sms = vi.fn(async (_url: string, options: RequestInit) => {
  const body = JSON.parse(String(options.body));
  expect(body.to).toBe(phone);
  expect(body.text).toMatch(/\n@staff\.example\.test #[0-9]{6}$/);
  code = body.text.slice(-6);
  return new Response(null, { status: 202 });
});

async function clearFixtures() {
  const numbers = [phone, unknown];
  await pool.query("delete from sessions using staff where sessions.staff_id=staff.id and staff.phone=any($1)", [numbers]);
  await pool.query("delete from otp_codes where phone=any($1)", [numbers]);
  await pool.query("delete from otp_requests where phone=any($1)", [numbers]);
  await pool.query("delete from staff where phone=any($1)", [numbers]);
}

beforeEach(async () => {
  await clearFixtures();
  await pool.query("insert into staff(name,phone,role,created_at) values ('Test staff',$1,'staff',now())", [phone]);
  vi.stubEnv("SESSION_SECRET", "integration-test-only-secret-at-least-32-bytes");
  vi.stubEnv("SMS_PROVIDER_API_KEY", "test");
  vi.stubEnv("SMS_FROM", "+12125550170");
  vi.stubEnv("APP_DOMAIN", "staff.example.test");
  vi.stubEnv("BOOTSTRAP_ADMIN_PHONE", unknown);
  vi.stubGlobal("fetch", sms);
  sms.mockClear();
  code = "";
});
afterAll(async () => {
  await clearFixtures();
  await pool.end();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function request(phoneInput = phone) {
  const result = await requestSignInCode(phoneInput);
  if (result.kind === "accepted") await result.deliver?.();
  return result.kind;
}

test("unknown and disabled phones get the accepted response and no SMS or OTP", async () => {
  await pool.query("update staff set active=false where phone=$1", [phone]);
  expect(await request(unknown)).toBe("accepted");
  expect(await request()).toBe("accepted");
  expect(await request(unknown)).toBe("limited");
  expect(sms).not.toHaveBeenCalled();
  expect((await pool.query("select id from otp_codes")).rowCount).toBe(0);
});

test("concurrent requests share cooldown and five sends exhaust the rolling hour", async () => {
  const results = await Promise.all([request(), request("(212) 555-0171")]);
  expect(results.sort()).toEqual(["accepted", "limited"]);
  for (let i = 1; i < 5; i++) {
    await pool.query("update otp_requests set requested_at=requested_at-interval '31 seconds'");
    expect(await request()).toBe("accepted");
  }
  await pool.query("update otp_requests set requested_at=requested_at-interval '31 seconds'");
  expect(await request()).toBe("limited");
  expect(sms).toHaveBeenCalledTimes(5);
  await pool.query("update otp_requests set requested_at=requested_at-interval '1 hour'");
  expect(await request()).toBe("accepted");
});

test("expired codes, replaced codes and a code locked by five wrong attempts are rejected", async () => {
  await request();
  await pool.query("update otp_codes set expires_at=now()");
  expect(await verifySignInCode(phone, code)).toBeNull();
  await pool.query("update otp_requests set requested_at=requested_at-interval '31 seconds'");
  await request();
  const wrong = code === "000000" ? "111111" : "000000";
  for (let i = 0; i < 6; i++) expect(await verifySignInCode(phone, wrong)).toBeNull();
  expect(await verifySignInCode(phone, code)).toBeNull();
  const rows = await pool.query("select consumed_at,failed_attempts from otp_codes order by created_at");
  expect(rows.rows[0].consumed_at).toBeTruthy();
  expect(rows.rows[1].failed_attempts).toBe(5);
});

test("only one concurrent verification redeems a code and identity comes from current staff", async () => {
  await request();
  const row = (await pool.query("select code_hash, expires_at-created_at as ttl from otp_codes")).rows[0];
  expect(row.code_hash).not.toBe(code);
  expect(row.ttl.minutes).toBe(10);
  const issued = (await Promise.all([verifySignInCode(phone, code), verifySignInCode(phone, code)])).filter(s => s !== null);
  expect(issued).toHaveLength(1);
  const { token } = issued[0];
  expect(await readSession(undefined)).toBeNull();
  expect(await readSession(token + "x")).toBeNull();
  expect(await readSession(token)).toMatchObject({ role: "staff", name: "Test staff" });
  await pool.query("update staff set role='admin' where phone=$1", [phone]);
  expect(await readSession(token)).toMatchObject({ role: "admin" });
  await pool.query("update staff set active=false,disabled_at=now() where phone=$1", [phone]);
  expect(await readSession(token)).toBeNull();
});

test.each(["idle", "absolute", "logout"])("%s ends the session", async end => {
  await request();
  const session = await verifySignInCode(phone, code);
  expect(session).toBeTruthy();
  const token = session!.token;
  const stored = (await pool.query("select expires_at-created_at as ttl from sessions")).rows[0];
  expect(stored.ttl.days).toBe(30);
  if (end === "idle") await pool.query("update sessions set last_used_at=now()-interval '7 days'");
  if (end === "absolute") await pool.query("update sessions set expires_at=now()");
  if (end === "logout") await revokeSession(token);
  expect(await readSession(token)).toBeNull();
});

test("concurrent first-admin setup creates one admin and a disabled admin still blocks reruns", async () => {
  const attempts = await Promise.allSettled([bootstrapFirstAdmin(pool), bootstrapFirstAdmin(pool)]);
  expect(attempts.filter(a => a.status === "fulfilled")).toHaveLength(1);
  await pool.query("update staff set active=false where phone=$1", [unknown]);
  await expect(bootstrapFirstAdmin(pool)).rejects.toThrow(/admin already exists/i);
});
