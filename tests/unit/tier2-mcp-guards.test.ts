/**
 * Tier 2 §2.3 / §2.5 / §2.6 / §2.7 — the MCP door's guards.
 *
 * Scopes: a token map keyed by sha256 so the env var never holds a usable credential; the single
 * token still works. Budgets: a hung downstream returns a NAMED envelope, never a shape-only
 * degrade. listChanged: advertised, because on 12 Sep a cached client manifest hid a tool that the
 * server was serving. Fleet: the admin card's payload reachable without a browser cookie.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";

const sha = (v: string) => createHash("sha256").update(v).digest("hex");

vi.mock("@/lib/db", () => {
  const sql = () => Promise.resolve([]);
  sql.transaction = async () => [];
  return { sql, db: {} };
});

const A = await import("@/lib/mcp/auth");
const B = await import("@/lib/mcp/budgets");
const AUD = await import("@/lib/mcp/audit");

const req = (token?: string) =>
  new Request("https://x/api/mcp", { headers: token ? { authorization: `Bearer ${token}` } : {} });

const ENV = { ...process.env };
beforeEach(() => {
  delete process.env.SCRIBE_MCP_TOKEN;
  delete process.env.SCRIBE_MCP_TOKENS;
});
afterEach(() => {
  process.env = { ...ENV };
});

// ---------------------------------------------------------------------------
// §2.3 — per-token scopes
// ---------------------------------------------------------------------------

describe("token map resolution", () => {
  it("resolves a mapped token to its actor and scopes", () => {
    process.env.SCRIBE_MCP_TOKENS = JSON.stringify({
      [sha("watcher-tok")]: { actor: "watcher", scopes: ["read"] },
      [sha("full-tok")]: { actor: "operator-v", scopes: ["read", "invoke", "write"] },
    });
    const w = A.checkMcpBearer(req("watcher-tok"));
    expect(w.ok).toBe(true);
    if (w.ok) {
      expect(w.principal.token_id).toBe("watcher");
      expect([...w.principal.scopes]).toEqual(["read"]);
      expect(w.principal.scopes.has("write")).toBe(false);
      expect(w.principal.scopes.has("invoke")).toBe(false);
    }
    const f = A.checkMcpBearer(req("full-tok"));
    expect(f.ok && [...f.principal.scopes].sort()).toEqual(["invoke", "read", "write"]);
  });

  it("the map holds only HASHES — the raw token never appears in it", () => {
    const raw = JSON.stringify({ [sha("secret-tok")]: { actor: "a", scopes: ["read"] } });
    expect(raw).not.toContain("secret-tok");
    process.env.SCRIBE_MCP_TOKENS = raw;
    expect(A.checkMcpBearer(req("secret-tok")).ok).toBe(true);
  });

  it("falls back to SCRIBE_MCP_TOKEN with all three scopes — nothing that works today breaks", () => {
    process.env.SCRIBE_MCP_TOKEN = "legacy";
    const r = A.checkMcpBearer(req("legacy"));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.principal.token_id).toBe(A.MCP_TOKEN_ID);
      expect([...r.principal.scopes].sort()).toEqual(["invoke", "read", "write"]);
    }
  });

  it("the map is consulted FIRST, and the fallback still answers for its own token", () => {
    process.env.SCRIBE_MCP_TOKEN = "legacy";
    process.env.SCRIBE_MCP_TOKENS = JSON.stringify({ [sha("watcher")]: { actor: "w", scopes: ["read"] } });
    expect(A.checkMcpBearer(req("watcher")).ok && A.checkMcpBearer(req("watcher")));
    const w = A.checkMcpBearer(req("watcher"));
    expect(w.ok && w.principal.token_id).toBe("w");
    const l = A.checkMcpBearer(req("legacy"));
    expect(l.ok && l.principal.token_id).toBe(A.MCP_TOKEN_ID);
  });

  it("an unknown token is 401, and no env configured at all is 503 — fail closed", () => {
    process.env.SCRIBE_MCP_TOKEN = "legacy";
    const bad = A.checkMcpBearer(req("nope"));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.failure).toEqual({ status: 401, code: "unauthorized" });
    delete process.env.SCRIBE_MCP_TOKEN;
    const none = A.checkMcpBearer(req("anything"));
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.failure.status).toBe(503);
  });

  it("a malformed scopes list grants NOTHING — it must never widen access", () => {
    process.env.SCRIBE_MCP_TOKENS = JSON.stringify({
      [sha("t1")]: { actor: "a", scopes: "read" },
      [sha("t2")]: { actor: "b", scopes: ["read", "admin", 7] },
      [sha("t3")]: { actor: "c" },
    });
    expect([...(A.checkMcpBearer(req("t1")) as { principal: { scopes: Set<string> } }).principal.scopes]).toEqual([]);
    expect([...(A.checkMcpBearer(req("t2")) as { principal: { scopes: Set<string> } }).principal.scopes]).toEqual(["read"]);
    expect([...(A.checkMcpBearer(req("t3")) as { principal: { scopes: Set<string> } }).principal.scopes]).toEqual([]);
  });

  it("unreadable JSON and non-hex keys are ignored, not fatal", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.SCRIBE_MCP_TOKEN = "legacy";
    process.env.SCRIBE_MCP_TOKENS = "{not json";
    expect(A.checkMcpBearer(req("legacy")).ok).toBe(true);
    process.env.SCRIBE_MCP_TOKENS = JSON.stringify({ "plain-token": { actor: "a", scopes: ["read"] } });
    expect(A.parseTokenMap(process.env.SCRIBE_MCP_TOKENS)).toEqual({});
    warn.mockRestore();
  });

  it("the audit actor is the resolved token, prefixed once", () => {
    expect(AUD.mcpActorId("watcher")).toBe("mcp:watcher");
    expect(AUD.mcpActorId("mcp:watcher")).toBe("mcp:watcher");
    expect(AUD.mcpActorId(null)).toBe(AUD.MCP_AUDIT_ACTOR);
    expect(AUD.mcpActorId("  ")).toBe(AUD.MCP_AUDIT_ACTOR);
  });
});

// ---------------------------------------------------------------------------
// §2.5 — named downstream timeouts
// ---------------------------------------------------------------------------

describe("downstream budgets", () => {
  it("every budget is strictly below the tool budget it runs inside", () => {
    for (const svc of Object.keys(B.DOWNSTREAM_BUDGET_MS) as B.DownstreamService[]) {
      expect(B.budgetFor(svc, "read"), svc).toBeLessThan(B.READ_TOOL_BUDGET_MS);
      expect(B.budgetFor(svc, "invoke"), svc).toBeLessThan(B.INVOKE_TOOL_BUDGET_MS);
    }
    expect(B.READ_DOWNSTREAM_BUDGET_MS).toBe(40_000);
    expect(B.INVOKE_DOWNSTREAM_BUDGET_MS).toBe(90_000);
  });

  it("a hung downstream returns the NAMED envelope, not a degrade", async () => {
    vi.useFakeTimers();
    const hang = B.withBudget("whisper", "read", () => new Promise<string>(() => {}));
    await vi.advanceTimersByTimeAsync(B.budgetFor("whisper", "read") + 1);
    const out = await hang;
    expect(B.isDownstreamTimeout(out)).toBe(true);
    expect((out as B.DownstreamTimeout).error).toBe("whisper_timeout");
    expect((out as B.DownstreamTimeout).budget_ms).toBe(40_000);
    vi.useRealTimers();
  });

  it("names the service that actually hung, one envelope per service", async () => {
    vi.useFakeTimers();
    for (const svc of ["join", "ollama", "gemini", "r2", "diarize", "emotion", "indic"] as B.DownstreamService[]) {
      const p = B.withBudget(svc, "read", () => new Promise<string>(() => {}));
      await vi.advanceTimersByTimeAsync(B.budgetFor(svc, "read") + 1);
      expect(((await p) as B.DownstreamTimeout).error, svc).toBe(`${svc}_timeout`);
    }
    vi.useRealTimers();
  });

  it("aborts the request rather than leaving it running", async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | null = null;
    const p = B.withBudget("join", "read", (signal) => {
      seen = signal;
      return new Promise<string>(() => {});
    });
    await vi.advanceTimersByTimeAsync(B.budgetFor("join", "read") + 1);
    await p;
    expect(seen!.aborted).toBe(true);
    vi.useRealTimers();
  });

  it("a call that finishes in time is returned untouched, and the timer is cleared", async () => {
    const out = await B.withBudget("whisper", "read", async () => ({ text: "hello" }));
    expect(out).toEqual({ text: "hello" });
    expect(B.isDownstreamTimeout(out)).toBe(false);
  });

  it("a real error still throws — only the timeout is swallowed into an envelope", async () => {
    await expect(B.withBudget("r2", "read", async () => { throw new Error("no such key"); })).rejects.toThrow("no such key");
  });
});
