import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { readHealth, type HealthReport } from "@/db/health";

export default function Home() {
  return (
    <main>
      <h1>Laverie Transfer</h1>
      <p>Health check for this environment.</p>
      <Suspense fallback={<p>Checking the database…</p>}>
        <HealthPanel />
      </Suspense>
    </main>
  );
}

async function HealthPanel() {
  await connection();
  const report = await loadReport();
  return <pre>{JSON.stringify(report, null, 2)}</pre>;
}

async function loadReport(): Promise<HealthReport> {
  try {
    return await readHealth(getDb());
  } catch {
    return { ok: false, database: "down", migrationVersion: null };
  }
}
