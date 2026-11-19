import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) {
    process.loadEnvFile(file);
  }
}

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    env: process.env.DATABASE_URL
      ? { DATABASE_URL: process.env.DATABASE_URL }
      : {},
  },
});
