/**
 * Tier 1 §3 — `scribe_room_command`, the MCP door onto the three operator verbs. Mocked `sql`; the
 * mcp-set-audio-input mock set for everything lib/mcp/tools/bench.ts imports that is not under test.
 *
 * bad_args before the room is resolved · APP_TOO_OLD below 0.1.22 (and for a room with no bound
 * Mac) · kiosk_not_listening · one command, source mcp, args as validated · the ack verbatim ·
 * report_diag waits 20 s, the other two keep the 8 s every existing kind has.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
const BC = await import("@/lib/bench-commands");

const tool = BENCH_TOOLS.find((t) => t.name === "scribe_room_command")!;
const ROOM = { id: "room_home", slug: "home-office-w8fb", name: "Home Office", disabled_at: null };
const ctx = { origin: "https://preview.example" };
const inserts = () => calls.filter((c) => /INSERT INTO bench_command/.test(c.text));

const NO_INSTALL = Symbol("no bound install");
function room(
  ageMs: number | null,
  ack: Row | null = { status: "acked", result: { ok: true }, error: null },
  appVersion: string | null | typeof NO_INSTALL = "0.1.22",
) {
  responder = (text, values) => {
    if (/FROM room WHERE/.test(text)) return [ROOM];
    if (/FROM room_install WHERE room_id = \?/.test(text)) {
      return appVersion === NO_INSTALL ? [] : [{ install_id: "install_home", app_version: appVersion }];
    }
    if (/FROM bench_listener WHERE room_id/.test(text)) {
      return ageMs === null ? [] : [{ room_id: ROOM.id, tab_id: "app_install_home", last_poll_at: new Date(Date.now() - ageMs).toISOString(), recording_session_id: null, paused: false }];
    }
    if (/FROM bench_command WHERE id = \?/.test(text)) {
      const ins = inserts()[0];
      return ins && ack ? [{ id: values[0], room_id: ROOM.id, kind: ins.values[2], args: null, source: "mcp", created_at: new Date().toISOString(), acked_at: new Date().toISOString(), ...ack }] : [];
    }
    return [];
  };
}

beforeEach(() => {
  calls.length = 0;
  responder = () => [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("scribe_room_command — registration", () => {
  it("is ONE write tool, beside scribe_set_audio_input, taking room, kind and args", () => {
    expect(tool).toBeTruthy();
    expect(tool.scope).toBe("write");
    const schema = tool.inputSchema as { properties: Record<string, { enum?: string[] }>; required?: string[] };
    expect(Object.keys(schema.properties).sort()).toEqual(["args", "kind", "room", "room_id", "room_slug"]);
    expect(schema.properties.kind!.enum).toEqual(["check_update_now", "report_diag", "restart_engine"]);
    expect(schema.required).toEqual(["kind"]);
    const names = BENCH_TOOLS.map((t) => t.name);
    expect(names.indexOf("scribe_room_command")).toBe(names.indexOf("scribe_set_audio_input") + 1);
  });
});

describe("scribe_room_command — refusals, and nothing written", () => {
  it("an unknown kind, or a day verb, is refused by name", async () => {
    room(1_000);
    for (const kind of ["start_day", "set_audio_input", "reboot", undefined]) {
      const out = (await tool.handler({ room: "home-office-w8fb", kind } as never, ctx as never)) as Row;
      expect(out.error).toBe("unknown_kind");
    }
    expect(calls).toHaveLength(0);
  });

  it("bad args are refused BEFORE the room is looked up", async () => {
    room(1_000);
    const bad: Array<[string, unknown]> = [
      ["check_update_now", { force: true }],
      ["report_diag", { log_lines: 501 }],
      ["report_diag", { log_lines: 1.5 }],
      ["report_diag", { lines: 5 }],
      ["restart_engine", { force: "yes" }],
    ];
    for (const [kind, args] of bad) {
      const out = (await tool.handler({ room: "home-office-w8fb", kind, args } as never, ctx as never)) as Row;
      expect(out.error, `${kind} ${JSON.stringify(args)}`).toBe("bad_args");
    }
    expect(calls).toHaveLength(0);
  });

  it("APP_TOO_OLD below 0.1.22, for a null version, and for a room with no bound Mac — nothing inserted", async () => {
    for (const v of ["0.1.21", null, NO_INSTALL] as const) {
      calls.length = 0;
      room(1_000, undefined, v);
      const out = (await tool.handler({ room: "home-office-w8fb", kind: "report_diag" } as never, ctx as never)) as { error: Row };
      expect(out.error.code).toBe("APP_TOO_OLD");
      expect(inserts()).toHaveLength(0);
    }
  });

  it("kiosk_not_listening for a dark room — nothing inserted", async () => {
    room(60_000);
    const out = (await tool.handler({ room: "home-office-w8fb", kind: "check_update_now" } as never, ctx as never)) as Row;
    expect(out.error).toBe("kiosk_not_listening");
    expect(inserts()).toHaveLength(0);
  });
});

describe("scribe_room_command — the command and its ack", () => {
  it("inserts one command, source mcp, with the validated args, and returns the ack verbatim", async () => {
    room(1_000, { status: "acked", result: { ok: true, restarting: true }, error: null });
    const out = (await tool.handler({ room: "home-office-w8fb", kind: "restart_engine", args: { force: true } } as never, ctx as never)) as Row;
    expect(out.ok).toBe(true);
    expect(out.result).toEqual({ ok: true, restarting: true });
    const ins = inserts();
    expect(ins).toHaveLength(1);
    expect(ins[0]!.values[2]).toBe("restart_engine");
    expect(JSON.parse(String(ins[0]!.values[3]))).toEqual({ force: true });
    expect(ins[0]!.values[4]).toBe("mcp");
  });

  it("a refusal from the app is ok:false with the app's own error name", async () => {
    room(1_000, { status: "failed", result: { ok: false, error: "session_open" }, error: "session_open" });
    const out = (await tool.handler({ room: "home-office-w8fb", kind: "restart_engine" } as never, ctx as never)) as Row;
    expect(out.ok).toBe(false);
    expect(out.error).toBe("session_open");
  });

  it("check_update_now stores no args at all", async () => {
    room(1_000);
    await tool.handler({ room: "home-office-w8fb", kind: "check_update_now" } as never, ctx as never);
    expect(inserts()[0]!.values[3]).toBeNull();
  });

  it("report_diag waits 20 s; check_update_now keeps the 8 s every existing kind has", async () => {
    expect(BC.ACK_WAIT_MS).toBe(8_000);
    expect(BC.LISTENER_FRESH_MS).toBe(10_000);
    expect(BC.ackWaitMsFor("report_diag")).toBe(20_000);
    for (const k of ["start_day", "pause_day", "resume_day", "end_day", "set_audio_input", "check_update_now", "restart_engine"]) {
      expect(BC.ackWaitMsFor(k)).toBe(8_000);
    }
    vi.useFakeTimers({ now: new Date("2026-09-11T16:00:00.000Z") });
    for (const [kind, secs] of [["report_diag", 20], ["check_update_now", 8]] as const) {
      calls.length = 0;
      // Listening now; no ack ever arrives; the listener then shows a poll after the insert.
      room(0, null);
      const p = tool.handler({ room: "home-office-w8fb", kind } as never, ctx as never) as Promise<Row>;
      await vi.advanceTimersByTimeAsync((secs - 1) * 1_000);
      let settled = false;
      void p.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled, `${kind} settled before ${secs - 1} s`).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      const out = await p;
      expect(out.error).toBe("ack_timeout");
      expect(String(out.hint)).toContain(`within ${secs} s`);
    }
  });
});
