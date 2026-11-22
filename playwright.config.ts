import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) {
    process.loadEnvFile(file);
  }
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set. See README.md.");
}

// Workers inherit this run's inbox path. Only the test server writes to it.
process.env.LAVERIE_TEST_INBOX ??= join(tmpdir(), `laverie-sms-${randomUUID()}`);

export default defineConfig({
  testDir: "./e2e",
  // The browser fixtures share one database, including the count of active admins.
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:3000",
  },
  webServer: {
    command: "node --import ./e2e/sms-inbox.mjs node_modules/next/dist/bin/next start",
    url: "http://127.0.0.1:3000/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      SESSION_SECRET: "playwright-only-session-key-for-local-tests",
      APP_DOMAIN: "staff.example.test",
      SMS_PROVIDER_API_KEY: "playwright-only",
      SMS_FROM: "+12125550170",
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
