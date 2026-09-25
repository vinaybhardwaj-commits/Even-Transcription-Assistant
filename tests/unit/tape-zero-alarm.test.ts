/**
 * DRAFT (Fable ruling 255b / 343 / 345) — the tape-level exact-zero alarm's rules, pinned. The module is inert (nothing calls it), so these tests are the whole behaviour.
 * Pure rules first; then the SQL against a REAL postgres, because "the join to the session", "the window is [since, until)" and "a NULL size is returned, not dropped" are properties of the query.
 * The numbers come from the measurement in scribe #2143/#2147: exact-zero chunks are ONE size, 212,378 bytes per 300 s = 707.93 B/s; the next class starts at 711.06; an empty room reads 892+.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>) }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v) }));

import {
  CONSECUTIVE_TRIGGER, MEASURED_CONTENT_TYPE, MIN_FULL_CHUNK_MS, RENOTICE_AFTER_MS, STALE_CHUNK_MS, ZERO_CHUNK_BPS, ZERO_CHUNK_SIZE_BYTES, ZERO_CHUNK_TOLERANCE_BPS,
  chunkBps, deviceClass, findZeroRuns, isExactZeroChunk, isFullChunk, isJudgeableChunk, readTapeChunks, renoticeDue, tapeZeroMessage, unknownRooms, type TapeChunk,
} from "@/lib/tape-zero-alarm";

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-tape-zero-alarm");

describe("REQUIRED PROOF — the tape-zero alarm's query runs against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/tape-zero-alarm.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

const FULL = 300_000;
const ZERO_SIZE = 212_378;              // 300 s at 707.93 B/s
const HEALTHY_SIZE = 1_000_000;         // about 3,333 B/s
const EMPTY_ROOM_SIZE = 300_000;        // 1,000 B/s: an empty closed room, above the silence size

describe("the definitions", () => {
  it("the constants are the measured ones", () => {
    expect(ZERO_CHUNK_BPS).toBe(707.93);
    expect(ZERO_CHUNK_SIZE_BYTES).toBe(212_378);
    expect(MEASURED_CONTENT_TYPE).toBe("audio/webm");
    expect(ZERO_CHUNK_TOLERANCE_BPS).toBe(1);
    expect(MIN_FULL_CHUNK_MS).toBe(299_000);
    expect(CONSECUTIVE_TRIGGER).toBe(2);
    expect(STALE_CHUNK_MS).toBe(15 * 60_000);
    expect(RENOTICE_AFTER_MS).toBe(3 * 3_600_000);
  });

  it("bytes per second is size*1000/duration, and null for anything unusable", () => {
    expect(chunkBps({ size_bytes: ZERO_SIZE, duration_ms: FULL })).toBeCloseTo(707.9267, 3);
    for (const bad of [{ size_bytes: null, duration_ms: FULL }, { size_bytes: -1, duration_ms: FULL }, { size_bytes: 10, duration_ms: 0 }, { size_bytes: NaN, duration_ms: FULL }, { size_bytes: 10, duration_ms: NaN }]) {
      expect(chunkBps(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("FULL means at least 299 s: 298.999 s is not, 299 s is", () => {
    expect(isFullChunk({ duration_ms: 298_999 })).toBe(false);
    expect(isFullChunk({ duration_ms: 299_000 })).toBe(true);
    expect(isFullChunk({ duration_ms: NaN })).toBe(false);
  });

  it("exact zero is a spike at 707.93, not a band: 706.93 and 708.93 are in, the next class (711.06) and an empty room (1,000) are out", () => {
    const at = (bps: number) => isExactZeroChunk({ size_bytes: Math.round((bps * FULL) / 1000), duration_ms: FULL });
    expect(at(707.93)).toBe(true);
    expect(at(707.0)).toBe(true);
    expect(at(708.9)).toBe(true);
    expect(at(706.5)).toBe(false);
    expect(at(709.5)).toBe(false);
    expect(at(711.06)).toBe(false);
    expect(at(892)).toBe(false);
    expect(isExactZeroChunk({ size_bytes: EMPTY_ROOM_SIZE, duration_ms: FULL })).toBe(false);
    expect(isExactZeroChunk({ size_bytes: HEALTHY_SIZE, duration_ms: FULL })).toBe(false);
  });

  it("a SHORT chunk or an unknown size is never exact zero, even at the silence rate", () => {
    expect(isExactZeroChunk({ size_bytes: Math.round(707.93 * 100), duration_ms: 100_000 })).toBe(false);
    expect(isExactZeroChunk({ size_bytes: null, duration_ms: FULL })).toBe(false);
  });
});

describe("the encoder is NOT pinned (eta-refuter #2148): the baseline applies only to the container it was measured on", () => {
  const zero = { size_bytes: ZERO_SIZE, duration_ms: FULL };
  it("a chunk in another container, or with no content type, is never exact zero; audio/webm (with parameters, any case) is", () => {
    expect(isExactZeroChunk({ ...zero, content_type: "audio/webm" })).toBe(true);
    expect(isExactZeroChunk({ ...zero, content_type: "Audio/WebM; codecs=opus" })).toBe(true);
    expect(isExactZeroChunk({ ...zero, content_type: "audio/ogg" })).toBe(false);
    expect(isExactZeroChunk({ ...zero, content_type: "audio/mp4" })).toBe(false);
    expect(isExactZeroChunk({ ...zero, content_type: null })).toBe(false);
    expect(isExactZeroChunk(zero)).toBe(true);                                // the caller did not say: judged as before
  });
  it("only a judgeable chunk can be evidence of recovery or of the newest state", () => {
    expect(isJudgeableChunk({ duration_ms: FULL, content_type: "audio/webm" })).toBe(true);
    expect(isJudgeableChunk({ duration_ms: FULL, content_type: "audio/ogg" })).toBe(false);
    expect(isJudgeableChunk({ duration_ms: 1000, content_type: "audio/webm" })).toBe(false);
  });
});

describe("deviceClass and the wording by device (eta-refuter #2148)", () => {
  it("a TONOR TM20 is tm20, another named device is other, nothing is unknown", () => {
    expect(deviceClass("TONOR TM20 Audio Device")).toBe("tm20");
    expect(deviceClass("tonor tm20")).toBe("tm20");
    expect(deviceClass("C270 HD WEBCAM")).toBe("other");
    expect(deviceClass("Microsoft Teams Audio")).toBe("other");
    expect(deviceClass(null)).toBe("unknown");
    expect(deviceClass("   ")).toBe("unknown");
    expect(deviceClass(undefined)).toBe("unknown");
  });
});

const T0 = Date.parse("2026-09-25T04:30:00Z");
let seq = 0;
const chunk = (room: string, session: string, idx: number, size: number | null, o: { source?: string; duration_ms?: number; content_type?: string | null } = {}): TapeChunk => {
  const duration_ms = o.duration_ms ?? FULL;
  return { room_id: room, session_id: session, idx, source: o.source ?? "primary", started_at_ms: T0 + idx * FULL, ended_at_ms: T0 + idx * FULL + duration_ms, duration_ms, size_bytes: size, content_type: o.content_type === undefined ? "audio/webm" : o.content_type };
};
const seqChunks = (room: string, session: string, sizes: Array<number | null>, o: { source?: string } = {}) => sizes.map((s, i) => chunk(room, session, i, s, o));
const Z = ZERO_SIZE, G = HEALTHY_SIZE;

describe("findZeroRuns — consecutive exact chunks in one session", () => {
  it("one run: two or more consecutive exact chunks; a single exact chunk is not alarming at the default trigger but is at trigger 1", () => {
    const cs = seqChunks("a", "s1", [G, Z, Z, Z, G, G]);
    const [r] = findZeroRuns(cs);
    expect(r).toMatchObject({ room_id: "a", session_id: "s1", source: "primary", start_idx: 1, end_idx: 3, length: 3, start_ms: T0 + FULL, end_ms: T0 + 4 * FULL, open: false });
    expect(r!.recovered_at_ms).toBe(T0 + 4 * FULL);                   // the first good full chunk after it
    expect(findZeroRuns(seqChunks("a", "s1", [G, Z, G]))).toEqual([]);
    expect(findZeroRuns(seqChunks("a", "s1", [G, Z, G]), 1)).toHaveLength(1);
  });

  it("OPEN while the run includes the newest full chunk of its session; not recovered", () => {
    const [r] = findZeroRuns(seqChunks("a", "s1", [G, Z, Z]));
    expect(r).toMatchObject({ open: true, recovered_at_ms: null, length: 2 });
  });

  it("a trailing SHORT chunk does not make an open run look closed, and does not count as recovery", () => {
    const cs = [...seqChunks("a", "s1", [G, Z, Z]), chunk("a", "s1", 3, 100_000, { duration_ms: 60_000 })];
    const [r] = findZeroRuns(cs);
    expect(r).toMatchObject({ open: true, recovered_at_ms: null });
  });

  it("a MISSING index ends the run (two exact chunks with a hole between are two singletons, not a run)", () => {
    const cs = [chunk("a", "s1", 0, Z), chunk("a", "s1", 2, Z)];
    expect(findZeroRuns(cs)).toEqual([]);
    expect(findZeroRuns(cs, 1)).toHaveLength(2);
  });

  it("a SHORT chunk in the middle ends the run; an empty-room chunk (1,000 B/s) ends it too", () => {
    const withShort = [chunk("a", "s1", 0, Z), chunk("a", "s1", 1, Z, { duration_ms: 120_000 }), chunk("a", "s1", 2, Z)];
    expect(findZeroRuns(withShort)).toEqual([]);
    expect(findZeroRuns(seqChunks("a", "s1", [Z, EMPTY_ROOM_SIZE, Z]))).toEqual([]);
  });

  it("sessions and SOURCES are separate: a zero backup mic beside a healthy primary is its own run, and two sessions never join", () => {
    const cs = [...seqChunks("a", "s1", [G, G, G]), ...seqChunks("a", "s1", [Z, Z, Z], { source: "backup" }), ...seqChunks("a", "s2", [Z]), ...seqChunks("a", "s3", [Z])];
    const runs = findZeroRuns(cs);
    expect(runs.map((r) => [r.session_id, r.source, r.length])).toEqual([["s1", "backup", 3]]);
  });

  it("input order does not matter, and a duplicate (session, source, idx) collapses to the first", () => {
    const cs = seqChunks("a", "s1", [G, Z, Z, G]);
    const shuffled = [cs[3]!, cs[1]!, cs[0]!, cs[2]!, { ...cs[1]!, size_bytes: G }];
    expect(findZeroRuns(shuffled)).toEqual(findZeroRuns(cs));
  });

  it("a chunk in another container ends a run and is NOT evidence of recovery: only a judgeable good chunk recovers it", () => {
    const cs = [chunk("a", "s1", 0, Z), chunk("a", "s1", 1, Z), chunk("a", "s1", 2, G, { content_type: "audio/ogg" })];
    const [r] = findZeroRuns(cs);
    expect(r).toMatchObject({ length: 2, recovered_at_ms: null, open: true });     // the ogg chunk is neither exact nor a recovery, and is not the newest judgeable chunk
    const cs2 = [...cs, chunk("a", "s1", 3, G)];
    expect(findZeroRuns(cs2)[0]).toMatchObject({ open: false, recovered_at_ms: T0 + 3 * FULL });
  });

  it("an unknown size (NULL) is not exact zero and ends a run", () => {
    expect(findZeroRuns(seqChunks("a", "s1", [Z, null, Z]))).toEqual([]);
  });
});

describe("renoticeDue, unknownRooms and the message", () => {
  it("an OPEN run is re-announced only after 3 h; a recovered or closed one never", () => {
    const open = { open: true, recovered_at_ms: null };
    expect(renoticeDue(open, 0, 3 * 3_600_000 - 1)).toBe(false);
    expect(renoticeDue(open, 0, 3 * 3_600_000)).toBe(true);
    expect(renoticeDue({ open: true, recovered_at_ms: 5 }, 0, 10 * 3_600_000)).toBe(false);
    expect(renoticeDue({ open: false, recovered_at_ms: null }, 0, 10 * 3_600_000)).toBe(false);
  });

  it("a room whose newest chunk is older than 15 minutes, or that has none, is UNKNOWN: never green", () => {
    const now = T0 + 10 * FULL;
    const cs = [{ room_id: "fresh", ended_at_ms: now - STALE_CHUNK_MS }, { room_id: "stale", ended_at_ms: now - STALE_CHUNK_MS - 1 }, { room_id: "stale", ended_at_ms: now - 4 * STALE_CHUNK_MS }];
    expect(unknownRooms(["fresh", "stale", "none", "none"], cs, now)).toEqual(["none", "stale"]);
    expect(unknownRooms(["fresh"], cs, now)).toEqual([]);
  });

  it("the message says exact digital silence on the tape, gives counts and an IST time, and never names a cause", () => {
    const run = { length: 6, start_ms: Date.parse("2026-09-25T04:30:00Z"), end_ms: Date.parse("2026-09-25T05:00:00Z"), open: true, recovered_at_ms: null };
    const m = tapeZeroMessage("OPD 4", run);
    const all = `${m.subject}\n${m.text}`;
    expect(all).toContain("exact digital silence");
    expect(all).toContain("6 consecutive");
    expect(all).toContain("30 minutes");
    expect(all).toContain("2026-09-25 10:00 IST");
    expect(all).toContain("still going");
    expect(all).toContain("does not say why");
    expect(all).not.toMatch(/hardware-mute|TM20/i);                     // the default text names no cause; the device sentences are asserted below
    expect(tapeZeroMessage("OPD 4", { ...run, open: false, recovered_at_ms: Date.parse("2026-09-25T05:05:00Z") }).text).toContain("It recovered at 2026-09-25 10:35 IST.");
    // by device class (eta-refuter #2148): a TM20 hit is likely a deliberate mute; a device with no mute button is not
    expect(tapeZeroMessage("OPD 3", run, "tm20").text).toContain("hardware mute; a mute is likely deliberate");
    expect(tapeZeroMessage("OPD 4", run, "other").text).toContain("This input has no mute button: investigate.");
    expect(tapeZeroMessage("OPD 4", run, "unknown").text).toContain("a hardware mute cannot be ruled in or out");
    expect(tapeZeroMessage("OPD 4", run).text).toContain("a hardware mute cannot be ruled in or out");       // default: unknown
    expect(tapeZeroMessage("OPD 4", run, "other").text).not.toContain("likely deliberate");
  });
});

const insertSession = (id: string, room: string) => pg.exec(`INSERT INTO bench_session (id, room_id) VALUES ('${id}', '${room}') ON CONFLICT DO NOTHING;`);
const insertChunk = (session: string, idx: number, size: number | null, o: { source?: string | null; dur?: number; start?: string; ct?: string } = {}) => {
  const dur = o.dur ?? FULL;
  const start = o.start ?? new Date(T0 + idx * FULL).toISOString();
  const src = o.source === null ? "NULL" : `'${o.source ?? "primary"}'`;
  pg.exec(`INSERT INTO bench_chunk (id, session_id, idx, source, r2_key, content_type, started_at, ended_at, duration_ms, size_bytes)
           VALUES ('bc_${session}_${idx}_${o.source ?? "p"}_${++seq}', '${session}', ${idx}, ${src}, 'k', '${o.ct ?? "audio/webm"}', '${start}'::timestamptz, ('${start}'::timestamptz) + interval '${dur} milliseconds', ${dur}, ${size === null ? "NULL" : size});`);
};

beforeAll(() => {
  if (!HAVE_DOCKER) return;
  pg.start();
  pg.exec(`CREATE TABLE bench_session (id text PRIMARY KEY, room_id text NOT NULL);
           CREATE TABLE bench_chunk (id text PRIMARY KEY, session_id text NOT NULL REFERENCES bench_session(id), idx integer NOT NULL, source text, r2_key text NOT NULL, content_type text NOT NULL,
             started_at timestamptz NOT NULL, ended_at timestamptz NOT NULL, duration_ms integer NOT NULL, size_bytes bigint);`);
  H.sql = pg.sql;
}, 240_000);
afterAll(() => { if (HAVE_DOCKER) pg.stop(); });
beforeEach(() => { if (HAVE_DOCKER) pg.exec("TRUNCATE bench_chunk, bench_session CASCADE;"); });

const read = (o: { roomId?: string; sinceMs?: number; untilMs?: number } = {}) =>
  readTapeChunks({ roomId: o.roomId, sinceMs: o.sinceMs ?? Date.parse("2026-09-24T00:00:00Z"), untilMs: o.untilMs ?? Date.parse("2026-09-26T00:00:00Z") });

describe.runIf(HAVE_DOCKER)("readTapeChunks — against a real postgres", () => {
  it("joins the chunk to its session's room, orders by room, session, source and idx, and feeds findZeroRuns", async () => {
    insertSession("s_b", "room_b"); insertSession("s_a", "room_a");
    insertChunk("s_a", 1, ZERO_SIZE); insertChunk("s_a", 0, ZERO_SIZE); insertChunk("s_a", 2, HEALTHY_SIZE);
    insertChunk("s_b", 0, HEALTHY_SIZE);
    const rows = await read();
    expect(rows.map((r) => [r.room_id, r.session_id, r.idx])).toEqual([["room_a", "s_a", 0], ["room_a", "s_a", 1], ["room_a", "s_a", 2], ["room_b", "s_b", 0]]);
    const [run] = findZeroRuns(rows);
    expect(run).toMatchObject({ room_id: "room_a", session_id: "s_a", length: 2, start_idx: 0, end_idx: 1, open: false });
    expect(run!.recovered_at_ms).toBe(T0 + 2 * FULL);
  });

  it("a NULL size is RETURNED as null (never dropped, never exact); a NULL source reads as primary; sizes and times come back as numbers", async () => {
    insertSession("s_a", "room_a");
    insertChunk("s_a", 0, null, { source: null });
    insertChunk("s_a", 1, ZERO_SIZE, { source: null });
    const [a, b] = await read();
    expect(a).toMatchObject({ size_bytes: null, source: "primary", idx: 0, duration_ms: FULL });
    expect(typeof b!.size_bytes).toBe("number");
    expect(b!.started_at_ms).toBe(T0 + FULL);
    expect(b!.ended_at_ms).toBe(T0 + 2 * FULL);
    expect(b!.content_type).toBe("audio/webm");                          // the reader carries the container, so the rule can refuse a foreign one
  });

  it("roomId narrows, the window is [since, until) on the chunk's START, and a room with nothing returns no row", async () => {
    insertSession("s_a", "room_a"); insertSession("s_b", "room_b");
    for (let i = 0; i < 4; i++) { insertChunk("s_a", i, ZERO_SIZE); insertChunk("s_b", i, HEALTHY_SIZE); }
    expect((await read({ roomId: "room_b" })).every((r) => r.room_id === "room_b")).toBe(true);
    expect(await read({ roomId: "room_none" })).toEqual([]);
    const until = T0 + 2 * FULL;                                       // exclusive: idx 0 and 1 only
    expect((await read({ roomId: "room_a", untilMs: until })).map((r) => r.idx)).toEqual([0, 1]);
    expect((await read({ roomId: "room_a", sinceMs: T0 + 3 * FULL })).map((r) => r.idx)).toEqual([3]);
  });

  it("READ-ONLY: it changes nothing", async () => {
    insertSession("s_a", "room_a"); insertChunk("s_a", 0, ZERO_SIZE);
    const count = async () => ((await pg.sql`SELECT count(*)::int AS n FROM bench_chunk`) as Array<{ n: number }>)[0]!.n;
    const before = await count();
    await read();
    await read({ roomId: "room_a" });
    expect(await count()).toBe(before);
  });
});
