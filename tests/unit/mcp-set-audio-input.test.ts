/**
 * R4-D6 — `scribe_set_audio_input`, the MCP door onto the fifth command kind. Mocked `sql`; the
 * mcp-s3 mock set for everything lib/mcp/tools/bench.ts imports that is not under test here.
 *
 * Same shape as the tape-control tools: resolve the room → refuse a dark room (kiosk_not_listening,
 * no row written) → one `set_audio_input` command, source `mcp` → the app's ack, verbatim.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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

const tool = BENCH_TOOLS.find((t) => t.name === "scribe_set_audio_input");
const ROOM = { id: "room_opd3", slug: "opd-3-x1y2", name: "OPD 3", disabled_at: null };
const ctx = { origin: "https://preview.example" };
const inserts = () => calls.filter((c) => /INSERT INTO bench_command/.test(c.text));

/**
 * A room whose app polled `ageMs` ago, whose bound install reports `appVersion` (NO_INSTALL = no
 * bound install at all), and which acks whatever it is sent with `ack`.
 */
const NO_INSTALL = Symbol("no bound install");
function room(
  ageMs: number | null,
  ack: Row | null = { status: "acked", result: { ok: true }, error: null },
  appVersion: string | null | typeof NO_INSTALL = "0.1.21",
) {
  responder = (text, values) => {
    if (/FROM room WHERE/.test(text)) return [ROOM];
    if (/FROM room_install WHERE room_id = \?/.test(text)) {
      return appVersion === NO_INSTALL ? [] : [{ install_id: "install_opd3", app_version: appVersion }];
    }
    if (/FROM bench_listener WHERE room_id/.test(text)) {
      return ageMs === null ? [] : [{ room_id: ROOM.id, tab_id: "app_install_1", last_poll_at: new Date(Date.now() - ageMs).toISOString(), recording_session_id: "bs_live", paused: false }];
    }
    if (/FROM bench_command WHERE id = \?/.test(text)) {
      const ins = inserts()[0];
      return ins && ack ? [{ id: values[0], room_id: ROOM.id, kind: "set_audio_input", args: JSON.parse(String(ins.values[3])), source: "mcp", created_at: new Date().toISOString(), acked_at: new Date().toISOString(), ...ack }] : [];
    }
    return [];
  };
}

beforeEach(() => {
  calls.length = 0;
  responder = () => [];
});

describe("R4-D6 — scribe_set_audio_input", () => {
  it("is registered as a write tool beside the tape-control tools, with the room and the two fields", () => {
    expect(tool).toBeTruthy();
    expect(tool!.scope).toBe("write");
    const props = (tool!.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props).sort()).toEqual(["device_uid", "input_volume", "room", "room_id", "room_slug"]);
    const names = BENCH_TOOLS.map((t) => t.name);
    expect(names.indexOf("scribe_set_audio_input")).toBe(names.indexOf("scribe_stop_recording") + 1);
  });

  it("sends one set_audio_input, source mcp, to a listening room and returns the ack", async () => {
    room(1_000);
    const out = (await tool!.handler({ room: "OPD 3", device_uid: "c270-1" }, ctx as never)) as Row;
    expect(inserts()).toHaveLength(1);
    const ins = inserts()[0]!;
    expect(ins.values.slice(1)).toEqual([ROOM.id, "set_audio_input", JSON.stringify({ device_uid: "c270-1" }), "mcp"]);
    expect(out).toMatchObject({ ok: true, status: "acked", kind: "set_audio_input", command_id: ins.values[0], result: { ok: true } });
    expect(out.room).toEqual({ id: ROOM.id, slug: ROOM.slug, name: ROOM.name });
  });

  it("returns the app's named failure as the error", async () => {
    room(1_000, { status: "failed", result: { ok: false, error: "volume_not_settable" }, error: "volume_not_settable" });
    const out = (await tool!.handler({ room: "OPD 3", input_volume: 0.5 }, ctx as never)) as Row;
    expect(out).toMatchObject({ ok: false, status: "failed", error: "volume_not_settable" });
    expect(inserts()[0]!.values[3]).toBe(JSON.stringify({ input_volume: 0.5 }));
  });

  it("refuses a dark room with kiosk_not_listening and writes no command row", async () => {
    for (const age of [null, 60_000]) {
      calls.length = 0;
      room(age);
      const out = (await tool!.handler({ room: "OPD 3", device_uid: "c270-1" }, ctx as never)) as Row;
      expect(out).toMatchObject({ ok: false, error: "kiosk_not_listening" });
      expect(inserts()).toHaveLength(0);
    }
  });

  it("refuses bad args with bad_args before touching the database", async () => {
    for (const args of [{ room: "OPD 3" }, { room: "OPD 3", input_volume: 1.5 }, { room: "OPD 3", device_uid: "" }, { room: "OPD 3", input_volume: "loud" }]) {
      calls.length = 0;
      const out = (await tool!.handler(args, ctx as never)) as Row;
      expect(out, JSON.stringify(args)).toMatchObject({ ok: false, error: "bad_args" });
      expect(calls).toHaveLength(0);
    }
  });

  it("accepts a numeric-string volume, as the other tools accept loose JSON-RPC numbers", async () => {
    room(1_000);
    await tool!.handler({ room: "OPD 3", input_volume: "0.25" }, ctx as never);
    expect(inserts()[0]!.values[3]).toBe(JSON.stringify({ input_volume: 0.25 }));
  });

  // ── R4-D11 ─────────────────────────────────────────────────────────────────────────────────
  it("D11: refuses 0.1.20, a null version and a room with no bound Mac with APP_TOO_OLD — nothing inserted", async () => {
    for (const v of ["0.1.20", null, NO_INSTALL] as const) {
      calls.length = 0;
      room(1_000, undefined, v);
      const out = (await tool!.handler({ room: "OPD 3", device_uid: "c270-1" }, ctx as never)) as Row;
      expect(out.ok, String(v)).toBe(false);
      expect(out.error).toEqual({
        code: "APP_TOO_OLD",
        message: expect.stringContaining("0.1.21"),
        app_version: typeof v === "string" ? v : null,
      });
      expect(inserts()).toHaveLength(0);
    }
    const lookup = calls.find((c) => /FROM room_install WHERE room_id = \?/.test(c.text))!;
    expect(lookup.text).toContain("AND enrolled_at IS NOT NULL");
    expect(lookup.text).toContain("AND retired_at IS NULL");
  });

  it("D11: sends to 0.1.21", async () => {
    room(1_000, undefined, "0.1.21");
    const out = (await tool!.handler({ room: "OPD 3", device_uid: "c270-1" }, ctx as never)) as Row;
    expect(out).toMatchObject({ ok: true, status: "acked" });
    expect(inserts()).toHaveLength(1);
  });

  it("answers unknown_room for a room that does not exist", async () => {
    responder = () => [];
    const out = (await tool!.handler({ room: "Nowhere", device_uid: "c270-1" }, ctx as never)) as Row;
    expect(out).toMatchObject({ error: "unknown_room" });
    expect(inserts()).toHaveLength(0);
  });
});
