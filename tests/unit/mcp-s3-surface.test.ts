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

describe("S3.1 profile selection", () => {
  it("defaults to operator: exactly the 13 names, in order", async () => {
    expect((await listed()).map((t) => t.name)).toEqual(OPERATOR_13);
  });

  it("header X-Scribe-Profile: lab selects lab; so does ?profile=lab; junk values fall back to the default", async () => {
    const byHeader = await listed({ headers: { "x-scribe-profile": "lab" } });
    const byQuery = await listed({ url: "https://x/api/mcp?profile=lab" });
    expect(byHeader).toHaveLength(S.LAB_TOOLS.length);
    expect(byQuery.map((t) => t.name)).toEqual(byHeader.map((t) => t.name));
    expect((await listed({ headers: { "x-scribe-profile": "root" } })).map((t) => t.name)).toEqual(OPERATOR_13);
    expect((await listed({ url: "https://x/api/mcp?profile=" })).map((t) => t.name)).toEqual(OPERATOR_13);
  });

  it("header beats query beats the path flag", async () => {
    expect(P.resolveProfile(new Request("https://x/?profile=lab", { headers: { "x-scribe-profile": "operator" } }), "lab")).toBe("operator");
    expect(P.resolveProfile(new Request("https://x/?profile=operator"), "lab")).toBe("operator");
    expect(P.resolveProfile(new Request("https://x/"), "lab")).toBe("lab");
    expect(P.resolveProfile(new Request("https://x/"))).toBe("operator");
  });

  it("the four routes: bearer and path-key doors are operator, their /lab twins are lab", async () => {
    const bearer = { authorization: `Bearer ${TOKEN}` };
    const names = async (res: Response) => ((await res.json()).result.tools as Array<{ name: string }>).map((t) => t.name);
    const list = rpcBody("tools/list");
    expect(await names(await headerPost(mkReq("https://x/api/mcp", list, bearer)))).toEqual(OPERATOR_13);
    expect(await names(await pathPost(mkReq("https://x/api/mcp/k", list), { params: Promise.resolve({ key: TOKEN }) }))).toEqual(OPERATOR_13);
    const lab1 = await names(await labPost(mkReq("https://x/api/mcp/lab", list, bearer)));
    const lab2 = await names(await pathLabPost(mkReq("https://x/api/mcp/k/lab", list), { params: Promise.resolve({ key: TOKEN }) }));
    expect(lab1).toHaveLength(S.LAB_TOOLS.length);
    expect(lab2).toEqual(lab1);
    // the lab routes keep the door's auth
    expect((await labPost(mkReq("https://x/api/mcp/lab", list))).status).toBe(401);
    expect((await pathLabPost(mkReq("https://x/api/mcp/k/lab", list), { params: Promise.resolve({ key: "wrong" }) })).status).toBe(401);
  });

  it("the lab list is today's listed tools plus scribe_jobs (42), every operator name among them", async () => {
    const lab = (await listed({ headers: { "x-scribe-profile": "lab" } })).map((t) => t.name);
    expect(lab).toHaveLength(S.LISTED_TOOLS.length + 1);
    expect(lab).toHaveLength(42);
    for (const t of S.LISTED_TOOLS) expect(lab).toContain(t.name);
    expect(lab).toContain("scribe_jobs");
    for (const n of OPERATOR_13) expect(lab).toContain(n);
  });

  it("lab keeps today's FULL descriptions and schemas, byte for byte", async () => {
    const lab = await listed({ headers: { "x-scribe-profile": "lab" } });
    for (const t of lab) {
      const real = S.CALLABLE_TOOLS.get(t.name)!;
      expect(t.description, t.name).toBe(real.description);
      expect(t.inputSchema, t.name).toEqual(real.inputSchema);
    }
  });

  it("lab descriptions match origin/main's capture (ec0d8a7), except scribe_help and scribe_jobs — a diet cannot touch lab silently", async () => {
    const main = JSON.parse(readFileSync("fixtures/mcp/live-tools-list-ec0d8a7.json", "utf8")) as { result: { tools: Array<{ name: string; description: string; inputSchema: unknown }> } };
    const mainBy = new Map(main.result.tools.map((t) => [t.name, t]));
    const lab = await listed({ headers: { "x-scribe-profile": "lab" } });
    let compared = 0;
    for (const t of lab) {
      if (t.name === "scribe_help" || t.name === "scribe_jobs") continue;
      const base = mainBy.get(t.name);
      expect(base, `${t.name} missing from origin/main capture`).toBeDefined();
      expect(t.description, t.name).toBe(base!.description);
      expect(t.inputSchema, t.name).toEqual(base!.inputSchema);
      compared++;
    }
    expect(compared).toBe(40);
    expect(lab.map((t) => t.name).filter((n) => !mainBy.has(n))).toEqual(["scribe_jobs"]);
  });

  it("operator input schemas are unchanged", async () => {
    for (const t of await listed()) expect(t.inputSchema, t.name).toEqual(S.CALLABLE_TOOLS.get(t.name)!.inputSchema);
  });

  it("initialize says which profile is active and how to reach the other", async () => {
    const op = ((await door("initialize")).body.result as { instructions: string }).instructions;
    expect(op).toMatch(/^Profile: operator \(13 tools listed\)/);
    expect(op).toContain("X-Scribe-Profile: lab");
    expect(op).toContain("?profile=lab");
    expect(op).toContain("/lab");
    expect(op).toContain("(S3)");
    expect(op).not.toContain("(S2)");
    const lab = ((await door("initialize", { headers: { "x-scribe-profile": "lab" } })).body.result as { instructions: string }).instructions;
    expect(lab).toMatch(/^Profile: lab \(42 tools listed\)/);
    expect(lab).toContain("X-Scribe-Profile: operator");
    expect(op + lab).not.toContain(TOKEN);
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
    expect(P.operatorTool("scribe_jobs")!.description).toMatch(/status\/list need read, submit needs invoke, cancel needs write/);
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
    for (const headers of [{}, { "x-scribe-profile": "lab" }]) {
      const body = (await door("tools/list", { headers })).body.result as { tools: Array<{ name: string; annotations: Row }> };
      const jobs = body.tools.find((t) => t.name === "scribe_jobs")!;
      expect(jobs.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
    }
  });

  it("G1: no listed tool with a write- or invoke-scope member carries readOnlyHint true (both profiles)", async () => {
    for (const headers of [{}, { "x-scribe-profile": "lab" }]) {
      const body = (await door("tools/list", { headers })).body.result as { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> };
      for (const t of body.tools) {
        const tool = S.CALLABLE_TOOLS.get(t.name)!;
        const members = S.groupMembers(tool);
        const scopes = [tool.scope, ...members.map((m) => S.CALLABLE_TOOLS.get(m)!.scope)];
        if (scopes.some((s) => s !== "read")) expect(t.annotations.readOnlyHint, t.name).toBe(false);
      }
    }
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
    expect(await li("scribe_job_status")).toEqual(["lab"]);
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

describe("S3.3 the operator description diet", () => {
  it("plain tools <= 200 chars, generated group descriptions <= 400", async () => {
    for (const t of await listed()) {
      const isGroup = S.groupProbes(S.CALLABLE_TOOLS.get(t.name)!).length > 0;
      expect(t.description.length, t.name).toBeLessThanOrEqual(isGroup ? 400 : 200);
    }
  });

  it("every operator description says read or write, whether it can touch a live room, and that times are UTC", async () => {
    for (const t of await listed()) {
      expect(t.description, t.name).toMatch(/\b(read-only|reads|writes?)\b/i);
      expect(t.description, t.name).toMatch(/room/i);
      expect(t.description, t.name).toMatch(/times utc/i);
    }
    const byName = Object.fromEntries((await listed()).map((t) => [t.name, t.description]));
    expect(byName.scribe_room_command).toMatch(/WRITE/);
    expect(byName.scribe_room_command).toMatch(/LIVE/);
  });

  it("the room-reading tools carry the silence caveats; scribe_room_command carries the command rules", async () => {
    const byName = Object.fromEntries((await listed()).map((t) => [t.name, t.description]));
    for (const n of ["scribe_rooms", "scribe_room_levels"]) {
      expect(byName[n], n).toContain("tape_advancing does not mean audio is arriving");
      expect(byName[n], n).toContain("zero_ratio>=0.98 = digital silence");
      expect(byName[n], n).toContain("levels can freeze after a device drop");
    }
    const c = byName.scribe_room_command!;
    for (const s of ["kiosk_not_listening", "start_day idempotent", "room_paused is consent", "no start/stop on a room with patients without V's GO"]) expect(c).toContain(s);
  });

  it("group value lists are generated from the variant table", async () => {
    const byName = Object.fromEntries((await listed()).map((t) => [t.name, t.description]));
    for (const n of ["scribe_health", "scribe_system", "scribe_rooms", "scribe_sessions", "scribe_session_tape", "scribe_room_command", "scribe_jobs"]) {
      for (const p of S.groupProbes(S.CALLABLE_TOOLS.get(n)!)) expect(byName[n], `${n} ${p.value}`).toContain(p.value);
    }
  });

  it("budget: the operator tools/list result stays under 24,000 characters", async () => {
    const { body } = await door("tools/list");
    const chars = JSON.stringify(body.result).length;
    console.log(`operator tools/list: ${chars} chars (~${Math.round(chars / 4)} tokens)`);
    expect(chars, `operator tools/list is ${chars} chars`).toBeLessThanOrEqual(24_000);
  });

  it("scribe_help returns the long text as `help` beside the short description, for every dieted tool", async () => {
    const help = S.CALLABLE_TOOLS.get("scribe_help")!;
    for (const name of OPERATOR_13) {
      const out = (await help.handler({ tool: name }, { origin: "x", actor: "a", scopes: ALL } as never)) as Row;
      const full = S.CALLABLE_TOOLS.get(name)!;
      expect(out.help, name).toBe(full.description);
      expect((out.description as string).length, name).toBeLessThanOrEqual(400);
      expect(out.description, name).toBe(P.operatorTool(name)!.description);
    }
    // a lab-only tool keeps its description and has no help field
    const lab = (await help.handler({ tool: "scribe_fuse_report" }, { origin: "x", actor: "a", scopes: ALL } as never)) as Row;
    expect(lab.description).toBe(S.CALLABLE_TOOLS.get("scribe_fuse_report")!.description);
    expect(lab.help).toBeUndefined();
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
