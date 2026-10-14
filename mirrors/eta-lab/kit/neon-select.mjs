// Read-only production query helper for panes (box or Mini). Usage:
//   cd <an ETA repo checkout> && node ~/dev/eta-lab/kit/neon-select.mjs "SELECT ..."   (prints JSON rows)
// Refuses anything that is not a single SELECT/WITH statement. Never prints the connection string.
// Counts/ids/codes only in reports — never transcript text.
//
// eta-refuter-2 FAIL, 23 Sep (studies/2026-09-23-neon-select-refuter-2/VERDICT.md): the old keyword
// blocklist let `SELECT ... INTO t` (creates a table), `SELECT setval/nextval(...)` (moves a sequence),
// and `SELECT pg_terminate_backend(pid) FROM pg_stat_activity` (kills an arbitrary connection) all
// through, running as neondb_owner against production. Two layers now, neither alone sufficient:
// (1) the query runs inside a Postgres READ ONLY transaction (driver supports it natively) --
// verified live: SELECT INTO is refused by Postgres itself ("cannot execute SELECT INTO in a
// read-only transaction"), so is setval/nextval. (2) the blocklist is widened to also refuse the
// backend-control and large-object functions a read-only transaction does NOT stop (calling
// pg_terminate_backend is just a function call, not a "write", from Postgres's own point of view).
// The real fix -- connecting as an actual SELECT-only role instead of neondb_owner -- is a
// production database change and is NOT done here; flagged to Fable/V.
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(process.cwd() + "/");
const { neon } = require("@neondatabase/serverless");
const q = (process.argv[2] || "").trim().replace(/;\s*$/, "");
const BLOCKED = /\b(insert|update|delete|drop|alter|truncate|grant|create|copy|into|setval|nextval|set_config|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|lo_import|lo_export|lo_put|lo_get|dblink|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_write_file)\b/i;
if (!/^(select|with)\b/i.test(q) || q.includes(";") || BLOCKED.test(q)) {
  console.error("neon-select: only a single, plain SELECT/WITH statement is allowed"); process.exit(2);
}
const key = fs.readFileSync(process.env.HOME + "/.claude/secrets/neon_api_key", "utf8").trim();
const r = await fetch("https://console.neon.tech/api/v2/projects/floral-butterfly-54959636/connection_uri?database_name=neondb&role_name=neondb_owner&pooled=true", { headers: { Authorization: "Bearer " + key } });
if (!r.ok) {
  console.error(`neon-select: HTTP ${r.status} fetching the connection URI`); process.exit(1);
}
const { uri } = await r.json();
const sql = neon(uri);
const strings = Object.assign([q], { raw: [q] });
const [rows] = await sql.transaction([sql(strings)], { readOnly: true });
console.log(JSON.stringify(rows));
