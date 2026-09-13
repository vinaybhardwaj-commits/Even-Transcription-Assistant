/**
 * Slice E — the regrouped MCP surface keeps every name the door ever published.
 *
 * ─── WHAT THIS PROVES, AND WHAT IT DELIBERATELY DOES NOT ─────────────────────────────────────
 * Every one of the 51 names must RESOLVE and BEHAVE IDENTICALLY: the same handler runs, it receives
 * the same arguments, the caller gets back exactly what that handler returned, and the same scope
 * gates it. Descriptions are NOT frozen — they are supposed to change as tools change (Ruling A, 13
 * Sep): an earlier version compared them byte for byte and would have failed the moment Slice C2
 * edited one. What is frozen is the ARGUMENT CONTRACT: no argument a caller could pass may disappear,
 * change type, lose an enum value, or become required.
 *
 * ─── WHERE THE NAMES COME FROM ───────────────────────────────────────────────────────────────
 * fixtures/mcp/live-tools-list-6b2347e.json is the raw JSON-RPC answer to `tools/list` from the
 * LIVE door (www.evenscribe.app/api/mcp, banner version 6b2347e), captured with curl on 13 Sep
 * 2026. Never the registry — a test that enumerated the registry would shrink silently with the
 * code — and never origin/main, which carried 42 names while production served 51. A recaptured
 * fixture may add names; it must never drop one of these 51.
 *
 * fixtures/mcp/tool-scopes-6b2347e.json is each name's scope as the code at 6b2347e declared it.
 * tools/list exposes only readOnlyHint (read vs not); the first test pins the file to it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

type Row = Record<string, unknown>;
const auditInserts: unknown[][] = [];

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    if (/^INSERT INTO audit_log/.test(text)) auditInserts.push(values);
    return Promise.resolve([]);
  };
  sql.transaction = async () => [];
  return { sql, db: {} };
});

const { NextRequest } = await import("next/server");
const { handleMcpRpc } = await import("@/lib/mcp/handler");
const S = await import("@/lib/mcp/surface");
// The tool files themselves — the objects whose handlers must run. Imported here, not taken from
// lib/mcp/surface, so a surface that swapped in a wrapper object would be caught.
const TOOL_FILES = [
  (await import("@/lib/mcp/tools/health")).HEALTH_TOOLS, (await import("@/lib/mcp/tools/brain")).BRAIN_TOOLS,
  (await import("@/lib/mcp/tools/bench")).BENCH_TOOLS, (await import("@/lib/mcp/tools/stt")).STT_TOOLS,
  (await import("@/lib/mcp/tools/voice")).VOICE_TOOLS, (await import("@/lib/mcp/tools/encounters")).ENCOUNTER_TOOLS,
  (await import("@/lib/mcp/tools/stores")).STORE_TOOLS, (await import("@/lib/mcp/tools/llm")).LLM_TOOLS,
  (await import("@/lib/mcp/tools/fuse")).FUSE_TOOLS, (await import("@/lib/mcp/tools/fuse-report")).FUSE_REPORT_TOOLS,
  (await import("@/lib/mcp/tools/jobs")).JOB_TOOLS,
].flat();
const original = (name: string) => {
  const hits = TOOL_FILES.filter((t) => t.name === name);
  expect(hits, `${name} is defined ${hits.length} times in lib/mcp/tools`).toHaveLength(1);
  return hits[0]!;
};

type Scope = "read" | "invoke" | "write";
const ALL_SCOPES: Scope[] = ["read", "invoke", "write"];
type Frag = Row & { type?: string | string[]; enum?: unknown[]; anyOf?: Frag[] };
type LiveTool = { name: string; inputSchema: Row & { properties?: Record<string, Frag>; required?: string[] }; annotations: { readOnlyHint: boolean } };

const LIVE = JSON.parse(readFileSync("fixtures/mcp/live-tools-list-6b2347e.json", "utf8")) as { result: { tools: LiveTool[] } };
const LIVE_TOOLS = LIVE.result.tools;
const SCOPES = JSON.parse(readFileSync("fixtures/mcp/tool-scopes-6b2347e.json", "utf8")) as Record<string, Scope>;

/** The two published names a group now answers. Old-shaped calls must still reach the old handler. */
const REUSED_NAMES = ["scribe_health", "scribe_room_command"] as const;

/** Primary tools after Slice E commit 1. Commit 2 (stt.ts + voice.ts + window_speakers) brings it to 25. */
const COMMIT_1_PRIMARY_COUNT = 33;

const ctx = { origin: "https://x", actor: "mcp:test", scopes: new Set<Scope>(ALL_SCOPES) };

const rpc = async (body: unknown, scopes: Scope[]) => {
  const req = new NextRequest("https://x/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await handleMcpRpc(req, { token_id: "surface-test", scopes: new Set(scopes) });
  return { status: res.status, body: (await res.json()) as Row };
};
const call = (name: string, args: Row, scopes: Scope[]) =>
  rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, scopes);

/** One value for every argument the live schema declared — the call an old client could make. */
function oldShapedArgs(live: LiveTool): Row {
  const sample = (f: Frag): unknown => {
    if (Array.isArray(f.enum) && f.enum.length) return f.enum[0];
    switch (f.type) {
      case "integer": case "number": return 1;
      case "boolean": return true;
      case "object": return {};
      case "array": return [];
      default: return "x";
    }
  };
  return Object.fromEntries(Object.entries(live.inputSchema.properties ?? {}).map(([k, f]) => [k, sample(f)]));
}

/** Every JSON type the property accepted is still accepted (`type` may be a string or an array). */
const typeSet = (t: Frag["type"]) => new Set(t === undefined ? [] : Array.isArray(t) ? t : [t]);
const coversType = (now: Frag["type"], was: Frag["type"]) => was === undefined || [...typeSet(was)].every((x) => typeSet(now).has(x));

/** The fragments a published property now has: itself, or each branch of an anyOf. */
const branches = (f: Frag): Frag[] => (Array.isArray(f.anyOf) ? f.anyOf : [f]);

beforeEach(() => {
  auditInserts.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("the committed fixture", () => {
  it("is the 51-tool live capture, and the scope list agrees with its readOnlyHint", () => {
    expect(LIVE_TOOLS).toHaveLength(51);
    expect(new Set(LIVE_TOOLS.map((t) => t.name)).size).toBe(51);
    expect(Object.keys(SCOPES).sort()).toEqual(LIVE_TOOLS.map((t) => t.name).sort());
    for (const t of LIVE_TOOLS) expect(SCOPES[t.name] === "read", t.name).toBe(t.annotations.readOnlyHint);
  });
});

describe("every one of the 51 live names resolves and behaves identically", () => {
  const CASES = LIVE_TOOLS.map((t) => [t.name, t] as const);

  it.each(CASES)("%s — resolves, same scope, same handler", (name) => {
    const tool = S.CALLABLE_TOOLS.get(name);
    expect(tool, `${name} is no longer callable`).toBeDefined();
    expect(tool!.scope).toBe(SCOPES[name]);
    expect(original(name).scope).toBe(SCOPES[name]);
    if ((REUSED_NAMES as readonly string[]).includes(name)) {
      expect(S.GROUPS).toContain(tool); // the group answers; the call test below proves it reaches the old handler
    } else {
      expect(tool).toBe(original(name)); // the very object the tool file exports — not a wrapper
    }
  });

  it.each(CASES)("%s — the argument contract: nothing removed, retyped, narrowed or newly required", (name, live) => {
    const props = (S.CALLABLE_TOOLS.get(name)!.inputSchema.properties ?? {}) as Record<string, Frag>;
    for (const [key, was] of Object.entries(live.inputSchema.properties ?? {})) {
      const now = props[key];
      expect(now, `${name}.${key} was removed`).toBeDefined();
      const ok = branches(now!).some((b) =>
        coversType(b.type, was.type) &&
        (!Array.isArray(was.enum) || (Array.isArray(b.enum) && was.enum.every((e) => b.enum!.includes(e)))),
      );
      expect(ok, `${name}.${key} changed type or lost an enum value`).toBe(true);
    }
    const required = S.CALLABLE_TOOLS.get(name)!.inputSchema.required ?? [];
    for (const r of required) expect(live.inputSchema.required ?? [], `${name} now requires ${r}`).toContain(r);
  });

  it.each(CASES)("%s — an old-shaped call through the door runs the original handler with the same arguments and returns its answer", async (name, live) => {
    const spy = vi.spyOn(original(name), "handler").mockResolvedValue({ sentinel: name, nested: { kept: [1, 2] } });
    const args = oldShapedArgs(live);
    const { status, body } = await call(name, args, ALL_SCOPES);
    expect(status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toEqual(args);
    expect(spy.mock.calls[0]![1]).toMatchObject({ actor: "mcp:surface-test", origin: "https://x" });
    const result = body.result as Row;
    expect(result.structuredContent).toEqual({ sentinel: name, nested: { kept: [1, 2] } });
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toEqual({ sentinel: name, nested: { kept: [1, 2] } });
    expect(result.isError).toBe(false);
    expect((result._meta as Row).tool).toBe(name);
  });

  it.each(CASES)("%s — a token without its scope is refused at the door and nothing runs", async (name, live) => {
    const spies = TOOL_FILES.map((t) => vi.spyOn(t, "handler").mockResolvedValue({}));
    const { status, body } = await call(name, oldShapedArgs(live), ALL_SCOPES.filter((s) => s !== SCOPES[name]));
    expect(status).toBe(403);
    expect((body.error as Row).code).toBe(-32001);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

describe("tools/list — the primary surface", () => {
  it(`publishes ${COMMIT_1_PRIMARY_COUNT} tools, no duplicates, and no name a group has taken`, async () => {
    const { status, body } = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, ["read"]);
    expect(status).toBe(200);
    const names = ((body.result as Row).tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toHaveLength(COMMIT_1_PRIMARY_COUNT);
    expect(new Set(names).size).toBe(names.length);
    const taken = new Set(S.GROUPS.flatMap((g) => S.groupMembers(g)));
    for (const g of S.GROUPS) taken.delete(g.name);
    for (const n of names) expect(taken.has(n), `${n} is grouped but still listed`).toBe(false);
  });

  it("every live name is listed as itself or run by exactly one group", () => {
    const listed = new Set(S.LISTED_TOOLS.map((t) => t.name));
    for (const t of LIVE_TOOLS) {
      const groups = S.GROUPS.filter((g) => S.groupMembers(g).includes(t.name));
      if (groups.length === 0) expect(listed.has(t.name), t.name).toBe(true);
      else expect(groups, t.name).toHaveLength(1);
    }
  });

  it("stt.ts and voice.ts tools are untouched this commit: listed as the original objects", () => {
    for (const n of ["scribe_list_stt_engines", "scribe_stt_health", "scribe_stt_routing", "scribe_list_stt_runs", "scribe_get_stt_run",
      "scribe_route_tripwires", "scribe_voice_health", "scribe_list_voiceprints", "scribe_list_voice_samples", "scribe_get_clusters"]) {
      expect(S.LISTED_TOOLS).toContain(S.PUBLISHED_TOOLS.find((t) => t.name === n));
    }
  });
});

describe("every group variant runs its original handler", () => {
  /** [group, arguments to the group, the published tool expected to run, the arguments it must receive]. */
  const CASES: Array<[string, Row, string, Row]> = [
    ["scribe_health", { aspect: "all" }, "scribe_health", {}],
    ["scribe_health", { aspect: "llm" }, "scribe_llm_health", {}],
    ["scribe_health", { aspect: "kb", q: "anemia", topK: 3, include_text: true }, "scribe_kb_probe", { q: "anemia", topK: 3, include_text: true }],
    ["scribe_system", { view: "map", detail: "full" }, "scribe_system_map", { detail: "full" }],
    ["scribe_system", { view: "stores" }, "scribe_store_stats", {}],
    ["scribe_rooms", { view: "list", include_scratch: true }, "scribe_list_rooms", { include_scratch: true }],
    ["scribe_rooms", { view: "now", room: "r1" }, "scribe_diff_room", { room: "r1" }],
    ["scribe_rooms", { view: "fleet", detail: "full" }, "scribe_fleet", { detail: "full" }],
    ["scribe_rooms", { view: "day_report", room: "r1", ist_date: "2026-09-12" }, "scribe_day_report", { room: "r1", ist_date: "2026-09-12" }],
    ["scribe_sessions", { view: "list", status: "ended", limit: 5 }, "scribe_list_sessions", { status: "ended", limit: 5 }],
    ["scribe_sessions", { view: "replay", session_id: "bs_1" }, "scribe_replay_session", { session_id: "bs_1" }],
    ["scribe_session_tape", { view: "session", session_id: "bs_1" }, "scribe_get_session", { session_id: "bs_1" }],
    ["scribe_session_tape", { view: "manifest", session_id: "bs_1" }, "scribe_get_recording", { session_id: "bs_1", mode: "manifest" }],
    ["scribe_session_tape", { view: "timeline", session_id: "bs_1" }, "scribe_get_recording", { session_id: "bs_1", mode: "timeline" }],
    ["scribe_session_tape", { view: "chunk", session_id: "bs_1", chunk_idx: 2, source: "backup" }, "scribe_get_recording", { session_id: "bs_1", chunk_idx: 2, source: "backup", mode: "chunk" }],
    ["scribe_session_tape", { view: "zip", session_id: "bs_1", mode: "manifest" }, "scribe_get_recording", { session_id: "bs_1", mode: "zip" }],
    ["scribe_encounter", { encounter_id: "enc_1", include_identity: true }, "scribe_get_encounter", { encounter_id: "enc_1", include_identity: true }],
    ["scribe_encounter", { trace_id: "tr_1", include_prompts: true }, "scribe_get_trace", { trace_id: "tr_1", include_prompts: true }],
    ["scribe_ops_log", { source: "commands", room: "r1", status: "failed" }, "scribe_list_commands", { room: "r1", status: "failed" }],
    ["scribe_ops_log", { source: "jobs", kind: "stitch", limit: 10 }, "scribe_job_list", { kind: "stitch", limit: 10 }],
    ["scribe_ops_log", { source: "audit", action: "bench.command", since: "2026-09-12T00:00:00Z" }, "scribe_audit_recent", { action: "bench.command", since: "2026-09-12T00:00:00Z" }],
    ["scribe_room_command", { kind: "start_day", room: "r1", override_pause: true }, "scribe_start_recording", { room: "r1", override_pause: true }],
    ["scribe_room_command", { kind: "pause_day", room: "r1" }, "scribe_pause_recording", { room: "r1" }],
    ["scribe_room_command", { kind: "resume_day", room_id: "room_1" }, "scribe_resume_recording", { room_id: "room_1" }],
    ["scribe_room_command", { kind: "end_day", room_slug: "opd-1" }, "scribe_stop_recording", { room_slug: "opd-1" }],
    ["scribe_room_command", { kind: "close_orphaned_session", room: "r1" }, "scribe_close_orphaned_session", { room: "r1" }],
    ["scribe_room_command", { kind: "set_audio_input", room: "r1", input_volume: 0.5 }, "scribe_set_audio_input", { room: "r1", input_volume: 0.5 }],
    ["scribe_room_command", { kind: "check_update_now", room: "r1" }, "scribe_room_command", { kind: "check_update_now", room: "r1" }],
    ["scribe_room_command", { kind: "report_diag", room: "r1", args: { log_lines: 5 } }, "scribe_room_command", { kind: "report_diag", room: "r1", args: { log_lines: 5 } }],
    ["scribe_room_command", { kind: "restart_engine", room: "r1", args: { force: true } }, "scribe_room_command", { kind: "restart_engine", room: "r1", args: { force: true } }],
    ["scribe_scratch", { action: "replay", session_id: "bs_1", limit: 10 }, "scribe_replay_write", { session_id: "bs_1", limit: 10 }],
    ["scribe_scratch", { action: "fuse", room_day_id: "rd_1", arm: "rules", dry_run: true }, "scribe_fuse_run", { room_day_id: "rd_1", arm: "rules", dry_run: true }],
  ];

  it("covers every variant of every group", () => {
    const covered = new Set(CASES.map(([g, a]) => `${g}:${JSON.stringify(a.aspect ?? a.view ?? a.source ?? a.kind ?? a.action ?? (a.encounter_id ? "enc" : "trace"))}`));
    let variants = 0;
    for (const g of S.GROUPS) {
      const p = (g.inputSchema.properties ?? {}) as Record<string, { enum?: string[] }>;
      const sel = ["aspect", "view", "source", "kind", "action"].find((k) => p[k]?.enum);
      variants += sel ? p[sel]!.enum!.length : 2;
    }
    expect(covered.size).toBe(variants);
  });

  it.each(CASES)("%s %j → %s", async (groupName, groupArgs, member, memberArgs) => {
    const group = S.CALLABLE_TOOLS.get(groupName)!;
    const orig = S.PUBLISHED_TOOLS.find((t) => t.name === member)!;
    expect(group.scope).toBe(orig.scope);
    const spy = vi.spyOn(orig, "handler").mockResolvedValue({ sentinel: member });
    const out = await group.handler(groupArgs, ctx);
    expect(out).toEqual({ sentinel: member });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(memberArgs, ctx);
    expect(group.memberFor!(groupArgs)).toBe(member);
  });

  it("an unknown or missing selector is refused and runs nothing", async () => {
    const spies = S.PUBLISHED_TOOLS.map((t) => vi.spyOn(t, "handler").mockResolvedValue({}));
    expect(await S.CALLABLE_TOOLS.get("scribe_rooms")!.handler({ view: "everything" }, ctx)).toMatchObject({ ok: false, error: "unknown_view" });
    expect(await S.CALLABLE_TOOLS.get("scribe_ops_log")!.handler({}, ctx)).toMatchObject({ ok: false, error: "unknown_source" });
    expect(await S.CALLABLE_TOOLS.get("scribe_health")!.handler({ aspect: "stt" }, ctx)).toMatchObject({ ok: false, error: "unknown_aspect" });
    expect(await S.CALLABLE_TOOLS.get("scribe_room_command")!.handler({ kind: "reboot", room: "r1" }, ctx)).toMatchObject({ ok: false, error: "unknown_kind" });
    expect(await S.CALLABLE_TOOLS.get("scribe_encounter")!.handler({}, ctx)).toMatchObject({ ok: false, error: "one_id_required" });
    expect(await S.CALLABLE_TOOLS.get("scribe_encounter")!.handler({ encounter_id: "e", trace_id: "t" }, ctx)).toMatchObject({ ok: false, error: "one_id_required" });
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

describe("scope enforcement is unchanged per tool", () => {
  it("every group holds one scope, equal to each member's live scope", () => {
    for (const g of S.GROUPS) {
      for (const m of S.groupMembers(g)) expect(SCOPES[m], `${g.name} ⊃ ${m}`).toBe(g.scope);
    }
  });

  it("buildGroup refuses to mix scopes", () => {
    const tool = (name: string, scope: Scope) => ({ name, description: "", scope, inputSchema: { type: "object" as const }, handler: async () => ({}) });
    expect(() => S.buildGroup({ name: "g", lead: "", selector: { key: "view" }, variants: [
      { value: "a", tool: tool("a", "read") }, { value: "b", tool: tool("b", "write") },
    ] })).toThrow(/mixes scopes/);
  });

  // The 51 old names are each refused without their scope above; these are the group names.
  const groupNames = S.GROUPS.map((g) => g.name);

  it.each(groupNames.map((n) => [n]))("a token without its scope is refused group %s at the door, and nothing runs", async (name) => {
    const spies = S.PUBLISHED_TOOLS.map((t) => vi.spyOn(t, "handler").mockResolvedValue({}));
    const scope = S.CALLABLE_TOOLS.get(name)!.scope;
    const { status, body } = await call(name, { kind: "start_day", action: "replay", view: "list", source: "jobs", aspect: "all", encounter_id: "e", room: "r1" }, ALL_SCOPES.filter((s) => s !== scope));
    expect(status).toBe(403);
    expect((body.error as Row).code).toBe(-32001);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it("write and invoke stay apart: a write-only token cannot reach an invoke tool, nor an invoke-only token a write tool", async () => {
    for (const [name, scopes] of [
      ["scribe_extract_audio", ["read", "write"]], ["scribe_transcribe_range", ["read", "write"]], ["scribe_job_submit", ["read", "write"]],
      ["scribe_room_command", ["read", "invoke"]], ["scribe_start_recording", ["read", "invoke"]], ["scribe_scratch", ["read", "invoke"]], ["scribe_job_cancel", ["read", "invoke"]],
    ] as Array<[string, Scope[]]>) {
      expect((await call(name, { kind: "start_day", action: "replay" }, scopes)).status, name).toBe(403);
    }
  });

  it("a read token reaches a read group through the real door", async () => {
    const orig = S.PUBLISHED_TOOLS.find((t) => t.name === "scribe_list_rooms")!;
    const spy = vi.spyOn(orig, "handler").mockResolvedValue({ rooms: [] });
    const { status, body } = await call("scribe_rooms", { view: "list" }, ["read"]);
    expect(status).toBe(200);
    expect((body.result as Row).structuredContent).toEqual({ rooms: [] });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("audit — a grouped call still names the tool that ran", () => {
  const metaOf = (values: unknown[]) => JSON.parse(values.find((v) => typeof v === "string" && v.startsWith("{")) as string) as Row;
  const targetOf = (values: unknown[]) => values[1];

  it("a group call records the group as target and the member as variant; an old name records exactly what it did before", async () => {
    vi.spyOn(S.PUBLISHED_TOOLS.find((t) => t.name === "scribe_list_rooms")!, "handler").mockResolvedValue({ rooms: [] });
    await call("scribe_rooms", { view: "list" }, ["read"]);
    await call("scribe_list_rooms", {}, ["read"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(auditInserts).toHaveLength(2);
    expect(targetOf(auditInserts[0]!)).toBe("scribe_rooms");
    expect(metaOf(auditInserts[0]!)).toMatchObject({ variant: "scribe_list_rooms" });
    expect(targetOf(auditInserts[1]!)).toBe("scribe_list_rooms");
    expect(Object.keys(metaOf(auditInserts[1]!)).sort()).toEqual(["args", "ms", "ok"]);
  });
});

describe("docs/operator-mcp/TOOL-NOTES.md describes the surface the door serves", () => {
  const notes = readFileSync("docs/operator-mcp/TOOL-NOTES.md", "utf8");

  it("states the listed count and names every listed tool", () => {
    expect(notes).toContain(`## The surface: ${S.LISTED_TOOLS.length} listed tools, ${LIVE_TOOLS.length} names that answer`);
    for (const t of S.LISTED_TOOLS) expect(notes, t.name).toContain(`\`${t.name}\``);
  });

  it("has one table row per group, naming its scope and every member it runs", () => {
    for (const g of S.GROUPS) {
      const row = notes.split("\n").find((l) => l.startsWith(`| \`${g.name}\` |`));
      expect(row, `${g.name} has no row`).toBeDefined();
      expect(row).toContain(`| ${g.scope} |`);
      for (const m of S.groupMembers(g)) expect(row, `${g.name} row omits ${m}`).toContain(`\`${m}\``);
    }
    expect(notes.split("\n").filter((l) => /^\| `scribe_/.test(l))).toHaveLength(S.GROUPS.length);
  });
});

describe("descriptions state what the code does — derived, and capped (Ruling B)", () => {
  const desc = (n: string) => S.CALLABLE_TOOLS.get(n)!.description;
  const selectorKey = (g: (typeof S.GROUPS)[number]) =>
    ["aspect", "view", "source", "kind", "action"].find((k) => ((g.inputSchema.properties ?? {}) as Record<string, Frag>)[k]?.enum);

  it.each(S.GROUPS.map((g) => [g.name, g] as const))(`%s is at most ${S.GROUP_DESCRIPTION_MAX_WORDS} words`, (_n, g) => {
    expect(S.wordCount(g.description)).toBeLessThanOrEqual(S.GROUP_DESCRIPTION_MAX_WORDS);
  });

  it.each(S.GROUPS.map((g) => [g.name, g] as const))("%s names every value it accepts and every tool it runs, exactly as it routes them", (_n, g) => {
    const key = selectorKey(g);
    const values = key ? ((g.inputSchema.properties as Record<string, Frag>)[key]!.enum as string[]) : ["encounter_id", "trace_id"];
    for (const value of values) {
      const member = g.memberFor!(key ? { [key]: value } : { [value]: "x" })!;
      expect(member, `${g.name} does not route ${value}`).toBeTruthy();
      // "value → tool" or "value | other → tool": the value and the tool it actually routes to, on one row.
      const row = g.description.split(/[;:]\s*/).filter((part) => part.includes(" → ")).find((part) => part.split(" → ")[0]!.split(" | ").map((s) => s.trim()).includes(value));
      expect(row, `${g.name} does not list ${value}`).toBeDefined();
      expect(row!.split(" → ")[1]!.split(/[ .]/)[0]).toBe(member);
    }
  });

  it("the list is generated: a variant added to a group appears in its description with no prose written", () => {
    const tool = (name: string) => ({ name, description: "long original text that must not be copied", scope: "read" as const, inputSchema: { type: "object" as const }, handler: async () => ({}) });
    const g = S.buildGroup({ name: "g", lead: "Framing.", selector: { key: "view" }, variants: [
      { value: "a", tool: tool("t_a") }, { value: "b", tool: tool("t_b") }, { value: "c", tool: tool("t_b") },
    ] });
    expect(g.description).toContain("a → t_a; b | c → t_b");
    expect(g.description).not.toContain("long original text");
  });

  it("buildGroup refuses a description over the cap", () => {
    const tool = (name: string) => ({ name, description: "", scope: "read" as const, inputSchema: { type: "object" as const }, handler: async () => ({}) });
    expect(() => S.buildGroup({ name: "g", lead: "word ".repeat(S.GROUP_DESCRIPTION_MAX_WORDS), selector: { key: "view" }, variants: [
      { value: "a", tool: tool("t_a") }, { value: "b", tool: tool("t_b") },
    ] })).toThrow(/words \(max 150\)/);
  });

  it.each([
    ["scribe_health", "SAME TOOL, MORE ASPECTS. scribe_health called with no `aspect` (or aspect=all) is the old scribe_health: same arguments, same behaviour, same response."],
    ["scribe_room_command", "SAME TOOL, MORE KINDS. scribe_room_command called with kind check_update_now | report_diag | restart_engine is the old scribe_room_command: same arguments, same behaviour, same response."],
  ])("%s opens by saying the old call shape is the old tool", (name, opening) => {
    expect(desc(name).startsWith(opening)).toBe(true);
  });

  it("only the two reused names carry that opening", () => {
    for (const g of S.GROUPS) expect(g.description.startsWith("SAME TOOL"), g.name).toBe((REUSED_NAMES as readonly string[]).includes(g.name));
  });

  it("scribe_room_command says where each of its nine kinds executes; close_orphaned_session is a server-side repair", () => {
    const d = desc("scribe_room_command");
    expect(d).toContain("start_day, pause_day, resume_day, end_day — queued as a bench_command for the room's listening kiosk.");
    expect(d).toContain("set_audio_input, check_update_now, report_diag, restart_engine — queued as a bench_command for the native Room Recorder app, which a browser kiosk ignores.");
    expect(d).toContain("close_orphaned_session — a SERVER-SIDE REPAIR, not a stop: no command is queued and no kiosk is involved.");
  });

  it("the execution claims match the handlers: close_orphaned_session never queues a command; the other kinds do, to the site named", () => {
    const src = readFileSync("lib/mcp/tools/bench.ts", "utf8");
    const body = (name: string) => {
      const start = src.indexOf(`const ${name}: McpTool = {`);
      return src.slice(start, src.indexOf("\n};\n", start));
    };
    expect(body("closeOrphaned")).not.toMatch(/insertCommand|sendAndWait/);
    expect(body("closeOrphaned")).toMatch(/closeOrphanedSession\(/);
    expect(body("startRecording")).toMatch(/sendAndWait\(room, "start_day"/);
    expect(src).toMatch(/simpleVerb\(\s*"scribe_pause_recording",\s*"pause_day"/);
    expect(src).toMatch(/simpleVerb\(\s*"scribe_resume_recording",\s*"resume_day"/);
    expect(src).toMatch(/simpleVerb\(\s*"scribe_stop_recording",\s*"end_day"/);
    // The native-app kinds are the ones gated on the bound Mac's app version.
    expect(body("setAudioInput")).toMatch(/sendAndWait\(room, "set_audio_input"/);
    expect(body("setAudioInput")).toMatch(/boundInstallForRoom\(/);
    expect(body("roomCommand")).toMatch(/insertCommand\(/);
    expect(body("roomCommand")).toMatch(/boundInstallForRoom\(/);
  });

  it("scribe_session_tape's framing matches get_recording: manifest and chunk mint presigned links, timeline and zip do not", () => {
    expect(desc("scribe_session_tape")).toContain("manifest and chunk return presigned audio links");
    const live = original("scribe_get_recording").description;
    expect(live).toMatch(/mode=manifest: manifest\.json shape with per-chunk presigned GET URLs/);
    expect(live).toMatch(/mode=chunk: one presigned GET URL/);
    expect(live).toMatch(/mode=timeline: generated timeline\.md text/);
    expect(live).toMatch(/mode=zip: the admin day-zip route path .*not presignable/);
  });
});
