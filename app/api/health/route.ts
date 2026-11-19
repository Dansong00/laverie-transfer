import { connection } from "next/server";
import { getDb } from "@/db/client";
import { readHealth, type HealthReport } from "@/db/health";

const noStore = { "cache-control": "no-store" };

export async function GET() {
  await connection();

  let report: HealthReport;
  try {
    report = await readHealth(getDb());
  } catch {
    report = { ok: false, database: "down", migrationVersion: null };
  }

  return Response.json(report, {
    status: report.ok ? 200 : 503,
    headers: noStore,
  });
}
