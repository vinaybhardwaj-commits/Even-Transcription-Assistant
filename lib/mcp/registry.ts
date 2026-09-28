/**
 * lib/mcp/registry.ts — shared tool contract for /api/mcp (Operator MCP S1).
 *
 * NOT in the S1 file contract — added so `lib/mcp/tools/*` and `app/api/mcp/route.ts` share
 * one `McpTool` type and the fail-safe helpers without a type-only import cycle through the
 * route file. Flagged in the S1 report. Contains no tool logic and no secrets.
 *
 * Every tool: name (the contract, PRD §12), description, JSON-Schema inputSchema, scope, and a
 * handler that NEVER throws for data reasons — reads fail-safe to `{ degraded:true, error }`
 * plus the tool's empty shape (kickoff "SQL honesty"). Only /api/mcp auth fails closed.
 */

import type { McpScope } from "./auth";

export type JsonSchema = {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export type ToolArgs = Record<string, unknown>;

/** Per-call context the door hands every handler (S3): the request origin for same-origin hops. */
/**
 * What every tool handler is told about the call it is serving.
 *
 * `actor` is the RESOLVED principal (Tier 2 §2.3): the `actor` of the matching `SCRIBE_MCP_TOKENS`
 * entry, prefixed `mcp:`, or `mcp:operator-v1` for the single-token fallback. It is here rather
 * than re-derived per tool because a tool that writes a durable row — a job, an audit entry — must
 * record WHO asked, and nothing else in the handler's arguments can say. Slice B's job rows carried
 * `actor: null` until this existed.
 *
 * ALWAYS A STRING. A missing principal defaults to the single-token id rather than null, so a
 * `scribe_job.actor` is never blank and "who ran this" is never unanswerable.
 */
export type ToolContext = {
  origin: string;
  actor: string;
  /** The caller's scopes. A tool whose OPTIONS differ by scope (scribe_job_status's include_urls,
   *  scribe_job_submit's per-kind check) reads this; the tool's own scope is still checked first
   *  by the handler, so this narrows within a tool, it never widens access to one. */
  scopes: ReadonlySet<McpScope>;
  /** The caller's room allowlist (lib/mcp/auth.ts's per-token `rooms`), or `undefined` when the
   *  token is unrestricted (every token before 27 Sep 2026, and the single-token fallback). NOT
   *  every tool checks this — `handler.ts`'s `ROOM_RESTRICTED_ALLOWED_TOOLS` is the real boundary,
   *  refusing a room-restricted token before a tool that has not been vetted to check it ever
   *  runs. `resolveForWrite` (lib/mcp/tools/bench.ts) is the one place that DOES check it, and is
   *  what the tools on that allowlist are vetted against. */
  rooms?: ReadonlySet<string>;
  /** The caller's PER-TOKEN tool allowlist (lib/mcp/auth.ts's per-token `tools`, 28 Sep 2026), or
   *  `undefined` for every tool a room-restricted token could otherwise reach. Only meaningful
   *  alongside `rooms`; checked by `handler.ts`'s gate ANDed with `ROOM_RESTRICTED_ALLOWED_TOOLS`
   *  — it can only narrow, never widen past that vetted set. */
  tools?: ReadonlySet<string>;
};

/**
 * Thrown by a handler that needs a scope its caller has not got — a per-KIND requirement the tool's
 * own single `scope` cannot express. `callTool` turns it into the same -32001
 * `scope_or_tool_unavailable` an unregistered tool gets, so a caller sees one refusal, not two.
 */
export class ToolScopeError extends Error {
  constructor(public needed: McpScope, public detail: Record<string, unknown> = {}) {
    super(`scope_or_tool_unavailable: needs ${needed}`);
  }
}

/**
 * Thrown by `resolveForWrite` when the caller's token has a room allowlist (`ctx.rooms`) that
 * does not name the room the call resolved to. The SAME authorization category as `ToolScopeError`
 * — the caller has the tool's scope, just not for this room — so `callTool` catches it the same
 * way and gives the same -32001 `scope_or_tool_unavailable` shape: one refusal, not a second kind
 * of "you may not do that".
 */
export class ToolRoomError extends Error {
  constructor(public room: { id: string; slug: string; name: string }) {
    super(`scope_or_tool_unavailable: room ${room.slug} is not on this token's allowlist`);
  }
}

/**
 * ─── DEFAULT-DENY FOR A ROOM-RESTRICTED TOKEN (eta-refuter-2 #5114, 27 Sep) ────────────────────
 * The first cut of the room allowlist enforced `ctx.rooms` inside `resolveForWrite`, on the belief
 * that every room-touching tool called it. FALSE, reproduced: `scribe_extract_audio` (and
 * `scribe_transcribe_range`) resolve a room straight from a `session_id` WITHOUT calling
 * `resolveForWrite` at all, so a token restricted to one room could read another room's audio by
 * naming its session id — and roughly a dozen more tools (replay_write, post_cue, pin_visit,
 * fuse_run, set_visit_clinician, jev_window_run, job_submit/job_cancel, silence_readjudicate,
 * encounter_shadow_run, note_safety_replay, clinical_route_replay) touch a room, session, visit,
 * window or job with NO room check whatsoever.
 *
 * Auditing every one of those — each derives "the room" from a different kind of id — is real work
 * and the wrong shape for a same-day fix. So the boundary moves from "does this tool happen to
 * check ctx.rooms" (provably incomplete; a new tool can silently reopen the gap) to "is this tool
 * even REACHABLE for a room-restricted token" (default deny; a NEW tool is unreachable until
 * someone deliberately adds it here, having verified it room-checks correctly).
 *
 * A room-restricted token (`ctx.rooms` set — including the empty set, the malformed-token fail-
 * closed case) may call ONLY a tool named here; `callTool` refuses every other name before the
 * handler ever runs, with the same -32001 `scope_or_tool_unavailable` shape.
 *
 * `scribe_room_command` covers start_day, pause_day, resume_day, end_day, set_audio_input,
 * close_orphaned_session, check_update_now, report_diag, restart_engine AND self_test
 * (lib/mcp/surface.ts's group) when called BY THAT NAME — every one of those routes through
 * `resolveForWrite` (verified, tests/unit/mcp-room-allowlist.test.ts). `scribe_start_recording`
 * and `scribe_stop_recording` are the SAME start_day/end_day handlers, reachable by their own
 * published names (the group is one route to them, not the only one) — also verified to route
 * through `resolveForWrite`, added 28 Sep 2026 for the day-boundary owner's per-tool allowlist
 * (`McpPrincipal.tools`, lib/mcp/auth.ts) to narrow down to. ADDING A NAME HERE without first
 * confirming (by the same standard: a passing test, not a read) that its own handler enforces
 * `ctx.rooms` before touching any room-scoped data reopens exactly the hole this closes.
 */
export const ROOM_RESTRICTED_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  "scribe_room_command",
  "scribe_start_recording",
  "scribe_stop_recording",
]);

export type McpTool = {
  name: string;
  description: string;
  scope: McpScope;
  inputSchema: JsonSchema;
  handler: (args: ToolArgs, ctx: ToolContext) => Promise<unknown>;
  /**
   * Slice E — set only on a GROUP (lib/mcp/surface): the name of the published tool these
   * arguments would run, or null when the group would refuse them. The door records it on the
   * audit row, so a grouped call still says which tool actually ran.
   */
  memberFor?: (args: ToolArgs) => string | null;
};

export type ToolResult = Record<string, unknown>;

/** Run `fn`; on any throw return `{ ...empty, degraded:true, error }` instead of failing. */
export async function failSafe(empty: ToolResult, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    // A SCOPE OR ROOM REFUSAL IS NOT A DEGRADED ANSWER. Everything else here becomes
    // `{degraded:true}` so a read that failed answers rather than 500s — but flattening "you may
    // not do that" into that shape would tell a caller the data was unavailable when it was in
    // fact withheld, and would turn a 403 into a 200. It goes up to the handler, which renders it
    // as -32001.
    if (e instanceof ToolScopeError || e instanceof ToolRoomError) throw e;
    return { ...empty, degraded: true, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

export type ProbeResult = { ok: boolean; latency_ms: number; error?: string } & Record<string, unknown>;

/** Sub-probe wrapper: `{ ok, latency_ms, error?, ...extra }` — never throws. */
export async function probe(fn: () => Promise<Record<string, unknown> | void>, timeoutMs?: number): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const run = fn();
    const extra = timeoutMs
      ? await Promise.race([
          run,
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timeout_${timeoutMs}ms`)), timeoutMs)),
        ])
      : await run;
    return { ok: true, latency_ms: Date.now() - t0, ...(extra ?? {}) };
  } catch (e) {
    return { ok: false, latency_ms: Date.now() - t0, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

// ---- arg coercion helpers (JSON-RPC clients send loose types) ----

export function argStr(args: ToolArgs, key: string, max = 256): string | null {
  const v = args[key];
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 && s.length <= max ? s : null;
}

export function argInt(args: ToolArgs, key: string, def: number, min: number, max: number): number {
  const v = args[key];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

export function argBool(args: ToolArgs, key: string): boolean {
  const v = args[key];
  return v === true || v === "true" || v === 1;
}

export function argDate(args: ToolArgs, key: string): Date | null {
  const v = args[key];
  if (typeof v !== "string" && typeof v !== "number") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const IST_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Tier 2 §2.4 — `detail`. Every wide read tool takes it; `summary` is the DEFAULT and is what an
 * operator reads first. `full` is exactly today's payload, so nothing that parses these tools
 * breaks: a caller that wants the old shape asks for it by name.
 *
 * WHY THE DEFAULT MOVED. `scribe_diff_room` returns ~40 fields per room across every enabled room;
 * an operator asking "what is wrong right now" pays for all of it and then reads six of them. The
 * summary is those six-ish, and the full payload is one argument away.
 */
export type McpDetail = "summary" | "full";

export function argDetail(args: ToolArgs): McpDetail {
  return argStr(args, "detail", 16) === "full" ? "full" : "summary";
}

/** The schema fragment every tool with `detail` shares, so the wording cannot drift between them. */
export const DETAIL_SCHEMA = {
  type: "string",
  enum: ["summary", "full"],
  default: "summary",
  description:
    "summary (default) = the fields an operator reads first; full = the complete payload this tool returned before Tier 2. Nothing is removed by summary — it is a narrower selection of the same facts.",
} as const;

/**
 * PURE — §2.4, hardened by the Slice A Refuter's (d). Keep only `keys` from a payload row.
 *
 * ─── IT THROWS ON A KEY THE PAYLOAD HAS NOT GOT ───────────────────────────────────────────────
 * The first version did `if (k in row)` and skipped anything else. That is how six wrong field
 * names in SUMMARY_DAY_SESSION_FIELDS shipped: `id` for `session_id`, `ended_disagrees` for
 * `end_time_disagrees`, and four columns that never existed. Summary silently returned four fields
 * instead of ten and every test still passed, because a projection that drops what it cannot find
 * has no failure mode — it just answers less, and "less" is indistinguishable from "that room had
 * nothing to report".
 *
 * So a missing REQUIRED key is a programming error and is thrown, loudly, naming the key and what
 * the row actually has. `failSafe` turns it into the tool's empty envelope rather than a 500, so a
 * mistake costs one visibly-empty answer in preview instead of a quietly-thin one in production.
 *
 * `optional` is the escape hatch and it is EXPLICIT: a key that is legitimately absent sometimes
 * (day_report's `ended_at` is only present when the stored end disagrees with the tape) is listed
 * there and skipped when missing. The only silence left is silence someone declared.
 *
 * The TYPE is the first line of defence: `keys` is `readonly (keyof T)[]`, so a name that is not a
 * field of the payload fails `tsc` at the call site before any of this runs.
 */
export function pickSummary<T extends object>(
  row: T,
  keys: readonly (keyof T)[],
  optional: readonly (keyof T)[] = [],
): Partial<T> {
  const out: Record<string, unknown> = {};
  const opt = new Set<PropertyKey>(optional as readonly PropertyKey[]);
  for (const k of keys) {
    if (!(k in row)) {
      if (opt.has(k)) continue;
      throw new Error(
        `pickSummary: "${String(k)}" is not on this payload (has: ${Object.keys(row).sort().join(", ")})`,
      );
    }
    out[k as string] = row[k];
  }
  return out as Partial<T>;
}
