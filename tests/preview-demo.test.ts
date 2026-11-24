import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { requestSignInCode, verifySignInCode } from "../staff/codes";
import { demoAccounts, demoEnabled } from "../staff/preview-demo";
import { readSession } from "../staff/session";
import { setupStaffTestDatabase } from "./helpers/staff-database";

const pool = setupStaffTestDatabase("laverie_preview_demo_");
const account = demoAccounts[0];
const credential = "private-test-only-demo-key";
const other = "+12125550188";

beforeEach(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = "/" + (await pool.query("select current_database() as name")).rows[0].name;
  vi.stubEnv("DATABASE_URL", url.toString());
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("PREVIEW_OTP_ACCESS_CODE", credential);
  vi.stubEnv("SESSION_SECRET", "test-only-preview-database-session-secret");
  vi.stubGlobal("fetch", vi.fn());
  await pool.query("insert into staff(id,name,phone,role,created_at) values ($1,$2,$3,'staff',now()),(gen_random_uuid(),'Other',$4,'staff',now())",
    [account.id, account.name, account.phone, other]);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

test("a fixture can redeem its displayed OTP once and enter as the demo staff member", async () => {
  const result = await requestSignInCode(account.phone, undefined, credential);
  if (result.kind !== "demo") throw new Error("Expected a demo OTP");
  expect(result.code).toMatch(/^\d{6}$/);
  expect((await requestSignInCode(account.phone, undefined, credential)).kind).toBe("limited");
  const session = await verifySignInCode(account.phone, result.code);
  expect(await readSession(session?.token)).toMatchObject({ name: account.name, role: "staff" });
  expect(await verifySignInCode(account.phone, result.code)).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

test("wrong credentials, other staff, disabled fixtures and unknown numbers cannot obtain demo codes", async () => {
  for (const phone of [account.phone, other, "+12125550199"]) {
    for (const key of [undefined, "incorrect"]) expect(await requestSignInCode(phone, undefined, key)).toEqual({ kind: "denied" });
  }
  await pool.query("update staff set active=false where id=$1", [account.id]);
  for (const phone of [account.phone, other, "+12125550199"]) {
    expect(await requestSignInCode(phone, undefined, credential)).toEqual({ kind: "accepted" });
  }
  expect((await pool.query("select * from otp_codes")).rowCount).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});

test("a demo code cannot follow a phone reassigned to a different identity", async () => {
  const result = await requestSignInCode(account.phone, undefined, credential);
  if (result.kind !== "demo") throw new Error("Expected a demo OTP");
  await pool.query("update staff set phone='+12125550109' where id=$1", [account.id]);
  await pool.query("update staff set phone=$1 where phone=$2", [account.phone, other]);
  expect(await verifySignInCode(account.phone, result.code)).toBeNull();
});

test.each(["production", "staging"])("%s stays on the normal SMS path even with a matching credential", async env => {
  vi.stubEnv("VERCEL_ENV", env);
  expect(demoEnabled()).toBe(false);
  const result = await requestSignInCode(account.phone, undefined, credential);
  if (result.kind !== "accepted" || !result.deliver) throw new Error("Expected normal SMS delivery");
  vi.stubEnv("SMS_PROVIDER_API_KEY", "test-only");
  vi.stubEnv("SMS_FROM", "+12125550190");
  vi.stubEnv("APP_DOMAIN", "staff.example.test");
  vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 202 }));
  await result.deliver();
  expect(fetch).toHaveBeenCalledOnce();
  expect(result).not.toHaveProperty("code");
});

test("requires an isolated database and a sufficiently long secret", () => {
  vi.stubEnv("PREVIEW_OTP_ACCESS_CODE", "  too short  ");
  expect(demoEnabled()).toBe(false);
  vi.stubEnv("PREVIEW_OTP_ACCESS_CODE", credential);
  vi.stubEnv("DATABASE_URL", "postgres://localhost/live");
  expect(demoEnabled()).toBe(false);
});
