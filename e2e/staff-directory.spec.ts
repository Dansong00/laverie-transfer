import { createHmac, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { directoryErrors } from "../i18n/directory-errors";
import { confirmAction } from "./transfer-fixtures";
import { t } from "../i18n";
import { en } from "../i18n/en";

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
    await page.getByRole("button", { name: en.menuOpen }).click();
    await page.getByRole("link", { name: en.directory }).click();
    await page.getByText(en.staffAdd, { exact: true }).click();
    await page.getByLabel(en.name, { exact: true }).fill("Jordan");
    await page.getByLabel(en.mobileNumber).fill(newPhone);
    await page.getByRole("button", { name: en.staffAddMember }).click();
    const member = page.getByRole("listitem").filter({ hasText: "Jordan" });
    await expect(member).toContainText(newPhone);
    await confirmAction(page, en.staffMakeAdmin, t("en", "staffConfirmMakeAdmin", { name: "Jordan" }), member);
    await expect(member).toContainText(`${en.admin} · ${newPhone} · ${en.staffActive}`);
    await confirmAction(page, en.staffDisable, t("en", "staffConfirmDisable", { name: "Jordan" }), member);
    await expect(member).toContainText(`${en.admin} · ${newPhone} · ${en.staffDisabled}`);
    const self = page.getByRole("listitem").filter({ hasText: phone });
    await confirmAction(page, en.staffMakeStaff, t("en", "staffConfirmMakeStaff", { name: "Avery" }), self);
    await expect(page.getByRole("status")).toHaveText(directoryErrors.DIRECTORY_LAST_ACTIVE_ADMIN.en);
    await page.reload();
    await expect(member).toContainText(en.staffDisabled);
    await confirmAction(page, en.staffEnable, t("en", "staffConfirmEnable", { name: "Jordan" }), member);
    await expect(member).toContainText(`${en.admin} · ${newPhone} · ${en.staffActive}`);
    await page.reload();
    await expect(member.getByRole("button", { name: en.staffDisable, exact: true })).toBeVisible();
  } finally {
    await pool.query("delete from operations where staff_id=$1", [admin]);
    await pool.query("delete from sessions where staff_id=$1", [admin]);
    await pool.query("delete from staff where phone=any($1)", [[phone, newPhone]]);
    await pool.end();
  }
});
