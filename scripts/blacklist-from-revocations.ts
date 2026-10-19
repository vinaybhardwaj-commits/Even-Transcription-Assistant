/**
 * scripts/blacklist-from-revocations.ts — R5 N1 / R6: reads the 16 Oct 2026 (IST) revocations and writes the exact lowercase addresses to a NEW 0600 JSON file at the path given, for
 * `mcp-keys.ts blacklist-file` (SCRIBE_MCP_BLACKLIST_FILE=<that path>). Prints ONLY counts. Never an address.
 *
 *   npx tsx scripts/blacklist-from-revocations.ts <path-outside-the-repo>
 *   npx tsx scripts/blacklist-from-revocations.ts --dry-count        (prints `db=N env=M union=K rejected=R`, writes nothing; exit 1 when R>0)
 *
 * Two sources, unioned (exact lowercase): (db) mcp_person revoked that IST day, plus addresses whose mcp_key rows were revoked that day and who hold no live key now; (env) the key denylist env
 * (SCRIBE_MCP_TOKENS_DENY, hashes) joined to mcp_key.key_hash. Refuses an existing file, a path inside the repo (realpath of the parent directory), no rows, or more than 50 addresses. Exit 0 ok, 1 refused.
 */
import { closeSync, openSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";

export type Sources = { db: string[]; env: string[] };
const ADDRESS = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/;

async function realSources(): Promise<Sources> {
  const { revocationAddresses16Oct, denylistAddresses } = await import("../lib/mcp/blacklist-file");
  return { db: await revocationAddresses16Oct(), env: await denylistAddresses() };
}

const usable = (rows: string[]) => new Set(rows.filter((e) => e === e.toLowerCase() && ADDRESS.test(e)));

/** Real path of the parent directory plus the file name: a symlinked directory cannot hide a path inside the repo. */
function insideRepo(path: string, repoRoot: string): boolean {
  let parent: string;
  try { parent = realpathSync(dirname(path)); } catch { return true; } // a parent that cannot be resolved is refused
  const rel = relative(realpathSync(repoRoot), resolve(parent, basename(path)));
  return !rel.startsWith("..") && !rel.startsWith("/") && rel !== "";
}

export async function main(argv: string[], sources: () => Promise<Sources> = realSources, repoRoot: string = resolve(process.argv[1] ?? ".", "..", ".."), out: (s: string) => void = console.log): Promise<number> {
  const dry = argv.length === 1 && argv[0] === "--dry-count";
  const target = argv[0];
  if (!dry && (!target || argv.length !== 1)) { console.error("usage: blacklist-from-revocations.ts <path> | --dry-count"); return 1; }
  let path = "";
  if (!dry) {
    path = resolve(target!);
    if (insideRepo(path, repoRoot)) { console.error("refused: path is inside the repo"); return 1; }
  }
  const { db, env } = await sources();
  const d = usable(db);
  const e = usable(env);
  const union = [...new Set([...d, ...e])].sort();
  const rejected = new Set(db).size - d.size + (new Set(env).size - e.size); // unusable rows: the real run refuses on these, so --dry-count must too
  if (dry) { out(`db=${d.size} env=${e.size} union=${union.length} rejected=${rejected}`); return rejected > 0 ? 1 : 0; }
  if (union.length === 0) { console.error("refused: addresses=0, nothing written"); return 1; }
  if (union.length > 50 || rejected > 0) { console.error(`refused: ${union.length} usable addresses (db=${db.length} env=${env.length} rows)`); return 1; }
  let fd: number;
  try { fd = openSync(path, "wx", 0o600); } catch { console.error("refused: cannot create the file (exists, or no permission)"); return 1; }
  try { writeSync(fd, JSON.stringify(union)); } catch { closeSync(fd); try { unlinkSync(path); } catch { /* best effort */ } console.error("refused: write failed"); return 1; }
  closeSync(fd);
  out(`db=${d.size} env=${e.size} addresses=${union.length}`);
  return 0;
}

if (basename(process.argv[1] ?? "") === "blacklist-from-revocations.ts") {
  main(process.argv.slice(2)).then((c) => process.exit(c), () => { console.error("failed (database)"); process.exit(1); });
}
