/**
 * Arch #16 — offline kiosk, stale cloud Recording. One block per acceptance criterion.
 *   AC1 documented TTL: no poll for HOST_OFFLINE_TTL_MS -> the room is not shown as healthy Recording
 *   AC2 Bench / fleet shows host-offline (chip state + attention item)
 *   AC3 a stale Recording cannot sit for hours without an attention signal
 *   AC4 the kiosk returning recovers cleanly, with no second session
 */
import { describe, it, expect, vi } from "vitest";
import { HOST_OFFLINE_TTL_MS, roomState } from "../../lib/bench-bus-constants";
import { computeAttention } from "../../lib/fleet-attention";
import { decideResume } from "../../lib/bench-resume-core";
import { decideStart, ABANDONED_SESSION_GRACE_MS } from "../../lib/bench-commands";
import { NOTE_SUPERSEDED, STALLED_BADGE_MINUTES } from "../../lib/bench-reaper-core";

const sqlCalls: Array<{ text: string; values: unknown[] }> = [];
vi.mock("@/lib/db", () => ({
  sql: (s: TemplateStringsArray, ...v: unknown[]) => { sqlCalls.push({ text: s.join("?").replace(/\s+/g, " ").trim(), values: v }); return Promise.resolve([]); },
}));
vi.mock("@/lib/room-auth", () => ({ readRoomClaims: async () => ({ room_id: "room_card" }) }));

const NOW = Date.parse("2026-10-05T14:30:00.000Z");   // 20:00 IST
const min = (n: number) => n * 60_000;
const iso = (t: number) => new Date(t).toISOString();
const rs = (over: Record<string, unknown>) => roomState({
  listenerReadFailed: false, pausedSession: false, recording: true, recordingSince: iso(NOW - min(240)), nowMs: NOW,
  listener: { last_poll_at: iso(NOW - min(1)), paused: false }, ...over,
} as never);

describe("AC1 — the TTL", () => {
  it("is five minutes, documented beside the constant", () => { expect(HOST_OFFLINE_TTL_MS).toBe(300_000); });
  it("a poll 4 min old is still Recording; 6 min old is not", () => {
    expect(rs({ listener: { last_poll_at: iso(NOW - min(4)), paused: false } }).state).toBe("recording");
    const s = rs({ listener: { last_poll_at: iso(NOW - min(6)), paused: false } });
    expect(s.state).toBe("host_offline");
    expect(s.label).toMatch(/not capturing/);
  });
  it("hours stale (Dietary 16:04 -> 20:00) never reads as healthy Recording", () => {
    const s = rs({ listener: { last_poll_at: iso(NOW - min(236)), paused: false } });
    expect(s.state).toBe("host_offline");
    expect(s.level).toBe("red");
    expect(s.start_available).toBe(false);
  });
  it("no listener row at all: judged from the session's own start", () => {
    expect(rs({ listener: null }).state).toBe("host_offline");
    expect(rs({ listener: null, recordingSince: iso(NOW - min(2)) }).state).toBe("recording");
  });
  it("a consent pause still outranks, and a dead command bus is still 'can't tell'", () => {
    expect(rs({ listener: { last_poll_at: iso(NOW - min(60)), paused: true } }).state).toBe("paused");
    expect(rs({ listenerReadFailed: true, listener: null }).state).toBe("cant_tell");
  });
});

describe("AC2/AC3 — fleet attention", () => {
  const room = (over: Record<string, unknown>) => ({
    room_id: "room_card", room_name: "Cardiology", machine: null, ext_events: [], poller: null, recent_activity: null,
    open_session: { id: "bs_c", status: "recording", started_at: iso(NOW - min(240)) },
    last_session_started_at: iso(NOW - min(240)), samples: [], chunks: [{ created_at: iso(NOW - min(2)), size_bytes: 100000, duration_ms: 60000 }],
    windows: [], outbox: null, failed_start: null, ...over,
  });
  const run = (r: unknown) => computeAttention({ now_ms: NOW, rooms: [r] } as never).filter((i) => i.kind === "host_offline");
  it("red item once the kiosk has been silent past the TTL, naming the room", () => {
    const items = run(room({ listener_last_poll_at: iso(NOW - min(7)) }));
    expect(items).toHaveLength(1);
    expect(items[0]!.severity).toBe("red");
    expect(items[0]!.detail).toMatch(/Cardiology/);
  });
  it("still present three hours in (no age cut-off while the session is open)", () => {
    expect(run(room({ listener_last_poll_at: iso(NOW - min(180)) }))).toHaveLength(1);
  });
  it("the action copy states the resume window the code enforces (STALLED_BADGE_MINUTES), not a different number", () => {
    const [item] = run(room({ listener_last_poll_at: iso(NOW - min(7)) }));
    expect(item!.action).toContain(`${STALLED_BADGE_MINUTES} minutes`);
    expect(item!.action).not.toMatch(/30 minutes/);
  });
  it("silent for a fresh poll, an unsupplied read, and a room whose kiosk never polled", () => {
    expect(run(room({ listener_last_poll_at: iso(NOW - min(1)) }))).toHaveLength(0);
    expect(run(room({}))).toHaveLength(0);                                     // read failed -> undefined -> no rule
    expect(run(room({ listener_last_poll_at: null }))).toHaveLength(0);       // never polled: no row, no claim
  });
  it("not raised for a paused or absent session", () => {
    expect(run(room({ listener_last_poll_at: iso(NOW - min(60)), open_session: null }))).toHaveLength(0);
    expect(run(room({ listener_last_poll_at: iso(NOW - min(60)), open_session: { id: "b", status: "paused", started_at: iso(NOW - min(240)) } }))).toHaveLength(0);
  });
});

describe("AC4 — recovery", () => {
  it("the moment the kiosk polls again the chip is Recording again (nothing latched)", () => {
    const gone = rs({ listener: { last_poll_at: iso(NOW - min(30)), paused: false } });
    const back = rs({ listener: { last_poll_at: iso(NOW - 1000), paused: false } });
    expect([gone.state, back.state]).toEqual(["host_offline", "recording"]);
  });
  it("a kiosk back within the stalled-badge window RESUMES the same session; after it, it starts fresh", () => {
    const row = (lastChunkMin: number) => ({ id: "bs_c", status: "recording", started_at: iso(NOW - min(240)), last_primary_at: iso(NOW - min(lastChunkMin)), last_backup_at: null });
    expect(decideResume(row(STALLED_BADGE_MINUTES - 2) as never, NOW).resumable).toBe(true);
    expect(decideResume(row(STALLED_BADGE_MINUTES + 2) as never, NOW).resumable).toBe(false);
  });
  it("starting that fresh session ENDS the stale one first (no two open recordings), at its last-audio time, with a why", async () => {
    const { POST } = await import("@/app/api/bench/sessions/route");
    sqlCalls.length = 0;
    const res = await POST({ json: async () => ({}) } as never);
    expect(res.status).toBe(200);
    expect(sqlCalls[0]!.text).toMatch(/^UPDATE bench_session s SET status = 'ended'/);
    expect(sqlCalls[0]!.text).toMatch(/MAX\(c\.created_at\)/);            // honest last audio, not now()
    expect(sqlCalls[0]!.text).toMatch(/s\.status = 'recording'/);           // paused untouched
    expect(sqlCalls[0]!.values).toContain(NOTE_SUPERSEDED);
    expect(sqlCalls[0]!.values).toContain("room_card");
    expect(sqlCalls[1]!.text).toMatch(/^INSERT INTO bench_session/);       // ...then the new one
  });
  it("a remote start is not swallowed by the stale row: abandoned recording -> send; live or fresh -> already_recording", () => {
    const listener = (rec: string | null) => ({ room_id: "room_card", tab_id: "t", last_poll_at: iso(Date.now() - 1000), recording_session_id: rec, paused: false }) as never;
    const old = iso(Date.now() - ABANDONED_SESSION_GRACE_MS - 60_000);
    expect(decideStart({ listener: listener(null), activeSession: { id: "bs_c", status: "recording", started_at: old }, overridePause: false }).action).toBe("send");
    expect(decideStart({ listener: listener("bs_c"), activeSession: { id: "bs_c", status: "recording", started_at: old }, overridePause: false }).action).toBe("already_recording");
    expect(decideStart({ listener: listener(null), activeSession: { id: "bs_c", status: "recording", started_at: iso(Date.now() - 10_000) }, overridePause: false }).action).toBe("already_recording");
    expect(decideStart({ listener: listener(null), activeSession: { id: "bs_c", status: "recording" }, overridePause: false }).action).toBe("already_recording");
  });
});
