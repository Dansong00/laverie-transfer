import { existsSync } from "node:fs";

// First file wins. Existing process env, including CI, is left untouched.
export function loadLocalEnv(): void {
  for (const file of [".env.local", ".env"]) {
    if (existsSync(file)) {
      process.loadEnvFile(file);
    }
  }
}
