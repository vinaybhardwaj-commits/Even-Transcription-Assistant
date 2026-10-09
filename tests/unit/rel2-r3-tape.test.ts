/**
 * REL2-R3 B3 — the tape tools (scribe_get_session, scribe_get_recording, scribe_extract_audio, scribe_transcribe_range) and the stitch / transcribe_range jobs refuse a held-out (room, IST date)
 * BEFORE any chunk list, presign or R2 read. sql, R2 and Whisper are spies.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const stmts: string[] = [];
const r2 = { presign: 0, get: 0 };
const guard = { row: null as Row | null };
const SESSION: Row = { id: "bs_a", room_id: "", label: null, mic_label: null, started_at: "", ended_at: null, status: "ended", notes: null, room_slug: "x", room_name: "X" };
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray) => { const t = s.join("?").replace(/\s+/g, " "); stmts.push(t);
  if (/FROM bench_session s WHERE s\.id/.test(t)) return Promise.resolve(guard.row ? [guard.row] : []);
  if (/FROM bench_session s JOIN room r/.test(t)) return Promise.resolve([SESSION]);
  return Promise.resolve([]); } }));
vi.mock("@/lib/r2", () => ({ signGetUrl: async () => { r2.presign++; return "u"; }, getObjectBytes: async () => { r2.get++; return new Uint8Array([1]); } }));
vi.mock("@/lib/whisper", () => ({ transcribeWithWhisper: async () => { r2.get++; return { ok: true, transcript: "t", language: "en", duration_seconds: 1, latency_ms: 1 }; } }));
vi.mock("@/lib/bench-timeline", () => ({ renderBenchTimeline: async () => { r2.get++; return { markdown: "" }; } }));
vi.mock("@/lib/brain/db", () => ({ TOKEN_ENV: "T", getPool: () => ({}), query: async () => ({ rows: [] }) }));
vi.mock("@/lib/brain/state", () => ({ CUES_DEFAULT_LIMIT: 50, CUES_MAX_LIMIT: 200, findRoomDay: async () => null, isIstDateString: (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s), istDate: () => "2026-08-19", listCuesForDay: async () => ({ cues: [] }), readGraph: async () => ({}), roomExists: async () => true, WINDOW_CUE_TYPE: "stt_window" }));

const { BLIND_ROOM_DAYS } = await import("@/lib/rubrics/blind-room-days");
const { BENCH_TOOLS } = await import("@/lib/mcp/tools/bench");
const { spanTouchesBlindDay } = await import("@/lib/room-access/check");
const { stitchKind } = await import("@/lib/jobs/kinds/stitch");
const { transcribeRangeKind } = await import("@/lib/jobs/kinds/transcribe-range");
const [BD, BR] = BLIND_ROOM_DAYS[0]!;
const dayStart = Date.parse(`${BD}T00:00:00+05:30`);
const tool = (n: string) => BENCH_TOOLS.find((t) => t.name === n)!;
const ctx = { origin: "x", actor: "a", scopes: new Set(["read", "invoke"]) } as never;
const GUARD = (o: Partial<Row> = {}): Row => ({ room_id: BR, started_ms: dayStart + 3_600_000, last_ms: dayStart + 7_200_000, window_blind: false, ...o });
const reads = () => stmts.filter((t) => /FROM bench_chunk|FROM bench_event|FROM bench_consult/.test(t) && !/FROM bench_session s WHERE s\.id/.test(t));

beforeEach(() => { stmts.length = 0; r2.presign = 0; r2.get = 0; guard.row = GUARD(); Object.assign(SESSION, { room_id: BR, started_at: new Date(dayStart + 3_600_000).toISOString() }); });

describe("the tools: a held-out session / range is blind_room_day with 0 R2 reads", () => {
  it("scribe_get_session and scribe_get_recording (every mode)", async () => {
    expect(await tool("scribe_get_session").handler({ session_id: "bs_a" }, ctx)).toMatchObject({ session: null, error: "blind_room_day" });
    for (const mode of ["manifest", "timeline", "chunk", "zip"]) expect(await tool("scribe_get_recording").handler({ session_id: "bs_a", mode, chunk_idx: 0 }, ctx), mode).toMatchObject({ error: "blind_room_day" });
    expect(r2).toEqual({ presign: 0, get: 0 });
    expect(reads()).toEqual([]);
  });
  it("scribe_extract_audio and scribe_transcribe_range: the session's day; a clean session whose RANGE crosses midnight into it (forward) and back out of the next day into it; a window-only placement", async () => {
    const day = new Date(dayStart).toISOString();
    for (const name of ["scribe_extract_audio", "scribe_transcribe_range"]) {
      const run = (a: Row) => tool(name).handler({ session_id: "bs_a", dry_run: false, ...a }, ctx);
      expect(await run({ start: new Date(dayStart + 3_600_000).toISOString(), end: new Date(dayStart + 4_000_000).toISOString() }), name).toMatchObject({ ok: false, error: "blind_room_day" });
      guard.row = GUARD({ started_ms: dayStart - 86_400_000, last_ms: dayStart - 86_400_000 + 3_600_000 }); // a session of the day BEFORE, a range into the held-out day
      expect(await run({ start: new Date(dayStart - 600_000).toISOString(), end: new Date(dayStart + 600_000).toISOString() }), `${name} forward`).toMatchObject({ error: "blind_room_day" });
      guard.row = GUARD({ started_ms: dayStart + 86_400_000 + 600_000, last_ms: dayStart + 86_400_000 + 1_800_000 }); // a session of the day AFTER, a range reaching back into it
      expect(await run({ start: new Date(dayStart + 86_400_000 - 600_000).toISOString(), end: new Date(dayStart + 86_400_000 + 600_000).toISOString() }), `${name} back`).toMatchObject({ error: "blind_room_day" });
      guard.row = GUARD({ room_id: "r_clean", window_blind: true, started_ms: Date.parse("2026-08-19T05:00:00Z"), last_ms: Date.parse("2026-08-19T06:00:00Z") });
      expect(await run({ start: "2026-08-19T05:10:00Z", end: "2026-08-19T05:20:00Z" }), `${name} window`).toMatchObject({ error: "blind_room_day" });
      expect(day).toBeTruthy();
    }
    expect(r2).toEqual({ presign: 0, get: 0 });
    expect(reads()).toEqual([]);
  });
  it("a clean session and range is NOT refused by the guard (it proceeds to the chunk list)", async () => {
    guard.row = GUARD({ room_id: "r_clean", started_ms: Date.parse("2026-08-19T05:00:00Z"), last_ms: Date.parse("2026-08-19T06:00:00Z") });
    Object.assign(SESSION, { room_id: "r_clean", started_at: "2026-08-19T05:00:00Z" });
    const out = await tool("scribe_extract_audio").handler({ session_id: "bs_a", start: "2026-08-19T05:10:00Z", end: "2026-08-19T05:20:00Z" }, ctx) as Row;
    expect(out.error).not.toBe("blind_room_day");
    expect(reads().length).toBeGreaterThan(0);
  });
});

describe("the jobs: the same rule at the first step (so async:true and a direct submit are covered)", () => {
  const step = (kind: { run: (c: never) => Promise<unknown> }, args: Row) => kind.run({ job: { id: "j" }, step: "resolve", args, progress: {}, runner: "r" } as never);
  it("stitch and transcribe_range fail blind_room_day with no chunk read", async () => {
    const args = { session_id: "bs_a", start: dayStart + 3_600_000, end: dayStart + 4_000_000, source: "primary", format: "webm" };
    for (const k of [stitchKind, transcribeRangeKind]) expect(JSON.stringify(await step(k as never, args)), k.name).toContain("blind_room_day");
    expect(reads()).toEqual([]);
  });
});

describe("spanTouchesBlindDay (pure)", () => {
  it("the day itself, either midnight edge, a span covering it; not the neighbours, not another room", () => {
    const e = dayStart + 86_400_000;
    expect(spanTouchesBlindDay(BR, dayStart, dayStart)).toBe(true);
    expect(spanTouchesBlindDay(BR, e - 1, e - 1)).toBe(true);
    expect(spanTouchesBlindDay(BR, dayStart - 5, dayStart + 5)).toBe(true);
    expect(spanTouchesBlindDay(BR, e - 5, e + 5)).toBe(true);
    expect(spanTouchesBlindDay(BR, dayStart - 10, dayStart - 1)).toBe(false);
    expect(spanTouchesBlindDay(BR, e, e + 10)).toBe(false);
    expect(spanTouchesBlindDay("r_other", dayStart, e)).toBe(false);
    expect(spanTouchesBlindDay(BR, e + 5, dayStart - 5)).toBe(true); // order of the ends does not matter
  });
});
