import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { t } from "../i18n";
import { en } from "../i18n/en";
import fixture from "../fixtures/order-created.json";
import { cleanTransfers, confirmBoardAction, signIn } from "./transfer-fixtures";

test("four SoHo orders complete a round trip with a Cents completion and a handoff history for each order", async ({
  browser,
  context,
  page: soho,
  request,
  baseURL,
}) => {
  test.setTimeout(60_000);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const staff: string[] = [];
  const tickets = Array.from({ length: 4 }, () => "ACCEPT-" + randomUUID()).sort();
  const destination = await browser.newContext({ baseURL });
  const eastVillage = await destination.newPage();

  async function deliver(event: "order_created" | "order_completed") {
    for (const orderCode of tickets) {
      const order = { ...fixture.order, id: orderCode, orderCode };
      const response = await request.post("/api/cents/webhook", {
        headers: { "X-Cents-Test": "playwright-only" },
        data: {
          ...fixture,
          event,
          order: event === "order_created"
            ? order
            : { ...order, status: "COMPLETED", updatedAt: "2026-11-19T14:02:00.000Z" },
        },
      });
      expect(response.status()).toBe(200);
    }
  }

  async function expectCentsState(status: string, event: string) {
    const snapshots = await pool.query(
      `select o.order_number, o.store_id, o.status, e.body->>'event' as event
       from cents_orders o left join cents_raw_events e on e.id = o.last_event_id
       where o.order_number = any($1::text[]) order by o.order_number`,
      [tickets],
    );
    expect(snapshots.rows).toEqual(
      tickets.map(orderNumber => ({ order_number: orderNumber, store_id: "soho", status, event })),
    );
  }

  try {
    await signIn(context, pool, staff, "+12125550194");
    await signIn(destination, pool, staff, "+12125550195");
    soho.on("dialog", dialog => dialog.accept());
    await deliver("order_created");

    await soho.goto("/orders?store=soho");
    for (const ticket of tickets) {
      await soho.getByRole("checkbox", { name: "#" + ticket, exact: true }).check();
    }
    await soho.getByRole("button", { name: en.ordersCreatePlan }).click();
    const batch = await soho.getByRole("heading", { name: /^SOHO-B/ }).innerText();
    await soho.getByRole("button", { name: en.ordersMarkSent, exact: true }).click();
    await expect(soho.getByText(t("en", "ordersSentStatus", { batch }))).toBeVisible();

    await eastVillage.goto("/board?store=east_village");
    const arrivals = eastVillage.getByRole("region", { name: en.boardArriving });
    await arrivals.getByRole("link", { name: batch, exact: true }).click();
    await confirmBoardAction(eastVillage, en.boardReceive);
    await confirmBoardAction(eastVillage, t("en", "boardStartProcessingMany", { count: 4 }));
    await confirmBoardAction(eastVillage, t("en", "boardMarkRemainingReady", { count: 4 }));
    await expect(
      eastVillage.getByText(`${en.phaseReady} · ${t("en", "boardReadyCount", { count: 4, total: 4 })}`),
    ).toBeVisible();
    await confirmBoardAction(eastVillage, en.boardSendReturn);
    await expect(
      eastVillage.getByText(`${en.boardReturning} · ${t("en", "boardReturningCount", { total: 4 })}`),
    ).toBeVisible();
    await expectCentsState("SUBMITTED", "order_created");

    await deliver("order_completed");
    await expectCentsState("COMPLETED", "order_completed");
    await soho.goto("/board?store=soho");
    const returns = soho.getByRole("region", { name: en.boardReturning });
    await returns.getByRole("link", { name: batch, exact: true }).click();
    await confirmBoardAction(soho, en.boardAcknowledgeReturn);
    await expect(
      soho.getByText(`${en.boardRecentlyReturned} · ${t("en", "boardReturnedCount", { count: 4, total: 4 })}`),
    ).toBeVisible();

    await soho.reload();
    await expect(soho.getByRole("heading", { name: en.handoffHistory })).toBeVisible();
    for (const ticket of tickets) {
      await soho.locator("button.order-row").filter({ hasText: ticket }).click();
      const sheet = soho.getByRole("dialog");
      const history = sheet.locator(".order-history > li");
      await expect(history).toHaveCount(6);
      await expect(history).toContainText([
        en.phaseSent, en.phaseReceived, en.phaseProcessing, en.phaseReady, en.phaseReturnSent, en.phaseReturned,
      ]);
      await sheet.getByRole("button", { name: en.close }).click();
    }
    const [originStaff, destinationStaff] = staff;
    const operations = await pool.query(
      "select kind, staff_id from operations where staff_id=any($1::uuid[]) order by created_at",
      [staff],
    );
    expect(operations.rows.map(row => [row.kind, row.staff_id])).toEqual([
      ["createBatch", originStaff],
      ["send", originStaff],
      ["receive", destinationStaff],
      ["startProcessing", destinationStaff],
      ["markReady", destinationStaff],
      ["sendReturn", destinationStaff],
      ["acknowledgeReturn", originStaff],
    ]);
    execFileSync("pnpm", ["check:invariants"], { stdio: "inherit" });
  } finally {
    await destination.close();
    await cleanTransfers(pool, staff, tickets);
  }
});
