/**
 * lib/overnight-translate/main.ts — argument parsing and wiring for the overnight driver.
 *
 *   node overnight-translate.mjs [--mode run|dry-run] [--limit N] [--fixtures rd_a,rd_b,...]
 *
 *   run       Waits for closed hours (21:30-07:10 IST), then submits `room_window` jobs one at a time. Needs a token.
 *   dry-run   `--limit N` (1..500). Prints the plan — which windows, in what order, which need the override — and
 *             the counts. Submits NOTHING, needs NO token, touches no clock or gate. The safe way to look.
 *
 * NOTHING HERE READS A SECRET FILE. The launcher (scripts/overnight-translate.ts) puts the database string and the
 * token into this process's ENVIRONMENT before importing this module, exactly as the night-drain's launcher does;
 * this module only reads `process.env`. So a test can drive `main` with an env object and no filesystem.
 *
 * FIXTURES come in by flag or `OVERNIGHT_FIXTURE_ROOM_DAYS` (comma-separated room_day ids), never from source.
 *
 * THE ORIGIN MUST BE THE CANONICAL HOST. `evenscribe.app` answers a POST with a 307 to `www.evenscribe.app`, and a
 * cross-origin redirect drops the Authorization header — the door then answers 401 to a valid token, and the job's
 * own segment step (which posts cues back to the origin) fails the same way. So an apex APP_URL is refused here
 * rather than left to look like a bad token at 02:00.
 *
 * EXIT CODES: 0 finished or stopped by the clock / empty backlog / a signal; 2 a fatal stop or a start-up refusal.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { sql } from "@/lib/db";
import { makeStore, type SqlTag } from "./select";
import { makeDoor } from "./door";
import { runOvernight, ACTOR, DEFAULT_MAX_FAILED_JOBS, type Deps } from "./driver";
import { DEFAULT_PRESSURE_FILE, gateDecision, readLastLine, freeDiskGb } from "./gate";

export const DEFAULT_APP_URL = "https://www.evenscribe.app";

export type Parsed =
  | { ok: true; mode: "run" | "dry-run"; limit: number; fixtures: string[] }
  | { ok: false; code: string };

/** PURE — argv + env → options, or a closed refusal code. */
export function parseArgs(argv: readonly string[], env: Record<string, string | undefined>): Parsed {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const mode = (arg("--mode") ?? "run") as "run" | "dry-run";
  if (mode !== "run" && mode !== "dry-run") return { ok: false, code: "bad_mode" };
  const limit = Number(arg("--limit") ?? 0);
  if (!Number.isInteger(limit) || limit < 0) return { ok: false, code: "bad_limit" };
  if (mode === "dry-run" && !(limit >= 1 && limit <= 500)) return { ok: false, code: "dry_run_needs_limit_1_to_500" };
  const raw = arg("--fixtures") ?? env.OVERNIGHT_FIXTURE_ROOM_DAYS ?? "";
  const fixtures = raw.split(",").map((x) => x.trim()).filter(Boolean);
  for (const f of fixtures) if (!/^rd_[A-Za-z0-9_]{1,60}$/.test(f)) return { ok: false, code: "bad_fixture_id" };
  return { ok: true, mode, limit, fixtures };
}

/** PURE — is this base URL the canonical host? Refuses the apex, which redirects and drops the bearer. */
export function originProblem(appUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(appUrl);
  } catch {
    return "bad_app_url";
  }
  if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") return "app_url_not_https";
  if (u.hostname === "evenscribe.app") return "apex_origin_redirects_and_drops_the_bearer";
  return null;
}

const abortableSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); resolve(); };
    signal.addEventListener("abort", onAbort, { once: true });
  });

export async function main(argv: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  const p = parseArgs(argv, env);
  if (!p.ok) { console.error(`[overnight-translate] refused: ${p.code}`); return 2; }

  const appUrl = env.APP_URL || DEFAULT_APP_URL;
  const bad = originProblem(appUrl);
  if (bad) { console.error(`[overnight-translate] refused: ${bad}`); return 2; }
  if (!env.APP_DATABASE_URL && !env.DATABASE_URL) { console.error("[overnight-translate] refused: db_not_configured"); return 2; }
  const token = env.OVERNIGHT_TRANSLATE_TOKEN ?? "";
  // A dry run never calls the door, so it needs no token. A real run without one stops before touching anything.
  if (p.mode === "run" && !token) { console.error("[overnight-translate] refused: token_not_configured"); return 2; }

  const logDir = env.OVERNIGHT_TRANSLATE_LOG_DIR ?? join(env.HOME ?? ".", "overnight-translate");
  try { mkdirSync(logDir, { recursive: true }); } catch { /* the console line below still carries the event */ }
  const logFile = join(logDir, "overnight-translate.log");
  const log = (ev: Record<string, unknown>): void => {
    const line = JSON.stringify({ t: new Date().toISOString(), ...ev });
    console.log(line);
    try { appendFileSync(logFile, line + "\n"); } catch { /* console already has it */ }
  };

  const pressureFile = env.OVERNIGHT_TRANSLATE_PRESSURE_FILE ?? DEFAULT_PRESSURE_FILE;
  const deps: Deps = {
    store: makeStore(sql as unknown as SqlTag, { fixtureRoomDays: p.fixtures, maxFailedJobs: DEFAULT_MAX_FAILED_JOBS, actor: ACTOR }),
    door: makeDoor({ baseUrl: appUrl, token }),
    origin: appUrl,
    now: () => Date.now(),
    sleep: abortableSleep,
    gate: () => gateDecision(readLastLine(pressureFile), Date.now(), freeDiskGb("/")),
    log,
  };

  const ac = new AbortController();
  const onTerm = () => { log({ event: "signal", signal: "SIGTERM" }); ac.abort(); };
  const onInt = () => { log({ event: "signal", signal: "SIGINT" }); ac.abort(); };
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);

  log({ event: "start", mode: p.mode, pid: process.pid, fixtures: p.fixtures.length, limit: p.limit > 0 ? p.limit : null });
  try {
    const s = await runOvernight(deps, p.mode, p.limit, ac.signal);
    return s.fatal ? 2 : 0;
  } finally {
    // A function that returns must not leave process-wide handlers behind (a test host would inherit them).
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
  }
}
