import { createHmac, randomUUID } from "node:crypto";
import type { BrowserContext } from "@playwright/test";
import type pg from "pg";

export async function signIn(client: BrowserContext, pool: pg.Pool, ids: string[], phone: string) {
  const staff = randomUUID(),
    session = randomUUID();
  await pool.query("insert into staff(id,name,phone,role,created_at) values ($1,'Sam',$2,'staff',now())", [
    staff,
    phone,
  ]);
  ids.push(staff);
  await pool.query(
    "insert into sessions(id,staff_id,created_at,last_used_at,expires_at) values ($1,$2,now(),now(),now()+interval '1 day')",
    [session, staff],
  );
  const signature = createHmac("sha256", "playwright-only-session-key-for-local-tests")
    .update("session:" + session)
    .digest("hex");
  await client.addCookies([
    {
      name: "laverie_session",
      value: session + "." + signature,
      url: "http://127.0.0.1:3000",
      httpOnly: true,
      secure: true,
    },
  ]);
}

export async function cleanTransfers(pool: pg.Pool, ids: string[], tickets: string[]) {
  await pool.query("delete from handoffs where staff_id=any($1::uuid[])", [ids]);
  await pool.query(
    "delete from batch_orders where batch_id in (select id from batches where created_by=any($1::uuid[]))",
    [ids],
  );
  await pool.query("delete from batches where created_by=any($1::uuid[])", [ids]);
  await pool.query("delete from operations where staff_id=any($1::uuid[])", [ids]);
  await pool.query("delete from staff_preferences where staff_id=any($1::uuid[])", [ids]);
  await pool.query("delete from sessions where staff_id=any($1::uuid[])", [ids]);
  await pool.query("delete from staff where id=any($1::uuid[])", [ids]);
  await pool.query("delete from cents_orders where order_number=any($1)", [tickets]);
  await pool.query("delete from cents_raw_events where body->'order'->>'orderCode'=any($1::text[])", [tickets]);
  await pool.end();
}
