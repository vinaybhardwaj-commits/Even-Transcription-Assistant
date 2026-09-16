/**
 * E11 — a quiet room is not a failed read, on the room_window job path too.
 *
 * E10 §1: Whisper answered every drain with HTTP 200, and 21 of 25 windows held no speech.
 * `lib/whisper.ts` reports that as `{ ok:false, error: EMPTY_TRANSCRIPT }`, and `roomWindowSegment`
 * mapped every `!ok` to `whisper_unavailable` — so a silent window burned all three attempts and
 * read as an outage. The sync tool and `transcribe_range` already finished it as K5 silence.
 *
 * These drive the REAL step machine and the REAL turn builders against a fake database, so what is
 * asserted is what the code does: which cues are built, which steps run, and whether an attempt is
 * spent. The last block pins all three window readers to one answer, and fails when a new caller of
 * Whisper appears without being classified.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

type Row = Record<string, unknown>;

/** Which fixture the fake database answers for: the room_window job, or the sync bench tool. */
const DB = vi.hoisted(() => ({
  mode: "room" as "room" | "bench",
  windowState: "closed",
  attempts: 0,
  attemptWrites: 0,
  subjectDone: 0,
  routingReads: 0,
  runInserts: 0,
  lastError: null as string | null,
}));
const ROUTER = vi.hoisted(() => ({ submits: 0 }));
const WHISPER = vi.hoisted(() => ({ value: null as unknown, calls: 0 }));
/**
 * The brain write. By default a recorder that answers `complete: true`. With `real: true` the REAL
 * writeWindowCues and postTurnBatch run and only `fetch` is faked, so a failure arrives in the only
 * shapes production can produce (E11(e)); `realAnswers` keeps what the real function returned.
 */
const CUES = vi.hoisted(() => ({ calls: [] as Array<{ turns: Row[]; marker: Row }>, answer: null as Row | null, real: false, realAnswers: [] as Row[] }));

const ROOM_WINDOW_ROW = { id: "bw_1", session_id: "sess_1", room_day_id: "rd_1", start_ms: 0, end_ms: 900_000,
  source_mic: "primary", clip_r2_key: null, grid_aligned: true, room_id: "room_1" };
const ROOM_CHUNKS = [{ idx: 0, source: "primary", r2_key: "chunks/a.webm", content_type: "audio/webm",
  started_at: new Date(0).toISOString(), ended_at: new Date(900_000).toISOString(), upload_state: "uploaded" }];

const ROOM = { id: "room_t", slug: "opd-test-a7q9", name: "OPD Test", disabled_at: null };
const SESSION = { id: "bs_a", room_id: "room_t", label: null, mic_label: null, started_at: "2026-08-19T05:00:00Z",
  ended_at: null, status: "ended", notes: null, room_slug: ROOM.slug, room_name: ROOM.name };
const benchChunk = (idx: number, s: string, e: string) => ({ id: `bc_${idx}`, idx, source: "primary", r2_key: `bench/x/${idx}.webm`,
  content_type: "audio/webm", started_at: s, ended_at: e, upload_state: "verified", duration_ms: 300_000, size_bytes: 1, gap_before_ms: 0, created_at: e });
const BENCH_CHUNKS = [benchChunk(0, "2026-08-19T05:00:00Z", "2026-08-19T05:05:00Z"), benchChunk(1, "2026-08-19T05:05:00Z", "2026-08-19T05:10:00Z")];

vi.mock("@/lib/db", () => {
  const sql = async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const q = strings.join("?").replace(/\s+/g, " ");
    if (DB.mode === "bench") {
      if (/FROM room/.test(q) && !/bench_session/.test(q)) return [ROOM];
      if (/FROM bench_session s/.test(q) && /JOIN room r/.test(q) && !/COUNT/.test(q)) return [SESSION];
      if (/FROM bench_chunk/.test(q)) return BENCH_CHUNKS;
      return [];
    }
    if (q.includes("FROM bench_window w JOIN bench_session")) return [{ ...ROOM_WINDOW_ROW, state: DB.windowState }];
    if (q.includes("FROM bench_chunk")) return ROOM_CHUNKS;
    if (q.includes("UPDATE bench_window SET state = 'transcribing'")) { DB.windowState = "transcribing"; return [{ id: "bw_1" }]; }
    if (q.includes("UPDATE bench_window SET state = 'transcribed'")) { DB.windowState = "transcribed"; return []; }
    if (q.includes("UPDATE bench_window SET state = 'closed'")) { DB.windowState = "closed"; return []; }
    if (q.includes("UPDATE bench_window SET state = 'failed'")) { DB.windowState = "failed"; return []; }
    if (q.includes("FROM stt_routing")) { DB.routingReads += 1; return [{ engine_id: "route" }]; }
    if (q.includes("FROM stt_engine")) return [{ enabled: true }];
    if (q.includes("INSERT INTO transcription_run")) { DB.runInserts += 1; return []; }
    // recordFailure binds `last_error` first; keep it so a test can say WHICH failure cost the attempt.
    if (q.includes("SET attempts = attempts + 1")) { DB.attemptWrites += 1; DB.attempts += 1; DB.lastError = String(v[0]); return [{ attempts: DB.attempts }]; }
    if (q.includes("UPDATE stt_subject_job SET state = 'done'")) { DB.subjectDone += 1; return []; }
    return [];
  };
  (sql as unknown as { transaction: () => Promise<unknown[]> }).transaction = async () => [];
  return { sql, db: {} };
});
vi.mock("@/lib/r2", () => ({
  getObjectBytes: async () => new Uint8Array([1, 2, 3, 4]),
  signGetUrl: async (o: { key: string }) => `https://r2.example/${o.key}`,
}));
vi.mock("@/lib/whisper", () => ({
  transcribeWithWhisper: async () => { WHISPER.calls += 1; return WHISPER.value; },
}));
vi.mock("@/lib/bench-join", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  joinServiceConfigured: () => true,
  callJoinService: async () => ({ ok: true, key: "clips/joined.webm" }),
}));
vi.mock("@/lib/room-switches", () => ({ isTranscriptEnabled: async () => true }));
vi.mock("@/lib/brain/db", () => ({
  TOKEN_ENV: "BRAIN_SERVICE_TOKEN",
  getPool: () => ({}),
  query: async () => ({ rows: [], rowCount: 0 }),
}));
vi.mock("@/lib/bench-timeline", () => ({ renderBenchTimeline: async () => ({ markdown: "" }) }));
// The REAL buildTurns and buildWindowCue. Only the network write is captured, and only as the room
// path sees it — so the silence and the marker asserted below are the ones the builders produce.
vi.mock("@/lib/mcp/tools/bench", async (orig) => {
  const real = await orig<typeof import("@/lib/mcp/tools/bench")>();
  return {
    ...real,
    writeWindowCues: async (o: string, r: string, d: string, sId: string, w: { startMs: number; endMs: number }, turns: Row[],
      cueFor: (complete: boolean, stoppedEarly: string | null) => Row) => {
      CUES.calls.push({ turns: [...turns], marker: cueFor(true, null) });
      if (CUES.real) {
        const counts = await real.writeWindowCues(o, r, d, sId, w, turns as never, cueFor as never);
        CUES.realAnswers.push(counts as unknown as Row);
        return counts;
      }
      return CUES.answer ?? { written: turns.length + 1, deleted: 0, failed: 0, complete: true, window_recorded: true };
    },
  };
});
vi.mock("@/lib/stt/eta-router", () => ({
  ROUTER_JOB_ON: () => true,
  submitRouteJob: async () => { ROUTER.submits += 1; return { ok: true, job_id: `rj_${ROUTER.submits}` }; },
  pollRouteJob: async () => ({ ok: true, state: "running" }),
  routeTranscribe: async () => ({ ok: true }),
}));

const { EMPTY_TRANSCRIPT } = await import("@/lib/whisper-constants");
const ARGS = { window_id: "bw_1", origin: "https://x.test", actor: "admin_1", via: "admin_route" };

/** Drive the room_window machine exactly as the runner does: one step per claim, progress carried. */
async function driveRoom(maxSteps = 12, stopAt?: string) {
  const { roomWindowKind } = await import("@/lib/jobs/kinds/room-window");
  let step = roomWindowKind.first;
  let progress: Row = {};
  const visited: string[] = [];
  for (let i = 0; i < maxSteps; i += 1) {
    visited.push(step);
    // Stop BEFORE running `stopAt`: the control below only needs to see where segment hands off,
    // and the routed engine's poll step would wait on a fake router that never finishes.
    if (step === stopAt) return { visited, result: undefined as Row | undefined, error: undefined as string | undefined };
    const out = await roomWindowKind.run({ job: {} as never, step, args: ARGS, progress, runner: "r1" });
    if (out.kind === "done") return { visited, result: (out as { result: Row }).result, error: undefined as string | undefined };
    if (out.kind === "fail") return { visited, result: undefined as Row | undefined, error: (out as { error: string }).error };
    progress = (out as { progress: Row }).progress;
    step = (out as { step: string }).step;
  }
  throw new Error(`did not settle: ${visited.join(" -> ")}`);
}

const SILENT = () => ({ ok: false, error: EMPTY_TRANSCRIPT, latency_ms: 3_900, attempts: 1 });

beforeEach(() => {
  Object.assign(DB, { mode: "room", windowState: "transcribing", attempts: 0, attemptWrites: 0, subjectDone: 0, routingReads: 0, runInserts: 0, lastError: null });
  ROUTER.submits = 0; WHISPER.calls = 0; WHISPER.value = SILENT(); CUES.calls = []; CUES.answer = null; CUES.real = false; CUES.realAnswers = [];
  process.env.BRAIN_SERVICE_TOKEN = "tok";
});

describe("V1 — a window whose Whisper call is a 200 with no text finishes transcribed, as silence", () => {
  it("one stt_silence, a complete marker with segment_count 0, zero turns, window transcribed", async () => {
    const r = await driveRoom();
    expect(r.error, "a quiet room must not fail the job").toBeUndefined();
    expect(DB.windowState).toBe("transcribed");
    expect(DB.subjectDone, "the subject row is settled done").toBe(1);
    expect(CUES.calls, "the window is written exactly once").toHaveLength(1);
    const { turns, marker } = CUES.calls[0]!;
    expect(turns.map((t) => t.type), "one silence and nothing else").toEqual(["stt_silence"]);
    expect(turns.some((t) => t.type === "stt_turn")).toBe(false);
    expect(marker.type).toBe("stt_window");
    expect(marker.payload).toMatchObject({ complete: true, segment_count: 0 });
    expect(r.result).toMatchObject({ silent_window: true, segment_count: 0, run_id: null });
  });
});

describe("V2 — a real Whisper failure still fails whisper_unavailable, and still costs an attempt", () => {
  // The guard of the EXACT comparison is not here: it is the real-client file
  // (e11-silent-room-window-real-client.test.ts), built from what lib/whisper.ts actually emits.
  for (const error of ["http_500: upstream exploded", "timeout_180000ms", "network: ECONNRESET", "whisper_failed"]) {
    it(`${error} → whisper_unavailable`, async () => {
      WHISPER.value = { ok: false, error, latency_ms: 40, attempts: 2 };
      const r = await driveRoom();
      expect(r.error, `${error} must fail the job`).toBe("room_window_failed: whisper_unavailable");
      expect(r.visited).toEqual(["prepare", "segment"]);
      expect(DB.attemptWrites, "a failed read consumes exactly one attempt").toBe(1);
      expect(DB.windowState, "and returns the window to the queue").toBe("closed");
      expect(CUES.calls, "no silence is written for a read that did not happen").toHaveLength(0);
    });
  }
});

describe("V3 — the silent branch consumes no attempt", () => {
  it("two consecutive silent drains of the same window leave the attempt counter at 0", async () => {
    await driveRoom();
    expect(DB.windowState).toBe("transcribed");
    DB.windowState = "transcribing"; // a forced re-drain claims it again
    const second = await driveRoom();
    expect(second.error).toBeUndefined();
    expect(DB.attemptWrites, "no attempt write on either drain").toBe(0);
    expect(DB.attempts).toBe(0);
    expect(CUES.calls, "each drain replaces the window with its silence").toHaveLength(2);
  });
});

describe("E11(b)/(e) — a silence that could not be written is NOT a finished read, on the brain's REAL failure shapes", () => {
  // THE FIRST VERSION OF THIS TEST FED A SHAPE PRODUCTION CANNOT PRODUCE ({failed: 2, window_recorded: false}),
  // so it proved the guard existed and never exercised its real failure: `!counts.window_recorded` and
  // `counts.failed > 1` both survived it (Refuter, E11 pre-merge §3C). A fake is only as good as the realism
  // of its answers. So these run the REAL writeWindowCues and postTurnBatch, and fake only `fetch` at
  // /api/brain/cues — the two ways the brain can refuse a silence batch:
  //   batch_refused_marker_accepted  K4's likeliest failure: the turn batch is refused, the marker-only
  //                                  request lands  →  complete:false, window_recorded:TRUE,  failed:1
  //   both_refused                   nothing lands  →  complete:false, window_recorded:false, failed:1
  // A silence is ONE turn, so `failed` is 1 in both. Either must cost one attempt and leave the window closed.
  const SHAPES: Array<{ mode: "batch_refused_marker_accepted" | "both_refused"; recorded: boolean }> = [
    { mode: "batch_refused_marker_accepted", recorded: true },
    { mode: "both_refused", recorded: false },
  ];
  for (const { mode, recorded } of SHAPES) {
    it(`${mode}: one attempt, cues_refused, window back to closed, subject not done`, async () => {
      const brain: Array<{ replace: boolean; types: string[] }> = [];
      CUES.real = true;
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        expect(String(url)).toBe("https://x.test/api/brain/cues");
        const body = JSON.parse(String(init.body)) as { replace_window?: unknown; cues: Array<{ type: string }> };
        const markerOnly = !body.replace_window;
        brain.push({ replace: !markerOnly, types: body.cues.map((c) => c.type) });
        const refuse = () => new Response(JSON.stringify({ ok: false, error: "brain_permission_denied" }), { status: 403 });
        if (mode === "both_refused" || !markerOnly) return refuse();
        return new Response(JSON.stringify({ ok: true, deleted: 0, written: 1, already_existed: 0, dropped: 0, attempted: 1 }), { status: 200 });
      });
      try {
        const r = await driveRoom();
        // The real function's own answer — the shape the check must be right about.
        expect(CUES.realAnswers).toHaveLength(1);
        expect(CUES.realAnswers[0]).toMatchObject({ complete: false, window_recorded: recorded, failed: 1 });
        expect(brain, "the silence batch with the window replace, then the marker alone without it").toEqual([
          { replace: true, types: ["stt_silence", "stt_window"] },
          { replace: false, types: ["stt_window"] },
        ]);
        expect(r.error).toBe("room_window_failed: cues_refused");
        expect(r.visited).toEqual(["prepare", "segment"]);
        expect(DB.attemptWrites, "one attempt, exactly").toBe(1);
        expect(DB.lastError).toMatch(/^cues_refused: brain_permission_denied/);
        expect(DB.windowState, "back in the queue, not settled").toBe("closed");
        expect(DB.subjectDone, "the subject row is never marked done").toBe(0);
        expect(ROUTER.submits + DB.routingReads + DB.runInserts, "and still no engine").toBe(0);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  }
});

describe("E22 R5 (F6) — SPOKEN turns that could not be written are NOT a finished read, on the brain's REAL failure shapes", () => {
  // The block above proves the guard on the silent branch only. The speech branch has its own guard, and mutant
  // E11-11 (that guard changed to `!counts.window_recorded`) survived: on batch_refused_marker_accepted the marker
  // lands, window_recorded is TRUE, and the mutant marks a window transcribed whose turns were rolled back. Same
  // REAL writeWindowCues and postTurnBatch, same fake `fetch`, spoken Whisper answer.
  const SPOKEN = () => ({ ok: true, transcript: "one two", language: "en", latency_ms: 90, attempts: 1, engineVersion: "large-v3-turbo",
    segments: [{ start_s: 0, end_s: 5, text: "one" }, { start_s: 30, end_s: 36, text: "two" }] });
  for (const { mode, recorded } of [
    { mode: "batch_refused_marker_accepted" as const, recorded: true },
    { mode: "both_refused" as const, recorded: false },
  ]) {
    it(`${mode}: one attempt, cues_refused, window back to closed, subject not done, engine never reached`, async () => {
      WHISPER.value = SPOKEN();
      const brain: Array<{ replace: boolean; types: string[] }> = [];
      CUES.real = true;
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        expect(String(url)).toBe("https://x.test/api/brain/cues");
        const body = JSON.parse(String(init.body)) as { replace_window?: unknown; cues: Array<{ type: string }> };
        const markerOnly = !body.replace_window;
        brain.push({ replace: !markerOnly, types: body.cues.map((c) => c.type) });
        if (mode === "both_refused" || !markerOnly) return new Response(JSON.stringify({ ok: false, error: "brain_permission_denied" }), { status: 403 });
        return new Response(JSON.stringify({ ok: true, deleted: 0, written: 1, already_existed: 0, dropped: 0, attempted: 1 }), { status: 200 });
      });
      try {
        const r = await driveRoom();
        expect(CUES.realAnswers).toHaveLength(1);
        expect(CUES.realAnswers[0], "the shape the real function returns — the one the guard must be right about").toMatchObject({ complete: false, window_recorded: recorded });
        expect(Number(CUES.realAnswers[0]!.failed), "spoken turns, so every turn in the batch failed").toBeGreaterThanOrEqual(1);
        expect(brain[0]!.replace, "the turn batch carries the window replace").toBe(true);
        expect(brain[0]!.types).toContain("stt_turn");
        expect(brain.at(-1), "then the marker alone, without the replace").toEqual({ replace: false, types: ["stt_window"] });
        expect(r.error).toBe("room_window_failed: cues_refused");
        expect(r.visited).toEqual(["prepare", "segment"]);
        expect(DB.attemptWrites, "one attempt, exactly").toBe(1);
        expect(DB.lastError).toMatch(/^cues_refused: brain_permission_denied/);
        expect(DB.windowState, "back in the queue, not transcribed").toBe("closed");
        expect(DB.subjectDone, "the subject row is never marked done").toBe(0);
        expect(ROUTER.submits, "no routed engine for a window whose turns did not land").toBe(0);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  }
});

describe("F1 (B3) — a spoken window with EXACTLY ONE turn, rolled back, is NOT a finished read", () => {
  // The block above drives a TWO-segment answer, so `failed` is 2 there and every guard that counts turns at all
  // agrees with the real one. Mutant B3 (the speech-path guard changed to `counts.failed > 1`) survived exactly
  // because of that: with one turn refused, `failed` is 1, and the mutant marks the window transcribed while the
  // only thing the day holds is the marker. One turn is the smallest spoken window there is, and the commonest
  // shape of a short consultation utterance — not an edge case invented to kill a mutant.
  const ONE_TURN = () => ({ ok: true, transcript: "one", language: "en", latency_ms: 90, attempts: 1, engineVersion: "large-v3-turbo",
    segments: [{ start_s: 0, end_s: 5, text: "one" }] });

  it("batch_refused_marker_accepted with ONE turn: failed is exactly 1, and the window is still cues_refused", async () => {
    WHISPER.value = ONE_TURN();
    const brain: Array<{ replace: boolean; types: string[] }> = [];
    CUES.real = true;
    const other: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      // Anything that is NOT the brain is recorded and answered blandly rather than asserted on, so that a guard
      // which wrongly lets the window through runs to the end and fails on what it DID, not on a timeout.
      if (String(url) !== "https://x.test/api/brain/cues") { other.push(String(url)); return new Response("{}", { status: 200 }); }
      const body = JSON.parse(String(init.body)) as { replace_window?: unknown; cues: Array<{ type: string }> };
      const markerOnly = !body.replace_window;
      brain.push({ replace: !markerOnly, types: body.cues.map((c) => c.type) });
      if (!markerOnly) return new Response(JSON.stringify({ ok: false, error: "brain_permission_denied" }), { status: 403 });
      return new Response(JSON.stringify({ ok: true, deleted: 0, written: 1, already_existed: 0, dropped: 0, attempted: 1 }), { status: 200 });
    });
    try {
      // Stop before the `engine` step: a guard that wrongly lets this window through returns `next` here, and
      // the drive would otherwise run on into the poll loop's real sleep. Stopping makes that wrong answer a fast,
      // named assertion failure instead of a timeout.
      const r = await driveRoom(12, "engine");
      expect(CUES.realAnswers).toHaveLength(1);
      // THE SEPARATING FACT: exactly one turn was rolled back. A guard that asks for more than one sees nothing here.
      expect(Number(CUES.realAnswers[0]!.failed), "one spoken turn, rolled back: failed is 1, not 2").toBe(1);
      expect(CUES.realAnswers[0], "the marker landed, so `written` and `window_recorded` both say success").toMatchObject({ complete: false, window_recorded: true });
      expect(Number(CUES.realAnswers[0]!.written), "the marker-only admission: written is non-zero").toBeGreaterThan(0);
      expect(brain[0]!.types, "the turn batch was sent, and refused").toContain("stt_turn");
      expect(brain.at(-1)).toEqual({ replace: false, types: ["stt_window"] });
      expect(r.visited, "the window never reaches the engine: the read did not finish").toEqual(["prepare", "segment"]);
      expect(r.error, "one rolled-back turn fails the window exactly as many do").toBe("room_window_failed: cues_refused");
      expect(DB.lastError).toMatch(/^cues_refused: brain_permission_denied/);
      expect(DB.windowState, "back in the queue, not transcribed").toBe("closed");
      expect(DB.subjectDone, "the subject row is never marked done").toBe(0);
      expect(DB.attemptWrites, "one attempt, exactly").toBe(1);
      expect(ROUTER.submits, "no routed engine for a window whose turn did not land").toBe(0);
      expect(other, "nothing but the brain is called on this path").toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 20_000);
});

describe("E11(c) — silent_window is SAID on a spoken result, never inherited", () => {
  it("segment entered with silent_window:true in progress, on a spoken window, goes to engine and clears the flag", async () => {
    // No step order does this today. The test pins the hazard: a stale `true` carried by the
    // speech branch's `...progress` would skip a spoken window's engine — silent data loss.
    WHISPER.value = { ok: true, transcript: "words", language: "en", latency_ms: 90, attempts: 1,
      segments: [{ start_s: 0, end_s: 5, text: "words" }], engineVersion: "large-v3-turbo" };
    const { roomWindowKind } = await import("@/lib/jobs/kinds/room-window");
    const out = await roomWindowKind.run({ job: {} as never, step: "segment", args: ARGS, runner: "r1",
      progress: { clip_r2_key: "clips/joined.webm", audio_seconds: 900, probe_language: "en", silent_window: true } });
    expect(out.kind).toBe("next");
    expect((out as { step: string }).step, "a spoken window must reach its engine").toBe("engine");
    expect((out as { progress: Row }).progress.silent_window).toBe(false);
  });
});

describe("V4 — the silent branch makes no routed-engine call", () => {
  it("segment goes straight to finish: no routing read, no router job, no run", async () => {
    const r = await driveRoom();
    expect(r.visited, "the engine step is never entered").toEqual(["prepare", "segment", "finish"]);
    expect(ROUTER.submits, "no router job").toBe(0);
    expect(DB.routingReads, "routing is not even resolved").toBe(0);
    expect(DB.runInserts, "no transcription_run, routed or shadow").toBe(0);
    expect(WHISPER.calls, "the probe and the full read — nothing more").toBe(2);
  });

  it("and a SPOKEN window still walks the engine step, so the skip is not universal", async () => {
    WHISPER.value = { ok: true, transcript: "words", language: "en", latency_ms: 90, attempts: 1,
      segments: [{ start_s: 0, end_s: 5, text: "words" }], engineVersion: "large-v3-turbo" };
    const r = await driveRoom(12, "engine");
    expect(r.visited).toEqual(["prepare", "segment", "engine"]);
    expect(DB.routingReads, "a spoken window resolves its route").toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// V5 — THE THREE PATHS GIVE ONE ANSWER. Table-driven over every window reader of Whisper.
// ---------------------------------------------------------------------------------------------

type Outcome = { finished: boolean; silent: boolean; speech_turns: number };

const PATHS: Array<{ file: string; name: string; run: () => Promise<Outcome> }> = [
  {
    file: "lib/mcp/tools/bench.ts",
    name: "sync tool scribe_transcribe_range (dry run)",
    run: async () => {
      DB.mode = "bench";
      const { BENCH_TOOLS } = await import("@/lib/mcp/tools/bench");
      const tool = BENCH_TOOLS.find((t) => t.name === "scribe_transcribe_range")!;
      const out = (await tool.handler({ session_id: "bs_a", start: "10:36", end: "10:38" }, { origin: "https://x.test" } as never)) as Row;
      const turns = (out.turns as Row[] | undefined) ?? [];
      return { finished: out.ok === true, silent: out.silent_window === true, speech_turns: turns.filter((t) => t.type === "stt_turn").length };
    },
  },
  {
    file: "lib/jobs/kinds/transcribe-range.ts",
    name: "transcribe_range job",
    run: async () => {
      const { transcribeRangeKind } = await import("@/lib/jobs/kinds/transcribe-range");
      const out = await transcribeRangeKind.run({ job: {} as never, step: "transcribe", args: { dry_run: true },
        progress: { clip_key: "clips/x.webm", duration_ms: 30_000, session_id: "sess_1" }, runner: "r1" });
      const result = out.kind === "done" ? (out as { result: Row }).result : undefined;
      return { finished: out.kind === "done", silent: result?.silent_window === true, speech_turns: Number(result?.segments ?? 0) };
    },
  },
  {
    file: "lib/stt/room-drain.ts",
    name: "room_window job",
    run: async () => {
      const r = await driveRoom();
      return { finished: r.error === undefined, silent: r.result?.silent_window === true, speech_turns: Number(r.result?.segment_count ?? 0) };
    },
  },
];

describe("V5 — every window reader of Whisper gives the SAME answer for the same Whisper result", () => {
  const CASES: Array<{ label: string; whisper: () => unknown; expected: Outcome }> = [
    { label: "empty_transcript (a quiet room)", whisper: SILENT, expected: { finished: true, silent: true, speech_turns: 0 } },
    { label: "http_500 (a read that did not happen)", whisper: () => ({ ok: false, error: "http_500: down", latency_ms: 40, attempts: 2 }),
      expected: { finished: false, silent: false, speech_turns: 0 } },
  ];
  for (const c of CASES) {
    for (const p of PATHS) {
      it(`${c.label} — ${p.name}`, async () => {
        WHISPER.value = c.whisper();
        expect(await p.run()).toEqual(c.expected);
      });
    }
  }

});

// ---------------------------------------------------------------------------------------------
// E11(d) — THE SWEEP CLASSIFIES CALL SITES, NOT FILES.
//
// A supplement to the behavioural table, never a substitute (rule 2). The first version classified
// FILES by one identifier in three roots, and the Refuter walked four realistic readers past it: a
// reader through the adapter, a new call inside an already-classified file, a caller under a root it
// did not scan, and a direct POST to Whisper's /inference. So: every source file in the repo; six ways
// to reach Whisper; and an EXACT count per (file, signal), so a new site in a known file fails too.
// Comments are stripped first, so prose that names a function is not a call site.
//
// E11(f): `ADAPTERS` is the sixth signal (`ADAPTERS.whisper.transcribe(...)` / `ADAPTERS[key]` reached the
// adapter with none of the other five), and the sweep reads EVERY file git knows — tracked, or untracked and
// not ignored, so a new reader fails before it is committed — instead of a list of roots (a caller under a
// new top-level directory walked past the list). Two trees are left out, each on purpose: `tests/` (mocks
// name every signal and nothing in it ships) and `docs/` (the bus: prose and probe files, nothing ships).
//
// WHAT THIS STILL CANNOT SEE, AS RULED — the shared-classifier round (E19), not this file: a reader through
// `routeTranscribe` (the router decodes with Whisper), a self-call to the app's own whisper-chunk route, a
// string-built URL, a wrapper module that imports none of the six names, and the comment stripper's two
// defeats (a "/*" inside a string before a namespace-imported call; a `#private` field line dropped as a `#`
// comment). A sweep for known names only catches readers written the expected way; E19 replaces it with
// "every read of a Whisper result goes through one classifier".
// ---------------------------------------------------------------------------------------------

/** Trees that ship nothing, excluded by name. Everything else git knows about is swept. */
const SWEEP_EXCLUDE = ["tests/", "docs/"];
const SWEEP_SOURCE = /\.(?:[cm]?[jt]sx?|py|sh|swift)$/;
const SIGNALS: Record<string, RegExp> = {
  transcribeWithWhisper: /\btranscribeWithWhisper\b/g, // the client
  whisperAdapter: /\bwhisperAdapter\b/g, // the engine adapter, by identity
  adapterFor: /\badapterFor\s*\(/g, // the engine adapter, by key ("whisper")
  inference: /\/inference\b/g, // a direct POST to a whisper.cpp-shaped server
  WHISPER_BASE_URL: /\bWHISPER_BASE_URL\b/g, // anything that knows where Whisper lives
  ADAPTERS: /\bADAPTERS\b/g, // the adapter record itself — ADAPTERS.whisper / ADAPTERS[key] (E11(f))
};
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*(\/\/|\*|#)/.test(l)).join("\n");

type SiteClass = "window_reader" | "not_a_window_reader";
/** Every call site that can reach Whisper, counted per (file, signal), each with the decision made about it. */
const SITES: Array<{ file: string; counts: Record<string, number>; role: SiteClass; why: string }> = [
  { file: "lib/mcp/tools/bench.ts", counts: { transcribeWithWhisper: 2, whisperAdapter: 4, adapterFor: 1, ADAPTERS: 2 }, role: "window_reader", why: "sync tool scribe_transcribe_range — K5 in whisperNotOkAnswer; ADAPTERS only lists engine keys" },
  { file: "lib/jobs/kinds/transcribe-range.ts", counts: { transcribeWithWhisper: 2 }, role: "window_reader", why: "transcribe_range job — K5 in transcribeStep" },
  { file: "lib/stt/room-drain.ts", counts: { transcribeWithWhisper: 3, whisperAdapter: 9, adapterFor: 2 }, role: "window_reader", why: "room_window job — K5 in roomWindowSegment (E11); the probe read may fail harmlessly" },
  { file: "lib/whisper.ts", counts: { transcribeWithWhisper: 1, inference: 1, WHISPER_BASE_URL: 1 }, role: "not_a_window_reader", why: "the client itself — it PRODUCES EMPTY_TRANSCRIPT" },
  { file: "lib/stt/adapters/whisper.ts", counts: { transcribeWithWhisper: 2, whisperAdapter: 1, inference: 1, WHISPER_BASE_URL: 1 }, role: "not_a_window_reader", why: "engine adapter; the room path reaches it only for a window with speech, and its health() is a GET" },
  { file: "lib/stt/registry.ts", counts: { whisperAdapter: 2, adapterFor: 1, ADAPTERS: 2 }, role: "not_a_window_reader", why: "the registry that defines ADAPTERS and maps a key to an adapter" },
  { file: "lib/stt/routing.ts", counts: { adapterFor: 1 }, role: "not_a_window_reader", why: "checks an adapter exists for a routed engine; calls nothing" },
  { file: "lib/stt/fanout.ts", counts: { adapterFor: 4 }, role: "not_a_window_reader", why: "encounter fan-out across engines; an adapter error is an engine run's error, not a window's silence" },
  { file: "lib/jobs/kinds/route-transcribe.ts", counts: { adapterFor: 2 }, role: "not_a_window_reader", why: "the route adapter only, by ROUTE_ADAPTER_KEY" },
  { file: "lib/mcp/tools/stt.ts", counts: { adapterFor: 1 }, role: "not_a_window_reader", why: "engine listing / health" },
  { file: "app/api/admin/stt-lab/health/route.ts", counts: { adapterFor: 1 }, role: "not_a_window_reader", why: "engine health" },
  { file: "lib/stt/measure-job.ts", counts: { transcribeWithWhisper: 2 }, role: "not_a_window_reader", why: "tuning-fork measurement on one fixed reference clip" },
  { file: "lib/transcribe-compare.ts", counts: { transcribeWithWhisper: 2 }, role: "not_a_window_reader", why: "engine comparison tool" },
  { file: "app/[slug]/api/encounters/[id]/process/route.ts", counts: { transcribeWithWhisper: 3 }, role: "not_a_window_reader", why: "encounter pipeline — no note can be made from silence, so empty is a failure there ON PURPOSE" },
  { file: "app/[slug]/api/transcribe/whisper-chunk/route.ts", counts: { transcribeWithWhisper: 2 }, role: "not_a_window_reader", why: "live encounter chunk, not a room window" },
  { file: "lib/health/whisper-probe.ts", counts: { inference: 1, WHISPER_BASE_URL: 1 }, role: "not_a_window_reader", why: "health probe on a half-second fixture" },
  { file: "lib/admin/dashboard.ts", counts: { inference: 1, WHISPER_BASE_URL: 1 }, role: "not_a_window_reader", why: "dashboard liveness GET" },
  { file: "lib/mcp/tools/health.ts", counts: { WHISPER_BASE_URL: 1 }, role: "not_a_window_reader", why: "lists env var NAMES only" },
  { file: "lib/emotion/client.ts", counts: { inference: 1 }, role: "not_a_window_reader", why: "the emotion service's /inference/wavlm, not Whisper" },
  { file: "lib/stt/adapters/indicconformer.ts", counts: { inference: 1 }, role: "not_a_window_reader", why: "IndicConformer's own /inference, not Whisper" },
];

describe("E11(d) — every call site that can reach Whisper is classified, by count", () => {
  it("THE SWEEP: the live (file, signal) counts are exactly the classified ones", () => {
    const actual: Record<string, number> = {};
    const files = execSync("git ls-files -co --exclude-standard", { encoding: "utf8" })
      .split("\n").filter((f) => SWEEP_SOURCE.test(f) && !SWEEP_EXCLUDE.some((x) => f.startsWith(x)));
    for (const f of files) {
      let src: string;
      try { src = codeOnly(readFileSync(f, "utf8")); } catch { continue; }
      for (const [name, re] of Object.entries(SIGNALS)) {
        const n = (src.match(re) ?? []).length;
        if (n > 0) actual[`${f} :: ${name}`] = n;
      }
    }
    const expected: Record<string, number> = {};
    for (const s of SITES) for (const [name, n] of Object.entries(s.counts)) expected[`${s.file} :: ${name}`] = n;
    expect(actual, "a Whisper call site was added, moved or removed. Classify it in SITES — and if it reads a window, add a behavioural row to PATHS").toEqual(expected);
  });

  it("every window reader in SITES has a behavioural row in PATHS, and every PATHS row is a classified window reader", () => {
    const readers = SITES.filter((s) => s.role === "window_reader").map((s) => s.file).sort();
    expect(PATHS.map((p) => p.file).sort()).toEqual(readers);
  });
});
