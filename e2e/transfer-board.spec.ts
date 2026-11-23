import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { t } from "../i18n";
import { en } from "../i18n/en";
import { cleanTransfers, signIn } from "./transfer-fixtures";

test("two staff see departures across phones, with independent section preferences", async ({
  browser,
  page,
  context,
}) => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const second = await browser.newContext({ baseURL: "http://127.0.0.1:3000" });
  const ids: string[] = [];
  const tickets = Array.from({ length: 5 }, () => "BOARD-" + randomUUID());
  async function send(...selected: string[]) {
    const make = await second.request.post("/api/batches", {
      data: { kind: "createBatch", operationId: randomUUID(), origin: "soho", add: selected },
    });
    expect(make.ok()).toBeTruthy();
    const id = (await make.json()).result.batchId;
    const operationId = randomUUID();
    const sent = await second.request.post("/api/batches", {
      data: {
        kind: "runAction",
        action: "send",
        origin: "soho",
        batchId: id,
        expectedVersion: 1,
        operationId,
      },
    });
    expect(sent.ok()).toBeTruthy();
    return { batchId: id as string, operationId };
  }
  try {
    await signIn(context, pool, ids, "+12125550191");
    await signIn(second, pool, ids, "+12125550192");
    await pool.query(
      "insert into cents_orders(store_id,order_number,status,source,created_at,updated_at) select 'soho',n,'SUBMITTED','webhook',now(),now() from unnest($1::text[]) n",
      [tickets],
    );
    await page.clock.install();
    await page.goto("/board?store=east_village");
    await expect(page.getByRole("region", { name: en.boardArriving })).toBeVisible();
    const { batchId: first, operationId } = await send(tickets[0]);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(
      page.getByRole("region", { name: en.boardArriving }).getByRole("link", { name: first }),
    ).toBeVisible();
    const { batchId: next } = await send(...tickets.slice(1));
    await page.clock.fastForward(45_000);
    await expect(page.getByRole("link", { name: next, exact: true })).toBeVisible();
    await page.getByRole("link", { name: first, exact: true }).click();
    await expect(page.getByText("#" + tickets[0], { exact: true }).first()).toBeVisible();
    await expect(page.getByText(t("en", "operationIdLabel", { id: operationId }))).toBeVisible();
    await expect(page.getByText(en.boardBackToPlanned)).toHaveCount(0);
    await page.getByRole("link", { name: t("en", "boardBackToStore", { store: "East Village" }) }).click();
    await page.getByText(en.boardSections, { exact: true }).click();
    await page.getByRole("checkbox", { name: en.boardArriving, exact: true }).uncheck();
    await page.getByRole("button", { name: en.boardSaveSections }).click();
    await expect(page.getByRole("region", { name: en.boardArriving })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("region", { name: en.phaseProcessing })).toBeVisible();
    await expect(page.getByRole("region", { name: en.boardArriving })).toHaveCount(0);
    const other = await second.newPage();
    await other.goto("/board?store=east_village");
    await expect(
      other.getByRole("region", { name: en.boardArriving }).getByRole("link", { name: first }),
    ).toBeVisible();
    await expect(other.getByRole("region")).toHaveCount(7);
    const card = other
      .getByRole("region", { name: en.boardArriving })
      .getByRole("listitem")
      .filter({ has: other.getByRole("link", { name: next, exact: true }) });
    other.on("dialog", (d) => d.accept());
    await card.getByRole("button", { name: en.boardReceive }).click();
    await other.getByRole("button", { name: en.boardStartProcessing, exact: true }).first().click();
    await other.getByRole("button", { name: en.boardMarkReady, exact: true }).first().click();
    await expect(
      other.getByText(`${en.phaseReceived} · ${t("en", "boardReadyCount", { count: 1, total: 4 })}`),
    ).toBeVisible();
    await other.getByRole("link", { name: t("en", "boardBackToStore", { store: "East Village" }) }).click();
    const received = other.getByRole("region", { name: en.phaseReceived, exact: true });
    await expect(
      received.getByText(t("en", "boardReadyCount", { count: 1, total: 4 }), { exact: true }),
    ).toBeVisible();
    await received.getByRole("link", { name: next, exact: true }).click();
    await other.getByRole("button", { name: t("en", "boardStartProcessingMany", { count: 3 }) }).click();
    await expect(
      other.getByText(`${en.phaseProcessing} · ${t("en", "boardReadyCount", { count: 1, total: 4 })}`),
    ).toBeVisible();
    await other.route(
      "**/api/batches",
      async (route) => {
        expect((await route.fetch()).status()).toBe(200);
        await route.abort();
      },
      { times: 1 },
    );
    await other.getByRole("button", { name: t("en", "boardMarkRemainingReady", { count: 3 }) }).click();
    await expect(other.getByText(en.alreadySaved, { exact: true })).toBeVisible();
    await expect(
      other.getByText(`${en.phaseReady} · ${t("en", "boardReadyCount", { count: 4, total: 4 })}`),
    ).toBeVisible();
    const ticket = tickets[1];
    const member = other
      .getByRole("listitem")
      .filter({ has: other.getByText("#" + ticket, { exact: true }) })
      .filter({ hasText: en.boardBackToProcessing });
    await member.getByText(en.boardBackToProcessing).click();
    await member.getByLabel(en.boardCorrectionReason).fill("Ticket still needs drying");
    await member.getByRole("button", { name: en.boardSaveCorrection }).click();
    await expect(
      other.getByText(`${en.phaseProcessing} · ${t("en", "boardReadyCount", { count: 3, total: 4 })}`),
    ).toBeVisible();
    await expect(
      other.getByText(t("en", "boardReason", { reason: "Ticket still needs drying" })),
    ).toBeVisible();

    await pool.query("update staff set role='admin' where id=$1", [ids[0]]);
    await page.goto("/board?store=east_village&batch=" + first);
    await page.getByText(en.boardBackToPlanned).click();
    await page.getByLabel(en.boardCorrectionReason).fill("Driver has not left yet");
    await page.getByRole("button", { name: en.boardSaveCorrection }).click();
    await expect(
      page.getByText(`${en.phasePlanned} · ${t("en", "boardReadyCount", { count: 0, total: 1 })}`),
    ).toBeVisible();
    await expect(page.getByText(t("en", "boardReason", { reason: "Driver has not left yet" }))).toBeVisible();
  } finally {
    await second.close();
    await cleanTransfers(pool, ids, tickets);
  }
});

for (const [origin, destination] of [
  ["soho", "east_village"],
  ["east_village", "soho"],
] as const) {
  test(`${destination} sends the return and ${origin} acknowledges it after a Cents completion`, async ({
    page,
    context,
  }) => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const ids: string[] = [];
    const tickets = ["RETURN-" + randomUUID(), "RETURN-" + randomUUID()];
    try {
      await signIn(context, pool, ids, "+12125550193");
      await pool.query(
        "insert into cents_orders(store_id,order_number,status,source,created_at,updated_at) select $2,n,'IN_PROGRESS','webhook',now(),now() from unnest($1::text[]) n",
        [tickets, origin],
      );
      async function save(data: Record<string, unknown>) {
        const response = await context.request.post("/api/batches", {
          data: { operationId: randomUUID(), origin, ...data },
        });
        expect(response.ok()).toBeTruthy();
        return (await response.json()).result;
      }
      let batch = await save({ kind: "createBatch", add: tickets });
      const orderKeys = tickets.map((orderNumber) => ({ storeId: origin, orderNumber }));
      for (const action of ["send", "receive", "startProcessing", "markReady"]) {
        batch = await save({
          kind: "runAction",
          action,
          batchId: batch.batchId,
          expectedVersion: batch.version,
          store: action === "send" ? origin : destination,
          ...(["startProcessing", "markReady"].includes(action) && { orderKeys }),
        });
      }
      const detail = "/board?batch=" + batch.batchId + "&store=";
      page.on("dialog", (d) => d.accept());
      await page.goto(detail + destination);
      await page.getByRole("button", { name: en.boardSendReturn }).click();
      await expect(
        page.getByText(`${en.boardReturning} · ${t("en", "boardReturningCount", { total: 2 })}`),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: en.boardAcknowledgeReturn })).toHaveCount(0);
      await pool.query("update cents_orders set status='COMPLETED' where order_number=$1", [tickets[0]]);
      await page.goto(detail + origin);
      await page.getByRole("button", { name: en.boardAcknowledgeReturn }).click();
      await expect(
        page.getByText(`${en.boardRecentlyReturned} · ${t("en", "boardReturnedCount", { count: 2, total: 2 })}`),
      ).toBeVisible();
      for (const store of ["soho", "east_village"]) {
        await page.goto("/board?store=" + store);
        const returned = page
          .getByRole("region", { name: en.boardRecentlyReturned })
          .getByRole("listitem")
          .filter({ has: page.getByRole("link", { name: batch.batchId, exact: true }) });
        await expect(returned.getByText(t("en", "boardReturnedCount", { count: 2, total: 2 }))).toBeVisible();
      }
    } finally {
      await cleanTransfers(pool, ids, tickets);
    }
  });
}
