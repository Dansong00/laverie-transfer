import { pathToFileURL } from "node:url";
import pg from "pg";

export async function bootstrapFirstAdmin(pool) {
  const phone = process.env.BOOTSTRAP_ADMIN_PHONE;
  if (!phone || !/^\+[1-9]\d{1,14}$/.test(phone)) throw new Error("Set BOOTSTRAP_ADMIN_PHONE to an E.164 number.");
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("lock table staff in share row exclusive mode");
    const exists = await client.query("select 1 from staff where role='admin' limit 1");
    if (exists.rowCount) throw new Error("An admin already exists.");
    const result = await client.query(
      "insert into staff(name,phone,role,created_at) values ('Administrator',$1,'admin',now()) returning id, name, role",
      [phone],
    );
    await client.query("commit");
    return result.rows[0];
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL before running first-admin setup.");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await bootstrapFirstAdmin(pool);
    console.log("Created first admin.");
  } catch (error) {
    console.error(error instanceof Error && !("code" in error) ? error.message : "Could not create first admin.");
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
