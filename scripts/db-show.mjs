import pg from "pg";

if (process.argv[2] !== "raw-events") throw new Error("Usage: pnpm db:show raw-events");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const { rows } = await client.query("select * from cents_raw_events order by id desc limit 50");
  console.log(JSON.stringify(rows, null, 2));
} finally {
  await client.end();
}
