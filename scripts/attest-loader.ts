/**
 * scripts/attest-loader.ts — validate a coordinator's attestation sheet. DRY RUN ONLY (see lib/attest/cli.ts).
 *
 *   APP_DATABASE_URL=... npx tsx scripts/attest-loader.ts --file sheet.csv --attested-by "<who>"
 *
 * The connection string comes from the environment of THIS process only. Never put it on the command line.
 */
import { readFileSync } from "node:fs";
import { sql } from "../lib/db";
import { runLoader } from "../lib/attest/cli";

runLoader({
  argv: process.argv.slice(2),
  sql: sql as unknown as Parameters<typeof runLoader>[0]["sql"],
  readInput: (p) => readFileSync(p === "-" ? 0 : p, "utf8"),
  out: (line) => console.log(line),
  now: () => new Date(),
}).then(
  (code) => process.exit(code),
  (err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); },
);
