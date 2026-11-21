import { expect, test } from "@playwright/test";

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
