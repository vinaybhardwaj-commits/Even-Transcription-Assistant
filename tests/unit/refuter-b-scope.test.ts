/**
 * REFUTER (f) per-kind scope at the tool boundary + failSafe, and (g) the async return shape
 * against the description that promises it. Driven through the real MCP handler where possible.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
let TABLE: Row[] = [];
vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    if (/^INSERT INTO scribe_job/.test(text)) {
      const [id, kind, args, actor] = values as [string, string, string, string | null];
      const row: Row = { id, kind, args, status: "queued", step: null, progress: "{}", result: null,
        error: null, actor, created_at: "2026-09-12T07:00:00.000Z", started_at: null,
        updated_at: "2026-09-12T07:00:00.000Z", finished_at: null, lease_until: null, attempts: 0, failures: 0 };
      TABLE.push(row); return Promise.resolve([row]);
    }
    return Promise.resolve([]);
  };
  sql.transaction = async () => [];
  return { sql, db: {} };
});
vi.mock("next/server", async (o) => ({ ...(await o() as object), after: (fn: () => unknown) => { void fn; } }));

import { JOB_TOOLS } from "@/lib/mcp/tools/jobs";
import { BENCH_TOOLS } from "@/lib/mcp/tools/bench";
import { failSafe, ToolScopeError } from "@/lib/mcp/registry";
import { KIND_BY_NAME } from "@/lib/jobs/kinds";
import { handleMcpRpc } from "@/lib/mcp/handler";
import { NextRequest } from "next/server";

type Scope = "read" | "invoke" | "write";
const ctxOf = (...s: Scope[]) => ({ origin: "https://x", actor: "mcp:refuter", scopes: new Set(s) as ReadonlySet<Scope> });
const jtool = (n: string) => JOB_TOOLS.find((t) => t.name === n)!;
const btool = (n: string) => BENCH_TOOLS.find((t) => t.name === n)!;

const rpc = async (name: string, args: Record<string, unknown>, scopes: Scope[]) => {
  const req = new NextRequest("https://x/api/mcp", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const res = await handleMcpRpc(req, { token_id: "refuter", scopes: new Set(scopes) as ReadonlySet<Scope> });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};

beforeEach(() => { TABLE = []; });

describe("(f) per-kind scope at the tool boundary", () => {
  it("failSafe swallows a normal throw but NEVER a ToolScopeError", async () => {
    const degraded = await failSafe({ ok: false }, async () => { throw new Error("db down"); });
    expect(degraded).toMatchObject({ degraded: true });
    await expect(failSafe({ ok: false }, async () => { throw new ToolScopeError("write", { a: 1 }); }))
      .rejects.toBeInstanceOf(ToolScopeError);
  });

  it("day_manifest declares `read`, so an invoke-only token is refused at submit", async () => {
    expect(KIND_BY_NAME.get("day_manifest")!.scope).toBe("read");
    await expect(jtool("scribe_job_submit").handler(
      { kind: "day_manifest", args: { room: "r1", ist_date: "2026-09-12" } }, ctxOf("invoke") as never,
    )).rejects.toBeInstanceOf(ToolScopeError);
    expect(TABLE).toHaveLength(0);
  });

  it("the handler renders that refusal as 403 / -32001, not a 200 degraded body", async () => {
    const { status, body } = await rpc("scribe_job_submit", { kind: "day_manifest", args: { room: "r1", ist_date: "2026-09-12" } }, ["invoke"]);
    expect(status).toBe(403);
    expect((body.error as Record<string, unknown>).code).toBe(-32001);
    expect(JSON.stringify(body)).toContain("scope_or_tool_unavailable");
    expect(JSON.stringify(body)).not.toContain("degraded");
    expect(TABLE).toHaveLength(0);
  });

  it("a read-only token cannot reach scribe_job_submit at all", async () => {
    const { status, body } = await rpc("scribe_job_submit", { kind: "transcribe_range", args: {} }, ["read"]);
    expect(status).toBe(403);
    expect((body.error as Record<string, unknown>).code).toBe(-32001);
  });

  it("with the right scope the same submit succeeds", async () => {
    const out = await jtool("scribe_job_submit").handler(
      { kind: "day_manifest", args: { room: "r1", ist_date: "2026-09-12" } }, ctxOf("read", "invoke") as never,
    );
    expect(out).toMatchObject({ ok: true, kind: "day_manifest" });
  });

  // ADOPTED AND KEPT. The original expected `{ok:false}` because the shim silently queued. The fix
  // moved the check inside submitJob, which every path goes through, so the shim now REFUSES —
  // a throw rather than a falsy body, which is the stronger of the two. The substantive assertion
  // is unchanged and is the one that mattered: no row from a token with no scopes.
  it("the async:true shims consult the kind's declared scope: no scopes, no job", async () => {
    await expect(
      btool("scribe_transcribe_range").handler(
        { async: true, session_id: "s1", start: 1_757_000_000_000, end: 1_757_000_060_000 },
        ctxOf() as never,            // NO scopes at all
      ),
    ).rejects.toBeInstanceOf(ToolScopeError);
    expect(TABLE).toHaveLength(0);
  });

  it("the other shim fails closed too", async () => {
    await expect(
      btool("scribe_extract_audio").handler(
        { async: true, session_id: "s1", start: 1_757_000_000_000, end: 1_757_000_060_000 },
        ctxOf() as never,
      ),
    ).rejects.toBeInstanceOf(ToolScopeError);
    expect(TABLE).toHaveLength(0);
  });

  it("and with invoke, the shim queues exactly one row", async () => {
    const out = await btool("scribe_transcribe_range").handler(
      { async: true, session_id: "s1", start: 1_757_000_000_000, end: 1_757_000_060_000 },
      ctxOf("invoke") as never,
    );
    expect(out).toMatchObject({ ok: true });
    expect(TABLE).toHaveLength(1);
  });
});

describe("(g) scribe_transcribe_range's description vs its actual async return", () => {
  const t = btool("scribe_transcribe_range");

  it("the description promises job_id + status_pointer and no text", () => {
    expect(t.description).toMatch(/async:true returns \{job_id, status_pointer\}/);
    expect(t.description).toMatch(/NEVER text/);
    expect(t.description).toMatch(/transcription_run_id is NULL/);
    expect(t.description.split(/\s+/).length).toBeLessThanOrEqual(150);
  });

  it("and the handler returns exactly that", async () => {
    const out = await t.handler(
      { async: true, session_id: "s1", start: 1_757_000_000_000, end: 1_757_000_060_000 },
      ctxOf("invoke") as never,
    ) as Record<string, unknown>;
    expect(out.ok).toBe(true);
    expect(typeof out.job_id).toBe("string");
    expect(out.status_pointer).toEqual({ tool: "scribe_job_status", job_id: out.job_id });
    for (const k of ["turns", "transcript", "text", "segments", "stt_silence"]) expect(out[k]).toBeUndefined();
    expect(TABLE).toHaveLength(1);
    expect(TABLE[0]!.kind).toBe("transcribe_range");
  });

  it("async:true is in the schema and defaults false, so the sync path is unchanged", async () => {
    const props = t.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.async).toMatchObject({ type: "boolean", default: false });
  });

  it("a bad range is refused at submit rather than queued", async () => {
    const out = await t.handler({ async: true, session_id: "s1", start: 5, end: 4 }, ctxOf("invoke") as never);
    expect(out).toMatchObject({ ok: false, error: "bad_args" });
    expect(TABLE).toHaveLength(0);
  });
});
