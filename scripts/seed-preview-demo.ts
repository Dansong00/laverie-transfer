import { sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { loadLocalEnv } from "../db/load-env";
import { centsOrders, staff } from "../db/schema";
import { configuredDemoDatabase, demoAccounts, demoEnabled } from "../staff/preview-demo";

async function seed() {
  loadLocalEnv();
  if (!demoEnabled()) throw new Error("Enable demo mode on a dedicated Preview demo database first.");
  await getDb().transaction(async tx => {
    const { rows: [db] } = await tx.execute(sql`select current_database() as name`);
    if (db.name !== configuredDemoDatabase()) throw new Error("Unexpected database for demo fixtures.");
    const { rows: [existing] } = await tx.execute(sql`
      select exists(select from staff where id not in (${demoAccounts[0].id}, ${demoAccounts[1].id}))
        or exists(select from cents_orders where source <> 'demo')
        or exists(select from cents_raw_events) as mixed
    `);
    if (existing.mixed) throw new Error("Use an empty database dedicated to sample data.");
    const now = new Date();
    for (const account of demoAccounts) {
      await tx.insert(staff).values({ ...account, role: "staff", createdAt: now }).onConflictDoNothing({ target: staff.id });
    }
    for (const storeId of ["soho", "east_village"]) {
      for (const orderNumber of ["DEMO-101", "DEMO-102", "DEMO-103"]) {
        await tx.insert(centsOrders).values({
          storeId, orderNumber, status: "IN_PROGRESS", source: "demo", createdAt: now, updatedAt: now,
        }).onConflictDoNothing();
      }
    }
  });
}

seed().catch(error => { console.error(error.message); process.exitCode = 1; });
