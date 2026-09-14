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
}));
const ROUTER = vi.hoisted(() => ({ submits: 0 }));
const WHISPER = vi.hoisted(() => ({ value: null as unknown, calls: 0 }));
const CUES = vi.hoisted(() => ({ calls: [] as Array<{ turns: Row[]; marker: Row }> }));

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
  const sql = async (strings: TemplateStringsArray, ..._v: unknown[]) => {
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
    if (q.includes("SET attempts = attempts + 1")) { DB.attemptWrites += 1; DB.attempts += 1; return [{ attempts: DB.attempts }]; }
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
vi.mock("@/lib/mcp/tools/bench", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  writeWindowCues: async (_o: string, _r: string, _d: string, _s: string, _w: unknown, turns: Row[],
    cueFor: (complete: boolean, stoppedEarly: string | null) => Row) => {
    CUES.calls.push({ turns: [...turns], marker: cueFor(true, null) });
    return { written: turns.length + 1, deleted: 0, failed: 0, complete: true, window_recorded: true };
  },
}));
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
  Object.assign(DB, { mode: "room", windowState: "transcribing", attempts: 0, attemptWrites: 0, subjectDone: 0, routingReads: 0, runInserts: 0 });
  ROUTER.submits = 0; WHISPER.calls = 0; WHISPER.value = SILENT(); CUES.calls = [];
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
  for (const error of ["http_500: upstream exploded", "timeout_180000ms", "network: ECONNRESET", "whisper_failed",
    // Contains the constant but is not it. An exact comparison must not treat it as silence.
    `http_502: ${EMPTY_TRANSCRIPT}`]) {
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

  it("THE SWEEP: every caller of transcribeWithWhisper is either a window reader in the table above, or classified as not one", () => {
    // A supplement to the behavioural table, never a substitute (rule 2): it exists so that a FOURTH
    // path reading a window through Whisper cannot be added without someone deciding which it is.
    const NOT_A_WINDOW_READER: Record<string, string> = {
      "lib/whisper.ts": "the client itself — it produces EMPTY_TRANSCRIPT",
      "lib/stt/adapters/whisper.ts": "engine adapter; the room path only reaches it for a window with speech",
      "lib/health/whisper-probe.ts": "health probe on a fixture",
      "app/api/health/route.ts": "health route",
      "lib/stt/measure-job.ts": "tuning-fork measurement on a fixed reference clip",
      "lib/transcribe-compare.ts": "engine comparison tool",
      "app/[slug]/api/encounters/[id]/process/route.ts": "encounter pipeline — no note can be made from silence, so empty is a failure there",
      "app/[slug]/api/transcribe/whisper-chunk/route.ts": "live encounter chunk, not a room window",
    };
    const callers = execSync("git ls-files -co --exclude-standard lib app scripts", { encoding: "utf8" })
      .split("\n").filter((f) => /\.[cm]?[jt]sx?$/.test(f))
      .filter((f) => { try { return /\btranscribeWithWhisper\b/.test(readFileSync(f, "utf8")); } catch { return false; } })
      .sort();
    const known = new Set([...PATHS.map((p) => p.file), ...Object.keys(NOT_A_WINDOW_READER)]);
    expect(callers.filter((f) => !known.has(f)), "an unclassified caller of Whisper — add it to PATHS with a behavioural run, or classify it").toEqual([]);
  });
});
