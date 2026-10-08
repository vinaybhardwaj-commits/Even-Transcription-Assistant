/**
 * Operator MCP S3 (8 Oct 2026) — two tools/list profiles, the scribe_jobs group, the operator
 * description diet, explicit OPTIONS. tools/call is profile-blind. `sql` is mocked; no DB.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";

type Row = Record<string, unknown>;
const auditInserts: unknown[][] = [];

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (/^\s*INSERT INTO audit_log/.test(strings.join("?"))) auditInserts.push(values);
    return Promise.resolve([]);
  };
  sql.transaction = async () => [];
  return { sql, db: {} };
});

const S = await import("@/lib/mcp/surface");
const P = await import("@/lib/mcp/profile");
const { handleMcpRpc } = await import("@/lib/mcp/handler");
const { POST: headerPost, OPTIONS: headerOptions } = await import("@/app/api/mcp/route");
const { POST: labPost, OPTIONS: labOptions } = await import("@/app/api/mcp/lab/route");
const { POST: pathPost, OPTIONS: pathOptions } = await import("@/app/api/mcp/[key]/route");
const { POST: pathLabPost, OPTIONS: pathLabOptions } = await import("@/app/api/mcp/[key]/lab/route");

const TOKEN = "s3-test-token";
const ORIGINAL = process.env.SCRIBE_MCP_TOKEN;
const ALL = new Set(["read", "invoke", "write"] as const);
const OPERATOR_13 = [
  "scribe_health", "scribe_system", "scribe_rooms", "scribe_sessions", "scribe_session_tape", "scribe_room_levels",
  "scribe_room_alerts", "scribe_room_command", "scribe_list_commands", "scribe_jobs", "scribe_audit_recent", "scribe_help", "scribe_usage",
];

const rpcBody = (method: string, params?: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) });
const mkReq = (url: string, body: string, headers: Record<string, string> = {}) =>
  new NextRequest(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

async function door(method: string, opts: { url?: string; headers?: Record<string, string>; scopes?: Array<"read" | "invoke" | "write">; params?: unknown } = {}) {
  const req = mkReq(opts.url ?? "https://x/api/mcp", rpcBody(method, opts.params), opts.headers);
  const res = await handleMcpRpc(req, { token_id: "s3-test", scopes: new Set(opts.scopes ?? ["read", "invoke", "write"]) });
  return { status: res.status, body: (await res.json()) as Row };
}
const listed = async (opts: Parameters<typeof door>[1] = {}) => {
  const { body } = await door("tools/list", opts);
  return (body.result as { tools: Array<{ name: string; description: string; inputSchema: unknown }> }).tools;
};
const call = (name: string, args: Row, scopes?: Array<"read" | "invoke" | "write">) =>
  door("tools/call", { params: { name, arguments: args }, scopes });

beforeEach(() => {
  process.env.SCRIBE_MCP_TOKEN = TOKEN;
  auditInserts.length = 0;
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.SCRIBE_MCP_TOKEN;
  else process.env.SCRIBE_MCP_TOKEN = ORIGINAL;
});

describe("S3.1 profile selection (S1A: one list for everyone)", () => {
  const names = async (opts: Parameters<typeof door>[1] = {}) => (await listed(opts)).map((t) => t.name);

  it("the default list is every listed tool: the 13 operator names, the lab families, scribe_jobs and the six S1 reads and scribe_reb_index", async () => {
    const all = await names();
    expect(all).toHaveLength(S.LAB_TOOLS.length);
    expect(all).toHaveLength(49);
    for (const n of OPERATOR_13) expect(all).toContain(n);
    for (const n of ["scribe_now", "scribe_room", "scribe_tape_day", "scribe_steward", "scribe_kiosks", "scribe_stt_windows", "scribe_reb_index", "scribe_fuse_report", "scribe_jev_signals"]) expect(all).toContain(n);
    expect(new Set(all).size).toBe(all.length);
  });

  it("every profile selector returns the SAME list: header, ?profile=, junk, and the /lab routes", async () => {
    const base = await listed();
    expect(await listed({ headers: { "x-scribe-profile": "lab" } })).toEqual(base);
    expect(await listed({ headers: { "x-scribe-profile": "operator" } })).toEqual(base);
    expect(await listed({ url: "https://x/api/mcp?profile=lab" })).toEqual(base);
    expect(await listed({ headers: { "x-scribe-profile": "root" } })).toEqual(base);
  });

  it("header beats query beats the path flag (selectors still resolve)", async () => {
    expect(P.resolveProfile(new Request("https://x/?profile=lab", { headers: { "x-scribe-profile": "operator" } }), "lab")).toBe("operator");
    expect(P.resolveProfile(new Request("https://x/?profile=operator"), "lab")).toBe("operator");
    expect(P.resolveProfile(new Request("https://x/"), "lab")).toBe("lab");
    expect(P.resolveProfile(new Request("https://x/"))).toBe("operator");
  });

  it("the four routes all serve the same full list, with the door's auth intact on the /lab twins", async () => {
    const bearer = { authorization: `Bearer ${TOKEN}` };
    const routeNames = async (res: Response) => ((await res.json()).result.tools as Array<{ name: string }>).map((t) => t.name);
    const list = rpcBody("tools/list");
    const one = await routeNames(await headerPost(mkReq("https://x/api/mcp", list, bearer)));
    expect(one).toHaveLength(S.LAB_TOOLS.length);
    expect(await routeNames(await pathPost(mkReq("https://x/api/mcp/k", list), { params: Promise.resolve({ key: TOKEN }) }))).toEqual(one);
    expect(await routeNames(await labPost(mkReq("https://x/api/mcp/lab", list, bearer)))).toEqual(one);
    expect(await routeNames(await pathLabPost(mkReq("https://x/api/mcp/k/lab", list), { params: Promise.resolve({ key: TOKEN }) }))).toEqual(one);
    expect((await labPost(mkReq("https://x/api/mcp/lab", list))).status).toBe(401);
    expect((await pathLabPost(mkReq("https://x/api/mcp/k/lab", list), { params: Promise.resolve({ key: "wrong" }) })).status).toBe(401);
  });

  it("input schemas of every pre-S1 tool match origin/main's capture (ec0d8a7) except property descriptions, which are shortened (the full schema is in scribe_help)", async () => {
    const main = JSON.parse(readFileSync("fixtures/mcp/live-tools-list-ec0d8a7.json", "utf8")) as { result: { tools: Array<{ name: string; inputSchema: unknown }> } };
    const mainBy = new Map(main.result.tools.map((t) => [t.name, t]));
    const all = await listed();
    let compared = 0;
    for (const t of all) {
      const base = mainBy.get(t.name);
      if (!base) continue;
      expect(t.inputSchema, t.name).toEqual(P.shortSchema(base.inputSchema));
      compared++;
    }
    expect(compared).toBe(41);
    expect(all.map((t) => t.name).filter((n) => !mainBy.has(n)).sort()).toEqual(["scribe_jobs", "scribe_kiosks", "scribe_now", "scribe_reb_index", "scribe_room", "scribe_steward", "scribe_stt_windows", "scribe_tape_day"]);
    // shortened descriptions only: same keys, types, enums, required, bounds as the registry's schema
    const strip = (o: unknown): unknown => Array.isArray(o) ? o.map(strip) : o && typeof o === "object" ? Object.fromEntries(Object.entries(o as Row).filter(([k, v]) => !(k === "description" && typeof v === "string")).map(([k, v]) => [k, strip(v)])) : o;
    for (const t of all) expect(strip(t.inputSchema), t.name).toEqual(strip(S.CALLABLE_TOOLS.get(t.name)!.inputSchema));
    // the full schema stays reachable
    const help = S.CALLABLE_TOOLS.get("scribe_help")!;
    for (const t of all) expect(((await help.handler({ tool: t.name }, { origin: "x", actor: "a", scopes: ALL } as never)) as Row).input_schema, t.name).toEqual(S.CALLABLE_TOOLS.get(t.name)!.inputSchema);
  });

  it("the long text of every tool is kept: scribe_help `help` equals the registry description (for tools main already had, main's own capture)", async () => {
    const main = JSON.parse(readFileSync("fixtures/mcp/live-tools-list-ec0d8a7.json", "utf8")) as { result: { tools: Array<{ name: string; description: string }> } };
    const help = S.CALLABLE_TOOLS.get("scribe_help")!;
    for (const t of main.result.tools) {
      if (t.name === "scribe_help") continue; // its own text was extended in S3
      if (!P.listedTool(t.name)) continue;    // an old name a group now fronts
      const out = (await help.handler({ tool: t.name }, { origin: "x", actor: "a", scopes: ALL } as never)) as Row;
      expect(out.help, t.name).toBe(t.description);
    }
  });

  it("initialize says it is one list and how selectors behave; it never carries the key", async () => {
    const op = ((await door("initialize")).body.result as { instructions: string }).instructions;
    expect(op).toContain("One tool list for every caller");
    expect(op).toContain("X-Scribe-Profile");
    expect(op).toContain("(S3)");
    expect(op).not.toContain("(S2)");
    expect(op).not.toContain(TOKEN);
    const lab = ((await door("initialize", { headers: { "x-scribe-profile": "lab" } })).body.result as { instructions: string }).instructions;
    expect(lab).toBe(op);
  });
});

describe("S3.1 tools/call ignores the profile", () => {
  it("every accepted name (the 52 pre-grouping names, every group name, scribe_help/usage, scribe_jobs) is callable from the operator profile", async () => {
    const live = JSON.parse(readFileSync("fixtures/mcp/live-tools-list-0f27b8c.json", "utf8")).result.tools as Array<{ name: string }>;
    expect(live).toHaveLength(52);
    const names = new Set<string>([...live.map((t) => t.name), ...S.CALLABLE_TOOLS.keys()]);
    expect(names.size).toBeGreaterThanOrEqual(75);
    expect(names.has("scribe_jobs")).toBe(true);
    // Stub every handler: this test is about NAME RESOLUTION through the operator profile, not behaviour.
    for (const t of new Set([...S.PUBLISHED_TOOLS, ...S.CALLABLE_TOOLS.values()])) vi.spyOn(t, "handler").mockResolvedValue({ ok: true });
    for (const name of names) {
      const { status, body } = await door("tools/call", { params: { name, arguments: name === "scribe_jobs" ? { action: "list" } : {} } });
      expect(status, name).toBe(200);
      expect(body.error, name).toBeUndefined();
    }
    // …and an unknown name is still refused, so the loop above proves something.
    expect((await call("scribe_no_such_tool", {})).status).toBe(403);
  });
});

describe("S3.2 scribe_jobs", () => {
  const MEMBER: Record<string, string> = { submit: "scribe_job_submit", status: "scribe_job_status", list: "scribe_job_list", cancel: "scribe_job_cancel" };

  it("is registered with the read scope (group gate), selector `action`, and a generated description", () => {
    const g = S.CALLABLE_TOOLS.get("scribe_jobs")!;
    expect(g.scope).toBe("read");
    expect(S.groupMembers(g)).toEqual(Object.values(MEMBER));
    expect(g.inputSchema.required).toEqual(["action"]);
    for (const [action, member] of Object.entries(MEMBER)) {
      expect(g.description).toContain(action);
      expect(g.description).toContain(member);
      expect(g.memberFor!({ action })).toBe(member);
    }
    expect(S.wordCount(g.description)).toBeLessThanOrEqual(S.GROUP_DESCRIPTION_MAX_WORDS);
  });

  it.each(Object.entries(MEMBER))("action=%s runs %s with the other arguments, selector removed", async (action, member) => {
    const spy = vi.spyOn(S.PUBLISHED_TOOLS.find((t) => t.name === member)!, "handler").mockResolvedValue({ via: member });
    const { status, body } = await call("scribe_jobs", { action, job_id: "job_x" });
    expect(status).toBe(200);
    expect((body.result as Row).structuredContent).toEqual({ via: member });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toEqual({ job_id: "job_x" });
  });

  it("an unknown or missing action answers unknown_action with the allowed list and runs nothing", async () => {
    const spies = Object.values(MEMBER).map((m) => vi.spyOn(S.PUBLISHED_TOOLS.find((t) => t.name === m)!, "handler").mockResolvedValue({}));
    for (const args of [{ action: "purge" }, {}]) {
      const { body } = await call("scribe_jobs", args);
      expect((body.result as Row).structuredContent).toEqual({ ok: false, error: "unknown_action", allowed: ["submit", "status", "list", "cancel"] });
    }
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it("the description states each action's scope", () => {
    const d = S.CALLABLE_TOOLS.get("scribe_jobs")!.description;
    expect(d).toMatch(/status and list need READ/);
    expect(d).toMatch(/submit[^.]*needs INVOKE/);
    expect(d).toMatch(/cancel needs WRITE/);
    expect(P.listedTool("scribe_jobs")!.description).toMatch(/status\/list need read, submit needs invoke, cancel needs write/);
  });

  // token shape × action → HTTP status. The member's scope decides; the old names are unchanged.
  const SHAPES: Record<string, Array<"read" | "invoke" | "write">> = { "read-only": ["read"], "read+write": ["read", "write"], "read+invoke+write": ["read", "invoke", "write"] };
  const EXPECT: Record<string, Record<string, number>> = {
    "read-only": { status: 200, list: 200, submit: 403, cancel: 403 },
    "read+write": { status: 200, list: 200, submit: 403, cancel: 200 },
    "read+invoke+write": { status: 200, list: 200, submit: 200, cancel: 200 },
  };
  const NEEDS: Record<string, string> = { submit: "invoke", cancel: "write" };
  for (const [shape, scopes] of Object.entries(SHAPES)) {
    it.each(["status", "list", "submit", "cancel"])(`token ${shape}: action=%s`, async (action) => {
      for (const m of Object.values(MEMBER)) vi.spyOn(S.PUBLISHED_TOOLS.find((t) => t.name === m)!, "handler").mockResolvedValue({ fine: true });
      const out = await call("scribe_jobs", { action, job_id: "j" }, scopes);
      expect(out.status).toBe(EXPECT[shape]![action]);
      if (out.status === 403) {
        expect(out.body.error).toMatchObject({ code: -32001, message: "scope_or_tool_unavailable", data: { tool: "scribe_jobs", needed: NEEDS[action] } });
      }
    });
  }

  it("a token with no read scope is refused at the group gate; the old names keep their own scope rules", async () => {
    for (const m of Object.values(MEMBER)) vi.spyOn(S.PUBLISHED_TOOLS.find((t) => t.name === m)!, "handler").mockResolvedValue({ fine: true });
    expect((await call("scribe_jobs", { action: "submit" }, ["invoke"])).status).toBe(403);
    expect((await call("scribe_job_list", {}, ["read"])).status).toBe(200);
    expect((await call("scribe_job_cancel", { job_id: "j" }, ["read", "write"])).status).toBe(200);
    expect((await call("scribe_job_submit", {}, ["read"])).status).toBe(403);
    expect((await call("scribe_job_submit", {}, ["invoke"])).status).toBe(200);
  });

  it("G1: scribe_jobs is never advertised read-only, under either profile; cancel makes it destructive", async () => {
    for (const headers of [{}, { "x-scribe-profile": "lab" }] as Array<Record<string, string>>) {
      const body = (await door("tools/list", { headers })).body.result as { tools: Array<{ name: string; annotations: Row }> };
      const jobs = body.tools.find((t) => t.name === "scribe_jobs")!;
      expect(jobs.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
    }
  });

  it("G1: no listed tool with a write- or invoke-scope member carries readOnlyHint true (both profiles)", async () => {
    for (const headers of [{}, { "x-scribe-profile": "lab" }] as Array<Record<string, string>>) {
      const body = (await door("tools/list", { headers })).body.result as { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> };
      for (const t of body.tools) {
        const tool = S.CALLABLE_TOOLS.get(t.name)!;
        const members = S.groupMembers(tool);
        const scopes = [tool.scope, ...members.map((m) => S.CALLABLE_TOOLS.get(m)!.scope)];
        if (scopes.some((s) => s !== "read")) expect(t.annotations.readOnlyHint, t.name).toBe(false);
      }
    }
  });

  it("G5: scribe_room_command is destructive and not read-only (end_day can stop a live room); scribe_tape_day's text names what it returns", async () => {
    const tools = (await door("tools/list")).body.result as { tools: Array<{ name: string; description: string; annotations: Row }> };
    const rc = tools.tools.find((t) => t.name === "scribe_room_command")!;
    expect(rc.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    const td = tools.tools.find((t) => t.name === "scribe_tape_day")!.description;
    expect(td).toMatch(/Minutes per audio state/);
    expect(td).toMatch(/include_segments/);
    expect(td).not.toMatch(/sessions|pieces|gaps/);
    // generic: every tool whose scope or members include a write is destructive-capable only if it is a room/queue mutator; none is advertised read-only
    for (const t of tools.tools) if (/^WRITE|^Reads and writes/.test(t.description)) expect(t.annotations.readOnlyHint, t.name).toBe(false);
  });

  it("a refused member never runs", async () => {
    const spy = vi.spyOn(S.PUBLISHED_TOOLS.find((t) => t.name === "scribe_job_submit")!, "handler").mockResolvedValue({});
    await call("scribe_jobs", { action: "submit" }, ["read", "write"]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("scribe_help reports listed_in per profile", async () => {
    const help = S.CALLABLE_TOOLS.get("scribe_help")!;
    const li = async (tool: string) => ((await help.handler({ tool }, { origin: "x", actor: "a", scopes: ALL } as never)) as Row).listed_in;
    expect(await li("scribe_jobs")).toEqual(["operator", "lab"]);
    expect(await li("scribe_job_status")).toEqual(["operator", "lab"]);
    expect(await li("scribe_list_rooms")).toEqual([]);
  });

  it("the audit row names scribe_jobs as target and the member as variant", async () => {
    vi.spyOn(S.PUBLISHED_TOOLS.find((t) => t.name === "scribe_job_list")!, "handler").mockResolvedValue({ jobs: [] });
    await call("scribe_jobs", { action: "list" });
    await new Promise((r) => setTimeout(r, 0));
    expect(auditInserts).toHaveLength(1);
    const values = auditInserts[0]!;
    expect(values[1]).toBe("scribe_jobs");
    expect(JSON.parse(values.find((v) => typeof v === "string" && v.startsWith("{")) as string)).toMatchObject({ variant: "scribe_job_list" });
  });

  it("job tools stay listed in lab beside scribe_jobs", async () => {
    const lab = (await listed({ headers: { "x-scribe-profile": "lab" } })).map((t) => t.name);
    for (const m of Object.values(MEMBER)) expect(lab).toContain(m);
  });
});

describe("S3.3 the description diet, every listed tool (S1A)", () => {
  it("plain tools <= 200 chars, generated group descriptions <= 400", async () => {
    for (const t of await listed()) {
      const isGroup = S.groupProbes(S.CALLABLE_TOOLS.get(t.name)!).length > 0;
      expect(t.description.length, t.name).toBeLessThanOrEqual(isGroup ? 400 : 200);
    }
  });

  it("every description says read or write, whether it can touch a room, and that times are UTC", async () => {
    for (const t of await listed()) {
      expect(t.description, t.name).toMatch(/Times UTC/);
      expect(t.description, t.name).toMatch(/read|write|invoke|reads and writes/i);
      expect(t.description, t.name).toMatch(/room|brain|session|queue|job|encounter|trace|audit|voice|clinician|diariz|jev|door|health|system|tool|visit|cue|window|tape/i);
    }
  });

  it("the write and invoke tools say so in words (the first words of the description)", async () => {
    const byName = Object.fromEntries((await listed()).map((t) => [t.name, t.description]));
    for (const t of S.LAB_TOOLS) {
      const members = S.groupMembers(t);
      const scopes = [t.scope, ...members.map((m) => S.CALLABLE_TOOLS.get(m)!.scope)];
      if (t.name === "scribe_jobs") continue;
      if (scopes.includes("write")) expect(byName[t.name], t.name).toMatch(/WRITE/);
      else if (scopes.includes("invoke")) expect(byName[t.name], t.name).toMatch(/INVOKE/);
      else expect(byName[t.name], t.name).toMatch(/Read-only|Reads|read tools|READ/i);
    }
  });

  it("the room-reading tools carry the silence caveats; scribe_room_command carries the command rules", async () => {
    const byName = Object.fromEntries((await listed()).map((t) => [t.name, t.description]));
    for (const n of ["scribe_rooms", "scribe_room_levels", "scribe_now", "scribe_room"]) {
      expect(byName[n], n).toMatch(/tape_advancing/);
      expect(byName[n], n).toMatch(/zero_ratio>=0\.98/);
      expect(byName[n], n).toMatch(/freeze|frozen/);
    }
    const c = byName.scribe_room_command!;
    for (const s of ["kiosk_not_listening", "start_day idempotent", "room_paused is consent", "no start/stop on a room with patients without V's GO"]) expect(c).toContain(s);
  });

  it("group value lists are generated from the variant table", async () => {
    const byName = Object.fromEntries((await listed()).map((t) => [t.name, t.description]));
    for (const n of ["scribe_health", "scribe_system", "scribe_rooms", "scribe_sessions", "scribe_session_tape", "scribe_room_command", "scribe_jobs", "scribe_scratch", "scribe_voice"]) {
      for (const p of S.groupProbes(S.CALLABLE_TOOLS.get(n)!)) expect(byName[n], `${n} ${p.value}`).toContain(p.value);
    }
  });

  it("budget: the full tools/list result stays under 36,500 characters", async () => {
    const { body } = await door("tools/list");
    const chars = JSON.stringify(body.result).length;
    console.log(`S1A full tools/list: ${chars} chars (~${Math.round(chars / 4)} tokens), ${(body.result as { tools: unknown[] }).tools.length} tools`);
    expect(chars, `tools/list is ${chars} chars`).toBeLessThanOrEqual(36_500);
  });

  it("scribe_help returns the long text as `help` beside the short description, for every listed tool", async () => {
    const help = S.CALLABLE_TOOLS.get("scribe_help")!;
    for (const t of S.LAB_TOOLS) {
      const out = (await help.handler({ tool: t.name }, { origin: "x", actor: "a", scopes: ALL } as never)) as Row;
      expect(out.help, t.name).toBe(t.help ?? t.description);
      expect((out.description as string).length, t.name).toBeLessThanOrEqual(400);
      expect(out.description, t.name).toBe(P.listedTool(t.name)!.description);
      expect(out.listed_in, t.name).toEqual(["operator", "lab"]);
    }
  });
});

describe("S3.4 OPTIONS", () => {
  it.each([
    ["/api/mcp", headerOptions, false],
    ["/api/mcp/lab", labOptions, false],
    ["/api/mcp/<key>", pathOptions, true],
    ["/api/mcp/<key>/lab", pathLabOptions, true],
  ] as const)("%s answers 204 with Allow: POST, OPTIONS%s", async (_n, fn, cors) => {
    const res = await (fn as () => Promise<Response>)();
    expect(res.status).toBe(204);
    expect(res.headers.get("allow")).toBe("POST, OPTIONS");
    expect(res.headers.get("access-control-allow-origin")).toBe(cors ? "*" : null);
    if (cors) expect(res.headers.get("access-control-allow-headers")).toContain("x-scribe-profile");
    expect(await res.text()).toBe("");
  });
});
