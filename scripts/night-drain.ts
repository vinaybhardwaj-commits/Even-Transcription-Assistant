/**
 * scripts/night-drain.ts — launcher for the overnight Mini drain.
 *
 * It reads the credentials the worker needs at RUN TIME and puts them in this process's ENVIRONMENT ONLY. Nothing is
 * printed, logged, written to a file or placed on a command line. Then it imports the worker, because lib/diarize.ts
 * reads DIARIZE_BASE_URL at import time.
 *
 *   database   the postgres:// string in the RTF the Orchestrator's console also reads, by regex → APP_DATABASE_URL
 *   the door   SCRIBE_MCP_TOKEN from a mode-600 file (NIGHT_DRAIN_MCP_TOKEN_FILE, default ~/.claude/secrets/scribe_mcp_token),
 *              else from the repo's .env.local; APP_URL from .env.local (the only two keys read from it)
 *   diarize    the Mini's own service on loopback — not the public tunnel
 *
 * A value that is the literal Vercel placeholder "[SENSITIVE]" counts as missing.
 *
 * Build:  node_modules/.bin/esbuild scripts/night-drain.ts --bundle --platform=node --format=esm \
 *           --banner:js="import {createRequire} from 'module'; const require = createRequire(import.meta.url);" \
 *           --outfile=$HOME/night-drain/night-drain.mjs
 * Run:    node $HOME/night-drain/night-drain.mjs [--mode run|dry-run|audio-only] [--limit N]
 */
import { readFileSync } from "node:fs";

const DB_FILE = process.env.NIGHT_DRAIN_DB_FILE ?? "/Users/vinaybhardwaj/dev/Neon Database Connection String.rtf";
const ENV_FILE = process.env.NIGHT_DRAIN_ENV_FILE ?? "/Users/vinaybhardwaj/dev/Even-Transcription-Assistant/.env.local";
const TOKEN_FILE = process.env.NIGHT_DRAIN_MCP_TOKEN_FILE ?? `${process.env.HOME ?? ""}/.claude/secrets/scribe_mcp_token`;
const isReal = (v: string | undefined): v is string => !!v && !v.includes("SENSITIVE");

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    console.error(`[night-drain] cannot read ${path.split("/").pop()} (${(e as NodeJS.ErrnoException).code ?? "error"})`);
    return null;
  }
}

function envFileValue(text: string | null, key: string): string | undefined {
  if (!text) return undefined;
  const m = new RegExp(`^${key}=(.*)$`, "m").exec(text);
  return m ? m[1]!.trim().replace(/^["']|["']$/g, "") : undefined;
}

if (!isReal(process.env.APP_DATABASE_URL)) {
  const rtf = readFileOrNull(DB_FILE);
  const m = rtf ? /postgres(?:ql)?:\/\/[^\s\\}"']+/.exec(rtf) : null;
  if (m) process.env.APP_DATABASE_URL = m[0];
}
if (!isReal(process.env.SCRIBE_MCP_TOKEN)) {
  // A token file wins over .env.local: the pulled .env.local can be older than the deployed token. A missing file is normal.
  let fromFile: string | null = null;
  try {
    fromFile = readFileSync(TOKEN_FILE, "utf8").trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[night-drain] cannot read the token file (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  }
  if (isReal(fromFile ?? undefined) && fromFile) process.env.SCRIBE_MCP_TOKEN = fromFile;
}
const envText = isReal(process.env.SCRIBE_MCP_TOKEN) && isReal(process.env.APP_URL) ? null : readFileOrNull(ENV_FILE);
for (const k of ["APP_URL", "SCRIBE_MCP_TOKEN"]) {
  if (!isReal(process.env[k])) {
    const v = envFileValue(envText, k);
    if (isReal(v)) process.env[k] = v;
  }
}
process.env.DIARIZE_BASE_URL = process.env.NIGHT_DRAIN_DIARIZE_URL ?? "http://127.0.0.1:8001";

const { main } = await import("../lib/night-drain/main");
process.exit(await main(process.argv.slice(2)));
