/**
 * tests/unit/repeat-runs.test.ts — the phrase-loop guard (0104), mark never delete.
 *
 * Root cause: docs/handoff/scratch/phrase-loop-19-SEP-2026.md. Whisper's own segment-level output
 * loops on some windows; buildTurns maps those segments to cues 1:1. This suite proves the pure
 * detector against the REAL shape found on OPD 4 - Ortho / 2026-09-18 (358 turns, one repeated
 * n-gram in 50 separate back-to-back runs summing to 197 matching turns, longest run 42) — with
 * SYNTHETIC placeholder text standing in for the real phrase and real filler speech, never the
 * patient/doctor words themselves (house rule: no transcript text in the repo). It also proves the
 * backfill against a real Postgres, and that assembleTape surfaces the flag without ever dropping
 * a turn.
 *
 * No text from any real encounter or room day appears in this file.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { detectRepeatRuns, normalizeTurnText, MIN_RUN_LENGTH_TO_FLAG, type RepeatRunTurnInput } from "@/lib/transcript/repeat-runs";
import { assembleTape, type AssembleTapeInput, type RawBenchWindowRow, type RawTurnRow, type RawRepeatRunRow } from "@/lib/room-day/admin";

// vi.mock is hoisted above every import in this file, so it applies to the static `admin.ts` import
// above (harmless - assembleTape never calls sql) and to the dynamic imports of the backfill/store
// modules below, which do.
const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>) }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v) }));

// ===========================================================================
// 1. The pure detector
// ===========================================================================

describe("detectRepeatRuns — pure", () => {
  it("the real window shape: 358 turns, 50 back-to-back runs of one phrase (197 turns), longest 42 — only runs >= 4 are flagged", () => {
    // The exact run-length sequence measured on the real window (PHI-free: lengths only, no text).
    // sum = 197, count = 50, matches docs/handoff/scratch/phrase-loop-19-SEP-2026.md.
    const REAL_RUN_LENGTHS = [3, 1, 2, 1, 3, 2, 2, 1, 3, 2, 2, 1, 2, 3, 2, 2, 2, 2, 2, 1, 2, 1, 1, 1, 2, 2, 1, 2, 1, 1, 2, 1, 2, 2, 1, 2, 2, 1, 1, 1, 3, 1, 1, 1, 1, 22, 17, 1, 40, 42];
    expect(REAL_RUN_LENGTHS.reduce((a, b) => a + b, 0)).toBe(197);

    let n = 0;
    let fillerN = 0;
    const turns: RepeatRunTurnInput[] = [];
    const push = (text: string) => turns.push({ source_ref: `ref_${n++}`, text });
    const filler = () => push(`filler speech ${fillerN++}`); // never repeats itself

    for (const runLen of REAL_RUN_LENGTHS) {
      filler(); // a gap turn before every run, so runs never touch each other
      for (let i = 0; i < runLen; i++) push("no you can use the placeholder");
    }
    while (turns.length < 358) filler();
    expect(turns.length).toBe(358);

    const results = detectRepeatRuns(turns);
    expect(results.length).toBe(358);

    const flagged = results.filter((r) => r.in_run);
    // Only runs >= MIN_RUN_LENGTH_TO_FLAG (4) count: 22 + 17 + 40 + 42 = 121, not the raw 197.
    expect(MIN_RUN_LENGTH_TO_FLAG).toBe(4);
    expect(flagged.length).toBe(22 + 17 + 40 + 42);

    const runIds = new Set(flagged.map((r) => r.run_id));
    expect(runIds.size).toBe(4); // four separate qualifying runs, not one merged run

    const lengths = [...runIds].map((id) => flagged.find((r) => r.run_id === id)!.run_length).sort((a, b) => a - b);
    expect(lengths).toEqual([17, 22, 40, 42]);

    // The runs of length 1-3 (46 of the 50) are NOT flagged - ordinary-speech range, conservative reading.
    const short = results.filter((r) => !r.in_run && r.run_length === 1);
    expect(short.length).toBe(358 - (22 + 17 + 40 + 42));
  });

  it("a window with no runs: every turn distinct, nothing flagged", () => {
    const turns: RepeatRunTurnInput[] = Array.from({ length: 12 }, (_, i) => ({ source_ref: `ref_${i}`, text: `distinct speech ${i}` }));
    const results = detectRepeatRuns(turns);
    expect(results.every((r) => !r.in_run)).toBe(true);
    expect(results.every((r) => r.run_id === null && r.run_length === 1 && r.run_rank === 1)).toBe(true);
  });

  it("a phrase legitimately repeated exactly 3 times back to back must NOT be flagged", () => {
    const turns: RepeatRunTurnInput[] = [
      { source_ref: "r0", text: "opening remark" },
      { source_ref: "r1", text: "okay, take a deep breath" },
      { source_ref: "r2", text: "okay, take a deep breath" },
      { source_ref: "r3", text: "okay, take a deep breath" },
      { source_ref: "r4", text: "closing remark" },
    ];
    const results = detectRepeatRuns(turns);
    const middle = results.slice(1, 4);
    expect(middle.every((r) => r.in_run === false)).toBe(true);
  });

  it("runs separated by other speech are two separate runs, never merged", () => {
    const turns: RepeatRunTurnInput[] = [
      { source_ref: "a0", text: "loop text" },
      { source_ref: "a1", text: "loop text" },
      { source_ref: "a2", text: "loop text" },
      { source_ref: "a3", text: "loop text" }, // run of 4 -> flagged
      { source_ref: "b0", text: "a real sentence in between" },
      { source_ref: "a4", text: "loop text" },
      { source_ref: "a5", text: "loop text" },
      { source_ref: "a6", text: "loop text" },
      { source_ref: "a7", text: "loop text" }, // second run of 4 -> flagged, DIFFERENT run
    ];
    const results = detectRepeatRuns(turns);
    const first = results.slice(0, 4);
    const between = results[4]!;
    const second = results.slice(5, 9);
    expect(first.every((r) => r.in_run && r.run_id === "a0")).toBe(true);
    expect(between.in_run).toBe(false);
    expect(second.every((r) => r.in_run && r.run_id === "a4")).toBe(true);
    expect(first[0]!.run_id).not.toBe(second[0]!.run_id);
    expect(second.map((r) => r.run_rank)).toEqual([1, 2, 3, 4]);
  });

  it("normalizeTurnText: case/whitespace insensitive, but keeps . ? ! per the canonical doc's §1", () => {
    expect(normalizeTurnText("  No,  you CAN use the hospital.  ")).toBe("no you can use the hospital.");
    expect(normalizeTurnText("wait -- really?")).toBe(normalizeTurnText("Wait really?"));
  });
});

// ===========================================================================
// 2. Backfill against a real Postgres — read-and-flag, no text touched
// ===========================================================================

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-plg-repeat-runs");

describe("REQUIRED PROOF — the backfill runs against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/repeat-runs.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

const noRecord = (f: string) => readFileSync(f, "utf8").replace(/INSERT INTO schema_migrations[\s\S]*?;/g, "");

beforeAll(() => {
  if (!HAVE_DOCKER) return;
  pg.start();
  pg.exec(`
    CREATE TABLE bench_session (id text PRIMARY KEY, room_id text);
    INSERT INTO bench_session VALUES ('bs_plg1', 'room_1');
    CREATE TABLE cue (id text PRIMARY KEY, room_day_id text, session_id text, type text, source text, source_ref text, payload jsonb, at timestamptz DEFAULT now());
  `);
  pg.exec(noRecord("db/migrations/0057_bench_window.sql"));
  pg.exec(noRecord("db/migrations/0104_room_turn_repeat_run.sql"));
  H.sql = pg.sql;
}, 240_000);
afterAll(() => { if (HAVE_DOCKER) pg.stop(); });

describe.runIf(HAVE_DOCKER)("backfillRepeatRuns — real postgres", () => {
  it("flags pre-existing rows without touching their text, and distinguishes never-measured from measured-clean", async () => {
    const { backfillRepeatRuns } = await import("@/lib/transcript/repeat-runs-backfill");

    const windowId = "bw_plg1_1000_primary";
    pg.exec(`INSERT INTO bench_window (id, session_id, start_ms, end_ms, source_mic, state)
             VALUES ('${windowId}', 'bs_plg1', 1000, 2000, 'primary', 'transcribed')`);

    const seedTurn = (i: number, text: string) => pg.exec(`
      INSERT INTO cue (id, room_day_id, session_id, type, source, source_ref, payload, at)
      VALUES ('cue_${i}', NULL, 'bs_plg1', 'stt_turn', NULL, 'bs_plg1|${1000 + i}|${1000 + i + 1}|-',
        '${JSON.stringify({ text, start_ms: 1000 + i, end_ms: 1000 + i + 1, window: { start_ms: 1000, end_ms: 2000 } })}'::jsonb,
        now())
    `);
    // 4 identical (a qualifying run) + 2 distinct (never a run).
    seedTurn(0, "loop text");
    seedTurn(1, "loop text");
    seedTurn(2, "loop text");
    seedTurn(3, "loop text");
    seedTurn(4, "clean turn a");
    seedTurn(5, "clean turn b");

    const before = pg.sql!`SELECT count(*)::int AS n FROM room_turn_repeat_run WHERE window_id = ${windowId}` as unknown as Promise<Array<{ n: number }>>;
    expect((await before)[0]!.n).toBe(0); // never measured before the backfill runs

    const summary = await backfillRepeatRuns();
    expect(summary.turns_total).toBe(6);
    expect(summary.turns_flagged).toBe(4);

    const rows = (await (pg.sql!`
      SELECT source_ref, in_run, run_length, run_rank
        FROM room_turn_repeat_run
       WHERE window_id = ${windowId}
       ORDER BY source_ref
    ` as unknown as Promise<Array<{ source_ref: string; in_run: boolean; run_length: number; run_rank: number }>>));
    expect(rows.length).toBe(6); // every turn measured, including the clean ones

    const flaggedRows = rows.filter((r) => r.in_run);
    expect(flaggedRows.length).toBe(4);
    expect(flaggedRows.every((r) => r.run_length === 4)).toBe(true);

    const cleanRows = rows.filter((r) => !r.in_run);
    expect(cleanRows.length).toBe(2);
    expect(cleanRows.every((r) => r.run_length === 1)).toBe(true); // measured, found clean - distinct from never-measured

    // No cue row's text was touched by the backfill.
    const texts = (await (pg.sql!`SELECT payload->>'text' AS t FROM cue WHERE session_id = 'bs_plg1' ORDER BY id` as unknown as Promise<Array<{ t: string }>>));
    expect(texts.map((r) => r.t)).toEqual(["loop text", "loop text", "loop text", "loop text", "clean turn a", "clean turn b"]);
  });
});

// ===========================================================================
// 3. The tape surfaces the flag - a looped turn is shown, marked, never dropped
// ===========================================================================

describe("assembleTape — surfaces repeat_run on the tape", () => {
  const win = (overrides: Partial<RawBenchWindowRow> = {}): RawBenchWindowRow => ({
    id: "bw_1", session_id: "bs_1", room_day_id: null, start_ms: 0, end_ms: 900_000,
    source_mic: "primary", grid_aligned: true, state: "transcribed",
    closed_at: null, auto_drain_refused_at: null, auto_drain_refused_reason: null,
    ...overrides,
  });
  const turnRow = (overrides: Partial<RawTurnRow> = {}): RawTurnRow => ({
    window_id: "bw_1", source_ref: "bs_1|1000|2000|0", speaker_idx: 0, cluster_id: null,
    cue_text: "loop text", cue_start_ms: 1000, cue_end_ms: 2000, clinician_id: null, role: null,
    match_confidence: null, no_role_reason: "no_match", losing_clinician_id: null, losing_score: null, score_basis: null,
    ...overrides,
  });
  const baseInput = (overrides: Partial<AssembleTapeInput> = {}): AssembleTapeInput => ({
    room: { id: "room_1", name: "OPD 4 - Ortho", slug: "opd-4-ortho" },
    ist_date: "2026-09-18",
    roomDay: null,
    spanStartMs: 0,
    spanEndMs: 900_000,
    windows: [win()],
    diarizeRows: [],
    transcriptRows: [],
    turnRows: [],
    repeatRunRows: [],
    emotionWindowRows: [],
    spanEmotionRows: [],
    clinicianNames: {},
    emotion: { compute_enabled: false, surface_enabled: false },
    nowMs: 900_000 * 10,
    autoDrainMaxAgeHours: 6,
    ...overrides,
  });

  it("a turn inside a run renders with in_run true, its run length, and its rank - and is still present", () => {
    const looped = turnRow({ source_ref: "bs_1|1000|2000|0" });
    const repeatRunRows: RawRepeatRunRow[] = [
      { window_id: "bw_1", source_ref: "bs_1|1000|2000|0", in_run: true, run_id: "bs_1|1000|2000|0", run_length: 42, run_rank: 5 },
    ];
    const tape = assembleTape(baseInput({ turnRows: [looped], repeatRunRows }));
    const slot = tape.slots.find((s) => s.kind === "window");
    expect(slot?.kind).toBe("window");
    const turns = slot!.kind === "window" ? slot!.window.turns : [];
    expect(turns.length).toBe(1); // never dropped
    expect(turns[0]!.repeat_run).toEqual({ in_run: true, run_id: "bs_1|1000|2000|0", run_length: 42, run_rank: 5 });
  });

  it("a turn never measured (no row in room_turn_repeat_run) renders repeat_run: null - not the same as clean", () => {
    const tape = assembleTape(baseInput({ turnRows: [turnRow({ source_ref: "bs_1|3000|4000|0" })], repeatRunRows: [] }));
    const slot = tape.slots.find((s) => s.kind === "window");
    const turns = slot!.kind === "window" ? slot!.window.turns : [];
    expect(turns[0]!.repeat_run).toBeNull();
  });

  it("a turn measured and found clean renders in_run: false, distinct from null", () => {
    const clean = turnRow({ source_ref: "bs_1|5000|6000|0" });
    const repeatRunRows: RawRepeatRunRow[] = [
      { window_id: "bw_1", source_ref: "bs_1|5000|6000|0", in_run: false, run_id: null, run_length: 1, run_rank: 1 },
    ];
    const tape = assembleTape(baseInput({ turnRows: [clean], repeatRunRows }));
    const slot = tape.slots.find((s) => s.kind === "window");
    const turns = slot!.kind === "window" ? slot!.window.turns : [];
    expect(turns[0]!.repeat_run).toEqual({ in_run: false, run_id: null, run_length: 1, run_rank: 1 });
  });
});
