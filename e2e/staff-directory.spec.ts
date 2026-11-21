import { createHmac, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import pg from "pg";

test("admin can add staff, change a role, disable access and keep the last admin", async ({
  page,
  context,
}) => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const admin = randomUUID(),
    session = randomUUID();
  const phone = "+12125550184",
    newPhone = "+12125550185";
  await pool.query(
    "insert into staff(id,name,phone,role,created_at) values ($1,'Avery',$2,'admin',now())",
    [admin, phone],
  );
  try {
    await pool.query(
      "insert into sessions(id,staff_id,created_at,last_used_at,expires_at) values ($1,$2,now(),now(),now()+interval '1 day')",
      [session, admin],
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
    await page.goto("/");
    await expect(page.getByText(phone)).toBeVisible();
    await page.getByRole("link", { name: "Staff admin" }).click();
    await page.getByText("Add staff", { exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("Jordan");
    await page.getByLabel("Mobile number").fill(newPhone);
    await page.getByRole("button", { name: "Add staff member" }).click();
    const member = page.getByRole("listitem").filter({ hasText: "Jordan" });
    await expect(member).toContainText(newPhone);
    page.on("dialog", (dialog) => dialog.accept());
    await member.getByRole("button", { name: "Make admin" }).click();
    await expect(member).toContainText("Admin · Active");
    await member.getByRole("button", { name: "Disable" }).click();
    await expect(member).toContainText("Admin · Disabled");
    await page
      .getByRole("listitem")
      .filter({ hasText: phone })
      .getByRole("button", { name: "Make staff" })
      .click();
    await expect(page.getByRole("status")).toContainText("last active admin");
    await page.reload();
    await expect(member).toContainText("Disabled");
  } finally {
    await pool.query("delete from operations where staff_id=$1", [admin]);
    await pool.query("delete from sessions where staff_id=$1", [admin]);
    await pool.query("delete from staff where phone=any($1)", [[phone, newPhone]]);
    await pool.end();
  }
});
