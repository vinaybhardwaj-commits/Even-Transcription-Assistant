/**
 * Slice E — the regrouped MCP surface keeps every name the door ever published.
 *
 * ─── WHERE THE OLD NAMES COME FROM ───────────────────────────────────────────────────────────
 * fixtures/mcp/live-tools-list-6b2347e.json is the raw JSON-RPC answer to `tools/list` from the
 * LIVE door (www.evenscribe.app/api/mcp, banner version 6b2347e), captured with curl on
 * 13 Sep 2026. Not the registry — a test that enumerated the registry would shrink silently with
 * the code — and not origin/main, which served 42 names while production served 51.
 *
 * fixtures/mcp/tool-scopes-6b2347e.json is each of those names' scope as the code at 6b2347e
 * declared it. tools/list only exposes readOnlyHint (read vs not), so the write/invoke split has
 * to come from somewhere; the first test pins that file to the live readOnlyHint so it cannot
 * disagree with what the door served.
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

type Scope = "read" | "invoke" | "write";
type LiveTool = { name: string; description: string; inputSchema: Row & { properties?: Record<string, Row>; required?: string[] }; annotations: { readOnlyHint: boolean } };

const LIVE = JSON.parse(readFileSync("fixtures/mcp/live-tools-list-6b2347e.json", "utf8")) as { result: { tools: LiveTool[] } };
const LIVE_TOOLS = LIVE.result.tools;
const SCOPES = JSON.parse(readFileSync("fixtures/mcp/tool-scopes-6b2347e.json", "utf8")) as Record<string, Scope>;

/**
 * The two published names a group now answers. Every other published name must resolve to a tool
 * whose name, description, schema and scope are byte-identical to the live capture. These two
 * cannot be (their group publishes more), so they are held to the weaker, stated contract below.
 */
const REUSED_NAMES = ["scribe_health", "scribe_room_command"] as const;

/** Primary tools after Slice E commit 1. Commit 2 (stt.ts + voice.ts + window_speakers) brings it to 25. */
const COMMIT_1_PRIMARY_COUNT = 33;

const ctx = { origin: "https://x", actor: "mcp:test", scopes: new Set<Scope>(["read", "invoke", "write"]) };

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

describe("every one of the 51 live names still resolves", () => {
  it.each(LIVE_TOOLS.map((t) => [t.name, t] as const))("%s", (name, live) => {
    const tool = S.CALLABLE_TOOLS.get(name);
    expect(tool, `${name} is no longer callable`).toBeDefined();
    expect(tool!.scope).toBe(SCOPES[name]);
    if ((REUSED_NAMES as readonly string[]).includes(name)) return; // held to the contract below
    expect(tool!.name).toBe(live.name);
    expect(tool!.description).toBe(live.description);
    expect(JSON.parse(JSON.stringify(tool!.inputSchema))).toEqual(live.inputSchema);
    expect(tool!.memberFor).toBeUndefined(); // an alias is the original object, not a group
  });
});

describe("the two reused names: old-shaped calls reach the original handler, unchanged", () => {
  const published = (n: string) => S.PUBLISHED_TOOLS.find((t) => t.name === n)!;

  it.each(REUSED_NAMES.map((n) => [n]))("%s — every live property survives, required does not grow past the selector", (name) => {
    const live = LIVE_TOOLS.find((t) => t.name === name)!;
    const group = S.CALLABLE_TOOLS.get(name)!;
    expect(S.GROUPS).toContain(group);
    const props = (group.inputSchema.properties ?? {}) as Record<string, Row>;
    for (const [key, frag] of Object.entries(live.inputSchema.properties ?? {})) {
      const now = props[key];
      expect(now, `${name}.${key} was dropped`).toBeDefined();
      if (Array.isArray(frag.enum)) {
        for (const e of frag.enum) expect(now!.enum as unknown[], `${name}.${key} lost ${String(e)}`).toContain(e);
        continue;
      }
      // Same fragment; a description may only gain a leading [variant] tag.
      const { description: liveDesc, ...liveRest } = frag;
      const { description: nowDesc, ...nowRest } = now!;
      expect(nowRest).toEqual(liveRest);
      if (typeof liveDesc === "string") expect(String(nowDesc).endsWith(liveDesc)).toBe(true);
    }
    for (const r of live.inputSchema.required ?? []) expect(group.inputSchema.required ?? []).toContain(r);
  });

  it("scribe_health with no aspect runs scribe_health's own handler with the same arguments", async () => {
    const orig = published("scribe_health");
    const spy = vi.spyOn(orig, "handler").mockResolvedValue({ sentinel: "health" });
    const out = await S.CALLABLE_TOOLS.get("scribe_health")!.handler({ anything: 1 }, ctx);
    expect(out).toEqual({ sentinel: "health" });
    expect(spy).toHaveBeenCalledWith({ anything: 1 }, ctx);
  });

  it.each(["check_update_now", "report_diag", "restart_engine"])("scribe_room_command kind=%s passes every argument, kind included", async (kind) => {
    const orig = published("scribe_room_command");
    const spy = vi.spyOn(orig, "handler").mockResolvedValue({ sentinel: kind });
    const args = { room: "opd-x", kind, args: { log_lines: 5 } };
    const out = await S.CALLABLE_TOOLS.get("scribe_room_command")!.handler(args, ctx);
    expect(out).toEqual({ sentinel: kind });
    expect(spy).toHaveBeenCalledWith(args, ctx);
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
    expect(() => S.buildGroup({ name: "g", lead: "", selector: { key: "view", description: "" }, variants: [
      { value: "a", tool: tool("a", "read") }, { value: "b", tool: tool("b", "write") },
    ] })).toThrow(/mixes scopes/);
  });

  const nonRead = LIVE_TOOLS.map((t) => t.name).filter((n) => SCOPES[n] !== "read");
  const nonReadGroups = S.GROUPS.filter((g) => g.scope !== "read").map((g) => g.name);

  it.each([...nonRead, ...nonReadGroups].map((n) => [n]))("a read-only token is refused %s at the door, and nothing runs", async (name) => {
    const spies = S.PUBLISHED_TOOLS.map((t) => vi.spyOn(t, "handler").mockResolvedValue({}));
    const { status, body } = await call(name, { kind: "start_day", action: "replay", room: "r1" }, ["read"]);
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

describe("descriptions state what the code does", () => {
  it("scribe_room_command names all nine kinds and where each executes; close_orphaned_session is a server-side repair", () => {
    const d = S.CALLABLE_TOOLS.get("scribe_room_command")!.description;
    for (const k of ["start_day", "pause_day", "resume_day", "end_day", "set_audio_input", "check_update_now", "report_diag", "restart_engine", "close_orphaned_session"]) {
      expect(d).toContain(k);
    }
    expect(d).toMatch(/close_orphaned_session is a SERVER-SIDE REPAIR, not a stop: no command is queued and no kiosk is involved/);
    expect(d).toMatch(/start_day, pause_day, resume_day and end_day are queued as a bench_command for the room's listening kiosk/);
    expect(d).toMatch(/set_audio_input \(app 0\.1\.21\+\), check_update_now, report_diag and restart_engine \(app 0\.1\.22\+\) are queued as a bench_command for the native Room Recorder app/);
  });

  it("the delivery claims match the handlers: close_orphaned_session never queues a command; the other kinds do", () => {
    const src = readFileSync("lib/mcp/tools/bench.ts", "utf8");
    const body = (name: string) => {
      const start = src.indexOf(`const ${name}: McpTool = {`);
      return src.slice(start, src.indexOf("\n};\n", start));
    };
    expect(body("closeOrphaned")).not.toMatch(/insertCommand|sendAndWait/);
    expect(body("closeOrphaned")).toMatch(/closeOrphanedSession\(/);
    expect(body("startRecording")).toMatch(/sendAndWait\(room, "start_day"/);
    expect(body("setAudioInput")).toMatch(/sendAndWait\(room, "set_audio_input"/);
    expect(body("roomCommand")).toMatch(/insertCommand\(/);
    expect(src).toMatch(/simpleVerb\(\s*"scribe_pause_recording",\s*"pause_day"/);
    expect(src).toMatch(/simpleVerb\(\s*"scribe_resume_recording",\s*"resume_day"/);
    expect(src).toMatch(/simpleVerb\(\s*"scribe_stop_recording",\s*"end_day"/);
  });

  it.each([
    ["scribe_health", "SAME TOOL, MORE ASPECTS. scribe_health called with no `aspect` (or aspect=all) is exactly the scribe_health", ["llm → scribe_llm_health", "kb → scribe_kb_probe"]],
    ["scribe_room_command", "SAME TOOL, MORE KINDS. scribe_room_command called with kind check_update_now | report_diag | restart_engine is exactly the scribe_room_command", [
      "start_day → scribe_start_recording", "pause_day → scribe_pause_recording", "resume_day → scribe_resume_recording", "end_day → scribe_stop_recording",
      "close_orphaned_session → scribe_close_orphaned_session", "set_audio_input → scribe_set_audio_input"]],
  ] as Array<[string, string, string[]]>)("%s opens by saying the old call shape is the old tool, and names every value added", (name, opening, added) => {
    const d = S.CALLABLE_TOOLS.get(name)!.description;
    expect(d.startsWith(opening)).toBe(true);
    const lead = d.slice(0, d.indexOf("\n\n"));
    expect(lead).toContain(`${added.length} `);
    for (const a of added) expect(lead).toContain(a);
    // The text a cached client holds is still in the new description, word for word.
    expect(d).toContain(LIVE_TOOLS.find((t) => t.name === name)!.description);
  });

  it("only the two reused names carry that opening", () => {
    for (const g of S.GROUPS) expect(g.description.startsWith("SAME TOOL"), g.name).toBe((REUSED_NAMES as readonly string[]).includes(g.name));
  });

  it("every group description carries each member's own description verbatim", () => {
    for (const g of S.GROUPS) {
      for (const m of S.groupMembers(g)) {
        expect(g.description, `${g.name} lost ${m}'s text`).toContain(S.PUBLISHED_TOOLS.find((t) => t.name === m)!.description);
      }
    }
  });
});
