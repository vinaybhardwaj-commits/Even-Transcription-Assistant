/**
 * Operator MCP S5A (8 Oct 2026) — scribe_reb_index over reb_track_index (migration 0135). `sql` is mocked; every statement is recorded.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
const statements: Array<{ text: string; values: unknown[] }> = [];
let answer: (text: string, values: unknown[]) => unknown = () => [];

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    statements.push({ text, values });
    const out = answer(text, values);
    return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
  };
  sql.transaction = async () => [];
  return { sql, db: {} };
});

const S = await import("@/lib/mcp/surface");
const { handleMcpRpc } = await import("@/lib/mcp/handler");
const ROOM = { id: "room_yh3etjpf", slug: "opd-1", name: "OPD 1", disabled_at: null };
const ctx = { origin: "x", actor: "a", scopes: new Set(["read"]) } as never;
const run = async (args: Row) => (await S.CALLABLE_TOOLS.get("scribe_reb_index")!.handler(args, ctx)) as Row;
const reb = (id: number, extra: Row = {}) => ({
  id: String(id), window_id: "bw_1", ist_date: "2026-10-08", room_id: ROOM.id, t0_ms: "1000", t1_ms: "2000", layer: "asr", engine: "whisper", model: null, version: "v1", config_hash: "c1",
  shadow: false, status: "ok", reason: null, machine: "m1", r2_key: "reb/bw_1/asr.whisper__v1__c1.json", sha256: "a".repeat(64), bytes: "10", started_at: "2026-10-08T06:00:00.000Z",
  finished_at: new Date("2026-10-08T06:01:00.000Z"), indexed_at: "2026-10-08T06:02:00.000Z", ...extra,
});
const roomTable = (text: string, values: unknown[]): Row[] | null => {
  if (!/FROM room\s/.test(text)) return null;
  const asked = values.filter((v) => typeof v === "string").map((v) => String(v).toLowerCase());
  return asked.some((v) => [ROOM.id, ROOM.slug, ROOM.name.toLowerCase()].includes(v)) ? [ROOM] : [];
};
const rebStmt = () => statements.find((s) => /FROM reb_track_index/.test(s.text))!;

beforeEach(() => {
  statements.length = 0;
  answer = (text, values) => roomTable(text, values) ?? [];
});

describe("scribe_reb_index", () => {
  it("is listed, read scope, and a room-restricted token is refused", async () => {
    const t = S.CALLABLE_TOOLS.get("scribe_reb_index")!;
    expect(t.scope).toBe("read");
    expect(S.LAB_TOOLS.includes(t)).toBe(true);
    const req = new NextRequest("https://x/api/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "scribe_reb_index", arguments: {} } }) });
    expect((await handleMcpRpc(req, { token_id: "t", scopes: new Set(["read"]), rooms: new Set([ROOM.id]) } as never)).status).toBe(403);
  });

  it("needs window_id or ist_date, a real date, a sane cursor — all before any SQL", async () => {
    expect(await run({})).toEqual({ ok: false, error: "window_id_or_ist_date_required" });
    for (const d of ["2026-02-30", "x", "2026-13-01"]) expect(await run({ ist_date: d })).toEqual({ ok: false, error: "invalid_ist_date" });
    for (const c of [-1, "abc", 1.5]) expect(await run({ window_id: "bw_1", cursor: c })).toEqual({ ok: false, error: "invalid_cursor" });
    expect(statements).toEqual([]);
  });

  it("reads rows as stored (ids numbers, times ISO) and binds every filter; shadow excluded by default", async () => {
    answer = (text, values) => roomTable(text, values) ?? (/FROM reb_track_index/.test(text) ? [reb(1), reb(2, { layer: "diarize" })] : []);
    const out = await run({ window_id: "bw_1", layer: "asr", engine: "whisper" });
    expect(out).toMatchObject({ ok: true, count: 2, next_cursor: null, include_shadow: false });
    expect((out.rows as Row[])[0]).toMatchObject({ id: 1, t0_ms: 1000, bytes: 10, r2_key: "reb/bw_1/asr.whisper__v1__c1.json", sha256: "a".repeat(64), finished_at: "2026-10-08T06:01:00.000Z" });
    // cursor, window, date, layer, engine, room, shadow, limit+1 — all bound
    expect(rebStmt().values).toEqual([0, "bw_1", "bw_1", null, null, "asr", "asr", "whisper", "whisper", null, null, false, 201]);
    expect(rebStmt().text).toMatch(/ORDER BY id/);
    expect(rebStmt().text).not.toMatch(/bw_1/);
  });

  it("include_shadow flips the shadow filter only", async () => {
    await run({ ist_date: "2026-10-08", include_shadow: true });
    expect(rebStmt().values).toContain(true);
    expect(rebStmt().values).toEqual([0, null, null, "2026-10-08", "2026-10-08", null, null, null, null, null, null, true, 201]);
  });

  it("keyset paging: limit+1 rows give next_cursor = the last returned id; limit clamps to 1000 and says so", async () => {
    answer = (text, values) => roomTable(text, values) ?? (/FROM reb_track_index/.test(text) ? [reb(5), reb(6), reb(7)] : []);
    const out = await run({ window_id: "bw_1", limit: 2, cursor: 4 });
    expect(out).toMatchObject({ count: 2, next_cursor: 6 });
    expect(rebStmt().values[0]).toBe(4);
    expect(rebStmt().values[rebStmt().values.length - 1]).toBe(3);
    statements.length = 0;
    const big = await run({ window_id: "bw_1", limit: 99999 });
    expect(big).toMatchObject({ clamped: true, limit_applied: 1000 });
    expect(rebStmt().values[rebStmt().values.length - 1]).toBe(1001);
    expect(await run({ window_id: "bw_1" })).not.toHaveProperty("clamped");
  });

  it("room resolves by id / slug / exact name to room_id; unknown room reads no index", async () => {
    for (const r of ["opd-1", "OPD 1", ROOM.id]) {
      statements.length = 0;
      expect(await run({ ist_date: "2026-10-08", room: r })).toMatchObject({ ok: true, room: { id: ROOM.id } });
      expect(rebStmt().values).toContain(ROOM.id);
    }
    statements.length = 0;
    expect(await run({ ist_date: "2026-10-08", room: "nope" })).toEqual({ ok: false, error: "unknown_room", room: "nope" });
    expect(statements.filter((s) => /reb_track_index/.test(s.text))).toEqual([]);
  });

  it("a missing table or column is not_collected; any other failure is ok:false", async () => {
    answer = (text) => (/FROM reb_track_index/.test(text) ? Object.assign(new Error('relation "reb_track_index" does not exist'), { code: "42P01" }) : []);
    expect(await run({ window_id: "bw_1" })).toMatchObject({ not_collected: true });
    answer = (text) => (/FROM reb_track_index/.test(text) ? new Error('relation "x" does not exist') : []);
    expect(await run({ window_id: "bw_1" })).toMatchObject({ ok: false });
  });

  it("never issues a write, and selects no transcript or note column", async () => {
    answer = (text, values) => roomTable(text, values) ?? (/FROM reb_track_index/.test(text) ? [reb(1)] : []);
    await run({ window_id: "bw_1", room: "opd-1" });
    for (const s of statements) {
      expect(s.text).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE)\b/i);
      expect(s.text).not.toMatch(/transcript|note_text|note_json/);
    }
  });
});
