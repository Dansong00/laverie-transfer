import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

let database: NodePgDatabase | undefined;

export function getDb(): NodePgDatabase {
  if (database) {
    return database;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }

  database = drizzle(
    new pg.Pool({
      connectionString,
      max: 5,
      allowExitOnIdle: true,
    }),
  );
  return database;
}
