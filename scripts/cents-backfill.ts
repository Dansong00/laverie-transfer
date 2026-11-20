import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { CsvError, parse } from "csv-parse";
import { importBackfillRow, reportLocations, ReportError, type ReportRow } from "../cents/backfill";
import { loadLocalEnv } from "../db/load-env";

const fields = new Map<string, keyof ReportRow>([
  ["order code", "orderCode"], ["location", "location"], ["status", "status"],
  ["due date", "dueDate"], ["first name", "firstName"], ["last name", "lastName"],
  ["customer first name", "firstName"], ["customer last name", "lastName"],
]);

async function main() {
  const [, , path, ...extra] = process.argv;
  if (!path || extra.length) throw new ReportError("Usage: pnpm cents:backfill <orders-report.csv>");
  loadLocalEnv();
  if (!process.env.DATABASE_URL) throw new ReportError("Set DATABASE_URL before importing.");
  const locations = reportLocations();
  let headerSeen = false;
  let record = 1;
  let inserted = 0;
  const parser = parse({
    bom: true, skip_empty_lines: true,
    columns(headers: string[]) {
      const columns = headers.map(h => fields.get(h.trim().toLowerCase()) ?? false);
      const known = columns.filter(name => name !== false);
      if (new Set(known).size !== known.length) throw new ReportError("Duplicate report column");
      for (const required of ["orderCode", "location", "status"] as const) {
        if (!known.includes(required)) throw new ReportError(`Missing report column: ${required}`);
      }
      headerSeen = true;
      return columns;
    },
  });
  try {
    await pipeline(createReadStream(path), parser, async source => {
      for await (const row of source) {
        record++;
        if (await importBackfillRow(row, locations) === "inserted") inserted++;
      }
    });
  } catch (error) {
    if (error instanceof CsvError) throw new ReportError(`Invalid CSV at line ${error.lines ?? "unknown"}.`);
    if (error instanceof ReportError) throw new ReportError(`Report record ${record}: ${error.message}`);
    throw new ReportError(`Import stopped at record ${record}. Check the file, database connection and field formats.`);
  }
  if (!headerSeen) throw new ReportError("Missing report header");
  console.log(`Inserted ${inserted} orders; ${record - 1 - inserted} already present.`);
}

main().catch(error => {
  // Parser and database errors may contain customer values.
  console.error(error instanceof ReportError ? error.message : "Import failed. Check the Cents store mapping.");
  process.exitCode = 1;
});
