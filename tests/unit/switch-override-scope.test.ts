/**
 * V's ruling, 21 Sep 2026 (RULINGS-21-SEP-1600): `switch_override` on a `room_window` job requires WRITE scope, not invoke.
 *
 * The Reviewer's finding was that any `invoke` token could submit a job that writes an off room's live day. The rule now lives in
 * `submitJob`, the one place every submit path passes (its own comment says why: three paths, and a rule in one of them is not a
 * rule) — so these tests drive BOTH the real `scribe_job_submit` tool handler and `submitJob` directly, and pin that:
 *   - an invoke-only caller is refused the override, by name, and NOTHING is queued;
 *   - a caller with write may use it, and it is stored;
 *   - everything else about the kind is unchanged: translate stays at invoke, a job without the override needs only invoke,
 *     and the check only ever ADDS a requirement.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const inserts: Array<{ kind: string; args: Row; actor: unknown }> = [];

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    if (/^INSERT INTO scribe_job/.test(text)) {
      const args = JSON.parse(String(values[2])) as Row;
      inserts.push({ kind: String(values[1]), args, actor: values[3] });
      return Promise.resolve([{
        id: values[0], kind: values[1], args, status: "queued", step: "prepare", progress: {}, result: null, error: null,
        actor: values[3], created_at: new Date().toISOString(), started_at: null, updated_at: new Date().toISOString(),
        finished_at: null, lease_until: null, lease_owner: null, attempts: 0, failures: 0,
      }]);
    }
    return Promise.resolve([]);
  };
  sql.transaction = async () => [];
  return { sql, db: {} };
});

const { JOB_TOOLS } = await import("@/lib/mcp/tools/jobs");
const { submitJob } = await import("@/lib/jobs/submit");
const { KIND_BY_NAME } = await import("@/lib/jobs/kinds");
const { ToolScopeError } = await import("@/lib/mcp/registry");

type Scope = "read" | "invoke" | "write";
const scopes = (...s: Scope[]) => new Set<Scope>(s);
const READ_INVOKE = scopes("read", "invoke");
const ALL = scopes("read", "invoke", "write");
const BASE = { window_id: "bw_1", origin: "https://www.evenscribe.app", actor: "overnight-translate", via: "mcp" };

const submitTool = JOB_TOOLS.find((t) => t.name === "scribe_job_submit")!;
const viaTool = (args: Row, s: Set<Scope>) =>
  submitTool.handler({ kind: "room_window", args }, { origin: "https://x", actor: "mcp:overnight-translate", scopes: s } as never) as Promise<Row>;
const viaSubmitJob = (args: Row, s?: Set<Scope>) =>
  submitJob({ kind: "room_window", args, actor: "mcp:t", ...(s ? { scopes: s } : {}) });

const refusal = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e as { needed?: string; detail?: Row; message?: string }; }
  return null;
};

beforeEach(() => { inserts.length = 0; delete process.env.JOBS_RUNNER_SECRET; });

describe("through the scribe_job_submit TOOL", () => {
  it("an invoke-only token is REFUSED the override — the scope error names write and the argument, and nothing is queued", async () => {
    const e = await refusal(viaTool({ ...BASE, switch_override: true }, READ_INVOKE));
    expect(e).toBeInstanceOf(ToolScopeError);
    expect(e!.needed).toBe("write");
    expect(e!.detail).toMatchObject({ kind: "room_window", kind_scope: "invoke", arg: "switch_override", arg_scope: "write" });
    expect(inserts, "a refused submit queues nothing").toHaveLength(0);
  });

  it("the refusal is the SAME error a missing kind scope gets (-32001 scope_or_tool_unavailable), not a new shape", async () => {
    const e = await refusal(viaTool({ ...BASE, switch_override: true }, READ_INVOKE));
    expect(String(e!.message)).toMatch(/scope_or_tool_unavailable/);
  });

  it("a token with write may use it: queued, and the flag is stored on the row", async () => {
    const r = await viaTool({ ...BASE, switch_override: true, translate: true }, ALL);
    expect(r.ok).toBe(true);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.args).toEqual({ ...BASE, translate: true, switch_override: true });
  });

  it("translate ALONE still needs only invoke — it costs Mini time, it does not widen what may be written", async () => {
    const r = await viaTool({ ...BASE, translate: true }, READ_INVOKE);
    expect(r.ok).toBe(true);
    expect(inserts[0]!.args).toEqual({ ...BASE, translate: true });
  });

  it("a job with neither choice needs only invoke, and its stored args are exactly the four it always had", async () => {
    const r = await viaTool({ ...BASE }, READ_INVOKE);
    expect(r.ok).toBe(true);
    expect(inserts[0]!.args).toEqual(BASE);
  });

  it("switch_override:false is not stored and needs nothing extra", async () => {
    const r = await viaTool({ ...BASE, switch_override: false }, READ_INVOKE);
    expect(r.ok).toBe(true);
    expect(Object.keys(inserts[0]!.args)).not.toContain("switch_override");
  });

  it("a malformed override is a BAD-ARGS refusal (parsed first), not a scope error — and still nothing is queued", async () => {
    const r = await viaTool({ ...BASE, switch_override: "true" }, READ_INVOKE);
    expect(r).toMatchObject({ ok: false, error: "bad_args" });
    expect(inserts).toHaveLength(0);
  });

  it("write WITHOUT invoke is refused on the KIND's scope first — write does not stand in for invoke", async () => {
    const e = await refusal(viaTool({ ...BASE, switch_override: true }, scopes("read", "write")));
    expect(e).toBeInstanceOf(ToolScopeError);
    expect(e!.needed).toBe("invoke");
    expect(e!.detail).toMatchObject({ kind: "room_window", kind_scope: "invoke" });
    expect(inserts).toHaveLength(0);
  });
});

describe("in submitJob ITSELF — the rule is not the tool's alone (three submit paths)", () => {
  it("the drain's own call shape (scopes = {invoke}, no override) still works — the auto-drain and admin routes are unaffected", async () => {
    const job = await viaSubmitJob({ ...BASE, via: "cron" }, scopes("invoke"));
    expect(job.kind).toBe("room_window");
    expect(inserts[0]!.args).toEqual({ ...BASE, via: "cron" });
  });

  it("the SAME shape carrying the override is refused — a path other than the MCP tool cannot skip the requirement", async () => {
    const e = await refusal(viaSubmitJob({ ...BASE, switch_override: true }, scopes("invoke")));
    expect(e).toBeInstanceOf(ToolScopeError);
    expect(e!.needed).toBe("write");
    expect(inserts).toHaveLength(0);
  });

  it("scopes omitted fails CLOSED, as it always did", async () => {
    const e = await refusal(viaSubmitJob({ ...BASE, switch_override: true }));
    expect(e).toBeInstanceOf(ToolScopeError);
    expect(inserts).toHaveLength(0);
  });

  it("all three scopes together are accepted", async () => {
    await viaSubmitJob({ ...BASE, switch_override: true }, ALL);
    expect(inserts[0]!.args.switch_override).toBe(true);
  });
});

describe("the hook is narrow — it adds a requirement to ONE argument of ONE kind", () => {
  it("only room_window declares a scopeForArgs; every other kind is exactly as it was", () => {
    const declaring = [...KIND_BY_NAME.values()].filter((k) => typeof k.scopeForArgs === "function").map((k) => k.name);
    expect(declaring).toEqual(["room_window"]);
  });

  it("scopeForArgs asks for write only when the parsed args carry switch_override:true", () => {
    const k = KIND_BY_NAME.get("room_window")!;
    expect(k.scopeForArgs!({ ...BASE })).toBeNull();
    expect(k.scopeForArgs!({ ...BASE, translate: true })).toBeNull();
    expect(k.scopeForArgs!({ ...BASE, switch_override: false })).toBeNull();
    expect(k.scopeForArgs!({ ...BASE, switch_override: "true" })).toBeNull();     // parseArgs refuses this before it ever gets here
    expect(k.scopeForArgs!({ ...BASE, switch_override: true })).toEqual({ scope: "write", arg: "switch_override" });
  });

  it("the kind's own scope is still invoke — the extra requirement did not replace it", () => {
    expect(KIND_BY_NAME.get("room_window")!.scope).toBe("invoke");
  });
});
