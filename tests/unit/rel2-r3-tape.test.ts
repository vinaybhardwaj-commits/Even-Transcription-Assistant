/**
 * (10 Oct 2026: the held-out rule is LIFTED. The former pair is an ordinary day: the tools and jobs SERVE / PROCESS it and spanTouchesBlindDay is always false.)
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

const { FORMER_BLIND_PAIRS } = await import("../support/former-blind-pairs");
const { BENCH_TOOLS } = await import("@/lib/mcp/tools/bench");
const { spanTouchesBlindDay } = await import("@/lib/room-access/check");
const { stitchKind } = await import("@/lib/jobs/kinds/stitch");
const { transcribeRangeKind } = await import("@/lib/jobs/kinds/transcribe-range");
const [BD, BR] = FORMER_BLIND_PAIRS[0]!;
const dayStart = Date.parse(`${BD}T00:00:00+05:30`);
const tool = (n: string) => BENCH_TOOLS.find((t) => t.name === n)!;
const ctx = { origin: "x", actor: "a", scopes: new Set(["read", "invoke"]) } as never;
const GUARD = (o: Partial<Row> = {}): Row => ({ room_id: BR, started_ms: dayStart + 3_600_000, last_ms: dayStart + 7_200_000, window_blind: false, ...o });
const reads = () => stmts.filter((t) => /FROM bench_chunk|FROM bench_event|FROM bench_consult/.test(t) && !/FROM bench_session s WHERE s\.id/.test(t));

beforeEach(() => { stmts.length = 0; r2.presign = 0; r2.get = 0; guard.row = GUARD(); Object.assign(SESSION, { room_id: BR, started_at: new Date(dayStart + 3_600_000).toISOString() }); });

describe("the tools: a session / range on a formerly held-out day is served like any clean one", () => {
  it("scribe_get_session and scribe_get_recording (every mode) are not refused: the session is returned and the chunk list is read", async () => {
    const got = await tool("scribe_get_session").handler({ session_id: "bs_a" }, ctx) as Row;
    expect(got.error).not.toBe("blind_room_day");
    expect(got.session).toMatchObject({ id: "bs_a" });
    for (const mode of ["manifest", "timeline", "chunk", "zip"]) expect(((await tool("scribe_get_recording").handler({ session_id: "bs_a", mode, chunk_idx: 0 }, ctx)) as Row).error, mode).not.toBe("blind_room_day");
    expect(reads().length).toBeGreaterThan(0);
  });
  it("scribe_extract_audio and scribe_transcribe_range: the session's day, ranges crossing midnight into / out of it, and a window-only placement are none refused; the chunk list is read", async () => {
    for (const name of ["scribe_extract_audio", "scribe_transcribe_range"]) {
      const run = (a: Row) => tool(name).handler({ session_id: "bs_a", dry_run: false, ...a }, ctx) as Promise<Row>;
      expect((await run({ start: new Date(dayStart + 3_600_000).toISOString(), end: new Date(dayStart + 4_000_000).toISOString() })).error, name).not.toBe("blind_room_day");
      guard.row = GUARD({ started_ms: dayStart - 86_400_000, last_ms: dayStart - 86_400_000 + 3_600_000 });
      expect((await run({ start: new Date(dayStart - 600_000).toISOString(), end: new Date(dayStart + 600_000).toISOString() })).error, `${name} forward`).not.toBe("blind_room_day");
      guard.row = GUARD({ started_ms: dayStart + 86_400_000 + 600_000, last_ms: dayStart + 86_400_000 + 1_800_000 });
      expect((await run({ start: new Date(dayStart + 86_400_000 - 600_000).toISOString(), end: new Date(dayStart + 86_400_000 + 600_000).toISOString() })).error, `${name} back`).not.toBe("blind_room_day");
      guard.row = GUARD({ room_id: "r_clean", window_blind: false, started_ms: Date.parse("2026-08-19T05:00:00Z"), last_ms: Date.parse("2026-08-19T06:00:00Z") });
      expect((await run({ start: "2026-08-19T05:10:00Z", end: "2026-08-19T05:20:00Z" })).error, `${name} window`).not.toBe("blind_room_day");
    }
    expect(reads().length).toBeGreaterThan(0);
  });
  it("a clean session and range is NOT refused by the guard (it proceeds to the chunk list)", async () => {
    guard.row = GUARD({ room_id: "r_clean", started_ms: Date.parse("2026-08-19T05:00:00Z"), last_ms: Date.parse("2026-08-19T06:00:00Z") });
    Object.assign(SESSION, { room_id: "r_clean", started_at: "2026-08-19T05:00:00Z" });
    const out = await tool("scribe_extract_audio").handler({ session_id: "bs_a", start: "2026-08-19T05:10:00Z", end: "2026-08-19T05:20:00Z" }, ctx) as Row;
    expect(out.error).not.toBe("blind_room_day");
    expect(reads().length).toBeGreaterThan(0);
  });
});

describe("the jobs: the same, at the first step (so async:true and a direct submit are covered)", () => {
  const step = (kind: { run: (c: never) => Promise<unknown> }, args: Row) => kind.run({ job: { id: "j" }, step: "resolve", args, progress: {}, runner: "r" } as never);
  it("stitch and transcribe_range do not fail blind_room_day on the former pair", async () => {
    const args = { session_id: "bs_a", start: dayStart + 3_600_000, end: dayStart + 4_000_000, source: "primary", format: "webm" };
    for (const k of [stitchKind, transcribeRangeKind]) expect(JSON.stringify(await step(k as never, args)), k.name).not.toContain("blind_room_day");
  });
});

describe("spanTouchesBlindDay (pure)", () => {
  it("is false for the former pair's day, its midnight edges, a covering span, the neighbours and another room", () => {
    const e = dayStart + 86_400_000;
    for (const [room, a, b] of [[BR, dayStart, dayStart], [BR, e - 1, e - 1], [BR, dayStart - 5, dayStart + 5], [BR, e - 5, e + 5], [BR, dayStart - 10, dayStart - 1], [BR, e, e + 10], ["r_other", dayStart, e], [BR, e + 5, dayStart - 5]] as const) {
      expect(spanTouchesBlindDay(room, a, b), `${room} ${a}`).toBe(false);
    }
  });
});
