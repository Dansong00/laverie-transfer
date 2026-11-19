import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

const connectionTimeoutMillis = 10_000;
const queryTimeoutMillis = 5_000;

let database: NodePgDatabase | undefined;

export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    allowExitOnIdle: true,
    connectionTimeoutMillis,
    query_timeout: queryTimeoutMillis,
  });
  pool.on("error", (error: Error & { code?: string }) => {
    console.error("idle postgres client error", error.code ?? "unknown");
  });
  return pool;
}

export function getDb(): NodePgDatabase {
  if (database) {
    return database;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }

  database = drizzle(createPool(connectionString));
  return database;
}
