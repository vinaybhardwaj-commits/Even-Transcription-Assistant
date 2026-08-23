/**
 * The live operator monitor — the rules an operator's Monday depends on.
 *
 * Everything here is PURE or driven through a fake Postgres. The tests that matter most are the
 * naming ones: the doctor-clock vital measures ONE LABELLED DOCTOR's Pulse clocks and cannot see
 * the room at all, because even_hospitals.doctor_opd_rooms is null on every hospital. Reading it
 * as "the warehouse is silent" is what turned a busy morning into an apparent six-hour blackout
 * on 19 August, so the copy is asserted, not just the arithmetic.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;

const appCalls: Array<{ text: string; values: unknown[] }> = [];
let appResponder: (text: string, values: unknown[]) => Row[] = () => [];
vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.raw.join("?").replace(/\s+/g, " ").trim();
    appCalls.push({ text, values });
    return Promise.resolve(appResponder(text, values));
  },
}));

const brainCalls: Array<{ text: string; values: unknown[] }> = [];
let brainResponder: (text: string, values: unknown[]) => Row[] = () => [];
vi.mock("@/lib/brain/db", () => ({
  TOKEN_ENV: "BRAIN_SERVICE_TOKEN",
  getPool: () => ({}),
  query: async (t: string, v?: unknown[]) => {
    brainCalls.push({ text: t, values: v ?? [] });
    const rows = brainResponder(t, v ?? []);
    return { rows, rowCount: rows.length };
  },
}));

import {
  DOCTOR_CLOCK_AMBER_MS,
  DOCTOR_CLOCK_LABEL,
  DOCTOR_CLOCK_NOTE,
  DOCTOR_CLOCK_RED_MS,
  MIC_AMBER_MS,
  MIC_RED_MS,
  SQL_LAST_WINDOW_MARKER,
  SQL_ROOM_DAY_ROLLUP,
  buildRoomLive,
  doctorClockLevel,
  istDayRangeUtc,
  listenerState,
  markerComplete,
  micLevel,
  normaliseSessions,
  readRoomsLive,
  type LiveSession,
} from "@/lib/admin/rooms-live";
import { LISTENER_FRESH_MS } from "@/lib/bench-commands";
import { WAREHOUSE_CUE_TYPES } from "@/lib/mcp/tools/fuse-report";

const migration = readFileSync(join(process.cwd(), "db", "migrations", "0054_live_monitor_indexes.sql"), "utf8");
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

// ===========================================================================
// 1. the vital that must never be misread
// ===========================================================================

describe("the doctor clock is one doctor's Pulse clocks, never the warehouse", () => {
  it("is LABELLED 'this doctor', and no string in the module says warehouse silent", () => {
    expect(DOCTOR_CLOCK_LABEL).toBe("this doctor");
    // Comments are stripped first: this asserts what reaches the OPERATOR. A comment that
    // quotes the banned phrase in order to ban it is the opposite of the problem.
    const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    const src = stripComments(readFileSync(join(process.cwd(), "lib", "admin", "rooms-live.ts"), "utf8"));
    const ui = stripComments(readFileSync(join(process.cwd(), "components", "admin", "BenchRoomsLive.tsx"), "utf8"));
    for (const text of [src, ui]) {
      expect(text).not.toMatch(/warehouse silent/i);
      expect(text).not.toMatch(/no warehouse event/i);
      expect(text).not.toMatch(/warehouse is (quiet|down|silent)/i);
    }
  });

  it("the alert copy says another doctor may be in the room", () => {
    expect(DOCTOR_CLOCK_NOTE).toMatch(/another doctor may be in this room/i);
    expect(DOCTOR_CLOCK_NOTE).toMatch(/cannot tell you the room is empty/i);
  });

  it("thresholds are 15 and 30 minutes", () => {
    expect(DOCTOR_CLOCK_AMBER_MS).toBe(15 * 60_000);
    expect(DOCTOR_CLOCK_RED_MS).toBe(30 * 60_000);
    expect(doctorClockLevel(14 * 60_000)).toBe("ok");
    expect(doctorClockLevel(15 * 60_000)).toBe("amber");
    expect(doctorClockLevel(29 * 60_000)).toBe("amber");
    expect(doctorClockLevel(30 * 60_000)).toBe("red");
  });

  it("null is UNKNOWN, not ok — there is nothing to be late for when nothing is recording", () => {
    expect(doctorClockLevel(null)).toBe("unknown");
  });
});

// ===========================================================================
// 2. the mic clock — the upload clock, which is why amber is 7
// ===========================================================================

describe("mic freshness", () => {
  it("is 7 amber / 10 red, so a mic that just rotated is not a mic in trouble", () => {
    expect(MIC_AMBER_MS).toBe(7 * 60_000);
    expect(MIC_RED_MS).toBe(10 * 60_000);
    expect(micLevel(5 * 60_000)).toBe("ok");   // a healthy mic cycles 0–5 min on created_at
    expect(micLevel(7 * 60_000)).toBe("amber");
    expect(micLevel(10 * 60_000)).toBe("red");
    expect(micLevel(null)).toBe("unknown");
  });
});

// ===========================================================================
// 3. the three listener states and the failure
// ===========================================================================

describe("listenerState — three states and a failure, never collapsed", () => {
  const now = Date.parse("2026-08-24T05:00:00Z");
  const row = (agoMs: number) => ({ room_id: "r", tab_id: "t", last_poll_at: new Date(now - agoMs).toISOString(), recording_session_id: null, paused: false });

  it("no row is `never`", () => expect(listenerState(null, false, now)).toBe("never"));
  it("a fresh row is `listening`", () => expect(listenerState(row(1_000), false, now)).toBe("listening"));
  it("an old row is `stale`", () => expect(listenerState(row(LISTENER_FRESH_MS + 1), false, now)).toBe("stale"));

  it("A FAILED READ IS `unknown`, never `never` — a bus outage is not an absent kiosk", () => {
    expect(listenerState(null, true, now)).toBe("unknown");
    // and even with a row present, a failed read stays unknown rather than claiming freshness
    expect(listenerState(row(1_000), true, now)).toBe("unknown");
  });
});

// ===========================================================================
// 4. the completeness marker
// ===========================================================================

describe("markerComplete — silence is not failure", () => {
  it("reads a real boolean", () => {
    expect(markerComplete({ complete: true })).toBe(true);
    expect(markerComplete({ complete: false })).toBe(false);
  });
  it("a marker that never SAYS complete is unknown, never failed", () => {
    expect(markerComplete({ segment_count: 3 })).toBeNull();
    expect(markerComplete({ complete: "yes" })).toBeNull();
    expect(markerComplete(null)).toBeNull();
    expect(markerComplete("nope")).toBeNull();
  });
});

// ===========================================================================
// 5. the IST day, half-open so the index is usable
// ===========================================================================

describe("istDayRangeUtc", () => {
  it("is exactly the IST midnight pair, 24 h apart", () => {
    const { fromIso, toIso } = istDayRangeUtc("2026-08-24");
    expect(fromIso).toBe("2026-08-23T18:30:00.000Z");
    expect(toIso).toBe("2026-08-24T18:30:00.000Z");
    expect(Date.parse(toIso) - Date.parse(fromIso)).toBe(86_400_000);
  });
});

// ===========================================================================
// 6. the per-room rollup
// ===========================================================================

const NOW = Date.parse("2026-08-24T06:00:00Z");
const ROOM = { id: "room_a", slug: "opd-7-y74w", name: "OPD 7", transcript_enabled: false, visits_enabled: false };
const session = (over: Partial<LiveSession> = {}): LiveSession => ({
  id: "bs_1", room_id: ROOM.id, status: "recording",
  started_at: new Date(NOW - 60 * 60_000).toISOString(), ended_at: null,
  last_primary_at: new Date(NOW - 60_000).toISOString(), last_backup_at: null,
  backup_chunks: 0, primary_chunks: 12, ...over,
});
const NO_COUNTS = { transcript: { done: 0, waiting: 0, no_day: 0, in_progress: 0, failed: 0, words_ms: 0 }, visits: { built: 0, open: 0 } };
const NO_BRAIN = { last_warehouse_at: null, marks_today: 0, last_mark_at: null, last_window_asked_at: null, last_window_complete: null };

describe("buildRoomLive", () => {
  it("a healthy recording room is green on both clocks", () => {
    const r = buildRoomLive(ROOM, [session()], NO_COUNTS, { ...NO_BRAIN, last_warehouse_at: new Date(NOW - 60_000).toISOString() }, 0, NOW, []);
    expect(r.recording).toBe(true);
    expect(r.mic_level).toBe("ok");
    expect(r.doctor_clock_level).toBe("ok");
    expect(r.stalled).toBe(false);
  });

  it("the doctor clock is NULL when nothing is recording — an idle room is not late", () => {
    const r = buildRoomLive(ROOM, [session({ status: "ended" })], NO_COUNTS, { ...NO_BRAIN, last_warehouse_at: new Date(NOW - 3 * 60 * 60_000).toISOString() }, 0, NOW, []);
    expect(r.recording).toBe(false);
    expect(r.doctor_clock_silent_ms).toBeNull();
    expect(r.doctor_clock_level).toBe("unknown");
  });

  it("the doctor clock is NULL while paused — a paused room is not failing to clock in", () => {
    const r = buildRoomLive(ROOM, [session({ status: "paused" })], NO_COUNTS, { ...NO_BRAIN, last_warehouse_at: new Date(NOW - 3 * 60 * 60_000).toISOString() }, 0, NOW, []);
    expect(r.paused_session).toBe(true);
    expect(r.doctor_clock_silent_ms).toBeNull();
  });

  it("any warehouse-typed cue RESETS the clock", () => {
    const stale = buildRoomLive(ROOM, [session()], NO_COUNTS, { ...NO_BRAIN, last_warehouse_at: new Date(NOW - 40 * 60_000).toISOString() }, 0, NOW, []);
    expect(stale.doctor_clock_level).toBe("red");
    const fresh = buildRoomLive(ROOM, [session()], NO_COUNTS, { ...NO_BRAIN, last_warehouse_at: new Date(NOW - 60_000).toISOString() }, 0, NOW, []);
    expect(fresh.doctor_clock_level).toBe("ok");
  });

  it("with no clock all day the gap runs from the tape's own start, not from zero", () => {
    const r = buildRoomLive(ROOM, [session()], NO_COUNTS, NO_BRAIN, 0, NOW, []);
    expect(r.doctor_clock_silent_ms).toBe(60 * 60_000);
    expect(r.doctor_clock_level).toBe("red");
  });

  it("a backup mic with zero chunks all session is flagged, and reads `no chunks`", () => {
    const r = buildRoomLive(ROOM, [session({ backup_chunks: 0 })], NO_COUNTS, NO_BRAIN, 0, NOW, []);
    expect(r.backup_reads_no_chunks).toBe(true);
    expect(r.backup_chunks_today).toBe(0);
    // and an idle room is not flagged: there is no second microphone to be silent
    expect(buildRoomLive(ROOM, [session({ status: "ended" })], NO_COUNTS, NO_BRAIN, 0, NOW, []).backup_reads_no_chunks).toBe(false);
  });

  it("stalled carries a real age beside the boolean", () => {
    const r = buildRoomLive(ROOM, [session({ last_primary_at: new Date(NOW - 20 * 60_000).toISOString() })], NO_COUNTS, NO_BRAIN, 0, NOW, []);
    expect(r.stalled).toBe(true);
    expect(r.stalled_age_ms).toBe(20 * 60_000);
  });

  it("mic freshness uses the newest piece on EITHER mic", () => {
    const r = buildRoomLive(
      ROOM,
      [session({ last_primary_at: new Date(NOW - 12 * 60_000).toISOString(), last_backup_at: new Date(NOW - 60_000).toISOString(), backup_chunks: 3 })],
      NO_COUNTS, NO_BRAIN, 0, NOW, [],
    );
    // the backup is carrying the room, so the mic clock is green even though primary is old
    expect(r.mic_level).toBe("ok");
    expect(r.backup_chunks_today).toBe(3);
  });

  it("marks and the not-sent count come through", () => {
    const r = buildRoomLive(ROOM, [session()], NO_COUNTS, { ...NO_BRAIN, marks_today: 7, last_mark_at: new Date(NOW - 5 * 60_000).toISOString() }, 2, NOW, []);
    expect(r.marks_today).toBe(7);
    expect(r.marks_not_sent).toBe(2);
  });
});

describe("normaliseSessions", () => {
  it("drops rows without ids and never yields NaN counts", () => {
    const out = normaliseSessions([{ id: "bs_1", room_id: "r" }, { room_id: "r" }, null, "nope"]);
    expect(out).toHaveLength(1);
    expect(out[0]!.backup_chunks).toBe(0);
    expect(out[0]!.primary_chunks).toBe(0);
  });
});

// ===========================================================================
// 7. the reads, and their fail-safety
// ===========================================================================

describe("readRoomsLive", () => {
  beforeEach(() => {
    appCalls.length = 0;
    brainCalls.length = 0;
    appResponder = (text) => {
      if (/FROM room WHERE/.test(text)) return [ROOM];
      if (/FROM bench_session s/.test(text)) return [{ id: "bs_1", room_id: ROOM.id, status: "recording", started_at: new Date(NOW - 60 * 60_000), ended_at: null, last_primary_at: new Date(NOW - 60_000), last_backup_at: null, backup_chunks: 0, primary_chunks: 5 }];
      if (/FROM bench_event/.test(text)) return [{ session_id: "bs_1", n: 1 }];
      return [];
    };
    brainResponder = (text) => {
      if (/FILTER \(WHERE c.type IN/.test(text)) return [{ room_id: ROOM.id, last_warehouse_at: new Date(NOW - 60_000), marks_today: 4, last_mark_at: new Date(NOW - 120_000) }];
      if (/DISTINCT ON/.test(text)) return [{ room_id: ROOM.id, at: new Date(NOW - 300_000), payload: { complete: true } }];
      return [];
    };
  });

  it("assembles one room from four reads", async () => {
    const out = await readRoomsLive(new Date(NOW));
    expect(out.rooms).toHaveLength(1);
    const r = out.rooms[0]!;
    expect(r.marks_today).toBe(4);
    expect(r.marks_not_sent).toBe(1);
    expect(r.last_window_complete).toBe(true);
    expect(out.degraded).toEqual([]);
  });

  it("the session read uses a HALF-OPEN started_at range, so 0054's index is usable", async () => {
    await readRoomsLive(new Date(NOW));
    const q = appCalls.find((c) => /FROM bench_session s/.test(c.text))!;
    expect(q.text).toMatch(/s\.started_at >= \?::timestamptz/);
    expect(q.text).toMatch(/s\.started_at < *\?::timestamptz/);
    // and never AT TIME ZONE, which is what defeats the index in listBenchSessions
    expect(q.text).not.toMatch(/AT TIME ZONE/);
  });

  it("reads the UPLOAD clock (created_at), never ended_at", async () => {
    await readRoomsLive(new Date(NOW));
    const q = appCalls.find((c) => /FROM bench_session s/.test(c.text))!;
    expect(q.text).toMatch(/MAX\(c\.created_at\) FILTER \(WHERE c\.source = 'primary'\)/);
    expect(q.text).toMatch(/MAX\(c\.created_at\) FILTER \(WHERE c\.source = 'backup'\)/);
    expect(q.text).not.toMatch(/MAX\(c\.ended_at\)/);
  });

  it("SKIPS scratch rooms — they have no kiosk and would alarm for ever", async () => {
    await readRoomsLive(new Date(NOW));
    expect(appCalls.find((c) => /FROM room WHERE/.test(c.text))!.text).toMatch(/room_scratch_/);
  });

  it("a brain fault degrades that section and still renders the room", async () => {
    brainResponder = () => { throw new Error("permission denied for table cue"); };
    const out = await readRoomsLive(new Date(NOW));
    expect(out.rooms).toHaveLength(1);
    expect(out.rooms[0]!.marks_today).toBe(0);
    expect(out.rooms[0]!.degraded.join(" ")).toMatch(/brain_rollup_unavailable/);
  });

  it("an app fault degrades and never throws", async () => {
    appResponder = () => { throw new Error("db gone"); };
    const out = await readRoomsLive(new Date(NOW));
    expect(out.rooms).toEqual([]);
    expect(out.degraded.join(" ")).toMatch(/rooms_unavailable/);
  });

  it("is READ-ONLY: no statement it issues writes anything", async () => {
    await readRoomsLive(new Date(NOW));
    for (const c of [...appCalls, ...brainCalls]) {
      expect(c.text).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i);
    }
  });
});

// ===========================================================================
// 8. migration 0054, and the constants it must agree with
// ===========================================================================

describe("0054 — the indexes the 3 s poll depends on", () => {
  const body = squash(migration.replace(/^--.*$/gm, ""));

  it("creates exactly the four indexes and its own row", () => {
    expect(body).toContain("CREATE INDEX IF NOT EXISTS bench_session_room_started_idx ON bench_session (room_id, started_at DESC);");
    expect(body).toContain("CREATE INDEX IF NOT EXISTS cue_mark_recent_idx ON cue (room_day_id, at DESC) WHERE type = 'consult_mark';");
    expect(body).toContain("CREATE INDEX IF NOT EXISTS bench_event_session_kind_idx ON bench_event (session_id, kind);");
    expect(body.split(";").filter((p) => p.trim().length > 0)).toHaveLength(5);
  });

  it("RECORDS ITSELF", () => {
    expect(squash(migration)).toContain("INSERT INTO schema_migrations (version, name) VALUES (54, '0054_live_monitor_indexes') ON CONFLICT DO NOTHING;");
  });

  it("is additive only — no unique index, no table touched, nothing dropped", () => {
    expect(body).not.toMatch(/UNIQUE/i);
    expect(body).not.toMatch(/DROP|ALTER TABLE|DELETE FROM|UPDATE /i);
  });

  it("the warehouse predicate is WAREHOUSE_CUE_TYPES, and the query filters on the same four", () => {
    const inIndex = body.match(/cue_warehouse_recent_idx[^;]*WHERE type IN \(([^)]*)\)/)![1]!;
    const names = inIndex.split(",").map((t) => t.trim().replace(/'/g, ""));
    expect(names).toEqual([...WAREHOUSE_CUE_TYPES]);
    // the rollup query must filter on exactly those names or it cannot use the index
    for (const n of names) expect(SQL_ROOM_DAY_ROLLUP).toContain(`'${n}'`);
  });

  it("the marker query filters the type the index predicate does NOT cover — flagged, not hidden", () => {
    expect(SQL_LAST_WINDOW_MARKER).toContain("c.type = 'stt_window'");
    expect(body).not.toContain("stt_window");
  });
});

// ===========================================================================
// 9. the six room states (K2 §1) — operator language, one precedence order
// ===========================================================================

// From the pure constants module. bench-commands re-exports LISTENER_FRESH_MS but NOT this one —
// deliberately left alone, since lib/bench-commands.ts is outside this slice's file contract.
import { LISTENER_OFFLINE_MS, roomState, fmtCoarse, fmtDayIst } from "@/lib/bench-bus-constants";

const T = Date.parse("2026-08-24T06:00:00Z");
const kiosk = (agoMs: number, paused = false) => ({ last_poll_at: new Date(T - agoMs).toISOString(), paused });
const st = (over: Partial<Parameters<typeof roomState>[0]> = {}) =>
  roomState({ listenerReadFailed: false, listener: kiosk(1_000), pausedSession: false, recording: false, recordingSince: null, nowMs: T, ...over });

describe("the six states", () => {
  it("1 — a FAILED listener read is Can't tell, never Offline", () => {
    const r = st({ listenerReadFailed: true, listener: null });
    expect(r.state).toBe("cant_tell");
    expect(r.label).toBe("Can't tell — cannot reach the command bus");
    // saying offline here would send somebody walking to a room that is perfectly fine
    expect(r.label).not.toMatch(/offline/i);
  });

  it("2 — PAUSED OUTRANKS RECORDING: consent withdrawn is the fact to act on", () => {
    const both = st({ recording: true, recordingSince: new Date(T - 2 * 3_600_000).toISOString(), pausedSession: true });
    expect(both.state).toBe("paused");
    expect(both.label).toBe("Paused for consent");
    // and either witness alone is enough
    expect(st({ listener: kiosk(1_000, true) }).state).toBe("paused");
    expect(st({ pausedSession: true }).state).toBe("paused");
  });

  it("3 — Recording carries how long", () => {
    const r = st({ recording: true, recordingSince: new Date(T - (2 * 3_600_000 + 14 * 60_000)).toISOString() });
    expect(r.state).toBe("recording");
    expect(r.label).toBe("Recording · 2h 14m");
  });

  it("4 — Ready is listening, not recording, not paused — and claims NOTHING else", () => {
    const r = st();
    expect(r.state).toBe("ready");
    expect(r.label).toBe("Ready");
    // the mockup's "both mics seen" was not buildable: before a session there are no chunks
    expect(r.label).not.toMatch(/mic/i);
    expect(r.hint).toBeNull();
  });

  it("5 — 9 minutes stale is Dropped, and it says to wait", () => {
    const r = st({ listener: kiosk(9 * 60_000) });
    expect(r.state).toBe("dropped");
    expect(r.label).toBe("Kiosk dropped 9m ago");
    expect(r.hint).toMatch(/wait/i);
  });

  it("6 — 11 minutes is Offline, and it says WHAT TO DO", () => {
    const r = st({ listener: kiosk(11 * 60_000) });
    expect(r.state).toBe("offline");
    expect(r.label).toMatch(/^Offline · no kiosk since /);
    expect(r.hint).toBe("open the room page on the Mini");
  });

  it("the Dropped/Offline boundary is LISTENER_OFFLINE_MS exactly", () => {
    expect(LISTENER_OFFLINE_MS).toBe(10 * 60_000);
    expect(st({ listener: kiosk(LISTENER_OFFLINE_MS - 1) }).state).toBe("dropped");
    expect(st({ listener: kiosk(LISTENER_OFFLINE_MS) }).state).toBe("offline");
  });

  it("6b — no row at all is Offline · never opened (OPD 7 today)", () => {
    const r = st({ listener: null });
    expect(r.state).toBe("offline");
    expect(r.label).toBe("Offline · never opened");
    expect(r.hint).toBe("open the room page on the Mini");
  });

  it("a 52-hour-stale kiosk names the DAY, not a duration — `page stale · 52h 27m` is gone", () => {
    const r = st({ listener: kiosk(52 * 3_600_000) });
    expect(r.label).toBe("Offline · no kiosk since 22 Aug");
    expect(r.label).not.toMatch(/stale/i);
    expect(r.label).not.toMatch(/52h/);
  });

  it("`page stale` appears nowhere in the monitor any more", () => {
    const ui = readFileSync(join(process.cwd(), "components", "admin", "BenchRoomsLive.tsx"), "utf8");
    expect(ui).not.toMatch(/page stale/i);
  });
});

describe("the state formatters are deterministic", () => {
  it("fmtDayIst is arithmetic IST, so server and browser agree", () => {
    // 18:29 UTC is still the 23rd in IST; 18:30 UTC is the 24th
    expect(fmtDayIst("2026-08-23T18:29:00Z")).toBe("23 Aug");
    expect(fmtDayIst("2026-08-23T18:30:00Z")).toBe("24 Aug");
    expect(fmtDayIst(null)).toBeNull();
  });
  it("fmtCoarse never shows seconds — these are not stopwatches", () => {
    expect(fmtCoarse(30_000)).toBe("just now");
    expect(fmtCoarse(3 * 60_000)).toBe("3m");
    expect(fmtCoarse(2 * 3_600_000 + 14 * 60_000)).toBe("2h 14m");
    expect(fmtCoarse(50 * 3_600_000)).toBe("2d");
  });
});

// ===========================================================================
// 10. the selection store — it must survive a poll
// ===========================================================================

import { selectedRoom } from "@/components/admin/BenchRoomsLive";

describe("the selected room", () => {
  beforeEach(() => selectedRoom.reset());

  it("a person's choice is NEVER overridden by a later default", () => {
    selectedRoom.choose("room_b");
    selectedRoom.suggest("room_a");           // the monitor finds a recording room
    selectedRoom.suggest("room_c");           // and again on the next poll
    expect(selectedRoom.get()).toEqual({ roomId: "room_b", source: "user" });
  });

  it("SURVIVES A POLL: repeated identical suggestions do not churn the selection", () => {
    selectedRoom.suggest("room_a");
    const first = selectedRoom.get();
    selectedRoom.suggest("room_a");
    selectedRoom.suggest("room_a");
    expect(selectedRoom.get()).toBe(first);   // same object — nothing was re-set
  });

  it("a default may be replaced by a better default, which is how recording outranks recency", () => {
    selectedRoom.suggest("room_recent");
    selectedRoom.suggest("room_recording");
    expect(selectedRoom.get()).toEqual({ roomId: "room_recording", source: "default" });
  });

  it("notifies subscribers, and stops when they leave", () => {
    let hits = 0;
    const off = selectedRoom.subscribe(() => { hits++; });
    selectedRoom.choose("room_a");
    expect(hits).toBe(1);
    off();
    selectedRoom.choose("room_b");
    expect(hits).toBe(1);
  });
});

// ===========================================================================
// 11. the client bundle boundary — the build caught this once
// ===========================================================================

describe("the state rules stay importable from a browser bundle", () => {
  it("lib/bench-bus-constants.ts imports NOTHING — a Postgres driver must never reach the browser", () => {
    const src = readFileSync(join(process.cwd(), "lib", "bench-bus-constants.ts"), "utf8");
    // The module's own contract, and the reason roomState lives here rather than in
    // lib/admin/rooms-live.ts (which imports lib/db and lib/brain/db).
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).toContain("export function roomState");
  });

  it("the monitor component does not import the server-side aggregation", () => {
    const ui = readFileSync(join(process.cwd(), "components", "admin", "BenchRoomsLive.tsx"), "utf8");
    expect(ui).not.toMatch(/from "@\/lib\/admin\/rooms-live"/);
    expect(ui).toMatch(/from "@\/lib\/bench-bus-constants"/);
  });

  it("and the server side still reaches roomState by one import path", async () => {
    const fromLib = await import("@/lib/admin/rooms-live");
    const fromPure = await import("@/lib/bench-bus-constants");
    expect(fromLib.roomState).toBe(fromPure.roomState);
  });
});
