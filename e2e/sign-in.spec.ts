import { readFile, rm } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import pg from "pg";

test("staff can sign in from a text, refresh and sign out", async ({ page, context }) => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const phone = "+12125550178";
  const inbox = process.env.LAVERIE_TEST_INBOX!;
  const { rows: [person] } = await pool.query(
    "insert into staff(name,phone,role,created_at) values ('Taylor',$1,'staff',now()) returning id", [phone],
  );
  try {
    const signedOut = await page.request.get("/api/session?role=admin&staffId=forged");
    expect(signedOut.status()).toBe(401);
    await page.goto("/");
    await page.getByLabel("Mobile number").fill("(212) 555-0178");
    await page.getByRole("button", { name: "Send code" }).click();
    const otp = page.getByLabel("One-time code");
    await expect(otp).toHaveAttribute("autocomplete", "one-time-code");
    await expect.poll(() => readFile(inbox, "utf8").catch(() => "")).toMatch(/^\d{6}$/);
    await otp.fill(await readFile(inbox, "utf8"));
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
    const cookie = (await context.cookies()).find(c => c.name === "laverie_session");
    expect(cookie).toMatchObject({ secure: true, httpOnly: true, sameSite: "Lax" });
    await page.reload();
    await expect(page.getByText("Taylor")).toBeVisible();
    await expect(page.getByRole("link", { name: "Staff admin" })).toHaveCount(0);
    await expect(page.getByText(phone)).toHaveCount(0);
    expect((await page.request.get("/api/staff")).status()).toBe(403);
    await page.goto("/staff");
    await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
    const response = await page.request.get("/api/session?role=admin&staffId=forged");
    expect(await response.json()).toEqual({ name: "Taylor", role: "staff", staffId: person.id });
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
    expect((await page.request.get("/api/session")).status()).toBe(401);
  } finally {
    await pool.query("delete from sessions where staff_id=$1", [person.id]);
    await pool.query("delete from otp_codes where phone=$1", [phone]);
    await pool.query("delete from otp_requests where phone=$1", [phone]);
    await pool.query("delete from staff where id=$1", [person.id]);
    await pool.end();
    await rm(inbox, { force: true });
  }
});
