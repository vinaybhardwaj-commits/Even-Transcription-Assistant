/**
 * BUILD 1 — the page tells the truth.
 *
 * Four alarms have been raised on the operator page in front of a person and every one of them
 * fired on healthy behaviour: the end-time alarm's first version on every ordinary end of day,
 * the doctor clock on every room thirty minutes in, "main microphone lost" on two working
 * microphones twice in one morning, and "kiosk dropped" on every room every time a day was ended
 * on purpose. The cost was not noise. On 24 August the one TRUE alarm on the page — Cardiology
 * recording for an hour with no day record, so none of its audio could be processed — sat unread
 * underneath two false ones.
 *
 * So the tests below are mostly about what does NOT appear. Every new rule is checked against an
 * ordinary day as well as a broken one, because four for four is the record so far and a rule
 * that fires on a healthy room doing a normal thing is a wrong rule, not a wrong room.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The two module mocks must be installed before anything that imports lib/db is pulled in.
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
vi.mock("@/lib/brain/db", () => ({
  TOKEN_ENV: "BRAIN_SERVICE_TOKEN",
  getPool: () => ({}),
  query: async () => ({ rows: [], rowCount: 0 }),
}));

import {
  DOCTOR_CLOCK_AMBER_MS,
  DOCTOR_CLOCK_RED_MS,
  STRANDED_MEASURE_NOTE,
  STRANDED_NEVER_CLOSED,
  STRANDED_NO_DAY,
  STRANDED_WAITING,
  WAITING_PHRASE,
  ZERO_STRANDED_RAW,
  doctorClockLevel,
  doctorClockSilentMs,
  endedAtLies,
  hasDoctorClock,
  strandedAudio,
  strandedTotal,
  transcriptLane,
  type StrandedRaw,
} from "@/lib/room-facts";
import { roomState, FINISHED_HINT } from "@/lib/bench-bus-constants";
import { buildRoomLive, type LiveSession } from "@/lib/admin/rooms-live";
import { readTranscriptAndStranded } from "@/lib/admin/room-reads";

/** Comments stripped, so every assertion below is about what SHIPS — a comment that quotes a
 *  banned string in order to explain why it is banned is the opposite of the problem. */
const code = (...parts: string[]) =>
  readFileSync(join(process.cwd(), ...parts), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const T = Date.parse("2026-08-24T10:46:00Z"); // 16:16 IST — when both rooms were ended
const kiosk = (agoMs: number, paused = false) => ({ last_poll_at: new Date(T - agoMs).toISOString(), paused });
const st = (over: Partial<Parameters<typeof roomState>[0]> = {}) =>
  roomState({ listenerReadFailed: false, listener: kiosk(1_000), pausedSession: false, recording: false, recordingSince: null, nowMs: T, ...over });

// ===========================================================================
// §3.2 — the seventh state, and the amber it replaces
// ===========================================================================

describe("§3.2 D30 — finished for today", () => {
  it("THE 24 AUGUST CASE: a day ended at 16:16 does not read 'kiosk dropped' nine minutes later", () => {
    // The exact shape of what was on the screen: both clinic rooms ended deliberately, the kiosk
    // page closed with them, and nine minutes of silence on the bus.
    const before = st({ listener: kiosk(9 * 60_000) });
    expect(before.state).toBe("dropped");
    expect(before.level).toBe("amber");

    const after = st({ listener: kiosk(9 * 60_000), lastSessionEnded: true, recordedMsToday: 4 * 3_600_000 + 21 * 60_000 });
    expect(after.state).toBe("finished");
    expect(after.label).toBe("Finished for today · 4h 21m recorded");
    expect(after.hint).toBe(FINISHED_HINT);
    expect(after.hint).toBe("Press start to record again");
    // NEVER AMBER. Nothing here needs anybody to do anything.
    expect(after.level).not.toBe("amber");
    expect(after.level).toBe("ok");
    expect(after.label).not.toMatch(/dropped|offline|come back/i);
  });

  it("carries no duration when nothing was recorded, rather than '0 m recorded'", () => {
    expect(st({ lastSessionEnded: true, recordedMsToday: 0 }).label).toBe("Finished for today");
    expect(st({ lastSessionEnded: true, recordedMsToday: null }).label).toBe("Finished for today");
  });

  // ---- PRECEDENCE. D30 is licence to add one state, not to reshuffle the chain. ------------
  it("is OUTRANKED by paused — consent withdrawn is still the fact to act on", () => {
    const v = st({ lastSessionEnded: true, pausedSession: true });
    expect(v.state).toBe("paused");
  });

  it("is OUTRANKED by recording — a live tape is never finished", () => {
    const v = st({ lastSessionEnded: true, recording: true, recordingSince: new Date(T - 60_000).toISOString() });
    expect(v.state).toBe("recording");
  });

  it("is OUTRANKED by can't tell — a failed listener read still means we do not know", () => {
    expect(st({ lastSessionEnded: true, listenerReadFailed: true }).state).toBe("cant_tell");
  });

  it("OUTRANKS ready, dropped and offline — the three that call a deliberate end an accident", () => {
    expect(st({ lastSessionEnded: true, listener: kiosk(1_000) }).state).toBe("finished");   // would be ready
    expect(st({ lastSessionEnded: true, listener: kiosk(9 * 60_000) }).state).toBe("finished"); // would be dropped
    expect(st({ lastSessionEnded: true, listener: kiosk(11 * 60_000) }).state).toBe("finished"); // would be offline
    expect(st({ lastSessionEnded: true, listener: null }).state).toBe("finished");           // would be offline · never opened
  });

  it("THE FALSE-ALARM GUARD: the other six states are untouched when no session has ended", () => {
    expect(st().state).toBe("ready");
    expect(st({ listener: kiosk(9 * 60_000) }).state).toBe("dropped");
    expect(st({ listener: kiosk(11 * 60_000) }).state).toBe("offline");
    expect(st({ recording: true, recordingSince: new Date(T - 60_000).toISOString() }).state).toBe("recording");
    expect(st({ pausedSession: true }).state).toBe("paused");
    expect(st({ listenerReadFailed: true }).state).toBe("cant_tell");
  });

  // ---- the button the hint promises -------------------------------------------------------
  it("start stays AVAILABLE on a finished room whose kiosk is still listening", () => {
    // Otherwise the state's own hint — press start to record again — would sit two lines above a
    // greyed-out start button, because `finished` outranks `ready`.
    expect(st({ lastSessionEnded: true, listener: kiosk(1_000) }).start_available).toBe(true);
  });

  it("start is NOT available on a finished room with no kiosk — the hint must not become a lie", () => {
    expect(st({ lastSessionEnded: true, listener: kiosk(11 * 60_000) }).start_available).toBe(false);
    expect(st({ lastSessionEnded: true, listener: null }).start_available).toBe(false);
  });

  it("start_available agrees with the old rule everywhere else", () => {
    expect(st().start_available).toBe(true);                                   // ready
    expect(st({ listener: kiosk(9 * 60_000) }).start_available).toBe(false);   // dropped
    expect(st({ pausedSession: true }).start_available).toBe(false);           // paused
    expect(st({ recording: true, recordingSince: null }).start_available).toBe(false);
    expect(st({ listenerReadFailed: true }).start_available).toBe(false);
  });
});

// ===========================================================================
// §3.2 — where the state's own input comes from
// ===========================================================================

const ROOM = { id: "room_1", slug: "cardio", name: "Cardiology", transcript_enabled: true, visits_enabled: false };
const NO_BRAIN = { last_warehouse_at: null, marks_today: 0, last_mark_at: null, last_window_asked_at: null, last_window_complete: null };
const NO_COUNTS = {
  transcript: { done: 0, waiting: 0, no_day: 0, in_progress: 0, failed: 0, words_ms: 0 },
  visits: { built: 0, open: 0 },
};
const session = (over: Partial<LiveSession> = {}): LiveSession => ({
  id: "bs_1", room_id: ROOM.id, status: "recording",
  started_at: new Date(T - 60 * 60_000).toISOString(), ended_at: null,
  last_primary_at: new Date(T - 60_000).toISOString(), last_backup_at: null,
  backup_chunks: 0, primary_chunks: 5, chunks_after_end: 0, ...over,
});

describe("§3.2 — last_session_ended, from the rows rather than from an ORDER BY", () => {
  it("is true when the newest session today is ended and nothing is recording", () => {
    const r = buildRoomLive(ROOM, [session({ status: "ended", ended_at: new Date(T - 9 * 60_000).toISOString() })], NO_COUNTS, NO_BRAIN, 0, T, []);
    expect(r.last_session_ended).toBe(true);
  });

  it("reads the NEWEST session, not the first row handed to it", () => {
    const older = session({ id: "bs_old", status: "ended", started_at: new Date(T - 5 * 3_600_000).toISOString(), ended_at: new Date(T - 4 * 3_600_000).toISOString() });
    const newer = session({ id: "bs_new", status: "recording", started_at: new Date(T - 60 * 60_000).toISOString() });
    // deliberately handed in with the ended one first
    const r = buildRoomLive(ROOM, [older, newer], NO_COUNTS, NO_BRAIN, 0, T, []);
    expect(r.last_session_ended).toBe(false);
    expect(r.recording).toBe(true);
  });

  it("is false for a room that has recorded nothing today — an unused room is not a finished one", () => {
    expect(buildRoomLive(ROOM, [], NO_COUNTS, NO_BRAIN, 0, T, []).last_session_ended).toBe(false);
  });
});

// ===========================================================================
// §3.1 — the doctor clock, hidden where nothing feeds it
// ===========================================================================

describe("§3.1 — the doctor clock is hidden when no warehouse cue exists", () => {
  it("THE BUG: no cue used to mean the RECORDING'S OWN LENGTH wearing a clock gap's label", () => {
    // A room recording happily for an hour, with no warehouse cue — which is every room, because
    // nothing in production writes one. It used to read 60 minutes of doctor-clock silence and
    // therefore RED, in every room, every day, thirty minutes in.
    const silent = doctorClockSilentMs({ lastWarehouseAt: null, recording: true, paused: false, nowMs: T });
    expect(silent).toBeNull();
    expect(doctorClockLevel(silent)).toBe("unknown");
    expect(doctorClockLevel(silent)).not.toBe("red");
    expect(doctorClockLevel(silent)).not.toBe("amber");
  });

  it("the row does not render when there is no cue, and does when there is", () => {
    expect(hasDoctorClock(null)).toBe(false);
    expect(hasDoctorClock("")).toBe(false);
    expect(hasDoctorClock(new Date(T - 60_000).toISOString())).toBe(true);
  });

  it("THE VITAL IS NOT REMOVED — it works unaltered the day something feeds it", () => {
    const at = new Date(T - 40 * 60_000).toISOString();
    expect(doctorClockSilentMs({ lastWarehouseAt: at, recording: true, paused: false, nowMs: T })).toBe(40 * 60_000);
    expect(DOCTOR_CLOCK_AMBER_MS).toBe(15 * 60_000);
    expect(DOCTOR_CLOCK_RED_MS).toBe(30 * 60_000);
    expect(doctorClockLevel(14 * 60_000)).toBe("ok");
    expect(doctorClockLevel(15 * 60_000)).toBe("amber");
    expect(doctorClockLevel(30 * 60_000)).toBe("red");
  });

  it("still returns null while paused or not recording, exactly as before", () => {
    const at = new Date(T - 40 * 60_000).toISOString();
    expect(doctorClockSilentMs({ lastWarehouseAt: at, recording: false, paused: false, nowMs: T })).toBeNull();
    expect(doctorClockSilentMs({ lastWarehouseAt: at, recording: true, paused: true, nowMs: T })).toBeNull();
  });

  it("THE SCREEN AND THE DOOR NOW SHARE ONE FUNCTION — neither may hold its own fallback", () => {
    const screen = code("lib", "admin", "rooms-live.ts");
    const door = code("lib", "mcp", "tools", "bench.ts");
    // The exact expression that was the bug, on either side.
    for (const src of [screen, door]) {
      expect(src).not.toMatch(/last_warehouse_at\s*\)?\s*\?\?\s*ms\(/);
      expect(src).not.toMatch(/lastWarehouse\s*\?\s*Date\.parse\(lastWarehouse\)\s*:\s*null/);
    }
    expect(screen).toMatch(/doctorClockSilentMs\(/);
    expect(door).toMatch(/doctorClockSilentMs\(/);
  });

  it("the banned phrases stay banned in the new shared module too", () => {
    // A comment that quotes the banned phrase in order to ban it is the opposite of the problem,
    // so comments are stripped first: this asserts what reaches the OPERATOR.
    const stripComments = (t: string) =>
      t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    void stripComments;
    for (const f of [["lib", "room-facts.ts"], ["lib", "admin", "room-reads.ts"]]) {
      const text = code(...f);
      expect(text).not.toMatch(/warehouse silent/i);
      expect(text).not.toMatch(/no warehouse event/i);
      expect(text).not.toMatch(/warehouse is (quiet|down|silent)/i);
    }
  });
});

// ===========================================================================
// §3.3 — stranded audio, in minutes, for each of the three reasons
// ===========================================================================

const raw = (over: Partial<StrandedRaw> = {}): StrandedRaw => ({ ...ZERO_STRANDED_RAW, ...over });
const SLOT = 15 * 60_000;

describe("§3.3 D7 — minutes that cannot currently be turned into words", () => {
  it("REASON 1 — waiting for someone to run it: finished slots with no job row at all", () => {
    // THE 24 AUGUST CASE, verified against production: Cardiology's bs_z3gpbh6e had 20 windows,
    // 17 of them `closed` with NO JOB ROW. The card said "17 waiting", which described a queue
    // that did not exist — nothing had ever been enqueued.
    const s = strandedAudio(raw({ closed_no_job_ms: 17 * SLOT, closed_no_job_n: 17 }), true);
    expect(s.waiting_ms).toBe(17 * SLOT);   // 4h 15m
    expect(s.total_ms).toBe(17 * SLOT);
    expect(s.reasons).toEqual([{ reason: STRANDED_WAITING, ms: 17 * SLOT, slots: 17 }]);
    expect(STRANDED_WAITING).toBe("waiting for someone to run it");
  });

  it("REASON 2 — cannot be processed, this room has no day record for today", () => {
    const s = strandedAudio(raw({ closed_no_job_no_day_ms: 4 * SLOT, closed_no_job_no_day_n: 4 }), false);
    expect(s.no_day_ms).toBe(4 * SLOT);
    expect(s.waiting_ms).toBe(0);
    expect(s.reasons[0]!.reason).toBe(STRANDED_NO_DAY);
    expect(STRANDED_NO_DAY).toBe("cannot be processed — this room has no day record for today");
  });

  it("REASON 3 — never closed: still open although the session that owns it ended", () => {
    const s = strandedAudio(raw({ open_after_end_ms: 3 * SLOT, open_after_end_n: 3 }), true);
    expect(s.never_closed_ms).toBe(3 * SLOT);
    expect(s.reasons).toEqual([{ reason: STRANDED_NEVER_CLOSED, ms: 3 * SLOT, slots: 3 }]);
    expect(STRANDED_NEVER_CLOSED).toBe("never closed — the recording did not cover the whole slot");
  });

  it("all three at once are DISJOINT — the reasons sum to the total, never double-count", () => {
    const s = strandedAudio(raw({
      closed_no_job_ms: 2 * SLOT, closed_no_job_n: 2,
      closed_no_job_no_day_ms: 3 * SLOT, closed_no_job_no_day_n: 3,
      open_after_end_ms: 1 * SLOT, open_after_end_n: 1,
      open_after_end_no_day_ms: 4 * SLOT, open_after_end_no_day_n: 4,
    }), false);
    expect(s.waiting_ms + s.no_day_ms + s.never_closed_ms).toBe(s.total_ms);
    expect(s.total_ms).toBe(10 * SLOT);
    expect(s.reasons.reduce((a, r) => a + r.ms, 0)).toBe(s.total_ms);
  });

  /**
   * THE FALSE-ALARM GUARD, and it is the same one the Transcript lane applies.
   *
   * A slot is bound to whatever day exists when it is WRITTEN, so on an ordinary morning the
   * first slot of the day is often written before Mark consult is pressed and binds on the very
   * next evaluation pass. Reporting "no day record" on room_day_id IS NULL alone would print
   * that sentence in every room every morning for one chunk cycle.
   */
  it("THE FALSE-ALARM GUARD: with a day present, unbound slots are NOT called 'no day record'", () => {
    const s = strandedAudio(raw({ closed_no_job_no_day_ms: 2 * SLOT, closed_no_job_no_day_n: 2 }), true);
    expect(s.no_day_ms).toBe(0);
    expect(s.waiting_ms).toBe(2 * SLOT);
    expect(s.reasons.map((r) => r.reason)).not.toContain(STRANDED_NO_DAY);
  });

  it("A FAILED READ IS NOT A 'NO' — null never invents the hardest reason", () => {
    // §5's first trap: a failed read must not silence a different alarm, and it must not raise
    // one either. Unknown reports the ordinary reason, which understates rather than invents.
    const s = strandedAudio(raw({ closed_no_job_no_day_ms: 2 * SLOT, closed_no_job_no_day_n: 2 }), null);
    expect(s.no_day_ms).toBe(0);
    expect(s.waiting_ms).toBe(2 * SLOT);
  });

  it("a healthy room reports nothing at all — no zero row, no empty box", () => {
    const s = strandedAudio(ZERO_STRANDED_RAW, true);
    expect(s.total_ms).toBe(0);
    expect(s.reasons).toEqual([]);
  });

  it("a slot already transcribed or in progress is not stranded", () => {
    // Nothing in the raw buckets can describe one: they are defined on state = 'closed' with no
    // job, and state = 'open' after the session ended. This is the guard against the figure
    // quietly becoming "all audio".
    expect(strandedAudio(ZERO_STRANDED_RAW, false).total_ms).toBe(0);
  });

  it("the day total merges the rooms' reasons rather than listing each room's separately", () => {
    const a = strandedAudio(raw({ closed_no_job_ms: 2 * SLOT, closed_no_job_n: 2 }), true);
    const b = strandedAudio(raw({ closed_no_job_ms: 3 * SLOT, closed_no_job_n: 3, open_after_end_ms: SLOT, open_after_end_n: 1 }), true);
    const day = strandedTotal([a, b]);
    expect(day.total_ms).toBe(6 * SLOT);
    expect(day.reasons).toHaveLength(2);
    expect(day.reasons.find((r) => r.reason === STRANDED_WAITING)!.slots).toBe(5);
  });

  it("SAYS THE TWO MEASURES DO NOT SUBTRACT, because one sums slots and the other sums pieces", () => {
    expect(STRANDED_MEASURE_NOTE).toMatch(/15-minute slots/);
    expect(STRANDED_MEASURE_NOTE).toMatch(/pieces themselves/);
    expect(STRANDED_MEASURE_NOTE).toMatch(/do not subtract/);
    const ui = readFileSync(join(process.cwd(), "components", "admin", "BenchRoomsLive.tsx"), "utf8");
    expect(ui).toMatch(/STRANDED_MEASURE_NOTE/);
  });
});

describe("§3.3 — the read behind it", () => {
  it("counts a window's job rows with EXISTS, never a join that could multiply the minutes", () => {
    // stt_subject_job has no unique constraint on (subject_type, subject_id) this code may
    // assume. A LEFT JOIN would multiply each slot's span by the number of job rows against it
    // and silently inflate every minute on the screen.
    appCalls.length = 0;
    appResponder = () => [];
    return readTranscriptAndStranded(["bs_1"]).then(() => {
      const q = appCalls.find((c) => /bench_window/.test(c.text))!;
      expect(q).toBeTruthy();
      expect(q.text).toMatch(/EXISTS \( SELECT 1 FROM stt_subject_job/);
      expect(q.text).not.toMatch(/LEFT JOIN stt_subject_job/);
      // spans come from the slot itself, per D7
      expect(q.text).toMatch(/SUM\(w\.end_ms - w\.start_ms\)/);
    });
  });

  it("FAILS LOCALLY: a broken read degrades itself and returns empty, never throws", async () => {
    appResponder = () => { throw new Error("boom"); };
    const r = await readTranscriptAndStranded(["bs_1"]);
    expect(r.value.size).toBe(0);
    expect(r.degraded).toMatch(/transcript_counts_unavailable/);
    appResponder = () => [];
  });

  it("is READ-ONLY — no statement it issues writes anything", async () => {
    appCalls.length = 0;
    appResponder = () => [];
    await readTranscriptAndStranded(["bs_1"]);
    for (const c of appCalls) expect(c.text).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i);
  });
});

// ===========================================================================
// §3.4 — nothing is trying, so nothing can be told to stop
// ===========================================================================

describe("§3.4 — the copy that described a worker that does not exist", () => {
  const C = (over: Partial<Parameters<typeof transcriptLane>[1]> = {}) =>
    ({ done: 0, waiting: 0, no_day: 0, in_progress: 0, failed: 0, words_ms: 0, ...over });

  it("a lane with finished slots and no worker reads 'waiting for someone to run it'", () => {
    expect(WAITING_PHRASE).toBe("waiting for someone to run it");
    const v = transcriptLane(true, C({ done: 3, waiting: 17 }), true);
    expect(v.state).toBe("3 done, 17 waiting for someone to run it");
    expect(v.level).toBe("amber");
  });

  it("never offers to stop something that is not running", () => {
    expect(code("components", "admin", "BenchRoomsLive.tsx")).not.toMatch(/stop trying/i);
  });

  it("the false backup-mic badge is gone from the sessions list, and NOT replaced", () => {
    // It read `primary_lost_count > 0`, a flag that does not clear, so a session that ran on its
    // MAIN microphone throughout was labelled "on backup mic · 40 chunks". Deciding which
    // microphone actually carried a session is Build 2; guessing here would put a second false
    // badge where the first one was.
    const rendered = code("components", "admin", "BenchClient.tsx");
    expect(rendered).not.toMatch(/on backup mic/);
    expect(rendered).not.toMatch(/backup used/);
    expect(rendered).not.toMatch(/no backup/);
    // The FLAG is still on the wire — the type keeps it, so Build 2 has it — and nothing reads it.
    expect(rendered).not.toMatch(/s\.mic_status/);
    expect(rendered).toMatch(/mic_status\?:/);
  });

  it("D32 — a room with one microphone says NOTHING about a spare", () => {
    const rendered = code("components", "admin", "BenchRoomsLive.tsx");
    // no amber vital, no attention row, no grey placeholder
    expect(rendered).not.toMatch(/reads no chunks/);
    // the field stays on the wire for Build 2; nothing on the card or in the list reads it
    expect(rendered).not.toMatch(/r\.backup_reads_no_chunks/);
    // and the spare is mentioned only where it has actually recorded something
    expect(rendered).toMatch(/backup_chunks_today > 0/);
  });
});

// ===========================================================================
// §3.6 — the screen and the door must agree
// ===========================================================================

describe("§3.6 — one shared source, and both surfaces call it", () => {
  const facts = code("lib", "room-facts.ts");
  const screen = code("lib", "admin", "rooms-live.ts");
  const door = code("lib", "mcp", "tools", "bench.ts");
  const reads = code("lib", "admin", "room-reads.ts");

  it("the shared module is PURE — a Postgres driver must never reach the browser", () => {
    // It is imported by the client component, so this is the same rule bench-bus-constants has.
    const imports = [...readFileSync(join(process.cwd(), "lib", "room-facts.ts"), "utf8").matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]!);
    expect(imports).toEqual(["@/lib/bench-bus-constants"]);
  });

  it("BOTH surfaces reach the lane words, the clock and the end-time checks through it", () => {
    for (const src of [screen, door]) {
      expect(src).toMatch(/from "@\/lib\/room-facts"/);
      expect(src).toMatch(/doctorClockSilentMs/);
      expect(src).toMatch(/strandedAudio/);
    }
    expect(door).toMatch(/transcriptLane/);
    expect(door).toMatch(/visitsLane/);
    expect(door).toMatch(/tapeLane/);
  });

  it("BOTH surfaces run the same query, from lib/admin/room-reads.ts", () => {
    for (const src of [screen, door]) expect(src).toMatch(/from "@\/lib\/admin\/room-reads"/);
    expect(screen).toMatch(/readTranscriptAndStranded\(/);
    expect(door).toMatch(/readTranscriptAndStranded\(/);
    // and the query itself is written once
    expect(reads).toMatch(/FROM bench_window bw/);
    expect(screen).not.toMatch(/FROM bench_window/);
    expect(door.slice(door.indexOf("liveMonitorExtras"))).not.toMatch(/FROM bench_window/);
  });

  it("DIVERGENCE 1 — the end-time checks: both surfaces now have BOTH", () => {
    // The screen had ended_disagrees (the tape running on after the row said stop); the door had
    // only its mirror image, ended_at_lies (the row claiming to have run on after the tape
    // stopped). Neither had both, so an operator and a watcher looking at one room saw two
    // different faults.
    for (const src of [screen, door]) {
      expect(src).toMatch(/ended_at_lies/);
      expect(src).toMatch(/ended_disagrees/);
    }
  });

  it("DIVERGENCE 2 — the door reports the two processing switches", () => {
    // Without them an automated watcher cannot warn that a room is recording into nothing.
    const extras = door.slice(door.indexOf("async function liveMonitorExtras"), door.indexOf("const diffRoom"));
    expect(extras).toMatch(/transcript_enabled: sw\.value\.transcript_enabled/);
    expect(extras).toMatch(/visits_enabled: sw\.value\.visits_enabled/);
  });

  it("the switches read UNKNOWN on a failed read, never false — 'off' is a claim", () => {
    expect(reads).toMatch(/transcript_enabled: null, visits_enabled: null/);
    // and it must not be the recording path's cached, fail-closed reader
    const extras = door.slice(door.indexOf("async function liveMonitorExtras"));
    expect(extras).not.toMatch(/readRoomSwitches/);
  });

  it("DIVERGENCE 3 — the doctor-clock fallback is gone from BOTH (also asserted in §3.1)", () => {
    for (const src of [screen, door]) expect(src).toMatch(/doctorClockSilentMs\(\{/);
  });

  it("the two surfaces answer with the SAME WORDS for the same room", () => {
    // The lane the card renders and the lane the door reports are one function call.
    const counts = { done: 3, waiting: 17, no_day: 0, in_progress: 0, failed: 0, words_ms: 0 };
    const lane = transcriptLane(true, counts, true);
    expect(lane.state).toBe("3 done, 17 waiting for someone to run it");
    expect(screen).toMatch(/transcriptLane/);
    expect(door).toMatch(/transcriptLane\(/);
  });

  it("endedAtLies is ONE rule with ONE window, not two hand-copied ones", () => {
    const TEN = 10 * 60_000;
    expect(endedAtLies(T, T - TEN - 1, TEN)).toBe(true);
    expect(endedAtLies(T, T - TEN, TEN)).toBe(false);
    // an unknown on either side is never a fault
    expect(endedAtLies(null, T, TEN)).toBe(false);
    expect(endedAtLies(T, null, TEN)).toBe(false);
    expect(facts).toMatch(/export function endedAtLies/);
  });

  it("THE ORDINARY DAY: neither end-time check fires on a normal end of day", () => {
    // The kiosk marks a session ended as soon as the recorder stops and only then finishes
    // uploading its flush, so ended_at lands a second or two AFTER the last capture and a chunk
    // ROW is created after it. Neither of those is a fault, and the first version of this alarm
    // fired on every one of them.
    const lastPiece = T - 2_000;
    expect(endedAtLies(T, lastPiece, 10 * 60_000)).toBe(false);
    const r = buildRoomLive(
      ROOM,
      [session({ status: "ended", ended_at: new Date(T).toISOString(), last_primary_at: new Date(lastPiece).toISOString(), chunks_after_end: 0 })],
      NO_COUNTS, NO_BRAIN, 0, T, [],
    );
    expect(r.ended_at_lies).toBe(false);
    expect(r.ended_disagrees).toBe(false);
    // …and the room reads as what it is
    expect(r.last_session_ended).toBe(true);
  });

  it("the screen DOES raise the mirror image when the stored end really is later", () => {
    const r = buildRoomLive(
      ROOM,
      [session({ status: "ended", ended_at: new Date(T).toISOString(), last_primary_at: new Date(T - 3 * 3_600_000).toISOString() })],
      NO_COUNTS, NO_BRAIN, 0, T, [],
    );
    expect(r.ended_at_lies).toBe(true);
    expect(r.ended_at_lies_sessions).toEqual(["bs_1"]);
  });
});

// ===========================================================================
// §4 — the do-not-touch list, asserted rather than promised
// ===========================================================================

describe("§4 — what this build was not allowed to change", () => {
  it("nothing in the build touches recording, uploading or storing audio", () => {
    // The one rule for this build. Asserted on the shared modules it introduced, which are the
    // only new code that could have reached the audio path.
    for (const f of [["lib", "room-facts.ts"], ["lib", "admin", "room-reads.ts"]]) {
      expect(code(...f)).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/);
    }
  });

  it("the mic thresholds are untouched — size is Build 2", () => {
    const facts = code("lib", "room-facts.ts");
    expect(facts).toMatch(/MIC_AMBER_MS = 7 \* 60_000/);
    expect(facts).toMatch(/MIC_RED_MS = 10 \* 60_000/);
  });

  it("the end-time alarm still compares CAPTURE times, not arrival times", () => {
    const src = readFileSync(join(process.cwd(), "lib", "admin", "rooms-live.ts"), "utf8");
    // c.started_at is the capture clock; c.created_at is the upload clock. The first version of
    // this alarm used the second and fired on every ordinary end of day.
    expect(src).toMatch(/c\.started_at > s\.ended_at \+ make_interval/);
  });

  it("the vocabulary holds — the interface never says drain, fuse, subject, window or cue", () => {
    const stripComments = (t: string) =>
      t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    // Only the strings an operator reads: the copy constants, not the field names behind them.
    for (const s of [STRANDED_WAITING, STRANDED_NO_DAY, STRANDED_NEVER_CLOSED, STRANDED_MEASURE_NOTE, WAITING_PHRASE, FINISHED_HINT]) {
      expect(s).not.toMatch(/\b(drain|fuse|subject|window|cue|bench_|stt_)\b/i);
    }
    void stripComments;
  });

  it("green still means working — a finished day is not green", () => {
    const ui = code("components", "admin", "BenchRoomsLive.tsx");
    // Grey, from shades the palette actually defines.
    expect(ui).toMatch(/FINISHED_PILL = "bg-even-ink-100 text-even-ink-600"/);
  });
});
