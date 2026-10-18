/**
 * scripts/blacklist-from-revocations.ts — R5 N1: reads the 16 Oct 2026 (IST) revocation rows from the database and writes the exact lowercase addresses to a NEW 0600 JSON file at the path given as the only
 * argument, for `mcp-keys.ts blacklist-file` (SCRIBE_MCP_BLACKLIST_FILE=<that path>). Prints ONLY the count. Never an address.
 *
 *   npx tsx scripts/blacklist-from-revocations.ts <path-outside-the-repo>
 *
 * Source rows: mcp_person revoked on that IST day, plus addresses whose mcp_key rows were revoked that day and who hold no live key now (a plain rotation leaves a live key, so it is not a revocation).
 * Refuses an existing file, a path inside the repo, no rows, or more than 50 addresses. Exit 0 ok, 1 refused.
 */
import { closeSync, openSync, unlinkSync, writeSync } from "node:fs";
import { relative, resolve } from "node:path";
import { revocationAddresses16Oct } from "../lib/mcp/blacklist-file";

async function main(argv: string[]): Promise<number> {
  const target = argv[0];
  if (!target || argv.length !== 1) { console.error("usage: blacklist-from-revocations.ts <path>"); return 1; }
  const path = resolve(target);
  const rel = relative(resolve(process.argv[1] ?? ".", "..", ".."), path);
  if (!rel.startsWith("..") && !rel.startsWith("/")) { console.error("refused: path is inside the repo"); return 1; }
  const rows = await revocationAddresses16Oct();
  const emails = [...new Set(rows)].filter((e) => e === e.toLowerCase() && /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(e)).sort();
  if (emails.length === 0 || emails.length > 50 || emails.length !== new Set(rows).size) { console.error(`refused: ${emails.length} usable addresses of ${rows.length} rows`); return 1; }
  let fd: number;
  try { fd = openSync(path, "wx", 0o600); } catch { console.error("refused: cannot create the file (exists, or no permission)"); return 1; }
  try { writeSync(fd, JSON.stringify(emails)); } catch { closeSync(fd); try { unlinkSync(path); } catch { /* best effort */ } console.error("refused: write failed"); return 1; }
  closeSync(fd);
  console.log(`addresses=${emails.length}`);
  return 0;
}

main(process.argv.slice(2)).then((c) => process.exit(c), () => { console.error("failed (database)"); process.exit(1); });
