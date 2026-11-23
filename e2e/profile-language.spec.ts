import { readFile, rm } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { en } from "../i18n/en";
import { es } from "../i18n/es";
import { cleanTransfers, signIn } from "./transfer-fixtures";

test("staff can save Spanish, see it on first render, and restore it on a fresh sign-in", async ({
  page, context, browser, baseURL,
}) => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const staff: string[] = [];
  const phone = "+12125550178";
  const inbox = process.env.LAVERIE_TEST_INBOX!;
  const fresh = await browser.newContext({ baseURL });
  try {
    await signIn(context, pool, staff, phone);
    await page.goto("/");
    await expect(page.getByLabel(en.language)).toHaveValue("en");
    await page.getByLabel(en.language).selectOption("es");
    await page.getByRole("button", { name: en.saveLanguage }).click();
    await expect(page.getByRole("heading", { name: es.profile })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
    const reload = await page.reload();
    expect(await reload?.text()).toContain('<html lang="es"');
    await expect(page.getByLabel(es.language)).toHaveValue("es");
    await page.getByRole("button", { name: es.signOut }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

    await fresh.addCookies([{ name: "laverie_locale", value: "es", url: baseURL! }]);
    const signedOut = await fresh.newPage();
    await signedOut.goto("/");
    await expect(signedOut.locator("html")).toHaveAttribute("lang", "en");
    await expect(signedOut.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await fresh.clearCookies();
    await signedOut.getByLabel("Mobile number").fill(phone);
    await signedOut.getByRole("button", { name: "Send code" }).click();
    await expect.poll(() => readFile(inbox, "utf8").catch(() => "")).toMatch(/^\d{6}$/);
    await signedOut.getByLabel("One-time code").fill(await readFile(inbox, "utf8"));
    await signedOut.getByRole("button", { name: "Continue" }).click();
    await expect(signedOut.getByRole("heading", { name: es.profile })).toBeVisible();
    await expect(signedOut.locator("html")).toHaveAttribute("lang", "es");
    expect((await fresh.cookies()).find(cookie => cookie.name === "laverie_locale")?.value).toBe("es");
  } finally {
    await fresh.close();
    await pool.query("delete from otp_codes where phone=$1", [phone]);
    await pool.query("delete from otp_requests where phone=$1", [phone]);
    await cleanTransfers(pool, staff, []);
    await rm(inbox, { force: true });
  }
});
