import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import pg from "pg";
import { batchErrors } from "../i18n/batch-errors";
import { directoryErrors } from "../i18n/directory-errors";
import { t } from "../i18n";
import { cleanTransfers, signIn } from "./transfer-fixtures";

test("Spanish staff screens preserve store, customer, ticket and handoff details", async ({ page, context }) => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const staff: string[] = [];
  const ticket = "SO-" + randomUUID();
  const due = new Date("2026-12-02T03:30:00Z"); // Still December 1 in New York.
  const dateFormat = new Intl.DateTimeFormat("es-US", {
    timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short",
  });
  try {
    await signIn(context, pool, staff, "+12125550197");
    await pool.query("update staff set role='admin' where id=$1", [staff[0]]);
    await pool.query(`insert into cents_orders
      (store_id, order_number, status, source, customer_first_name, customer_last_initial, due_at, created_at, updated_at)
      values ('soho',$1,'SUBMITTED','webhook','June','S',$2,now(),now())`, [ticket, due]);
    await page.goto("/");
    await page.getByLabel(t("en", "language")).selectOption("es");
    await page.getByRole("button", { name: t("en", "saveLanguage") }).click();
    await page.getByRole("link", { name: t("es", "directory") }).click();
    await expect(page.getByRole("heading", { name: t("es", "directory"), exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sam", exact: true })).toBeVisible();
    await page.getByText(t("es", "staffAdd"), { exact: true }).click();
    await page.getByLabel(t("es", "name"), { exact: true }).fill("Duplicate phone");
    await page.getByLabel(t("es", "mobileNumber")).fill("+12125550197");
    const rejected = page.waitForResponse(response =>
      response.url().endsWith("/api/staff") && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: t("es", "staffAddMember") }).click();
    const failure = await rejected;
    expect(failure.status()).toBe(409);
    expect(await failure.json()).toEqual({
      error: "DIRECTORY_PHONE_ALREADY_REGISTERED",
      message: directoryErrors.DIRECTORY_PHONE_ALREADY_REGISTERED.en,
    });
    await expect(page.getByRole("status")).toHaveText(directoryErrors.DIRECTORY_PHONE_ALREADY_REGISTERED.es);

    await page.goto("/orders?store=soho");
    await expect(page.getByRole("heading", { name: t("es", "orders"), exact: true })).toBeVisible();
    for (const store of ["SoHo", "East Village"]) {
      await expect(page.getByRole("link", { name: store, exact: true })).toBeVisible();
    }
    const order = page.getByRole("listitem").filter({ has: page.getByText("#" + ticket, { exact: true }) });
    await expect(order.getByText("June S.", { exact: true })).toBeVisible();
    await expect(order.locator("time")).toContainText(dateFormat.format(due));
    await order.getByRole("checkbox").check();
    // Cents can change eligibility after the order list has rendered.
    await pool.query("update cents_orders set status='COMPLETED' where store_id='soho' and order_number=$1", [ticket]);
    await page.getByRole("button", { name: t("es", "ordersCreatePlan") }).click();
    await expect(page.getByRole("status")).toHaveText(batchErrors.BATCH_ORDERS_INELIGIBLE.es.replace("{orders}", ticket));
    await pool.query("update cents_orders set status='SUBMITTED' where store_id='soho' and order_number=$1", [ticket]);
    await page.getByRole("button", { name: t("es", "ordersCreatePlan") }).click();
    const batch = await page.getByRole("heading", { name: /^SOHO-B/ }).innerText();
    const prompts: string[] = [];
    page.on("dialog", async dialog => {
      prompts.push(dialog.message());
      await dialog.accept();
    });
    await page.getByRole("button", { name: t("es", "ordersMarkSent") }).click();
    await expect(page.getByText(t("es", "ordersSentStatus", { batch }))).toBeVisible();
    expect(prompts).toEqual([t("es", "ordersConfirmSendOne", { batch })]);

    await page.goto("/board?store=east_village");
    await expect(page.getByRole("heading", { name: t("es", "board"), exact: true })).toBeVisible();
    await page.locator("summary").filter({ hasText: t("es", "boardSections") }).click();
    await expect(page.getByRole("group", { name: t("es", "boardShowSections") })).toBeVisible();
    await expect(page.getByRole("button", { name: t("es", "boardSaveSections") })).toBeVisible();
    await page.getByRole("button", { name: t("es", "done") }).click();
    await page.getByRole("region", { name: t("es", "boardArriving") }).getByRole("link", { name: batch }).click();
    await expect(page.getByRole("heading", { name: t("es", "handoffHistory"), exact: true })).toBeVisible();
    await page.locator(".handoff-step summary").first().click();
    const date = page.locator(".handoff-step[open] .handoff-date").first();
    const at = await date.getAttribute("datetime");
    if (!at) throw new Error("Expected a timestamp on the handoff");
    await expect(date).toHaveText(dateFormat.format(new Date(at)));
    await page.getByRole("link", { name: t("es", "boardCheckSent") }).click();
    await page.getByLabel(t("es", "didNotTravel")).check();
    const reason = "Driver kept ticket {batch} at SoHo";
    await page.getByLabel(t("es", "ordersReasonFor", { number: ticket })).fill(reason);
    await page.getByRole("button", { name: t("es", "ordersRecordCorrection") }).click();
    await expect(page.getByRole("heading", { name: t("es", "ordersRemoved"), exact: true })).toBeVisible();
    await expect(page.getByText(reason, { exact: false }).first()).toBeVisible();
  } finally {
    await cleanTransfers(pool, staff, [ticket]);
  }
});
