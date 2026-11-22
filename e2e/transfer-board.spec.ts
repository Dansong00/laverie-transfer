import { createHmac, randomUUID } from "node:crypto";
import { expect, test, type BrowserContext } from "@playwright/test";
import pg from "pg";

test("two staff see departures across phones, with independent section preferences", async ({
  browser,
  page,
  context,
}) => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const second = await browser.newContext({ baseURL: "http://127.0.0.1:3000" });
  const ids: string[] = [];
  const tickets = Array.from({ length: 5 }, () => "BOARD-" + randomUUID());
  async function signIn(client: BrowserContext, phone: string) {
    const staff = randomUUID(),
      session = randomUUID();
    await pool.query("insert into staff(id,name,phone,role,created_at) values ($1,'Sam',$2,'staff',now())", [
      staff,
      phone,
    ]);
    ids.push(staff);
    await pool.query(
      "insert into sessions(id,staff_id,created_at,last_used_at,expires_at) values ($1,$2,now(),now(),now()+interval '1 day')",
      [session, staff],
    );
    const signature = createHmac("sha256", "playwright-only-session-key-for-local-tests")
      .update("session:" + session)
      .digest("hex");
    await client.addCookies([
      {
        name: "laverie_session",
        value: session + "." + signature,
        url: "http://127.0.0.1:3000",
        httpOnly: true,
        secure: true,
      },
    ]);
  }
  async function send(...selected: string[]) {
    const make = await second.request.post("/api/batches", {
      data: { kind: "createBatch", operationId: randomUUID(), origin: "soho", add: selected },
    });
    expect(make.ok()).toBeTruthy();
    const id = (await make.json()).result.batchId;
    const sent = await second.request.post("/api/batches", {
      data: {
        kind: "runAction",
        action: "send",
        origin: "soho",
        batchId: id,
        expectedVersion: 1,
        operationId: randomUUID(),
      },
    });
    expect(sent.ok()).toBeTruthy();
    return id as string;
  }
  try {
    await signIn(context, "+12125550191");
    await signIn(second, "+12125550192");
    await pool.query(
      "insert into cents_orders(store_id,order_number,status,source,created_at,updated_at) select 'soho',n,'SUBMITTED','webhook',now(),now() from unnest($1::text[]) n",
      [tickets],
    );
    await page.clock.install();
    await page.goto("/board?store=east_village");
    await expect(page.getByRole("region", { name: "Arriving" })).toBeVisible();
    const first = await send(tickets[0]);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(
      page.getByRole("region", { name: "Arriving" }).getByRole("link", { name: first }),
    ).toBeVisible();
    const next = await send(...tickets.slice(1));
    await page.clock.fastForward(45_000);
    await expect(page.getByRole("link", { name: next, exact: true })).toBeVisible();
    await page.getByRole("link", { name: first, exact: true }).click();
    await expect(page.getByText("#" + tickets[0], { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/^Operation /)).toBeVisible();
    await page.getByRole("link", { name: "Back to East Village board" }).click();
    await page.getByText("Board sections", { exact: true }).click();
    await page.getByRole("checkbox", { name: "Arriving", exact: true }).uncheck();
    await page.getByRole("button", { name: "Save sections" }).click();
    await expect(page.getByRole("region", { name: "Arriving" })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("region", { name: "Processing" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Arriving" })).toHaveCount(0);
    const other = await second.newPage();
    await other.goto("/board?store=east_village");
    await expect(
      other.getByRole("region", { name: "Arriving" }).getByRole("link", { name: first }),
    ).toBeVisible();
    await expect(other.getByRole("region")).toHaveCount(7);
    const card = other
      .getByRole("region", { name: "Arriving" })
      .getByRole("listitem")
      .filter({ has: other.getByRole("link", { name: next, exact: true }) });
    other.on("dialog", (d) => d.accept());
    await card.getByRole("button", { name: "Mark received" }).click();
    await other.getByRole("button", { name: "Start processing", exact: true }).first().click();
    await other.getByRole("button", { name: "Mark ready", exact: true }).first().click();
    await expect(other.getByText("Received · 1 of 4 ready")).toBeVisible();
    await other.getByRole("link", { name: "Back to East Village board" }).click();
    const received = other.getByRole("region", { name: "Received", exact: true });
    await expect(received.getByText("1 of 4 ready", { exact: true })).toBeVisible();
    await received.getByRole("link", { name: next, exact: true }).click();
    await other.getByRole("button", { name: "Start processing 3 received orders" }).click();
    await expect(other.getByText("Processing · 1 of 4 ready")).toBeVisible();
    await other.route(
      "**/api/batches",
      async (route) => {
        expect((await route.fetch()).status()).toBe(200);
        await route.abort();
      },
      { times: 1 },
    );
    await other.getByRole("button", { name: "Mark 3 remaining ready" }).click();
    await expect(other.getByText("Already saved.", { exact: true })).toBeVisible();
    await expect(other.getByText("Ready for return · 4 of 4 ready")).toBeVisible();
  } finally {
    await second.close();
    await pool.query("delete from handoffs where staff_id=any($1::uuid[])", [ids]);
    await pool.query(
      "delete from batch_orders where batch_id in (select id from batches where created_by=any($1::uuid[]))",
      [ids],
    );
    await pool.query("delete from batches where created_by=any($1::uuid[])", [ids]);
    await pool.query("delete from operations where staff_id=any($1::uuid[])", [ids]);
    await pool.query("delete from staff_preferences where staff_id=any($1::uuid[])", [ids]);
    await pool.query("delete from sessions where staff_id=any($1::uuid[])", [ids]);
    await pool.query("delete from staff where id=any($1::uuid[])", [ids]);
    await pool.query("delete from cents_orders where order_number=any($1)", [tickets]);
    await pool.end();
  }
});
