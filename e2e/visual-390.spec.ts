import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { t } from "../i18n";
import { cleanTransfers, signIn } from "./transfer-fixtures";

for (const locale of ["en", "es"] as const) {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
    test(`walkthrough screens at ${viewport.width}px in ${locale}`, async ({ page, context }) => {
      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
      const staff: string[] = [];
      const ticket = "VISUAL-1842";
      const phone = "+12125550184";
      const dir = "test-results/visual";
      await mkdir(dir, { recursive: true });
      await page.setViewportSize(viewport);
      async function capture(screen: string) {
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        await page.screenshot({ path: `${dir}/${locale}-${viewport.width}-${screen}.png`, fullPage: true, animations: "disabled" });
      }
      try {
        await context.addCookies([{ name: "laverie_locale", value: locale, url: "http://127.0.0.1:3000" }]);
        await page.goto("/");
        await expect(page.getByLabel("Mobile number")).toBeVisible();
        await capture("phone");
        await page.getByLabel("Mobile number").fill(phone);
        await page.getByRole("button", { name: "Send code" }).click();
        await expect(page.getByLabel("One-time code")).toBeVisible();
        await capture("code-sent");

        await signIn(context, pool, staff, phone);
        await pool.query("insert into cents_orders(store_id,order_number,status,source,created_at,updated_at) values ('soho',$1,'SUBMITTED','fixture',now(),now())", [ticket]);
        await page.goto("/");
        await expect(page.getByRole("heading", { name: t(locale, "profile") })).toBeVisible();
        await capture("profile");
        const menu = page.getByRole("button", { name: t(locale, "menuOpen") });
        await menu.click();
        await expect(page.getByRole("navigation").getByRole("link", { name: t(locale, "directory") })).toHaveCount(0);
        await capture("menu");
        await page.keyboard.press("Escape");
        await expect(menu).toBeFocused();

        await page.goto("/orders");
        await page.getByRole("checkbox", { name: "#" + ticket }).check();
        await capture("build");
        await page.getByRole("button", { name: t(locale, "ordersCreatePlan") }).click();
        const heading = page.getByRole("heading", { name: /^SOHO-B/ });
        await expect(heading).toBeVisible();
        const batch = await heading.innerText();
        await capture("planned");
        page.once("dialog", dialog => dialog.accept());
        await page.getByRole("button", { name: t(locale, "ordersMarkSent") }).click();
        await expect(page.getByText(t(locale, "ordersSentStatus", { batch }))).toBeVisible();
        await page.goto("/board?store=east_village");
        const trip = page.getByRole("link", { name: batch, exact: true });
        await expect(trip).toBeVisible();
        await capture("board");
        await trip.click();
        await expect(page.getByRole("heading", { name: batch, exact: true })).toBeVisible();
        await capture("batch");
        page.once("dialog", dialog => dialog.accept());
        await page.getByRole("button", { name: t(locale, "boardReceive") }).click();
        await expect(page.getByRole("button", { name: t(locale, "boardReceive") })).toHaveCount(0);
        await expect(page.getByRole("heading", { name: t(locale, "handoffHistory") })).toBeVisible();
        await capture("order-history");
        await pool.query("update staff set role='admin' where id=$1", [staff[0]]);
        await page.goto("/staff");
        await expect(page.getByRole("heading", { name: t(locale, "directory"), exact: true })).toBeVisible();
        await capture("staff-admin");
        await menu.click();
        await expect(page.getByRole("navigation").getByRole("link", { name: t(locale, "directory") })).toBeVisible();
      } finally {
        await pool.query("delete from otp_requests where phone=$1", [phone]);
        await cleanTransfers(pool, staff, [ticket]);
      }
    });
  }
}
