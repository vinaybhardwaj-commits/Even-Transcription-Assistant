import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import { shortMachine } from "./address.js";

export interface DerivedIdentity {
  handle: string;
  machine: string;
  runtime: string;
  session: string;
  owner: string;
  orchestrator: string;
}

export interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: string;
}

function slug(input: string, max = 24): string {
  const s = input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return (s || "work").slice(0, max);
}

const PANE_RE = /^w\w+:p\d+$/;

/** Name of a herdr pane via `$HERDR_BIN_PATH agent list`, matched on pane_id. Null on any failure or after 2 s. */
export function resolvePaneName(env: NodeJS.ProcessEnv, paneId: string): string | null {
  const bin = env.HERDR_BIN_PATH;
  if (!bin) return null;
  const args = env.HERDR_SESSION && env.HERDR_SESSION !== "default" ? ["--session", env.HERDR_SESSION, "agent", "list"] : ["agent", "list"];
  try {
    const res = spawnSync(bin, args, { encoding: "utf8", timeout: 2000, env: { ...env }, maxBuffer: 4 * 1024 * 1024 });
    if (res.status !== 0 || !res.stdout) return null;
    const parsed = JSON.parse(res.stdout) as { result?: { agents?: unknown } } | unknown[];
    const list = Array.isArray(parsed) ? parsed : (parsed as { result?: { agents?: unknown } }).result?.agents;
    if (!Array.isArray(list)) return null;
    for (const a of list as Array<Record<string, unknown>>) {
      if (a && a.pane_id === paneId && typeof a.name === "string" && a.name) return a.name;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Shared by the stdio shim and the Claude hook so one pane maps to one {machine, runtime, session}.
 * Inside herdr the session comes from the pane alone, so the hook and the shim agree without sharing a cache.
 * Outside herdr the session comes from the hook's session_id, which only the hook sees: see resolveIdentity.
 */
export function deriveIdentity(env: NodeJS.ProcessEnv, hook?: HookInput): DerivedIdentity {
  const machine = (env.UBUS_MACHINE || shortMachine(hostname())).toLowerCase();
  const runtime = env.UBUS_RUNTIME || "claude-code";
  const owner = env.UBUS_OWNER || "fable";
  const orchestrator = env.UBUS_ORCHESTRATOR || owner;
  const cwd = hook?.cwd || env.PWD || process.cwd();
  const base = slug(basename(cwd));
  const paneId = env.HERDR_PANE_ID || "";
  const herdrName = env.HERDR_AGENT_NAME || "";
  if (herdrName || paneId) {
    const hs = env.HERDR_SESSION || "default";
    let name = herdrName;
    if (!name && PANE_RE.test(paneId)) name = resolvePaneName(env, paneId) || "";
    // The session never depends on the resolved name, so a slow or failed lookup cannot split one pane in two.
    const key = herdrName || paneId;
    const handle = env.UBUS_HANDLE || name || `cc-${slug(machine, 16)}-${base}-${slug(paneId.replace(":", "-"), 12)}`;
    return { handle, machine, runtime, session: env.UBUS_SESSION || `herdr:${hs}/${key}`, owner, orchestrator };
  }
  const sid = env.UBUS_SESSION_ID || hook?.session_id || env.CLAUDE_SESSION_ID || "local";
  const short = sid.replace(/[^a-z0-9]/gi, "").slice(0, 6).toLowerCase() || "local";
  const handle = env.UBUS_HANDLE || `cc-${slug(machine, 16)}-${base}-${short}`;
  const session = env.UBUS_SESSION || `cc:${sid}`;
  return { handle, machine, runtime, session, owner, orchestrator };
}

/** True when a process without the hook's stdin derives the same session as the hook does. */
export function identityIsDeterministic(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.UBUS_SESSION || env.HERDR_AGENT_NAME || env.HERDR_PANE_ID || env.UBUS_SESSION_ID || env.CLAUDE_SESSION_ID);
}

/**
 * The one identity for this process.
 * hook given: derive from the hook payload, write the cache.
 * no hook (the shim): a deterministic identity derives directly. Otherwise wait for the hook's fresh cache entry,
 * since only the hook sees session_id. A timeout falls back to the local derivation WITHOUT writing the cache.
 */
export async function resolveIdentity(
  env: NodeJS.ProcessEnv,
  cacheDir: string,
  hook?: HookInput,
  waitMs = 1500,
  maxAgeMs = 120_000,
): Promise<{ identity: DerivedIdentity; fromCache: boolean }> {
  const derived = deriveIdentity(env, hook);
  if (hook) {
    writeIdentity(cacheDir, derived);
    return { identity: derived, fromCache: false };
  }
  if (identityIsDeterministic(env)) {
    writeIdentity(cacheDir, derived);
    return { identity: derived, fromCache: false };
  }
  const start = Date.now();
  for (;;) {
    const found = readIdentity(cacheDir, derived, maxAgeMs);
    if (found) return { identity: found, fromCache: true };
    if (Date.now() - start >= waitMs) return { identity: derived, fromCache: false };
    await new Promise((r) => setTimeout(r, 50));
  }
}

export function identityCachePath(cacheDir: string, idn: DerivedIdentity): string {
  const key = createHash("sha256").update(`${idn.machine}|${idn.runtime}|${process.cwd()}`).digest("hex").slice(0, 16);
  return join(cacheDir, `identity-${key}.json`);
}

export function writeIdentity(cacheDir: string, idn: DerivedIdentity): void {
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  writeFileSync(identityCachePath(cacheDir, idn), JSON.stringify({ ...idn, written_at: Date.now() }), { mode: 0o600 });
}

export function readIdentity(cacheDir: string, hint: DerivedIdentity, maxAgeMs = Infinity): DerivedIdentity | null {
  const p = identityCachePath(cacheDir, hint);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as DerivedIdentity & { written_at?: number };
    if (!parsed.handle || !parsed.session) return null;
    if (Number.isFinite(maxAgeMs) && Date.now() - (parsed.written_at ?? 0) > maxAgeMs) return null;
    const { written_at: _w, ...idn } = parsed;
    return idn;
  } catch {
    return null;
  }
}
