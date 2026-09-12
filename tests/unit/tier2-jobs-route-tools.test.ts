/**
 * Tier 2 §3 — the runner route's auth, the four job tools, and the audit reader added after
 * Slice A's rollout found that nothing could read the rows §2.2/§2.3 write.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const calls: Array<{ text: string; values: unknown[] }> = [];
let auditRows: Row[] = [];
let jobRow: Row | null = null;

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    if (/FROM audit_log/.test(text)) return Promise.resolve(auditRows);
    if (/FROM scribe_job WHERE id = \?/.test(text)) return Promise.resolve(jobRow ? [jobRow] : []);
    if (/WITH claimable AS/.test(text)) return Promise.resolve([]);
    return Promise.resolve([]);
  };
  sql.transaction = async () => [];
  return { sql, db: {} };
});

const route = await import("@/app/api/jobs/run/route");
const { JOB_TOOLS } = await import("@/lib/mcp/tools/jobs");
const { READABLE_ACTIONS } = await import("@/lib/jobs/audit-read");
const tool = (n: string) => JOB_TOOLS.find((t) => t.name === n)!;
const ctx = { origin: "https://x" };

const ENV = { ...process.env };
beforeEach(() => {
  calls.length = 0; auditRows = []; jobRow = null;
  process.env = { ...ENV };
});

const call = (method: "GET" | "POST", auth?: string) => {
  const req = new Request("https://x/api/jobs/run", { method, ...(auth ? { headers: { authorization: auth } } : {}) });
  return method === "GET" ? route.GET(req) : route.POST(req);
};

describe("POST/GET /api/jobs/run — the runner door", () => {
  it("503 and NOTHING runs when JOBS_RUNNER_SECRET is unset — a runner that authorised everyone is worse than none", async () => {
    delete process.env.JOBS_RUNNER_SECRET;
    const res = await call("POST", "Bearer anything");
    expect(res.status).toBe(503);
    expect(calls.filter((c) => /WITH claimable AS/.test(c.text))).toHaveLength(0);
  });

  it("401 without the bearer, and the queue is never touched", async () => {
    process.env.JOBS_RUNNER_SECRET = "s3cret";
    for (const auth of [undefined, "Bearer wrong", "Basic s3cret", "s3cret"]) {
      expect((await call("POST", auth)).status, String(auth)).toBe(401);
    }
    expect(calls.filter((c) => /WITH claimable AS/.test(c.text))).toHaveLength(0);
  });

  it("200 with the runner bearer, on BOTH verbs — Vercel Cron issues GET", async () => {
    process.env.JOBS_RUNNER_SECRET = "s3cret";
    for (const m of ["GET", "POST"] as const) {
      const res = await call(m, "Bearer s3cret");
      expect(res.status, m).toBe(200);
      expect((await res.json()).ok, m).toBe(true);
    }
  });

  it("CRON_SECRET is also accepted, because that is what the scheduler actually sends", async () => {
    process.env.JOBS_RUNNER_SECRET = "s3cret";
    process.env.CRON_SECRET = "cron-tok";
    expect((await call("GET", "Bearer cron-tok")).status).toBe(200);
    expect((await call("GET", "Bearer neither")).status).toBe(401);
  });

  it("the every-minute cron is registered in vercel.json", async () => {
    const { readFileSync } = await import("node:fs");
    const v = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: Array<{ path: string; schedule: string }> };
    const c = v.crons.find((x) => x.path === "/api/jobs/run");
    expect(c, "no cron entry for the runner").toBeTruthy();
    expect(c!.schedule).toBe("* * * * *");
  });
});

describe("the four job tools", () => {
  it("are registered with the scopes §3 gives them", () => {
    expect(tool("scribe_job_submit").scope).toBe("invoke");
    expect(tool("scribe_job_status").scope).toBe("read");
    expect(tool("scribe_job_list").scope).toBe("read");
    expect(tool("scribe_job_cancel").scope).toBe("write");
  });

  it("submit refuses an unknown kind by name, with the allowed list", async () => {
    const out = (await tool("scribe_job_submit").handler({ kind: "nope" }, ctx)) as Row;
    expect(out.error).toBe("unknown_kind");
    expect(Array.isArray(out.allowed)).toBe(true);
  });

  it("submit refuses bad args before queuing — nothing is inserted", async () => {
    const out = (await tool("scribe_job_submit").handler({ kind: "stitch", args: {} }, ctx)) as Row;
    expect(out.error).toBe("bad_args");
    expect(String(out.detail)).toMatch(/session_id/);
    expect(calls.filter((c) => /^INSERT INTO scribe_job/.test(c.text))).toHaveLength(0);
  });

  it("status withholds the result unless asked — a transcript result carries text", async () => {
    jobRow = { id: "job_1", kind: "transcribe_range", args: "{}", status: "done", step: null, progress: "{}", result: '{"transcript":"…"}', error: null, actor: "a", created_at: "t", started_at: "t", updated_at: "t", finished_at: "t", lease_until: null, attempts: 1 };
    const withheld = (await tool("scribe_job_status").handler({ job_id: "job_1" }, ctx)) as Row;
    expect(withheld.result).toBeUndefined();
    expect(withheld.has_result).toBe(true);
    const asked = (await tool("scribe_job_status").handler({ job_id: "job_1", include_result: true }, ctx)) as Row;
    expect(asked.result).toEqual({ transcript: "…" });
  });

  it("status on an unknown id says so rather than inventing a job", async () => {
    const out = (await tool("scribe_job_status").handler({ job_id: "job_missing" }, ctx)) as Row;
    expect(out).toMatchObject({ ok: false, error: "unknown_job" });
  });

  it("cancel distinguishes not_cancellable from unknown_job", async () => {
    jobRow = { id: "job_9", kind: "stitch", args: "{}", status: "done", step: null, progress: "{}", result: null, error: null, actor: null, created_at: "t", started_at: null, updated_at: "t", finished_at: "t", lease_until: null, attempts: 1 };
    const done = (await tool("scribe_job_cancel").handler({ job_id: "job_9" }, ctx)) as Row;
    expect(done).toMatchObject({ ok: false, error: "not_cancellable", status: "done" });
    jobRow = null;
    const gone = (await tool("scribe_job_cancel").handler({ job_id: "job_x" }, ctx)) as Row;
    expect(gone).toMatchObject({ ok: false, error: "unknown_job" });
  });
});

describe("scribe_audit_recent — the Slice A gap", () => {
  it("is a READ tool with no free-text argument at all", () => {
    const t = tool("scribe_audit_recent");
    expect(t.scope).toBe("read");
    expect(Object.keys(t.inputSchema.properties as Row).sort()).toEqual(["action", "limit", "since"]);
  });

  it("returns the stored rows, renamed but not reshaped", async () => {
    auditRows = [{ action: "install.poll_write_failed", actor_type: "system", actor_id: "install", target_type: "room_install", target_id: "install_a", metadata_json: { install_id: "install_a", error: "boom" }, created_at: "2026-09-12T06:00:00Z" }];
    const out = (await tool("scribe_audit_recent").handler({ action: "install.poll_write_failed" }, ctx)) as Row;
    expect(out.count).toBe(1);
    expect((out.rows as Row[])[0]).toMatchObject({ action: "install.poll_write_failed", actor: "install", target_id: "install_a" });
    expect(((out.rows as Row[])[0]!.metadata as Row).error).toBe("boom");
  });

  it("refuses an action outside the allow-list by NAME, not with an empty list", async () => {
    const out = (await tool("scribe_audit_recent").handler({ action: "admin.password_change" }, ctx)) as Row;
    expect(out).toMatchObject({ error: "action_not_readable" });
    expect(calls.filter((c) => /FROM audit_log/.test(c.text))).toHaveLength(0);
  });

  it("the allow-list covers the rows Slice A writes and nothing sensitive", () => {
    expect(READABLE_ACTIONS).toContain("install.poll_write_failed");
    expect(READABLE_ACTIONS).toContain("install.assign_channel");
    expect(READABLE_ACTIONS).toContain("install.channel_reported");
    expect(READABLE_ACTIONS).not.toContain("admin.password_change");
  });

  it("the statement is bounded by the allow-list, a window and a limit", async () => {
    await tool("scribe_audit_recent").handler({ limit: 200 }, ctx);
    const q = calls.find((c) => /FROM audit_log/.test(c.text))!;
    expect(q.text).toMatch(/action = ANY\(\?\)/);
    expect(q.text).toMatch(/created_at >= \?::timestamptz/);
    expect(q.text).toMatch(/LIMIT \?/);
    expect(q.values).toContain(200);
  });
});

// ---------------------------------------------------------------------------
// Slice B fix-up (3) — the resolved principal reaches the job row
// ---------------------------------------------------------------------------

/** handleMcpRpc reads NextRequest.nextUrl; a plain Request has none. */
const withNextUrl = (req: Request) =>
  Object.assign(req, { nextUrl: new URL(req.url) }) as never;

describe("ctx.actor — who asked for this job", () => {
  it("a SCRIBE_MCP_TOKENS actor lands on scribe_job.actor, end to end", async () => {
    const { createHash } = await import("node:crypto");
    const sha = (v: string) => createHash("sha256").update(v).digest("hex");
    process.env.SCRIBE_MCP_TOKENS = JSON.stringify({
      [sha("watcher-tok")]: { actor: "operator-v", scopes: ["read", "invoke", "write"] },
    });
    process.env.SCRIBE_MCP_TOKEN = "legacy";

    const { checkMcpBearer } = await import("@/lib/mcp/auth");
    const { handleMcpRpc } = await import("@/lib/mcp/handler");
    const req = new Request("https://x/api/mcp", {
      method: "POST",
      headers: { authorization: "Bearer watcher-tok", "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "scribe_job_submit", arguments: { kind: "stitch", args: { session_id: "bs_1", start: 1000, end: 2000 } } },
      }),
    });
    const auth = checkMcpBearer(req);
    expect(auth.ok).toBe(true);
    if (!auth.ok) return;
    expect(auth.principal.token_id).toBe("operator-v");

    await handleMcpRpc(withNextUrl(req), auth.principal);

    // The INSERT's fourth parameter is `actor` — prefixed once, from the token map, not null.
    const ins = calls.find((c) => /^INSERT INTO scribe_job/.test(c.text));
    expect(ins, "no job was inserted").toBeTruthy();
    expect(ins!.values[3]).toBe("mcp:operator-v");
  });

  it("the single-token fallback records mcp:operator-v1, never null", async () => {
    delete process.env.SCRIBE_MCP_TOKENS;
    process.env.SCRIBE_MCP_TOKEN = "legacy";
    const { checkMcpBearer } = await import("@/lib/mcp/auth");
    const { handleMcpRpc } = await import("@/lib/mcp/handler");
    const req = new Request("https://x/api/mcp", {
      method: "POST",
      headers: { authorization: "Bearer legacy", "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "scribe_job_submit", arguments: { kind: "stitch", args: { session_id: "bs_1", start: 1000, end: 2000 } } },
      }),
    });
    const auth = checkMcpBearer(req);
    if (!auth.ok) throw new Error("fallback token did not authorise");
    await handleMcpRpc(withNextUrl(req), auth.principal);
    const ins = calls.find((c) => /^INSERT INTO scribe_job/.test(c.text));
    expect(ins!.values[3]).toBe("mcp:operator-v1");
  });

  it("ToolContext carries actor as a required string, so no tool can forget it", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/mcp/registry.ts", "utf8");
    expect(src).toMatch(/export type ToolContext = \{ origin: string; actor: string \}/);
    const handler = readFileSync("lib/mcp/handler.ts", "utf8");
    expect(handler).toMatch(/actor: mcpActorId\(principal\.token_id\)/);
  });
});
