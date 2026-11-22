import { createHmac, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import pg from "pg";

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
    await page.getByRole("button", { name: "Create planned batch" }).click();
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
    await page.getByRole("button", { name: "Create planned batch" }).click();
    await expect(page.getByText("Not confirmed yet.", { exact: false })).toBeVisible();
    await context.clearCookies();
    await page.getByRole("button", { name: "Check pending change" }).click();
    await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
    await context.addCookies(cookies);
    await page.goto("/orders?store=soho");
    await page.getByRole("button", { name: "Check pending change" }).click();
    await expect(page.getByText("Already saved.", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^SOHO-B/ })).toBeVisible();
    await page.getByRole("checkbox", { name: "Remove", exact: true }).check();
    await page.getByLabel("Reason for removing #" + numbers[0]).fill("Keep at SoHo");
    await page.getByRole("checkbox", { name: "#" + numbers[1] }).check();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("checkbox", { name: "#" + numbers[0] })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "#" + numbers[1] })).toHaveCount(0);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Cancel batch" }).click();
    await expect(page.getByRole("checkbox", { name: "#" + numbers[1] })).toBeVisible();
    expect(
      (
        await pool.query("select kind from operations where staff_id=$1 order by created_at", [staff])
      ).rows.map((r) => r.kind),
    ).toEqual(["createBatch", "updateBatch", "deleteBatch"]);
    await page.getByRole("checkbox", { name: "#" + numbers[1] }).check();
    await page.getByRole("button", { name: "Create planned batch" }).click();
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
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Mark sent" }).click();
    await expect(page.getByText("Not confirmed yet. Retry to check this change.")).toBeVisible();
    expect(await pendingKeys()).toHaveLength(1);
    const statusCheck = page.waitForRequest((req) => req.url().endsWith("/api/batches?check=1"));
    await page.reload();
    requests.push((await statusCheck).postDataJSON().operationId);
    await expect(page.getByText("Already saved.", { exact: true })).toBeVisible();
    await expect(page.getByText(/^Marked SOHO-B.* sent\.$/)).toBeVisible();
    expect(await pendingKeys()).toEqual([]);
    expect(requests).toHaveLength(3);
    expect(new Set(requests).size).toBe(1);
    expect((await pool.query("select * from handoffs where operation_id=$1", [requests[0]])).rowCount).toBe(
      1,
    );
    const sentBatch = (await pool.query("select batch_id from handoffs where operation_id=$1", [requests[0]]))
      .rows[0].batch_id as string;
    await page.getByRole("link", { name: "East Village", exact: true }).click();
    await page.getByRole("link", { name: sentBatch, exact: true }).click();
    await expect(page.getByRole("heading", { name: sentBatch, exact: true })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Did not travel" })).toHaveCount(0);
    await pool.query("update staff set role='admin' where id=$1", [staff]);
    await page.reload();
    await page.getByRole("checkbox", { name: "Did not travel" }).check();
    await page.getByLabel("Reason for #" + numbers[1]).fill("Stayed at SoHo");
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Record correction" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Contents changed, confirm before return" }),
    ).toBeVisible();
    await expect(page.getByText(/Did not travel · Stayed at SoHo/)).toBeVisible();
    await pool.query("update staff set role='staff' where id=$1", [staff]);
    await page.reload();
    await expect(page.getByText(/Receive the batch on the transfer board/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirm contents" })).toHaveCount(0);
    await page.getByRole("link", { name: "Transfer board" }).click();
    const arriving = page
      .getByRole("region", { name: "Arriving" })
      .getByRole("listitem")
      .filter({ has: page.getByRole("link", { name: sentBatch, exact: true }) });
    page.once("dialog", (d) => d.accept());
    await arriving.getByRole("button", { name: "Mark received" }).click();
    await expect(page.getByText("Received · 0 of 0 ready")).toBeVisible();
    await page.getByRole("link", { name: "Check sent contents" }).click();
    await page.route(
      "**/api/batches",
      async (route) => {
        expect((await route.fetch()).status()).toBe(200);
        await route.abort();
      },
      { times: 1 },
    );
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Confirm contents" }).click();
    await expect(page.getByText("Already saved.", { exact: true })).toBeVisible();
    await expect(page.getByText(/Robin confirmed no remaining orders/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirm contents" })).toHaveCount(0);
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
