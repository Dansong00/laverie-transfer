import { confirmAction } from "./transfer-fixtures";
import { createHmac, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { t } from "../i18n";
import { en } from "../i18n/en";

test("staff can recover a saved plan after a lost response, edit it and release its orders", async ({
  page,
  context,
}) => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const staff = randomUUID(),
    session = randomUUID();
  const numbers = ["S8-BROWSER-1", "S8-BROWSER-2"];
  try {
    await pool.query(
      "insert into staff(id,name,phone,role,created_at) values ($1,'Robin','+12125550188','staff',now())",
      [staff],
    );
    await pool.query(
      "insert into sessions(id,staff_id,created_at,last_used_at,expires_at) values ($1,$2,now(),now(),now()+interval '1 day')",
      [session, staff],
    );
    await pool.query(
      `insert into cents_orders(store_id,order_number,status,source,created_at,updated_at)
      select 'soho',n,'SUBMITTED','webhook',now(),now() from unnest($1::text[]) n`,
      [numbers],
    );
    const signature = createHmac("sha256", "playwright-only-session-key-for-local-tests")
      .update("session:" + session)
      .digest("hex");
    await context.addCookies([
      {
        name: "laverie_session",
        value: session + "." + signature,
        url: "http://127.0.0.1:3000",
        httpOnly: true,
        secure: true,
      },
    ]);
    await page.goto("/orders?store=soho");
    await page.getByRole("checkbox", { name: "#" + numbers[0] }).check();
    const cookies = await context.cookies();
    await context.clearCookies();
    await page.getByRole("button", { name: en.ordersCreatePlan }).click();
    await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
    const pendingKeys = () =>
      page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("planned-batch:")));
    expect(await pendingKeys()).toEqual([]);
    await context.addCookies(cookies);
    await page.goto("/orders?store=soho");
    await page.getByRole("checkbox", { name: "#" + numbers[0] }).check();
    expect((await pool.query("select id from batches where created_by=$1", [staff])).rowCount).toBe(0);
    await page.route(
      "**/api/batches",
      async (route) => {
        const result = await route.fetch();
        expect(result.status()).toBe(200);
        await route.abort();
      },
      { times: 1 },
    );
    await page.getByRole("button", { name: en.ordersCreatePlan }).click();
    await expect(page.getByText(en.retryToCheck)).toBeVisible();
    await context.clearCookies();
    await page.getByRole("button", { name: en.checkPending }).click();
    await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
    await context.addCookies(cookies);
    await page.goto("/orders?store=soho");
    await page.getByRole("button", { name: en.checkPending }).click();
    await expect(page.getByText(en.alreadySaved, { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^SOHO-B/ })).toBeVisible();
    await page.getByRole("checkbox", { name: en.ordersRemove, exact: true }).check();
    await page.getByLabel(t("en", "ordersReasonForRemoving", { number: numbers[0] })).fill("Keep at SoHo");
    await page.getByRole("checkbox", { name: "#" + numbers[1] }).check();
    const firstBatch = await page.getByRole("heading", { name: /^SOHO-B/ }).innerText();
    await confirmAction(page, en.ordersSaveChanges, t("en", "ordersConfirmSave", { batch: firstBatch }));
    await expect(page.getByRole("checkbox", { name: "#" + numbers[0] })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "#" + numbers[1] })).toHaveCount(0);
    await confirmAction(page, en.ordersCancelBatch, t("en", "ordersConfirmCancel", { batch: firstBatch }));
    await expect(page.getByRole("checkbox", { name: "#" + numbers[1] })).toBeVisible();
    expect(
      (
        await pool.query("select kind from operations where staff_id=$1 order by created_at", [staff])
      ).rows.map((r) => r.kind),
    ).toEqual(["createBatch", "updateBatch", "deleteBatch"]);
    await page.getByRole("checkbox", { name: "#" + numbers[1] }).check();
    await page.getByRole("button", { name: en.ordersCreatePlan }).click();
    await expect(page.getByRole("heading", { name: /^SOHO-B/ })).toBeVisible();
    const requests: string[] = [];
    await page.route(
      "**/api/batches",
      async (route) => {
        requests.push(route.request().postDataJSON().operationId);
        const result = await route.fetch();
        expect(result.status()).toBe(200);
        await route.abort();
      },
      { times: 1 },
    );
    await page.route(
      "**/api/batches?check=1",
      async (route) => {
        requests.push(route.request().postDataJSON().operationId);
        await route.abort();
      },
      { times: 1 },
    );
    await confirmAction(page, en.ordersMarkSent, t("en", "ordersConfirmSendOne", { batch: await page.getByRole("heading", { name: /^SOHO-B/ }).innerText() }));
    await expect(page.getByText(en.retryToCheck)).toBeVisible();
    expect(await pendingKeys()).toHaveLength(1);
    const statusCheck = page.waitForRequest((req) => req.url().endsWith("/api/batches?check=1"));
    await page.reload();
    requests.push((await statusCheck).postDataJSON().operationId);
    await expect(page.getByText(en.alreadySaved, { exact: true })).toBeVisible();
    expect(await pendingKeys()).toEqual([]);
    expect(requests).toHaveLength(3);
    expect(new Set(requests).size).toBe(1);
    expect((await pool.query("select * from handoffs where operation_id=$1", [requests[0]])).rowCount).toBe(
      1,
    );
    const sentBatch = (await pool.query("select batch_id from handoffs where operation_id=$1", [requests[0]]))
      .rows[0].batch_id as string;
    await expect(page.getByText(t("en", "ordersSentStatus", { batch: sentBatch }))).toBeVisible();
    await page.getByRole("link", { name: "East Village", exact: true }).click();
    await page.getByRole("link", { name: sentBatch, exact: true }).click();
    await expect(page.getByRole("heading", { name: sentBatch, exact: true })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: en.didNotTravel })).toHaveCount(0);
    await pool.query("update staff set role='admin' where id=$1", [staff]);
    await page.reload();
    await page.getByRole("checkbox", { name: en.didNotTravel }).check();
    await page.getByLabel(t("en", "ordersReasonFor", { number: numbers[1] })).fill("Stayed at SoHo");
    await confirmAction(page, en.ordersRecordCorrection, en.ordersConfirmMissing);
    await expect(
      page.getByRole("status").filter({ hasText: en.contentsChanged }),
    ).toBeVisible();
    await expect(page.getByText(`${en.didNotTravel} · Stayed at SoHo`)).toBeVisible();
    await pool.query("update staff set role='staff' where id=$1", [staff]);
    await page.reload();
    await expect(page.getByText(en.ordersReceiveBeforeConfirm)).toBeVisible();
    await expect(page.getByRole("button", { name: en.ordersConfirmContents })).toHaveCount(0);
    await page.getByRole("link", { name: en.board, exact: true }).click();
    const arriving = page
      .getByRole("region", { name: en.boardArriving })
      .getByRole("listitem")
      .filter({ has: page.getByRole("link", { name: sentBatch, exact: true }) });
    await arriving.getByRole("button", { name: en.boardReceive }).click();
    const receipt = page.getByRole("dialog", { name: en.boardReceive });
    await expect(receipt.locator("p")).toHaveText(t("en", "boardConfirmAction", { action: en.boardReceive, id: sentBatch }));
    await receipt.getByRole("button", { name: en.boardReceive }).click();
    await expect(
      page.getByText(`${en.phaseReceived} · ${t("en", "boardReadyCount", { count: 0, total: 0 })}`),
    ).toBeVisible();
    await page.getByRole("link", { name: en.boardCheckSent }).click();
    await page.route(
      "**/api/batches",
      async (route) => {
        expect((await route.fetch()).status()).toBe(200);
        await route.abort();
      },
      { times: 1 },
    );
    await page.getByRole("button", { name: en.ordersConfirmContents }).click();
    const diff = page.getByRole("dialog", { name: en.ordersConfirmContents });
    await expect(diff.locator("p")).toHaveText(t("en", "ordersConfirmRemaining", { batch: sentBatch, store: "East Village" }));
    await expect(diff.getByText(en.ordersNoneRemaining)).toBeVisible();
    await expect(diff.locator("del")).toHaveText("#" + numbers[1]);
    await diff.getByRole("button", { name: en.ordersConfirmContents }).click();
    await expect(page.getByText(en.alreadySaved, { exact: true })).toBeVisible();
    await expect(page.getByText(t("en", "ordersConfirmedEmpty", { name: "Robin" }))).toBeVisible();
    await expect(page.getByRole("button", { name: en.ordersConfirmContents })).toHaveCount(0);
    await page.goto("/board?store=east_village&batch=" + sentBatch);
    await expect(page.getByRole("button", { name: en.boardBackToSent })).toHaveCount(0);
    await pool.query("update staff set role='admin' where id=$1", [staff]);
    await page.reload();
    await page.getByRole("button", { name: en.boardBackToSent }).click({ timeout: 5000 });
    await page.getByLabel(en.boardCorrectionReason).fill("Receipt recorded for the wrong trip");
    await page.getByRole("button", { name: en.boardSaveCorrection }).click();
    await expect(page.getByText("Receipt recorded for the wrong trip", { exact: false })).toBeVisible();
  } finally {
    await pool.query("delete from handoffs where staff_id=$1", [staff]);
    await pool.query(
      "delete from batch_orders where batch_id in (select id from batches where created_by=$1)",
      [staff],
    );
    await pool.query("delete from batches where created_by=$1", [staff]);
    await pool.query("delete from operations where staff_id=$1", [staff]);
    await pool.query("delete from cents_orders where store_id='soho' and order_number=any($1)", [numbers]);
    await pool.query("delete from sessions where staff_id=$1", [staff]);
    await pool.query("delete from staff where id=$1", [staff]);
    await pool.end();
  }
});
