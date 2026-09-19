/**
 * scripts/jev-bench.ts — the J4 bench runner (ETA-JEV-ARM-D §7). READ-ONLY: it never writes a row.
 *
 *   npx --no-install tsx scripts/jev-bench.ts --fixture tests/fixtures/jev/bench-fixture.json
 *   APP_DATABASE_URL=… npx --no-install tsx scripts/jev-bench.ts --room-days rd_scratch_a,rd_scratch_b
 *   npx --no-install tsx scripts/jev-bench.ts --help
 *
 * THIS SCRIPT IS NOT AUTHORISED TO RUN ON LIVE ROOM-DAYS. The default mode reads scratch days
 * (`room_day.scratch = true`) only, and `--mode live` refuses to start unless the environment
 * carries JEV_BENCH_LIVE=V_HAS_CLEARED_J4 — V's explicit word for J4. The database URL is read from
 * APP_DATABASE_URL by name and is never printed. Output is counts, ids, ratios and seconds: no
 * transcript text, no name, no room label.
 *
 * All logic lives in lib/jev/bench-cli.ts and is tested there; this file only wires the real
 * environment, filesystem and Neon HTTP handle into it.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { neon } from "@neondatabase/serverless";
import { main } from "../lib/jev/bench-cli";
import { dbReader, type Sql } from "../lib/jev/bench-reader";

async function run(): Promise<void> {
  const code = await main(process.argv.slice(2), {
    env: process.env,
    readText: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
    writeText: (p, t) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); },
    makeDbReader: (url) => dbReader(neon(url) as unknown as Sql),
    now: () => new Date(),
    log: (l) => console.log(l),
  });
  process.exit(code);
}

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invokedDirectly) {
  run().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
