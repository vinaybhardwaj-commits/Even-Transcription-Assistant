// The mockup dataset is generated, not committed (it is over 1 MiB). Generate it when missing; safe under parallel test processes (write to a temp file, then rename).
import { existsSync, renameSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const MOCKUP_PATH = join(here, "..", "fixtures", "synthetic", "mockup.json");
export function ensureMockup() {
  if (existsSync(MOCKUP_PATH)) return MOCKUP_PATH;
  const tmp = MOCKUP_PATH + "." + process.pid + ".tmp";
  try {
    execFileSync(process.execPath, [join(here, "gen-fixtures.mjs")], { env: { ...process.env, GEN_OUT: tmp } });
    renameSync(tmp, MOCKUP_PATH);   // the output is deterministic, so replacing an identical file written by a racing process is harmless
  } finally { rmSync(tmp, { force: true }); }   // nothing is left behind on failure
  return MOCKUP_PATH;
}
