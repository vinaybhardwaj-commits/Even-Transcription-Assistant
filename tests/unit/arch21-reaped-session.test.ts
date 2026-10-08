/**
 * Arch #21 — a reap is a capture-failure event. One block per acceptance criterion.
 *   AC1 every reaper end alerts (outbox row + event) and surfaces on Bench attention
 *   AC2 a chunk recorded after a REAPED end is never registered into the ended session
 *   AC3 the kiosk learns the session was reaped (chunk reply, both key spellings; native poll reply)
 *   AC4 reap during clinic hours reads differently from an end-of-day reap
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Call = { text: string; values: unknown[] };
const calls: Call[] = [];
let notes: string | null = null;
let status = "ended";
let reapedLookup: unknown[] = [];
let endedAt: string | null = "2026-10-07T06:56:31.000Z";   // 12:26:31 IST

vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    if (/SELECT id, ended_at, notes FROM bench_session/.test(text)) return Promise.resolve(reapedLookup);
    return Promise.resolve([]);
  },
}));
vi.mock("@/lib/room-install", async (orig) => ({ ...((await orig()) as Record<string, unknown>), applyInstallPoll: async () => ({ ok: true, assigned_channel: null }) }));
vi.mock("@/lib/room-auth", () => ({ readRoomClaims: async () => ({ room_id: "room_test" }) }));
vi.mock("@/lib/r2", () => ({ headObject: async () => ({ size: 4242 }), benchChunkKey: () => "bench/room/2026-10-07/bs_t/9.webm" }));
vi.mock("@/lib/bench-window", () => ({ evaluateAndWriteWindows: async () => {}, istDateOf: () => "2026-10-07" }));
vi.mock("@/lib/bench", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  findBenchSession: async () => ({
    id: "bs_t", room_id: "room_test", room_slug: "opd-4", started_at: "2026-10-07T03:30:00.000Z",
    status, ended_at: endedAt, notes,
  }),
}));
vi.mock("next/server", async (orig) => ({ ...((await orig()) as Record<string, unknown>), after: (fn: () => unknown) => { void Promise.resolve(fn()); } }));

const { POST } = await import("@/app/api/bench/chunks/route");
const core = await import("@/lib/bench-reaper-core");
const { reapBenchSessions } = await import("@/lib/bench-reaper");
const { computeAttention } = await import("@/lib/fleet-attention");

const post = async (startedAt: string) => {
  const req = { json: async () => ({ session_id: "bs_t", idx: 9, started_at: startedAt, ended_at: startedAt, duration_ms: 300000, size_bytes: 4242, gap_before_ms: 0 }) } as never;
  const res = await POST(req);
  const json = (await res.json()) as Record<string, unknown>;
  await new Promise((r) => setTimeout(r, 0));
  return { status: res.status, json };
};
beforeEach(() => { calls.length = 0; notes = null; status = "ended"; endedAt = "2026-10-07T06:56:31.000Z"; });

describe("AC1 — every reap alerts and surfaces", () => {
  const NOW = Date.parse("2026-10-07T07:30:00.000Z");
  const cand = { id: "bs_wrnpdr4e", status: "recording", started_at: "2026-10-07T03:30:00.000Z", room_id: "room_opd4", room_name: "OPD4", last_primary_at: "2026-10-07T06:56:31.000Z" };
  it("writes an outbox row and a bench_event for the reaped session", async () => {
    const stmts: Call[] = [];
    const run = (async (s: TemplateStringsArray, ...v: unknown[]) => {
      const text = s.join("?").replace(/\s+/g, " ").trim(); stmts.push({ text, values: v });
      if (/^SELECT s\.id/.test(text)) return [cand];
      if (/^UPDATE bench_session/.test(text)) return [{ id: "bs_wrnpdr4e" }];
      return [];
    }) as never;
    const res = await reapBenchSessions({ now: new Date(NOW) }, run);
    expect(res.reaped).toHaveLength(1);
    const ob = stmts.find((c) => /INSERT INTO room_alert_outbox/.test(c.text))!;
    expect(ob.values).toContain("session_reaped");
    expect(ob.values).toContain("room_opd4");
    expect(ob.values).toContain("clinic_hours");
    expect(ob.values.join(" ")).toContain("bs_wrnpdr4e");
    expect(ob.values.join(" ")).toContain("12:26 IST");          // last chunk time
    const ev = stmts.find((c) => /INSERT INTO bench_event/.test(c.text))!;
    expect(ev.values).toContain("session_reaped");
  });
  it("a failed alert write does not undo or hide the reap", async () => {
    const run = (async (s: TemplateStringsArray) => {
      const text = s.join("?");
      if (/^\s*SELECT s\.id/.test(text)) return [cand];
      if (/UPDATE bench_session/.test(text)) return [{ id: "bs_wrnpdr4e" }];
      if (/room_alert_outbox|bench_event/.test(text)) throw new Error("boom");
      return [];
    }) as never;
    const res = await reapBenchSessions({ now: new Date(NOW) }, run);
    expect(res.reaped).toHaveLength(1);
  });
  it("migration 0132 admits the kind", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("db/migrations/0132_room_alert_outbox_session_reaped.sql", "utf8")).toContain("'session_reaped'");
  });
  const room = (reaped: unknown) => ({
    room_id: "room_opd4", room_name: "OPD4", machine: null, ext_events: [], poller: null, recent_activity: null, open_session: null,
    last_session_started_at: "2026-10-07T03:30:00.000Z", samples: [], chunks: [], windows: [], outbox: null, failed_start: null, reaped,
  });
  it("surfaces on Bench attention (red in clinic hours) until a session opens after it", () => {
    const at = "2026-10-07T07:30:00.000Z";
    const items = computeAttention({ now_ms: NOW + 60_000, rooms: [room({ created_at: at, body: "x", phase: "clinic_hours" })] } as never);
    const it0 = items.find((i) => i.kind === "session_reaped")!;
    expect(it0.severity).toBe("red");
    const recovered = computeAttention({ now_ms: NOW + 60_000, rooms: [{ ...room({ created_at: at, body: "x", phase: "clinic_hours" }), last_session_started_at: "2026-10-07T07:40:00.000Z" }] } as never);
    expect(recovered.some((i) => i.kind === "session_reaped")).toBe(false);
  });
});

describe("AC2 — a late chunk is never appended to a reaped session", () => {
  it("reaped session + chunk recorded after the end: no bench_chunk row, no window evaluation, audio key kept in an event", async () => {
    notes = core.NOTE_STALL;
    const { status: st, json } = await post("2026-10-07T10:11:00.000Z");   // 15:41 IST, the OPD4 case
    expect(st).toBe(200);
    expect(calls.some((c) => /INSERT INTO bench_chunk/.test(c.text))).toBe(false);
    const ev = calls.find((c) => /INSERT INTO bench_event/.test(c.text))!;
    expect(ev.text).toContain("chunk_refused_reaped");
    expect(JSON.stringify(ev.values)).toContain("bench/room/2026-10-07/bs_t/9.webm");
    expect(json.upload_state).toBe("refused_session_reaped");
    expect(json.session_reaped).toBe(true);
  });
  it("an OPERATOR-ended session keeps the old rule: chunk accepted", async () => {
    notes = null;
    const { json } = await post("2026-10-07T10:11:00.000Z");
    expect(calls.some((c) => /INSERT INTO bench_chunk/.test(c.text))).toBe(true);
    expect(json.upload_state).toBe("verified");
  });
  it("a flush chunk captured BEFORE the reap's ended_at still registers (not a late chunk)", async () => {
    notes = core.NOTE_STALL;
    const { json } = await post("2026-10-07T06:50:00.000Z");
    expect(json.upload_state).toBe("verified");
  });
});

describe("AC3 — the kiosk learns", () => {
  it("chunk reply carries `disagreement` (browser) AND `ended_disagrees` (native decodes this key)", async () => {
    notes = core.NOTE_ROLLOVER;
    const { json } = await post("2026-10-07T10:11:00.000Z");
    expect(json.disagreement).toBe("ended_disagrees");
    expect(json.ended_disagrees).toBe("ended_disagrees");
  });
  it("poll reply names the reaped session for a native install reporting it as recording", async () => {
    const { pollCommands } = await import("@/lib/bench-commands");
    const input = { roomId: "room_test", tabId: "t1", prevPollAt: null, recordingSessionId: "bs_t", paused: false, install: { install_id: "ins_1" } } as never;
    reapedLookup = [{ id: "bs_t", ended_at: "2026-10-07T06:56:31.000Z", notes: core.NOTE_STALL }];
    const out = (await pollCommands(input)) as Record<string, unknown>;
    expect(out.session_reaped).toEqual({ session_id: "bs_t", ended_at: "2026-10-07T06:56:31.000Z" });
    reapedLookup = [{ id: "bs_t", ended_at: "2026-10-07T06:56:31.000Z", notes: "operator" }];
    expect(((await pollCommands(input)) as Record<string, unknown>).session_reaped).toBeUndefined();
    reapedLookup = [];
    // the browser kiosk (no install) never gets the key and never pays the lookup
    calls.length = 0;
    expect(((await pollCommands({ ...(input as object), install: undefined } as never)) as Record<string, unknown>).session_reaped).toBeUndefined();
    expect(calls.some((c) => /FROM bench_session/.test(c.text))).toBe(false);
  });
  it("isReaperNote recognises both reaper notes and nothing else", () => {
    expect(core.isReaperNote(core.NOTE_STALL)).toBe(true);
    expect(core.isReaperNote(`x\n${core.NOTE_ROLLOVER}`)).toBe(true);
    expect(core.isReaperNote("operator ended")).toBe(false);
    expect(core.isReaperNote(null)).toBe(false);
  });
});

describe("AC4 — clinic-hours reap vs end-of-day reap", () => {
  it("classifies by the IST time of the last audio", () => {
    expect(core.classifyReap("stall", "2026-10-07T06:56:31.000Z")).toBe("clinic_hours");   // 12:26 IST
    expect(core.classifyReap("stall", "2026-10-07T11:53:00.000Z")).toBe("clinic_hours");   // 17:23 IST (Dietary)
    expect(core.classifyReap("stall", "2026-10-07T14:00:00.000Z")).toBe("end_of_day");     // 19:30 IST
    expect(core.classifyReap("stall", "2026-10-07T01:00:00.000Z")).toBe("end_of_day");     // 06:30 IST
    expect(core.classifyReap("rollover", "2026-10-07T06:56:31.000Z")).toBe("overnight");
  });
  it("the copy differs and the clinic-hours copy says capture FAILED", () => {
    const a = core.reapAlertCopy({ roomName: "OPD4", sessionId: "bs_x", rule: "stall", lastAudioIso: "2026-10-07T06:56:31.000Z" });
    const b = core.reapAlertCopy({ roomName: "OPD4", sessionId: "bs_x", rule: "stall", lastAudioIso: "2026-10-07T14:00:00.000Z" });
    expect(a.body).not.toBe(b.body);
    expect(a.subject).toMatch(/clinic hours/);
    expect(a.body).toMatch(/FAILED/);
    expect(b.body).not.toMatch(/FAILED/);
  });
});
