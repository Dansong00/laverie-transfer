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
    const cookies = await context.cookies();
    await context.clearCookies();
    await page.getByRole("button", { name: "Check pending change" }).click();
    await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
    await context.addCookies(cookies);
    await page.goto("/orders?store=soho");
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
  } finally {
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
