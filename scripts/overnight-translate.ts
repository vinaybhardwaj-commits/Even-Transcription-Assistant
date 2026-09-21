/**
 * scripts/overnight-translate.ts — launcher for the overnight transcribe + translate driver.
 *
 * It reads the two credentials the driver needs at RUN TIME and puts them in this process's ENVIRONMENT ONLY.
 * Nothing is printed, logged, written to a file or placed on a command line. Then it imports the driver.
 * Modelled on scripts/night-drain.ts (vinay/mini-night-drain).
 *
 *   database  the postgres:// string in the RTF the Orchestrator's console also reads, by regex → APP_DATABASE_URL.
 *             The driver only ever SELECTs (select.ts; a test asserts it), but it holds a full connection string,
 *             so it is read here, in memory, and never touched again.
 *   the door  OVERNIGHT_TRANSLATE_TOKEN from a mode-600 file (OVERNIGHT_TRANSLATE_TOKEN_FILE, default
 *             ~/.claude/secrets/overnight_translate_mcp_token). NO SUCH FILE EXISTS TODAY and this build does not
 *             create one: the token is V's to issue at deploy (an `invoke`-scope SCRIBE_MCP_TOKENS entry for actor
 *             `overnight-translate`). Without it, `--mode run` refuses to start; `--mode dry-run` needs none.
 *   APP_URL   defaults to https://www.evenscribe.app. The apex host is refused by main.ts (it redirects and drops
 *             the bearer).
 *
 * A value that is the literal Vercel placeholder "[SENSITIVE]" counts as missing.
 *
 * Build:  node_modules/.bin/esbuild scripts/overnight-translate.ts --bundle --platform=node --format=esm \
 *           --banner:js="import {createRequire} from 'module'; const require = createRequire(import.meta.url);" \
 *           --outfile=$HOME/overnight-translate/overnight-translate.mjs
 * Look:   node $HOME/overnight-translate/overnight-translate.mjs --mode dry-run --limit 20 --fixtures rd_a,rd_b
 * Run:    node $HOME/overnight-translate/overnight-translate.mjs --mode run   (needs the token file; not started by this build)
 */
import { readFileSync } from "node:fs";

const HOME = process.env.HOME ?? "";
const DB_FILE = process.env.OVERNIGHT_TRANSLATE_DB_FILE ?? `${HOME}/dev/Neon Database Connection String.rtf`;
const TOKEN_FILE = process.env.OVERNIGHT_TRANSLATE_TOKEN_FILE ?? `${HOME}/.claude/secrets/overnight_translate_mcp_token`;
const isReal = (v: string | undefined): v is string => !!v && !v.includes("SENSITIVE");

if (!isReal(process.env.APP_DATABASE_URL)) {
  try {
    const rtf = readFileSync(DB_FILE, "utf8");
    const m = /postgres(?:ql)?:\/\/[^\s\\}"']+/.exec(rtf);
    if (m) process.env.APP_DATABASE_URL = m[0];
  } catch (e) {
    console.error(`[overnight-translate] cannot read the database file (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  }
}

if (!isReal(process.env.OVERNIGHT_TRANSLATE_TOKEN)) {
  try {
    const fromFile = readFileSync(TOKEN_FILE, "utf8").trim();
    if (isReal(fromFile) && fromFile) process.env.OVERNIGHT_TRANSLATE_TOKEN = fromFile;
  } catch (e) {
    // A missing file is the normal state until V issues the token; say which kind of miss, never the path's contents.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[overnight-translate] cannot read the token file (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  }
}

const { main } = await import("../lib/overnight-translate/main");
process.exit(await main(process.argv.slice(2)));
