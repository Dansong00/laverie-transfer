import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const journal = JSON.parse(
  readFileSync("drizzle/meta/_journal.json", "utf8"),
) as { entries: unknown[] };

test("health route reads Postgres", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);

  const body = await response.json();
  expect(body).toMatchObject({
    ok: true,
    database: "up",
  });
  expect(body.migrationVersion.id).toBeGreaterThan(0);
  expect(body.migrationVersion.hash).toMatch(/^[a-f0-9]{64}$/);
  expect(body.migrationVersion.createdAt).toMatch(/^\d+$/);
});

test("home page shows the health result", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Laverie Transfer" }),
  ).toBeVisible();
  await expect(page.getByText('"database": "up"')).toBeVisible();
  await expect(
    page.getByText(`"id": ${journal.entries.length}`),
  ).toBeVisible();
});
