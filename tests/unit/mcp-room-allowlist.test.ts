/**
 * Per-token room allowlist (27 Sep 2026, W40 follow-up: a token restricted to ONE room, e.g. an
 * install pane's Home Office canary). lib/mcp/auth.ts's `rooms` field on a token entry, threaded
 * through ToolContext.rooms, enforced once in `resolveForWrite` (lib/mcp/tools/bench.ts) — the
 * single room-resolution path every room-write (and room-scoped invoke) tool already calls.
 *
 * Two layers: the pure parsing in auth.ts (no DB, no MCP door), and the enforcement through the
 * real `scribe_room_command` tool (mocked `sql`, same fixture as mcp-room-command.test.ts).
 */
import { createHash } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Layer 1 — auth.ts parsing, pure
// ---------------------------------------------------------------------------

const { checkMcpBearer, MCP_TOKENS_ENV } = await import("@/lib/mcp/auth");

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const req = (token: string) => new Request("https://x/api/mcp", { headers: { authorization: `Bearer ${token}` } });
const map = (o: Record<string, unknown>) => JSON.stringify(o);
const principalFor = (token: string) => {
  const r = checkMcpBearer(req(token));
  return r.ok ? r.principal : null;
};

const ENV = { ...process.env };
beforeEach(() => {
  delete process.env.SCRIBE_MCP_TOKEN;
  delete process.env[MCP_TOKENS_ENV];
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ENV };
  vi.restoreAllMocks();
});

describe("auth.ts — the per-token rooms field", () => {
  it("ABSENT rooms key = unrestricted: principal.rooms is undefined", () => {
    process.env[MCP_TOKENS_ENV] = map({ [sha("v")]: { actor: "operator-v", scopes: ["write"] } });
    expect(principalFor("v")?.rooms).toBeUndefined();
  });

  it("a rooms array restricts to exactly those slugs, lower-cased and trimmed", () => {
    process.env[MCP_TOKENS_ENV] = map({
      [sha("m")]: { actor: "minibot", scopes: ["write"], rooms: ["Home-Office-W8FB", "  opd-1-xqj7  "] },
    });
    const p = principalFor("m");
    expect([...(p?.rooms ?? [])].sort()).toEqual(["home-office-w8fb", "opd-1-xqj7"]);
  });

  it("a PRESENT-but-malformed rooms value fails CLOSED to an empty set, never to unrestricted", () => {
    for (const bad of ["home-office-w8fb", null, 5, {}]) {
      process.env[MCP_TOKENS_ENV] = map({ [sha("m")]: { actor: "minibot", scopes: ["write"], rooms: bad } });
      const p = principalFor("m");
      expect(p?.rooms, JSON.stringify(bad)).toBeDefined();
      expect(p?.rooms?.size, JSON.stringify(bad)).toBe(0);
    }
  });

  it("a rooms array with some bad entries keeps only the valid strings — never widens on a partial read", () => {
    process.env[MCP_TOKENS_ENV] = map({
      [sha("m")]: { actor: "minibot", scopes: ["write"], rooms: ["home-office-w8fb", 5, "", "  ", null, "opd-1-xqj7"] },
    });
    expect([...(principalFor("m")?.rooms ?? [])].sort()).toEqual(["home-office-w8fb", "opd-1-xqj7"]);
  });

  it("the single-token fallback is ALWAYS unrestricted, matching its all-scopes behaviour", () => {
    process.env.SCRIBE_MCP_TOKEN = "legacy";
    expect(principalFor("legacy")?.rooms).toBeUndefined();
  });

  it("an empty rooms array restricts to nothing (every room refused) — distinct from key-absent", () => {
    process.env[MCP_TOKENS_ENV] = map({ [sha("m")]: { actor: "minibot", scopes: ["write"], rooms: [] } });
    const p = principalFor("m");
    expect(p?.rooms).toBeDefined();
    expect(p?.rooms?.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — enforcement through the real scribe_room_command tool
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
const calls: Array<{ text: string; values: unknown[] }> = [];
let responder: (text: string, values: unknown[]) => Row[] = () => [];

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.raw.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    return Promise.resolve(responder(text, values));
  };
  return { sql };
});
vi.mock("@/lib/r2", () => ({ signGetUrl: async () => "https://r2.example/x", getObjectBytes: async () => new Uint8Array() }));
vi.mock("@/lib/whisper", () => ({ transcribeWithWhisper: async () => ({ ok: false }) }));
vi.mock("@/lib/bench-timeline", () => ({ renderBenchTimeline: async () => ({ markdown: "" }) }));
vi.mock("@/lib/brain/db", () => ({ TOKEN_ENV: "BRAIN_SERVICE_TOKEN", getPool: () => ({}), query: async () => ({ rows: [] }) }));
vi.mock("@/lib/brain/state", () => ({
  CUES_DEFAULT_LIMIT: 50, CUES_MAX_LIMIT: 200, findRoomDay: async () => null, isIstDateString: (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s),
  istDate: () => "2026-09-11", listCuesForDay: async () => ({ cues: [] }), readGraph: async () => ({}), roomExists: async () => true,
  WINDOW_CUE_TYPE: "stt_window",
}));

const { BENCH_TOOLS } = await import("@/lib/mcp/tools/bench");
const { ToolRoomError } = await import("@/lib/mcp/registry");
const tool = BENCH_TOOLS.find((t) => t.name === "scribe_room_command")!;

const HOME_OFFICE = { id: "room_home", slug: "home-office-w8fb", name: "Home Office", disabled_at: null };
const inserts = () => calls.filter((c) => /INSERT INTO bench_command/.test(c.text));

function homeOfficeListening() {
  responder = (text, values) => {
    if (/FROM room WHERE/.test(text)) return [HOME_OFFICE];
    if (/FROM room_install WHERE room_id = \?/.test(text)) return [{ install_id: "install_home", app_version: "0.1.25" }];
    if (/FROM bench_listener WHERE room_id/.test(text)) {
      return [{ room_id: HOME_OFFICE.id, tab_id: "app_install_home", last_poll_at: new Date().toISOString(), recording_session_id: null, paused: false }];
    }
    if (/FROM bench_command WHERE id = \?/.test(text)) {
      const ins = inserts()[0];
      return ins ? [{ id: values[0], room_id: HOME_OFFICE.id, kind: ins.values[2], args: null, source: "mcp", created_at: new Date().toISOString(), acked_at: new Date().toISOString(), status: "acked", result: { ok: true }, error: null }] : [];
    }
    return [];
  };
}

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { room?: { slug?: string } };
  }
  return null;
};

beforeEach(() => {
  calls.length = 0;
  responder = () => [];
});

describe("scribe_room_command — the room allowlist, enforced once for every kind", () => {
  it("a token allowlisted for home-office-w8fb may act on it: report_diag succeeds, one command inserted", async () => {
    homeOfficeListening();
    const ctx = { origin: "https://x", actor: "mcp:minibot", scopes: new Set(["write"]), rooms: new Set(["home-office-w8fb"]) };
    const out = (await tool.handler({ room: "home-office-w8fb", kind: "report_diag" } as never, ctx as never)) as Row;
    expect(out.ok).toBe(true);
    expect(inserts()).toHaveLength(1);
  });

  it("a token allowlisted for a DIFFERENT room is refused ToolRoomError, and NOTHING is inserted — for every kind, not just self_test", async () => {
    for (const kind of ["report_diag", "restart_engine", "check_update_now", "self_test"]) {
      calls.length = 0;
      homeOfficeListening();
      const ctx = { origin: "https://x", actor: "mcp:minibot", scopes: new Set(["write"]), rooms: new Set(["opd-1-xqj7"]) };
      const e = await refusal(tool.handler({ room: "home-office-w8fb", kind } as never, ctx as never));
      expect(e, kind).toBeInstanceOf(ToolRoomError);
      expect(e?.room?.slug, kind).toBe("home-office-w8fb");
      expect(inserts(), kind).toHaveLength(0);
    }
  });

  it("an UNRESTRICTED token (no rooms field) acts on any room, exactly as before this change", async () => {
    homeOfficeListening();
    const ctx = { origin: "https://x", actor: "mcp:operator-v1", scopes: new Set(["write"]) };
    const out = (await tool.handler({ room: "home-office-w8fb", kind: "report_diag" } as never, ctx as never)) as Row;
    expect(out.ok).toBe(true);
    expect(inserts()).toHaveLength(1);
  });

  it("an EMPTY rooms set (malformed-token fail-closed case) refuses every room, including the one it might have meant", async () => {
    homeOfficeListening();
    const ctx = { origin: "https://x", actor: "mcp:minibot", scopes: new Set(["write"]), rooms: new Set<string>() };
    const e = await refusal(tool.handler({ room: "home-office-w8fb", kind: "report_diag" } as never, ctx as never));
    expect(e).toBeInstanceOf(ToolRoomError);
    expect(inserts()).toHaveLength(0);
  });

  it("room-allowlist matching is case-insensitive, matching the room's slug as stored", async () => {
    homeOfficeListening();
    const ctx = { origin: "https://x", actor: "mcp:minibot", scopes: new Set(["write"]), rooms: new Set(["HOME-OFFICE-W8FB"]) };
    // The token's own rooms were already lower-cased by auth.ts's parseEntry; a test that builds
    // ctx directly (bypassing auth.ts) must lower-case itself, so this proves resolveForWrite's
    // OWN comparison also lower-cases the resolved room's slug rather than relying on the caller.
    const out = (await tool.handler({ room: "home-office-w8fb", kind: "report_diag" } as never, ctx as never)) as Row;
    expect(out.error, "resolveForWrite must lower-case the resolved room, not assume ctx.rooms already matches").toBeUndefined();
  });
});
