import { verifyFixture } from "../e2e/verify-fixture.mjs";
import { setupStaffTestDatabase } from "./helpers/staff-database";
import { afterAll, beforeEach, expect, test, vi } from "vitest";
import { requestSignInCode, verifySignInCode } from "../staff/codes";
import { readSession, revokeSession } from "../staff/session";
import { bootstrapFirstAdmin } from "../scripts/bootstrap-admin.mjs";

const pool = setupStaffTestDatabase();
const phone = "+12125550171";
const unknown = "+12125550172";
let code = "";
const sms = vi.fn((value: string) => { code = value; });

beforeEach(async () => {
  await pool.query("insert into staff(name,phone,role,created_at) values ('Test staff',$1,'staff',now())", [phone]);
  vi.stubEnv("SESSION_SECRET", "integration-test-only-secret-at-least-32-bytes");
  vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", "test-service");
  vi.stubEnv("TWILIO_ACCOUNT_SID", "test-account");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
  vi.stubEnv("BOOTSTRAP_ADMIN_PHONE", unknown);
  vi.stubGlobal("fetch", vi.fn(verifyFixture(phone, sms)));
  sms.mockClear();
  code = "";
});
afterAll(() => {
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
  const row = (await pool.query("select verification_sid, code_hash, expires_at-created_at as ttl from otp_codes")).rows[0];
  expect(row.code_hash).toBeNull();
  expect(row.verification_sid).toMatch(/^VE/);
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

test("the phone lock survives code replacement and expires with the rolling window", async () => {
  await request();
  await pool.query("insert into otp_failures(phone,failed_at) select $1,now() from generate_series(1,9)", [phone]);
  await pool.query("update otp_requests set requested_at=requested_at-interval '31 seconds'");
  await request();
  const currentCode = code;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const wrong = currentCode === "000000" ? "111111" : "000000";
    expect(await verifySignInCode(phone, wrong)).toBeNull();
    expect(warn.mock.calls).toEqual([["staff_otp_phone_locked"]]);
    expect(await verifySignInCode(phone, currentCode)).toBeNull();
    await pool.query("update otp_requests set requested_at=requested_at-interval '31 seconds'");
    expect(await requestSignInCode(phone)).toEqual(await requestSignInCode(unknown));
    expect(sms).toHaveBeenCalledTimes(2);
    expect((await pool.query("select count(*)::int as n from otp_codes")).rows[0].n).toBe(2);
    await pool.query("update otp_failures set failed_at=now()-interval '24 hours 1 second'");
    expect(await verifySignInCode(phone, currentCode)).toBeTruthy();
  } finally {
    warn.mockRestore();
  }
});

test("an exhausted client budget leaves a second client free to request and verify", async () => {
  const first = "192.0.2.10";
  const second = "198.51.100.10";
  // Create both budget rows through the service, then place them at the limit.
  await requestSignInCode(unknown, first);
  await verifySignInCode(unknown, "123456", first);
  await pool.query("update otp_traffic set attempts=case when action like 'request:%' then 20 else 60 end");
  expect((await requestSignInCode(phone, first)).kind).toBe("limited");
  expect((await pool.query("select id from otp_requests where phone=$1", [phone])).rowCount).toBe(0);
  const fresh = await requestSignInCode(phone, second);
  if (fresh.kind !== "accepted" || !fresh.deliver) throw new Error("Expected a new code");
  await fresh.deliver();
  expect(await verifySignInCode(phone, code, first)).toBeNull();
  expect(await verifySignInCode(phone, code, second)).toBeTruthy();
  await pool.query("update otp_traffic set window_start=now()-interval '61 seconds'");
  const otherPhone = "+12125550173";
  expect((await requestSignInCode(otherPhone, first)).kind).toBe("accepted");
  const { rows } = await pool.query("select action from otp_traffic");
  expect(JSON.stringify(rows)).not.toContain(first);
  expect(JSON.stringify(rows)).not.toContain(second);
});

test.each(["production", "preview"])("the test interceptor refuses to run in %s", env => {
  const original = process.env.VERCEL_ENV;
  vi.stubEnv("VERCEL_ENV", env);
  try {
    expect(() => verifyFixture(phone, sms)).toThrow(/restricted/);
  } finally {
    vi.stubEnv("VERCEL_ENV", original);
  }
});

test("a delayed delivery rechecks eligibility, and an older callback cannot replace the current challenge", async () => {
  const first = await requestSignInCode(phone);
  if (first.kind !== "accepted" || !first.deliver) throw new Error("Expected delivery");
  await pool.query("update otp_requests set requested_at=requested_at-interval '31 seconds'");
  await request();
  await first.deliver();
  expect(sms).toHaveBeenCalledTimes(1);
  await pool.query("update otp_requests set requested_at=requested_at-interval '31 seconds'");
  const last = await requestSignInCode(phone);
  if (last.kind !== "accepted" || !last.deliver) throw new Error("Expected delivery");
  await pool.query("update staff set active=false where phone=$1", [phone]);
  await last.deliver();
  expect(sms).toHaveBeenCalledTimes(1);
});

test("replacement cancels the previous provider challenge", async () => {
  await request();
  const first = (await pool.query("select verification_sid from otp_codes")).rows[0].verification_sid;
  await pool.query("update otp_requests set requested_at=requested_at-interval '31 seconds'");
  await request();
  const latest = (await pool.query("select verification_sid from otp_codes where consumed_at is null")).rows[0];
  expect(latest.verification_sid).toBeTruthy();
  expect(latest.verification_sid).not.toBe(first);
});

test("absent provider credentials cannot deliver or approve a code", async () => {
  await request();
  vi.stubEnv("TWILIO_AUTH_TOKEN", "");
  await expect(verifySignInCode(phone, code)).rejects.toThrow(/configuration/);
  await pool.query("update otp_requests set requested_at=requested_at-interval '31 seconds'");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await request()).toBe("accepted");
    expect(sms).toHaveBeenCalledTimes(1);
    expect(await verifySignInCode(phone, code)).toBeNull();
    expect((await pool.query("select id from sessions")).rowCount).toBe(0);
    expect(error).toHaveBeenCalledWith("Staff verification delivery failed");
  } finally { error.mockRestore(); }
});

test("a provider start with a lost response cannot carry its code into a replacement", async () => {
  const transport = verifyFixture(phone, sms);
  vi.mocked(fetch).mockImplementationOnce(async (input, options) => {
    await transport(input, options);
    throw new Error("Response lost");
  }).mockImplementation(transport);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await request();
    expect(await verifySignInCode(phone, code)).toBeNull();
    await pool.query("update otp_requests set requested_at=requested_at-interval '31 seconds'");
    await request();
    // First send, provider resend on the orphan, then fresh send after cancel.
    expect(sms).toHaveBeenCalledTimes(3);
    expect(await verifySignInCode(phone, code)).toBeTruthy();
  } finally { log.mockRestore(); }
});

test("provider unavailability grants no session and does not count as a bad guess", async () => {
  await request();
  vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 503 }));
  await expect(verifySignInCode(phone, code)).rejects.toThrow(/unavailable/);
  expect((await pool.query("select * from otp_failures")).rowCount).toBe(0);
  expect((await pool.query("select * from sessions")).rowCount).toBe(0);
});
