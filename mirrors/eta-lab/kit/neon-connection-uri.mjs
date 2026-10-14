// Prints a live Neon connection URI to stdout -- nothing else. Same project/creds path as
// kit/neon-select.mjs (~/.claude/secrets/neon_api_key), but with NO read-only restriction: this
// is meant to populate a DB env var for trusted, already-reviewed code (e.g. lib/db.ts via
// APP_DATABASE_URL), not to run an arbitrary query itself.
//
// Usage: node neon-connection-uri.mjs [--pooled]   (default: direct, not the -pooler endpoint --
//   orders/queue 001-herdr-kit.md item 1: no eta_database_url secret exists anywhere; lanes
//   needing a real Postgres connection string (not just SELECT-via-neon-select.mjs) get one
//   here instead, fetched fresh each run rather than stored anywhere on disk.)
//
// Caller contract: capture this script's stdout directly into an env var
// (`VAR="$(node neon-connection-uri.mjs)"`) -- never let it pass through a shell that might
// echo or log the command's own output.
import fs from "node:fs";

const pooled = process.argv.includes("--pooled");
const key = fs.readFileSync(process.env.HOME + "/.claude/secrets/neon_api_key", "utf8").trim();
const r = await fetch(
  `https://console.neon.tech/api/v2/projects/floral-butterfly-54959636/connection_uri?database_name=neondb&role_name=neondb_owner&pooled=${pooled}`,
  { headers: { Authorization: "Bearer " + key } },
);
if (!r.ok) {
  console.error(`neon-connection-uri: HTTP ${r.status} from Neon's API`);
  process.exit(1);
}
const { uri } = await r.json();
process.stdout.write(uri);
