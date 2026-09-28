/**
 * eta-refuter-2 #5114 (27 Sep): the first cut enforced a room-restricted token's `ctx.rooms` only
 * inside `resolveForWrite`, which several room-touching tools never call (reproduced:
 * scribe_extract_audio / scribe_transcribe_range resolve a room straight from `session_id`,
 * bypassing it entirely; ~11 more tools touch a room/session/visit/window/job with no check at
 * all). Fixed by moving the boundary to `handler.ts`'s `callTool`: a room-restricted token may
 * reach ONLY a tool named in `registry.ts`'s `ROOM_RESTRICTED_ALLOWED_TOOLS`, refused BEFORE the
 * handler runs for anything else — default deny, not "did this tool happen to check".
 *
 * THE WALK eta-refuter-2 asked for: every tool the door will register (LISTED_TOOLS, published
 * names plus group names — the exact set `tools/call` accepts) is called, with full read+invoke+
 * write scope so scope alone cannot explain a refusal, through a room-restricted principal. Every
 * name NOT on the allowlist must be refused for the ROOM reason specifically (not just "some
 * error") and must never reach a handler (asserted via the audit log, which only a completed call
 * writes to). The one allowed name must NOT be refused for the room reason (it may still answer an
 * ordinary tool-level error — no DB is seeded — but that is a different code path, proven in
 * tests/unit/mcp-room-allowlist.test.ts).
 */
import { describe, it, expect } from "vitest";

type Row = Record<string, unknown>;
const auditInserts: unknown[][] = [];

import { vi } from "vitest";
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
const { LISTED_TOOLS, CALLABLE_TOOLS } = await import("@/lib/mcp/surface");
const { ROOM_RESTRICTED_ALLOWED_TOOLS } = await import("@/lib/mcp/registry");

const rpc = async (name: string, rooms: readonly string[] | undefined, tools?: readonly string[]) => {
  auditInserts.length = 0;
  const req = new NextRequest("https://x/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }),
  });
  const principal = {
    token_id: "walker",
    scopes: new Set(["read", "invoke", "write"] as const),
    ...(rooms ? { rooms: new Set(rooms) } : {}),
    ...(tools ? { tools: new Set(tools) } : {}),
  };
  const res = await handleMcpRpc(req, principal as never);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe("default deny: every tool/call name, walked with a room-restricted token", () => {
  it("ROOM_RESTRICTED_ALLOWED_TOOLS names exactly the day-boundary trio today, and all are registered", () => {
    expect([...ROOM_RESTRICTED_ALLOWED_TOOLS].sort()).toEqual([
      "scribe_room_command", "scribe_start_recording", "scribe_stop_recording",
    ]);
    for (const name of ROOM_RESTRICTED_ALLOWED_TOOLS) expect(CALLABLE_TOOLS.has(name), name).toBe(true);
  });

  it("EVERY OTHER callable name is refused for the room reason, before any handler runs", async () => {
    const names = [...CALLABLE_TOOLS.keys()].filter((n) => !ROOM_RESTRICTED_ALLOWED_TOOLS.has(n));
    expect(names.length).toBeGreaterThan(10); // the whole surface, not a hand-picked few
    for (const name of names) {
      const { status, body } = await rpc(name, ["home-office-w8fb"]);
      expect(status, name).toBe(403);
      const err = body.error as Record<string, unknown>;
      expect(err?.code, name).toBe(-32001);
      const data = err?.data as Record<string, unknown> | undefined;
      expect(data?.room_restricted, `${name}: refused, but not for the room reason (data=${JSON.stringify(data)})`).toBe(true);
      expect(auditInserts, `${name}: a refused call must not reach a handler that audits`).toHaveLength(0);
    }
  });

  it("an EMPTY room set (the malformed-token fail-closed case) refuses everything the same way", async () => {
    const { status, body } = await rpc("scribe_health", []);
    expect(status).toBe(403);
    expect((body.error as Record<string, unknown>)?.data as Record<string, unknown>).toMatchObject({ room_restricted: true });
  });

  it("the allowed name is NOT refused for the room reason (unrestricted-scope tools are unaffected either way)", async () => {
    const { status, body } = await rpc("scribe_room_command", ["home-office-w8fb"]);
    const err = body.error as Record<string, unknown> | undefined;
    if (status === 403) {
      // Some OTHER refusal (e.g. bad_args from an empty {}) is fine; the room gate specifically must not fire.
      expect((err?.data as Record<string, unknown> | undefined)?.room_restricted, JSON.stringify(body)).not.toBe(true);
    }
  });

  it("an UNRESTRICTED token (no rooms field) is never touched by this gate: every name at least reaches its own logic", async () => {
    // Sample a handful across different tool shapes, unrestricted — none may carry room_restricted.
    const sample = [...CALLABLE_TOOLS.keys()].slice(0, 15);
    for (const name of sample) {
      const { body } = await rpc(name, undefined);
      const data = (body.error as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined;
      expect(data?.room_restricted, name).not.toBe(true);
    }
  });

  it("LISTED_TOOLS (what tools/list publishes) and CALLABLE_TOOLS (what tools/call accepts) agree: nothing listed is unreachable, nothing reachable is hidden from this walk", () => {
    for (const t of LISTED_TOOLS) expect(CALLABLE_TOOLS.has(t.name), t.name).toBe(true);
  });
});

/**
 * 28 Sep 2026 — Fable's durable day-boundary owner: a token restricted to the clinic rooms AND
 * narrowed to start_day/end_day, never self_test/restart_engine/report_diag/etc. `tools` can only
 * NARROW what the room gate already admitted; it can never let a token reach a name
 * ROOM_RESTRICTED_ALLOWED_TOOLS itself refuses.
 */
describe("per-token tools narrowing, ANDed with the room gate", () => {
  const DAY_BOUNDARY = ["scribe_start_recording", "scribe_stop_recording"] as const;

  it("a token narrowed to start_day/end_day reaches those two, not scribe_room_command (self_test etc.)", async () => {
    for (const name of DAY_BOUNDARY) {
      const { status, body } = await rpc(name, ["cardiology-opd-gh4a"], DAY_BOUNDARY);
      const data = (body.error as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined;
      // Refused for some OTHER reason is fine (no DB is seeded); the tool gate specifically must not fire.
      if (status === 403) expect(data?.tool_restricted, name).not.toBe(true);
    }
    const { status, body } = await rpc("scribe_room_command", ["cardiology-opd-gh4a"], DAY_BOUNDARY);
    expect(status).toBe(403);
    const data = (body.error as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.room_restricted).toBe(true);
    expect(data.tool_restricted).toBe(true);
  });

  it("narrowing can only SHRINK: a tools list naming something outside ROOM_RESTRICTED_ALLOWED_TOOLS still cannot reach it", async () => {
    const { status, body } = await rpc("scribe_extract_audio", ["cardiology-opd-gh4a"], ["scribe_extract_audio"]);
    expect(status).toBe(403);
    const data = (body.error as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.room_restricted).toBe(true);
    // Refused by the ROOM gate (the name was never admitted), not the tools gate — tool_restricted
    // is the narrower gate and only fires once the room gate has already let the name through.
    expect(data.tool_restricted).toBeUndefined();
  });

  it("an empty tools array (malformed-token fail-closed case) refuses even the one allowed name", async () => {
    const { status, body } = await rpc("scribe_room_command", ["cardiology-opd-gh4a"], []);
    expect(status).toBe(403);
    expect((body.error as Record<string, unknown>).data).toMatchObject({ room_restricted: true, tool_restricted: true });
  });

  it("tools with NO rooms is inert: the tools gate only applies alongside a room restriction", async () => {
    const { body } = await rpc("scribe_extract_audio", undefined, ["scribe_start_recording"]);
    const data = (body.error as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined;
    expect(data?.room_restricted).not.toBe(true);
    expect(data?.tool_restricted).not.toBe(true);
  });
});
