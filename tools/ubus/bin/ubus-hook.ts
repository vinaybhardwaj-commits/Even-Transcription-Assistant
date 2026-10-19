#!/usr/bin/env node
/**
 * Claude Code hook. Fails open: any error exits 0 with no output.
 * Output is counts, ids, and handles only.
 *
 *   ubus-hook session-start|prompt|stop|watch [--max-s N]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hookEndpoint, loadClientSettings } from "../src/client-config.js";
import { resolveIdentity, type DerivedIdentity, type HookInput } from "../src/derive.js";
import { VERSION } from "../src/version.js";
import { decideStop, formatPrompt, formatRegistered, formatWatch, type UnreadSummary } from "../src/hooklib.js";

const cacheDir = process.env.UBUS_CACHE_DIR || join(homedir(), ".cache", "ubus");
const client = loadClientSettings();
const hookUrl = hookEndpoint(client.url);
const args = process.argv.slice(2);
const op = args[0] || "prompt";
const maxS = (() => {
  const i = args.indexOf("--max-s");
  return i === -1 ? 3600 : Number(args[i + 1] || "3600");
})();

async function main(): Promise<number> {
  const hook = await readHook();
  const { identity: idn } = await resolveIdentity(process.env, cacheDir, hook);
  if (op === "session-start") {
    const res = await hookPost("session-start", idn);
    if (!res.ok) return 0;
    const unread = asUnread(res.unread);
    process.stdout.write(formatRegistered(String(res.handle || idn.handle), String(res.address || ""), unread) + "\n");
    return 0;
  }
  if (op === "prompt") {
    const res = await hookPost("unread", idn);
    if (!res.ok) return 0;
    const line = formatPrompt(asUnread(res.unread));
    if (line) process.stdout.write(line + "\n");
    return 0;
  }
  if (op === "stop") {
    const res = await hookPost("unread", idn);
    if (!res.ok) return 0;
    const unread = asUnread(res.unread);
    const state = readState(idn.session);
    const decision = decideStop({ unread, lastBlockAt: state.last_stop_block_at, now: Date.now() });
    if (!decision.block) return 0;
    state.last_stop_block_at = new Date().toISOString();
    writeState(idn.session, state);
    process.stdout.write(JSON.stringify({ decision: "block", reason: decision.reason }) + "\n");
    return 0;
  }
  if (op === "watch") {
    const deadline = Date.now() + Math.max(1, maxS) * 1000;
    while (Date.now() < deadline) {
      const slice = Math.min(25, Math.max(1, Math.ceil((deadline - Date.now()) / 1000)));
      const res = await hookPost("wait", idn, { timeout_s: slice });
      if (!res.ok) return 0;
      const unread = asUnread(res.unread);
      if (unread.ids.length > 0) {
        process.stderr.write(formatWatch(unread) + "\n");
        return 2;
      }
    }
    return 0;
  }
  return 0;
}

async function hookPost(opName: string, idn: DerivedIdentity, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { "content-type": "application/json", "x-ubus-client": "ubus-hook" };
  const file = client.cfTokenFile || process.env.UBUS_CF_TOKEN_FILE;
  if (file && existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { id?: string; secret?: string; clients?: Array<{ id: string; secret: string }> };
      const client = raw.clients?.[0] ?? raw;
      if (client.id && client.secret) {
        headers["cf-access-client-id"] = client.id;
        headers["cf-access-client-secret"] = client.secret;
      }
    } catch {
      /* no headers */
    }
  }
  const res = await fetch(hookUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      op: opName,
      handle: idn.handle,
      machine: idn.machine,
      runtime: idn.runtime,
      session: idn.session,
      owner: idn.owner,
      orchestrator: idn.orchestrator,
      capabilities: { client_version: VERSION, client: "ubus-hook" },
      ...extra,
    }),
  });
  return (await res.json()) as Record<string, unknown>;
}

async function readHook(): Promise<HookInput> {
  if (process.stdin.isTTY) return {};
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text) as HookInput;
  } catch {
    return {};
  }
}

function statePath(session: string): string {
  const safe = session.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
  return join(cacheDir, `hook-${safe}.json`);
}

function readState(session: string): { last_stop_block_at: string | null } {
  const p = statePath(session);
  if (!existsSync(p)) return { last_stop_block_at: null };
  try {
    return JSON.parse(readFileSync(p, "utf8")) as { last_stop_block_at: string | null };
  } catch {
    return { last_stop_block_at: null };
  }
}

function writeState(session: string, state: { last_stop_block_at: string | null }): void {
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  writeFileSync(statePath(session), JSON.stringify(state), { mode: 0o600 });
}

function asUnread(value: unknown): UnreadSummary {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    count: typeof v.count === "number" ? v.count : 0,
    ids: Array.isArray(v.ids) ? v.ids.map(String) : [],
    from: Array.isArray(v.from) ? v.from.map(String) : [],
  };
}

main()
  .then((code) => process.exit(code))
  .catch(() => process.exit(0));
