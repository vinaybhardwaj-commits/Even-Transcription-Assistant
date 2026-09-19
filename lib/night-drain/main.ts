/**
 * lib/night-drain/main.ts — the real wiring. Loaded by scripts/night-drain.ts AFTER it has put the credentials in
 * the environment (lib/diarize.ts reads DIARIZE_BASE_URL when it is imported).
 *
 * Modes:
 *   run         (default) the overnight drain. Closed hours only; writes rows; takes leases.
 *   dry-run     `--limit N`. Diarizes the next N windows, closed hours + gate as usual, WRITES NOTHING.
 *   audio-only  `--limit N`. Fetches and joins the next N windows and stops: no lease, no diarize, no write. Light.
 */
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { sql } from "@/lib/db";
import { DIARIZE_MAX_ATTEMPTS } from "@/lib/stt/diarize-job";
import { fetchWindowAudio } from "./audio";
import { DEFAULT_PRESSURE_FILE, pressureDecision, readLastLine } from "./pressure";
import { diarizeAndRecord, recordFailedRow } from "./record";
import { makeStore } from "./store";
import { runBatch, serve, type Deps, type LogRecord } from "./worker";

const DEFAULT_FFMPEG = "/opt/homebrew/bin/ffmpeg";

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal.removeEventListener("abort", done); resolve(); }
    signal.addEventListener("abort", done, { once: true });
  });
}

function makeLogger(dir: string): (rec: LogRecord) => void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "night-drain.log");
  return (rec) => {
    const line = JSON.stringify({ t: new Date().toISOString(), ...rec });
    console.log(line);
    try {
      appendFileSync(file, line + "\n");
    } catch (e) {
      console.error(`[night-drain] log file write failed (${(e as NodeJS.ErrnoException).code ?? "error"}); stdout has the line`);
    }
  };
}

async function health(base: string): Promise<{ ok: boolean; device: string | null }> {
  try {
    const r = await fetch(`${base.replace(/\/+$/, "")}/health`, { signal: AbortSignal.timeout(3_000), cache: "no-store" });
    if (!r.ok) return { ok: false, device: null };
    const j = (await r.json()) as { ok?: unknown; device?: unknown };
    return { ok: j.ok === true, device: typeof j.device === "string" ? j.device : null };
  } catch (e) {
    console.warn(`[night-drain] /health failed (${(e as Error)?.name ?? "error"})`);
    return { ok: false, device: null };
  }
}

export async function main(argv: string[]): Promise<number> {
  const arg = (name: string): string | null => { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] ?? null) : null; };
  const mode = (arg("--mode") ?? "run") as "run" | "dry-run" | "audio-only";
  const limit = Number(arg("--limit") ?? 0);
  if (!["run", "dry-run", "audio-only"].includes(mode)) { console.error("[night-drain] --mode must be run, dry-run or audio-only"); return 2; }
  if (mode !== "run" && !(limit >= 1 && limit <= 200)) { console.error("[night-drain] dry-run and audio-only need --limit 1..200"); return 2; }

  const diarizeBase = process.env.DIARIZE_BASE_URL ?? "";
  const mcp = { baseUrl: process.env.APP_URL ?? "", token: process.env.SCRIBE_MCP_TOKEN ?? "" };
  const ffmpeg = process.env.FFMPEG_BIN ?? DEFAULT_FFMPEG;
  const missing = [
    !process.env.APP_DATABASE_URL && "db_not_configured",
    !diarizeBase && "diarize_base_url_missing",
    (!mcp.baseUrl || !mcp.token) && "mcp_not_configured",
    !existsSync(ffmpeg) && "ffmpeg_missing",
  ].filter(Boolean);
  const log = makeLogger(process.env.NIGHT_DRAIN_LOG_DIR ?? join(process.env.HOME ?? ".", "night-drain"));
  if (missing.length) { log({ event: "fatal", code: missing.join(",") }); return 2; }

  const store = makeStore(sql, DIARIZE_MAX_ATTEMPTS);
  const pressureFile = process.env.NIGHT_DRAIN_PRESSURE_FILE ?? DEFAULT_PRESSURE_FILE;
  const holder = `night-drain@${hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`.slice(0, 160);

  const deps: Deps = {
    now: () => Date.now(),
    sleep: abortableSleep,
    gate: () => pressureDecision(readLastLine(pressureFile), Date.now()),
    serviceHealth: () => health(diarizeBase),
    store,
    audio: (w, chunks, signal) => fetchWindowAudio({ mcp, fetch, ffmpeg }, w, chunks, signal),
    diarize: diarizeAndRecord,
    recordFailed: recordFailedRow,
    log,
    holder,
  };

  const ac = new AbortController();
  const stop = (sig: string) => () => { log({ event: "signal", signal: sig }); ac.abort(); };
  process.on("SIGTERM", stop("SIGTERM"));
  process.on("SIGINT", stop("SIGINT"));

  log({ event: "start", mode, pid: process.pid, host: hostname(), limit: mode === "run" ? null : limit });
  if (mode === "run") {
    const r = await serve(deps, ac.signal);
    return r.fatal ? 2 : 0;
  }
  const s = await runBatch(deps, mode, limit, ac.signal);
  return s.fatal ? 2 : 0;
}
