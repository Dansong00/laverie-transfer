import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { CsvError, parse } from "csv-parse";
import { insertBackfillRow, prepareBackfillRow, reportLocations, ReportError, type ReportRow } from "../cents/backfill";
import { loadLocalEnv } from "../db/load-env";

const fields = new Map<string, keyof ReportRow>([
  ["order code", "orderCode"], ["location", "location"], ["status", "status"],
  ["due date", "dueDate"], ["first name", "firstName"], ["last name", "lastName"],
  ["customer first name", "firstName"], ["customer last name", "lastName"],
]);

async function* decodeCsv(source: AsyncIterable<Buffer>) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for await (const chunk of source) {
    try { yield decoder.decode(chunk, { stream: true }); }
    catch { throw new ReportError("Expected a UTF-8 CSV file."); }
  }
  try { yield decoder.decode(); }
  catch { throw new ReportError("Expected a UTF-8 CSV file."); }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const paths = args.filter(arg => arg !== "--dry-run");
  if (paths.length !== 1 || paths[0].startsWith("--") || args.length !== (dryRun ? 2 : 1)) {
    throw new ReportError("Usage: pnpm cents:backfill [--dry-run] <orders-report.csv>");
  }
  loadLocalEnv();
  if (!dryRun) {
    if (!process.env.DATABASE_URL) throw new ReportError("Set DATABASE_URL before importing.");
    console.log("Writing to database host", new URL(process.env.DATABASE_URL).hostname);
  }
  const locations = reportLocations();
  let headerSeen = false;
  let record = 1, inserted = 0, invalid = 0;
  const counts = new Map<string, number>();
  const parser = parse({
    bom: true, skip_empty_lines: true, relax_column_count: true,
    on_record(row, context) { return context.error ? { invalidColumns: true } : row; },
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
    await pipeline(createReadStream(paths[0]), decodeCsv, parser, async source => {
      for await (const row of source) {
        record++;
        try {
          if (row.invalidColumns) throw new ReportError("Wrong number of columns");
          const prepared = prepareBackfillRow(row, locations);
          if (dryRun) {
            const key = prepared.location.storeId + " " + prepared.status;
            counts.set(key, (counts.get(key) ?? 0) + 1);
          } else if (await insertBackfillRow(prepared) === "inserted") inserted++;
        } catch (error) {
          if (!dryRun || !(error instanceof ReportError)) throw error;
          invalid++;
          console.error(`Report record ${record}: ${error.message}`);
        }
      }
    });
  } catch (error) {
    if (error instanceof CsvError) throw new ReportError(`Invalid CSV at line ${error.lines ?? "unknown"}.`);
    if (error instanceof ReportError) throw new ReportError(`Report record ${record}: ${error.message}`);
    throw new ReportError(`Import stopped at record ${record}. Check the file, database connection and field formats.`);
  }
  if (!headerSeen) throw new ReportError("Missing report header");
  if (dryRun) {
    for (const [key, count] of [...counts].sort()) console.log(key, count);
    console.log(`Checked ${record - 1} records. ${invalid} invalid. No writes.`);
    if (invalid) process.exitCode = 1;
  } else {
    console.log(`Inserted ${inserted} orders; ${record - 1 - inserted} already present.`);
  }
}

main().catch(error => {
  console.error(error instanceof ReportError ? error.message : "Import failed. Check the Cents store mapping.");
  process.exitCode = 1;
});
