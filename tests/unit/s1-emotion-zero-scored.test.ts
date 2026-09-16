/**
 * S1 — an emotion_window whose every segment failed is a FAILURE; a RETRY of it replaces the rows and
 * records what was persisted (FIX2 N1); the window row is never left stale relative to its rows, and is
 * written if and only if it would change (FIX3b C9) — where "change" covers everything the segment rows can
 * contradict, model, model_key, subfolder, cap_s and room_day_id included (FIX4 C16); and a failure's counts
 * are the rows or NULL, never a remembered number (FIX3b C10).
 *
 * AGAINST A REAL POSTGRES (0057, 0074's two tables, 0085, 0088, 0089, 0090 verbatim), through BOUND
 * parameters. The kind's own `run` drives every step (prepare → warm → score → finish), so step dispatch
 * and outcomes are the real ones. Only the outside world is faked: the emotion service and R2.
 *
 * ORDER-INDEPENDENT (FIX3b C13). Every case seeds its own window and sets its own service behaviour; none
 * reads what another left behind. ETA_S1_REVERSE_ORDER=1 registers the cases in reverse — the order proof
 * reported with this build runs the file both ways.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

type Mode = "all_ok" | "all_fail" | "first_ok" | "warm_fail" | "throw" | "all_unscorable" | "first_unscorable_rest_fail";
const H = vi.hoisted(() => ({
  sql: (async () => []) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>,
  mode: "all_ok" as "all_ok" | "all_fail" | "first_ok" | "warm_fail" | "throw" | "all_unscorable" | "first_unscorable_rest_fail",
  healthOk: true,
  /** What the service says about itself on this run (FIX4: the model, subfolder and cap it reports). */
  svc: { model: "m", subfolder: "int8", cap: 30 },
}));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql(s, ...v) }));
vi.mock("@/lib/r2", () => ({ signGetUrl: async () => "https://r2.example/clip" }));
vi.mock("@/lib/emotion/gate", () => ({ emotionEnabled: () => true }));
vi.mock("@/lib/emotion/client", async (orig) => {
  const LABELS = ["anger", "disgust", "enthusiasm", "fear", "happiness", "neutral", "sadness"];
  return {
    ...(await orig<Record<string, unknown>>()),
    emotionSecretConfigured: () => true,
    emotionHealth: async () => (H.healthOk ? { ok: true, cap_s: H.svc.cap, min_speech_s: 1.5, loaded: true, model: H.svc.model, subfolder: H.svc.subfolder } : { ok: false, error: "health_down" }),
    scoreSegments: async (_url: string, segments: Array<{ start_s: number; end_s: number }>) => {
      const warm = segments.length === 1 && segments[0]!.start_s === 0 && segments[0]!.end_s === 1;
      if (warm && H.mode === "warm_fail") return { ok: false, error: "emotion_http_503", retryable: true };
      if (!warm && H.mode === "throw") throw new Error("socket hang up");
      return {
        ok: true, model: H.svc.model, model_key: "wavlm", subfolder: H.svc.subfolder, device: "cpu", cap_s: H.svc.cap, fetch_s: null, decode_s: null,
        results: segments.map((sg, i) => {
          // E16 — the client's parsed form of the service's gate refusal: unscorable, never failed.
          if (!warm && (H.mode === "all_unscorable" || (H.mode === "first_unscorable_rest_fail" && i === 0))) {
            return { index: i, ok: false, unscorable: true, reason: "insufficient_speech", service_speech_s: 0.4, duration_s: sg.end_s - sg.start_s };
          }
          const ok = warm || H.mode === "all_ok" || (H.mode === "first_ok" && i === 0);
          return ok
            ? { index: i, ok: true, labels: Object.fromEntries(LABELS.map((l) => [l, 1 / 7])), top_label: "anger", top_score: 1 / 7, duration_s: sg.end_s - sg.start_s, inference_s: 0.1 }
            : { index: i, ok: false, reason: "segment_too_short_for_model" };
        }),
      };
    },
  };
});

const { emotionWindowKind } = await import("@/lib/jobs/kinds/emotion-window");
const { errorCodeOf } = await import("@/lib/jobs/errors");
const { recordEmotionWindow, finishEmotionWindow } = await import("@/lib/emotion/store");

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const REVERSE = process.env.ETA_S1_REVERSE_ORDER === "1";
const pg = pgContainer("eta-s1-emotion");

describe("REQUIRED PROOF — the emotion window writes against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/s1-emotion-zero-scored.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

const noRecord = (f: string) => readFileSync(f, "utf8").replace(/INSERT INTO schema_migrations[\s\S]*?;/g, "");

beforeAll(() => {
  if (!HAVE_DOCKER) return;
  pg.start();
  const m0074 = readFileSync("db/migrations/0074_room_diarize.sql", "utf8");
  const keep = (name: string) => {
    const i = m0074.indexOf(`CREATE TABLE IF NOT EXISTS ${name}`);
    return m0074.slice(i, m0074.indexOf(");", i) + 2);
  };
  pg.exec(`
    CREATE TABLE bench_session (id text PRIMARY KEY, room_id text);
    INSERT INTO bench_session VALUES ('sess_1', 'room_1');
    CREATE TABLE cue (id text PRIMARY KEY, room_day_id text, type text, source text, source_ref text, payload jsonb, at timestamptz DEFAULT now());
  `);
  pg.exec(noRecord("db/migrations/0057_bench_window.sql"));
  pg.exec(keep("room_turn_speaker"));
  pg.exec(keep("room_diarize_window"));
  for (const f of ["0085_room_turn_speaker_role", "0088_room_diarize_window_retry", "0089_room_emotion", "0090_diarize_run_id_and_service_guess", "0097_room_span_emotion_speech", "0099_room_diarize_segments_run_id"]) {
    pg.exec(noRecord(`db/migrations/${f}.sql`));
  }
  H.sql = pg.sql;
}, 180_000);
afterAll(() => { if (HAVE_DOCKER) pg.stop(); });

let nextStart = 0;
/**
 * E16 — the diarizer's speech for the seeded turns, clip-relative ms: speaker 0 over 0–9 s, speaker 1 over
 * 12–20 s. Each planned run then measures well over min_speech_s and is sent, as these cases assume.
 */
const SEGMENTS_JSON = JSON.stringify([
  { start_ms: 0, end_ms: 9000, speaker_idx: 0 },
  { start_ms: 12000, end_ms: 20000, speaker_idx: 1 },
]);
/**
 * A diarized window with two speakers' runs — so TWO planned segments — and, with `turns: false`, none.
 * Speaker 0: 0–4 s and 5–9 s (one run). Speaker 1: 12–16 s and 17–20 s (one run).
 */
function seedWindow(id: string, opts: { turns?: boolean; windowRoomDay?: string | null; segmentsJson?: string; segmentsRunId?: string | null } = {}): void {
  const start = (nextStart += 900_000);
  const run = `run_${id}`;
  const windowRoomDay = opts.windowRoomDay === undefined ? "'rd_1'" : opts.windowRoomDay === null ? "NULL" : `'${opts.windowRoomDay}'`;
  pg.exec(`
    INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic, clip_r2_key, grid_aligned, state, closed_at)
    VALUES ('${id}', 'sess_1', ${windowRoomDay}, ${start}, ${start + 900_000}, 'primary', 'clips/${id}.webm', TRUE, 'transcribed', NOW());
    INSERT INTO room_diarize_window (window_id, room_day_id, state, speakers_json, segments_json, segments_run_id, clip_r2_key, error, timing_json, last_run_id)
    VALUES ('${id}', 'rd_1', 'ok', '[]'::jsonb, '${opts.segmentsJson ?? SEGMENTS_JSON}'::jsonb,
            ${opts.segmentsRunId === undefined ? `'${run}'` : opts.segmentsRunId === null ? "NULL" : `'${opts.segmentsRunId}'`}, 'clips/${id}.webm', NULL, NULL, '${run}');
  `);
  if (opts.turns === false) return;
  // The stored overlap_ms is what the seeded intervals bind each turn with, as one diarize run would write it.
  // Fixture arithmetic, not the code under test: each seeded turn holds ONE speaker, so its binding overlap is the
  // plain sum of that speaker's interval overlap with the turn. Staleness is set by `segmentsRunId` (0099).
  const segs = JSON.parse(opts.segmentsJson ?? SEGMENTS_JSON) as Array<{ start_ms: number; end_ms: number; speaker_idx: number }>;
  const overlapOf = (spk: number, s: number, e: number) =>
    segs.filter((g) => g.speaker_idx === spk).reduce((a, g) => a + Math.max(0, Math.min(e, g.end_ms) - Math.max(s, g.start_ms)), 0);
  const turns: Array<[string, number, number, number]> = [["a1", 0, 0, 4000], ["a2", 0, 5000, 9000], ["b1", 1, 12_000, 16_000], ["b2", 1, 17_000, 20_000]];
  for (const [ref, spk, s, e] of turns) {
    const sref = `${id}|${ref}`;
    pg.exec(`
      INSERT INTO cue (id, room_day_id, type, source, source_ref, payload)
      VALUES ('c_${sref}', 'rd_1', 'stt_turn', 'replay', '${sref}', '{"start_ms":${start + s},"end_ms":${start + e}}'::jsonb);
      INSERT INTO room_turn_speaker (window_id, source_ref, speaker_idx, overlap_ms, room_day_id, no_role_reason, run_id)
      VALUES ('${id}', '${sref}', ${spk}, ${overlapOf(spk, s, e)}, 'rd_1', 'no_match', '${run}');
    `);
  }
}

type Outcome = { kind: string; result?: Record<string, unknown>; error?: string };
/** Drive the kind step by step under `mode`. `before` may rewrite the progress handed to a named step. */
async function runKind(
  windowId: string, mode: Mode,
  before?: { step: string; tamper: (p: Record<string, unknown>) => Record<string, unknown> },
  healthOk = true,
  svc: Partial<typeof H.svc> = {},
): Promise<{ steps: string[]; out: Outcome }> {
  H.mode = mode;
  H.healthOk = healthOk;
  H.svc = { model: "m", subfolder: "int8", cap: 30, ...svc };
  let step = emotionWindowKind.first;
  let progress: Record<string, unknown> = {};
  const steps: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    steps.push(step);
    if (before && step === before.step) progress = before.tamper(progress);
    const out = await emotionWindowKind.run({ step, args: { window_id: windowId }, progress, job: {} as never } as never) as Outcome & { step?: string; progress?: Record<string, unknown> };
    if (out.kind !== "next") return { steps, out };
    step = out.step!;
    progress = out.progress!;
  }
  throw new Error("the kind did not finish");
}

type WindowRow = {
  state: string; error: string | null; attempts: number; history: number; planned: number | null; scored: number | null; failed: number | null;
  skipped: number | null; calls: number | null; at: string;
  model: string | null; model_key: string | null; subfolder: string | null; cap_s: number | null; room_day_id: string | null;
};
const windowRow = async (id: string) =>
  ((await pg.sql`SELECT state, error, attempts, jsonb_array_length(failure_history) AS history,
                        segments_planned AS planned, segments_scored AS scored, segments_failed AS failed, segments_skipped AS skipped,
                        calls, scored_at::text AS at, model, model_key, subfolder, cap_s, room_day_id
                   FROM room_emotion_window WHERE window_id = ${id}`) as WindowRow[])[0]!;
/** The same identifying facts, as every segment row of the window carries them. */
const segmentFacts = async (id: string) =>
  (await pg.sql`SELECT DISTINCT model, model_key, subfolder, cap_s, room_day_id FROM room_span_emotion WHERE window_id = ${id} AND state <> 'skipped'`) as Array<Record<string, unknown>>;
const segmentStates = async (id: string) =>
  ((await pg.sql`SELECT state FROM room_span_emotion WHERE window_id = ${id} ORDER BY segment_start_ms`) as Array<{ state: string }>).map((r) => r.state);

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [
  // ─── E16: unscorable is not a failure, and only SENT unscorable rows leave `planned` ─────────────────
  {
    name: "E16 — every sent span refused as unscorable: the window is OK, not zero-scored, and spends no retry",
    fn: async () => {
      seedWindow("bw_e16_unscorable");
      const { out } = await runKind("bw_e16_unscorable", "all_unscorable");
      expect(out.kind).toBe("done");
      expect(await segmentStates("bw_e16_unscorable")).toEqual(["unscorable", "unscorable"]);
      expect(await windowRow("bw_e16_unscorable")).toMatchObject({ state: "ok", error: null, attempts: 1, planned: 2, scored: 0, failed: 0 });
      const u = (await pg.sql`SELECT segments_unscorable AS n FROM room_emotion_window WHERE window_id = ${"bw_e16_unscorable"}`) as Array<{ n: number }>;
      expect(u[0]!.n).toBe(2);
      const rows = (await pg.sql`SELECT speech_ms, service_speech_ms, speech_basis FROM room_span_emotion WHERE window_id = ${"bw_e16_unscorable"} ORDER BY segment_start_ms`) as Array<Record<string, unknown>>;
      expect(rows).toEqual([{ speech_ms: 9000, service_speech_ms: 400, speech_basis: "diarize_segments" }, { speech_ms: 8000, service_speech_ms: 400, speech_basis: "diarize_segments" }]);
    },
  },
  {
    name: "E16 — one refused, one genuinely failed, none scored: still zero-scored, still FAILED",
    fn: async () => {
      seedWindow("bw_e16_mixed");
      const { out } = await runKind("bw_e16_mixed", "first_unscorable_rest_fail");
      expect(out.kind).toBe("fail");
      expect(out.error).toContain("emotion_zero_scored");
      expect(await windowRow("bw_e16_mixed")).toMatchObject({ state: "failed", planned: 2, scored: 0, failed: 1 });
    },
  },
  {
    name: "E16 — spans never sent are NOT subtracted from planned: a lone sent span that fails still fails the window",
    fn: async () => {
      // Speaker 1 speaks only 900 ms inside its run (under min_speech_s), so its run is recorded unscorable and never sent.
      // Its turns still bind to it — speaker 1 has NO interval at all would be stale segments, not a quiet speaker.
      seedWindow("bw_e16_unsent", { segmentsJson: JSON.stringify([{ start_ms: 0, end_ms: 9000, speaker_idx: 0 }, { start_ms: 12000, end_ms: 12500, speaker_idx: 1 }, { start_ms: 17000, end_ms: 17400, speaker_idx: 1 }]) });
      const { out } = await runKind("bw_e16_unsent", "all_fail");
      expect(out.kind, "subtracting the unsent row would leave planned 0 and pass this window").toBe("fail");
      expect(await segmentStates("bw_e16_unsent")).toEqual(["failed", "unscorable"]);
      expect(await windowRow("bw_e16_unsent")).toMatchObject({ state: "failed", planned: 1, scored: 0, failed: 1 });
    },
  },
  {
    name: "E24 R9/R8 — stale by RUN ID on Postgres: diarize_stale, named, nothing written, and a rerun spends NO attempt",
    fn: async () => {
      seedWindow("bw_e24_stale", { segmentsRunId: "run_older" });
      const first = await runKind("bw_e24_stale", "all_ok");
      expect(first.steps).toEqual(["prepare"]);
      expect(errorCodeOf(first.out.error!)).toBe("diarize_segments_stale");
      expect(await windowRow("bw_e24_stale")).toMatchObject({ state: "diarize_stale", attempts: 1 });
      const again = await runKind("bw_e24_stale", "all_ok");
      expect(errorCodeOf(again.out.error!)).toBe("diarize_segments_stale");
      expect(await windowRow("bw_e24_stale"), "R8: the same stale window run again spends no attempt").toMatchObject({ state: "diarize_stale", attempts: 1 });
      expect(await segmentStates("bw_e24_stale"), "nothing measured against another run's intervals").toEqual([]);
    },
  },
  {
    name: "E24 — segments with no recorded writer run (segments_run_id NULL) are stale on Postgres: an unknown run is not trusted",
    fn: async () => {
      seedWindow("bw_e24_legacy", { segmentsRunId: null });
      const { out } = await runKind("bw_e24_legacy", "all_ok");
      expect(errorCodeOf(out.error!)).toBe("diarize_segments_stale");
      expect(await windowRow("bw_e24_legacy")).toMatchObject({ state: "diarize_stale" });
    },
  },
  {
    name: "E24 R8 on Postgres — a window that FAILED an attempt before 0099 goes stale against the SAME run and spends no attempt",
    fn: async () => {
      // The realistic deploy shape: an attempt failed on weather under this run, then 0099 lands and the row's
      // segments_run_id is NULL (provenance unknown). The stale write meets a `failed` row for the same run, so
      // the upsert's no-op guard does not hide the attempt arithmetic.
      seedWindow("bw_e24_failed_then_stale");
      const down = await runKind("bw_e24_failed_then_stale", "all_ok", undefined, false);
      expect(errorCodeOf(down.out.error!)).toBe("emotion_unavailable");
      expect(await windowRow("bw_e24_failed_then_stale")).toMatchObject({ state: "failed", attempts: 1 });
      pg.exec(`UPDATE room_diarize_window SET segments_run_id = NULL WHERE window_id = 'bw_e24_failed_then_stale'`);
      const stale = await runKind("bw_e24_failed_then_stale", "all_ok");
      expect(errorCodeOf(stale.out.error!)).toBe("diarize_segments_stale");
      expect(await windowRow("bw_e24_failed_then_stale"), "R8: the stale write spends no attempt, and the earlier failure is kept in history")
        .toMatchObject({ state: "diarize_stale", attempts: 1, history: 1 });
    },
  },
  {
    name: "E24 W5 on Postgres — a window scored under an earlier run keeps those span rows when a later run leaves its segments stale",
    fn: async () => {
      seedWindow("bw_e24_keep");
      const scored = await runKind("bw_e24_keep", "all_ok");
      expect(scored.out.kind).toBe("done");
      expect(await segmentStates("bw_e24_keep")).toEqual(["scored", "scored"]);
      // A later diarize run that kept the ok row's segments, exactly as recordDiarizeWindow does: last_run_id moves.
      pg.exec(`UPDATE room_diarize_window SET last_run_id = 'run_bw_e24_keep_newer' WHERE window_id = 'bw_e24_keep';`);
      const stale = await runKind("bw_e24_keep", "all_ok");
      expect(errorCodeOf(stale.out.error!)).toBe("diarize_segments_stale");
      expect(await segmentStates("bw_e24_keep"), "the earlier run's span rows are left as they were").toEqual(["scored", "scored"]);
    },
  },
  {
    name: "E24 R10 / E25 R13 R14 R15 on Postgres — the keep-rule stands; ONLY a diarize_stale window accepts a fresh OK run, speakers included, ONCE per mark",
    fn: async () => {
      const { recordDiarizeWindow, repairStaleDiarizeSegments, speakersForStorage } = await import("@/lib/stt/diarize-window");
      type Speakers = Parameters<typeof speakersForStorage>[0];
      const fresh = [{ start_ms: 0, end_ms: 20000, speaker_idx: 0 }];
      // Two runs' speakers that DIFFER, so a repair that leaves speakers_json behind is visible (E25 R14 / B5).
      const freshSpeakers = [{ idx: 0, label: "Dr", type: "clinician", source: "auto", clinician_id: "doc_fresh", confidence: 0.9 }] as unknown as Speakers;
      const laterSpeakers = [{ idx: 0, label: "Patient", type: "patient", source: "heuristic" }] as unknown as Speakers;
      const diarizeRow = async (id: string) =>
        ((await pg.sql`SELECT state, speakers_json, segments_json, segments_run_id, last_run_id FROM room_diarize_window WHERE window_id = ${id}`) as Array<{ state: string; speakers_json: unknown; segments_json: unknown; segments_run_id: string | null; last_run_id: string }>)[0]!;
      const mark = async (id: string) =>
        ((await pg.sql`SELECT state, stale_segments_run_id FROM room_emotion_window WHERE window_id = ${id}`) as Array<{ state: string; stale_segments_run_id: string | null }>)[0]!;
      const rerun = (id: string, runId: string, speakers: Speakers = freshSpeakers, segments: unknown[] = fresh) =>
        recordDiarizeWindow({ windowId: id, roomDayId: "rd_1", state: speakers.length === 0 ? "no_speakers" : "ok", error: null, speakers, segments, clipR2Key: `clips/${id}.webm`, timing: null, runId });

      // A stale window: its emotion row says so, and names the segments it judged.
      seedWindow("bw_e24_repair", { segmentsRunId: "run_older" });
      await runKind("bw_e24_repair", "all_ok");
      expect(await mark("bw_e24_repair"), "the mark records the segments it judged").toEqual({ state: "diarize_stale", stale_segments_run_id: "run_older" });

      // E25 R13 — a NO_SPEAKERS run is refused, not imported: nothing of it lands in the ok row.
      await rerun("bw_e24_repair", "run_nospeakers", [] as unknown as Speakers, []);
      expect(await repairStaleDiarizeSegments({ windowId: "bw_e24_repair", runId: "run_nospeakers", runState: "no_speakers", speakers: [] as unknown as Speakers, segments: [] }), "R13: a no_speakers run is never adopted").toBe(false);
      expect(await diarizeRow("bw_e24_repair"), "R13: state, speakers, segments and their run all still describe the ok run")
        .toMatchObject({ state: "ok", speakers_json: [], segments_run_id: "run_older", last_run_id: "run_nospeakers" });
      expect((await diarizeRow("bw_e24_repair")).segments_json).not.toEqual([]);

      await rerun("bw_e24_repair", "run_fresh");
      expect(await diarizeRow("bw_e24_repair"), "the keep-rule is unchanged: the ok row keeps its segments").toMatchObject({ segments_run_id: "run_older", last_run_id: "run_fresh", speakers_json: [] });
      expect(await repairStaleDiarizeSegments({ windowId: "bw_e24_repair", runId: "run_older_than_last", runState: "ok", speakers: freshSpeakers, segments: fresh }), "only the latest run may repair").toBe(false);
      expect(await repairStaleDiarizeSegments({ windowId: "bw_e24_repair", runId: "run_fresh", runState: "ok", speakers: freshSpeakers, segments: fresh }), "an ok run after a refused no_speakers run still cures").toBe(true);
      expect(await diarizeRow("bw_e24_repair"), "R14: the repair replaces speakers_json with the fresh run's, beside its segments")
        .toMatchObject({ segments_run_id: "run_fresh", last_run_id: "run_fresh", segments_json: fresh, speakers_json: speakersForStorage(freshSpeakers) });
      expect(await repairStaleDiarizeSegments({ windowId: "bw_e24_repair", runId: "run_fresh", runState: "ok", speakers: freshSpeakers, segments: fresh }), "segments already this run's are not repaired twice").toBe(false);

      // E25 R15 — the SAME mark, a SECOND ok run before any rescore: the mark is spent, the keep-rule governs.
      expect((await mark("bw_e24_repair")).state, "no rescore happened in between").toBe("diarize_stale");
      await rerun("bw_e24_repair", "run_later", laterSpeakers, [{ start_ms: 0, end_ms: 9000, speaker_idx: 0 }]);
      expect(await repairStaleDiarizeSegments({ windowId: "bw_e24_repair", runId: "run_later", runState: "ok", speakers: laterSpeakers, segments: [{ start_ms: 0, end_ms: 9000, speaker_idx: 0 }] }), "R15: one stale mark permits one repair").toBe(false);
      expect(await diarizeRow("bw_e24_repair"), "R15: the second run meets the keep-rule")
        .toMatchObject({ segments_run_id: "run_fresh", last_run_id: "run_later", segments_json: fresh, speakers_json: speakersForStorage(freshSpeakers) });

      // A healthy window (emotion ok): the same fresh run is NOT accepted — the keep-rule stands for it.
      seedWindow("bw_e24_norepair");
      expect((await runKind("bw_e24_norepair", "all_ok")).out.kind).toBe("done");
      await rerun("bw_e24_norepair", "run_fresh_2");
      expect(await repairStaleDiarizeSegments({ windowId: "bw_e24_norepair", runId: "run_fresh_2", runState: "ok", speakers: freshSpeakers, segments: fresh })).toBe(false);
      expect(await diarizeRow("bw_e24_norepair")).toMatchObject({ segments_run_id: "run_bw_e24_norepair", last_run_id: "run_fresh_2", speakers_json: [] });
      expect(await mark("bw_e24_norepair"), "a finished window carries no mark").toEqual({ state: "ok", stale_segments_run_id: null });

      // A window whose segments have NO recorded writer and whose emotion row is ok (scored before 0099): its NULL
      // mark matches its NULL segments_run_id, so only the diarize_stale STATE keeps the repair out.
      seedWindow("bw_e25_legacy_ok", { segmentsRunId: null, turns: false });
      pg.exec(`INSERT INTO room_emotion_window (window_id, room_day_id, state, diarize_run_id) VALUES ('bw_e25_legacy_ok', 'rd_1', 'ok', 'run_bw_e25_legacy_ok')`);
      await rerun("bw_e25_legacy_ok", "run_legacy_fresh");
      expect(await repairStaleDiarizeSegments({ windowId: "bw_e25_legacy_ok", runId: "run_legacy_fresh", runState: "ok", speakers: freshSpeakers, segments: fresh }), "an unmarked window is never repaired, NULL provenance or not").toBe(false);
      expect(await diarizeRow("bw_e25_legacy_ok")).toMatchObject({ segments_run_id: null, last_run_id: "run_legacy_fresh", speakers_json: [] });
    },
  },
  {
    name: "E25 R15 on Postgres — a repaired window that then FAILS on weather drops its mark: a failed row carries none",
    fn: async () => {
      const { recordDiarizeWindow, repairStaleDiarizeSegments } = await import("@/lib/stt/diarize-window");
      const segs = JSON.parse(SEGMENTS_JSON) as unknown[];
      seedWindow("bw_e25_markdrop", { segmentsRunId: "run_older" });
      await runKind("bw_e25_markdrop", "all_ok");
      await recordDiarizeWindow({ windowId: "bw_e25_markdrop", roomDayId: "rd_1", state: "ok", error: null, speakers: [], segments: segs, clipR2Key: "clips/bw_e25_markdrop.webm", timing: null, runId: "run_bw_e25_markdrop" });
      pg.exec(`UPDATE room_diarize_window SET last_run_id = 'run_markdrop_fresh' WHERE window_id = 'bw_e25_markdrop'`);
      pg.exec(`UPDATE room_turn_speaker SET run_id = 'run_markdrop_fresh' WHERE window_id = 'bw_e25_markdrop'`);
      expect(await repairStaleDiarizeSegments({ windowId: "bw_e25_markdrop", runId: "run_markdrop_fresh", runState: "ok", speakers: [], segments: segs })).toBe(true);
      const down = await runKind("bw_e25_markdrop", "all_ok", undefined, false);
      expect(errorCodeOf(down.out.error!)).toBe("emotion_unavailable");
      const m = (await pg.sql`SELECT state, stale_segments_run_id FROM room_emotion_window WHERE window_id = 'bw_e25_markdrop'`) as Array<{ state: string; stale_segments_run_id: string | null }>;
      expect(m[0], "the failed write replaces the mark with nothing").toEqual({ state: "failed", stale_segments_run_id: null });
    },
  },
  {
    // E26 T4 — THE STRADDLE ROW'S CURE, END TO END, AND THE ONE MUTANT THAT PASSES EVERYTHING ELSE.
    // `IS NOT DISTINCT FROM` in repairStaleDiarizeSegments is what matches a NULL mark to NULL stored provenance.
    // Changed to `=`, NULL = NULL is NULL, the EXISTS never matches, and every NULL-marked window is permanently
    // incurable — the population e25 itself creates, and the population R18's NO BACKFILL ruling rests on being
    // curable. Nothing else in this suite fails under that change.
    // RULE 21: this case runs the whole chain in one fixture — score, a pre-E24 re-diarize that loses provenance,
    // the mark, the cure, and the rescore — rather than seeding the mark and asserting the repair alone.
    name: "E26 T4 on Postgres — a stale window whose mark is NULL is cured by a fresh ok run: score -> re-diarize -> mark -> cure -> rescore",
    fn: async () => {
      const { recordDiarizeWindow, repairStaleDiarizeSegments } = await import("@/lib/stt/diarize-window");
      const id = "bw_e26_null_mark";
      const mark = async () =>
        ((await pg.sql`SELECT state, stale_segments_run_id FROM room_emotion_window WHERE window_id = ${id}`) as Array<{ state: string; stale_segments_run_id: string | null }>)[0]!;
      const diarize = async () =>
        ((await pg.sql`SELECT segments_run_id, last_run_id FROM room_diarize_window WHERE window_id = ${id}`) as Array<{ segments_run_id: string | null; last_run_id: string }>)[0]!;

      // 1. SCORE. A healthy window, its segments recorded as run_<id>'s.
      seedWindow(id);
      expect((await runKind(id, "all_ok")).out.kind).toBe("done");
      expect(await windowRow(id)).toMatchObject({ state: "ok", attempts: 1 });
      expect(await segmentStates(id)).toEqual(["scored", "scored"]);

      // 2. RE-DIARIZE, by a PRE-E24 writer during the straddle: it names no segments_run_id, so the column is
      //    cleared while last_run_id moves. This is the write tests/fixtures/pre-e24-diarize-window-insert.sql holds.
      pg.exec(`UPDATE room_diarize_window SET segments_run_id = NULL, last_run_id = 'run_straddle_writer' WHERE window_id = '${id}'`);
      expect(await diarize()).toEqual({ segments_run_id: null, last_run_id: "run_straddle_writer" });

      // 3. MARK. The emotion job — not a seed — records diarize_stale, and the mark it writes is NULL, because
      //    NULL is what it judged. No attempt is spent (E24 R8).
      const stale = await runKind(id, "all_ok");
      expect(errorCodeOf(stale.out.error!)).toBe("diarize_segments_stale");
      expect(await mark(), "the mark records the segments it judged: an unrecorded writer").toEqual({ state: "diarize_stale", stale_segments_run_id: null });
      expect(await windowRow(id)).toMatchObject({ state: "diarize_stale", attempts: 1 });

      // 4. CURE. A fresh E24 ok run. The keep-rule leaves the segments alone; the named repair adopts them —
      //    and this is the step that dies under `=`, because both sides of the comparison are NULL.
      const fresh = [{ start_ms: 0, end_ms: 20000, speaker_idx: 0 }];
      await recordDiarizeWindow({ windowId: id, roomDayId: "rd_1", state: "ok", error: null, speakers: [], segments: fresh, clipR2Key: `clips/${id}.webm`, timing: null, runId: "run_e26_cure" });
      expect(await diarize(), "the keep-rule is unchanged: an ok row keeps its segments").toEqual({ segments_run_id: null, last_run_id: "run_e26_cure" });
      expect(await repairStaleDiarizeSegments({ windowId: id, runId: "run_e26_cure", runState: "ok", speakers: [], segments: fresh }),
        "a NULL mark against NULL stored provenance IS a match — `=` would never cure this row").toBe(true);
      expect(await diarize()).toEqual({ segments_run_id: "run_e26_cure", last_run_id: "run_e26_cure" });

      // 5. RESCORE. The window is offered again (its emotion row names an older run) and finishes ok.
      pg.exec(`UPDATE room_turn_speaker SET run_id = 'run_e26_cure' WHERE window_id = '${id}'`);
      const cured = await runKind(id, "all_ok");
      expect(cured.out.kind, `the cured window scores; ${JSON.stringify(cured.out)}`).toBe("done");
      expect(await windowRow(id), "cured: an ok row under the fresh run, and the mark is gone").toMatchObject({ state: "ok" });
      expect(await mark()).toEqual({ state: "ok", stale_segments_run_id: null });
    },
  },
  {
    // E26 R32 / M1. stale_segments_run_id was written by the DO UPDATE but missing from the comparison tuple, so a
    // rewrite that changes ONLY the mark wrote nothing: the row kept the older segments_run_id. The mark permits
    // exactly one repair (E25 R15), so a stale mark is a cure pointed at the wrong run.
    name: "E26 R32 on Postgres — a MARK-ONLY rewrite lands: same run, same state, a different judged segments_run_id",
    fn: async () => {
      const { recordStaleWindow } = await import("@/lib/emotion/store");
      const id = "bw_e26_markonly";
      seedWindow(id, { turns: false });
      const row = async () =>
        ((await pg.sql`SELECT state, stale_segments_run_id, attempts, scored_at::text AS at FROM room_emotion_window WHERE window_id = ${id}`) as Array<{ state: string; stale_segments_run_id: string | null; attempts: number; at: string }>)[0]!;
      const stale = (segmentsRunId: string | null) =>
        recordStaleWindow({ windowId: id, roomDayId: "rd_1", diarizeRunId: "run_same", segmentsRunId, reason: "diarize segments belong to another run" });

      await stale("seg_A");
      // attempts is 1 from the INSERT (0089 defaults it to 1, CHECK attempts >= 1) and must not move on a stale rewrite (E24 R8).
      expect(await row()).toMatchObject({ state: "diarize_stale", stale_segments_run_id: "seg_A", attempts: 1 });

      // Only the judged segments differ. Everything else the tuple compares is identical.
      await stale("seg_B");
      expect(await row(), "the mark is the only thing that changed, and it is the thing that must be right")
        .toMatchObject({ state: "diarize_stale", stale_segments_run_id: "seg_B", attempts: 1 });

      // And NULL is a value here too: a later judgement of unrecorded provenance replaces a named one.
      await stale(null);
      expect(await row()).toMatchObject({ state: "diarize_stale", stale_segments_run_id: null, attempts: 1 });

      // C9 still holds: a rewrite that changes NOTHING writes nothing, so scored_at does not move.
      const before = await row();
      await stale(null);
      expect(await row(), "an identical stale write is still a no-op (S1 FIX3b C9)").toEqual(before);
    },
  },
  {
    // E26 R35 — the repair's last two guards. Both survived the E26 mutation run because no fixture reached them:
    // today's writers do not produce these rows. That is a claim about TODAY'S writers, and the writers have changed
    // three times in two days — F1 was latent until E17 changed the drain, M1 until 0099 added a column. Each guard
    // decides a RETURN VALUE (measured: dropped, each returns true where the real code returns false), so each gets
    // an assertion. The rows are built by hand, because the point is that no current writer builds them.
    name: "E26 R35 on Postgres — the repair's last two guards each decide a return value: a FAILED diarize row, and segments already this run's",
    fn: async () => {
      const { repairStaleDiarizeSegments } = await import("@/lib/stt/diarize-window");
      const fresh = [{ start_ms: 0, end_ms: 20000, speaker_idx: 0 }];
      const diarize = async (id: string) =>
        ((await pg.sql`SELECT state, segments_run_id, last_run_id FROM room_diarize_window WHERE window_id = ${id}`) as Array<{ state: string; segments_run_id: string | null; last_run_id: string }>)[0]!;

      // (a) E26-4 — `AND d.state = 'ok'`. A FAILED diarize row that still carries a stale mark: the repair imports
      // content into a row whose state names a failure, so state and content would describe different runs.
      const failed = "bw_e26_failed_row";
      seedWindow(failed, { turns: false, segmentsRunId: "run_A" });
      pg.exec(`
        UPDATE room_diarize_window SET state = 'failed', error = 'boom', last_run_id = 'run_B' WHERE window_id = '${failed}';
        INSERT INTO room_emotion_window (window_id, room_day_id, state, diarize_run_id, error, stale_segments_run_id)
        VALUES ('${failed}', 'rd_1', 'diarize_stale', 'run_B', 'stale', 'run_A');`);
      expect(await repairStaleDiarizeSegments({ windowId: failed, runId: "run_B", runState: "ok", speakers: [], segments: fresh }),
        "a failed diarize row is not repaired: its state names a failure and the content would name a run").toBe(false);
      expect(await diarize(failed), "and nothing of the fresh run landed").toMatchObject({ state: "failed", segments_run_id: "run_A", last_run_id: "run_B" });

      // (b) E26-6 — `AND d.segments_run_id IS DISTINCT FROM ${runId}`. The stored segments are ALREADY this run's and
      // the mark names them too: there is nothing to replace, so the repair must not report that it acted.
      const same = "bw_e26_same_run";
      seedWindow(same, { turns: false, segmentsRunId: "run_C" });
      pg.exec(`
        UPDATE room_diarize_window SET last_run_id = 'run_C' WHERE window_id = '${same}';
        INSERT INTO room_emotion_window (window_id, room_day_id, state, diarize_run_id, error, stale_segments_run_id)
        VALUES ('${same}', 'rd_1', 'diarize_stale', 'run_C', 'stale', 'run_C');`);
      expect(await repairStaleDiarizeSegments({ windowId: same, runId: "run_C", runState: "ok", speakers: [], segments: fresh }),
        "segments already this run's are not repaired: a repair that changes nothing must not answer true").toBe(false);
      expect(await diarize(same)).toMatchObject({ state: "ok", segments_run_id: "run_C", last_run_id: "run_C" });
    },
  },
  {
    name: "E25 R15 / 0099 — the database refuses a stale mark on a row that is not diarize_stale",
    fn: async () => {
      seedWindow("bw_e25_markchk", { turns: false });
      expect(() => pg.exec(`
        INSERT INTO room_emotion_window (window_id, room_day_id, state, diarize_run_id, error, stale_segments_run_id)
        VALUES ('bw_e25_markchk', 'rd_1', 'failed', 'run_bw_e25_markchk', 'x', 'run_x');
      `)).toThrow(/room_emotion_window_stale_segments_chk/);
    },
  },
  {
    name: "E16(iii) / 0097 — the database refuses a diarize_segments row with no speech_ms",
    fn: async () => {
      seedWindow("bw_e16_basischk", { turns: false });
      expect(() => pg.exec(`
        INSERT INTO room_span_emotion (window_id, diarize_run_id, run_start_ms, run_end_ms, chunk_idx, chunk_count, segment_start_ms, segment_end_ms,
          speaker_idx, source_refs, clip_start_s, clip_end_s, state, reason, speech_basis)
        VALUES ('bw_e16_basischk', 'run_bw_e16_basischk', 1, 2, 0, 1, 1, 2, 0, ARRAY['x'], 0, 0.001, 'failed', 'x', 'diarize_segments');
      `)).toThrow(/room_span_emotion_basis_measure_chk/);
    },
  },
  {
    name: "E16 / 0097 — a row written without speech_basis reads pre_speech_fraction: a pre-fix score cannot pass as post-fix",
    fn: async () => {
      seedWindow("bw_e16_prefix", { turns: false });
      pg.exec(`
        INSERT INTO room_span_emotion (window_id, diarize_run_id, run_start_ms, run_end_ms, chunk_idx, chunk_count, segment_start_ms, segment_end_ms,
          speaker_idx, source_refs, clip_start_s, clip_end_s, state, reason)
        VALUES ('bw_e16_prefix', 'run_bw_e16_prefix', 1, 2, 0, 1, 1, 2, 0, ARRAY['x'], 0, 0.001, 'failed', 'malformed_scores');
      `);
      const r = (await pg.sql`SELECT speech_basis, speech_ms FROM room_span_emotion WHERE window_id = ${"bw_e16_prefix"}`) as Array<Record<string, unknown>>;
      expect(r).toEqual([{ speech_basis: "pre_speech_fraction", speech_ms: null }]);
    },
  },
  // ─── N1: zero scored, and its retry ───────────────────────────────────────────────────────────
  {
    name: "N1 — zero scored: window FAILED / emotion_zero_scored from the rows, and the job fails",
    fn: async () => {
      seedWindow("bw_zero");
      const { steps, out } = await runKind("bw_zero", "all_fail");
      expect(steps).toEqual(["prepare", "warm", "score", "finish"]);
      expect(out.kind).toBe("fail");
      expect(errorCodeOf(out.error!), "the job error still leads with a published code").toBe("emotion_window_failed");
      expect(out.error).toContain("emotion_zero_scored");
      expect(await segmentStates("bw_zero")).toEqual(["failed", "failed"]);
      expect(await windowRow("bw_zero")).toMatchObject({ state: "failed", error: "emotion_zero_scored", attempts: 1, planned: 2, scored: 0, failed: 2 });
    },
  },
  {
    name: "N1 — a retry that scores everything REPLACES the failed rows; the window is OK with counts from them",
    fn: async () => {
      seedWindow("bw_retry");
      await runKind("bw_retry", "all_fail");
      const { out } = await runKind("bw_retry", "all_ok");
      expect(out.kind).toBe("done");
      expect(await segmentStates("bw_retry"), "a retry's writes used to collide with the earlier rows and do nothing").toEqual(["scored", "scored"]);
      expect(await windowRow("bw_retry")).toMatchObject({ state: "ok", error: null, attempts: 2, history: 1, planned: 2, scored: 2, failed: 0 });
      expect(out.result).toMatchObject({ scored: 2, failed: 0, window_row: "written" });
    },
  },
  {
    name: "partial success stays OK: one scored, one failed",
    fn: async () => {
      seedWindow("bw_partial");
      const { out } = await runKind("bw_partial", "first_ok");
      expect(out.kind).toBe("done");
      expect(await windowRow("bw_partial")).toMatchObject({ state: "ok", error: null, planned: 2, scored: 1, failed: 1 });
    },
  },

  // ─── C9: written if and only if it would change ───────────────────────────────────────────────
  {
    name: "C9 — a re-run REPRODUCING the same result writes nothing: scored_at and attempts untouched",
    fn: async () => {
      seedWindow("bw_same");
      await runKind("bw_same", "all_ok");
      const before = await windowRow("bw_same");
      const { out } = await runKind("bw_same", "all_ok");
      expect(out.kind).toBe("done");
      expect(out.result).toMatchObject({ window_row: "left_final" });
      const after = await windowRow("bw_same");
      expect(after.at, "nothing changed, so nothing is recorded as having changed").toBe(before.at);
      expect(after.attempts).toBe(before.attempts);
      expect(after).toMatchObject({ state: "ok", scored: 2, failed: 0 });
    },
  },
  {
    name: "C9 — a re-run of a settled OK window that scores NOTHING rewrites it: window FAILED over rows FAILED, never ok over failed",
    fn: async () => {
      seedWindow("bw_turn");
      await runKind("bw_turn", "all_ok");
      const before = await windowRow("bw_turn");
      const { out } = await runKind("bw_turn", "all_fail");
      expect(out.kind).toBe("fail");
      expect(await segmentStates("bw_turn")).toEqual(["failed", "failed"]);
      const after = await windowRow("bw_turn");
      expect(after).toMatchObject({ state: "failed", error: "emotion_zero_scored", scored: 0, failed: 2 });
      expect(after.at, "the row was rewritten").not.toBe(before.at);
    },
  },
  {
    name: "C9 — a re-run of a settled OK window that fails PARTWAY (fail(), not finish) rewrites it too — no special case",
    fn: async () => {
      seedWindow("bw_partway");
      await runKind("bw_partway", "all_ok");
      const { out } = await runKind("bw_partway", "warm_fail");
      expect(out.kind).toBe("fail");
      expect(await segmentStates("bw_partway"), "prepare replaced the rows; warm failed before any were scored").toEqual([]);
      expect(await windowRow("bw_partway")).toMatchObject({ state: "failed", scored: 0, failed: 0, skipped: 0 });
    },
  },
  {
    name: "C9 — a FAILED window retried to the same failure still writes, so attempts count toward the enqueue bound",
    fn: async () => {
      seedWindow("bw_failfail");
      await runKind("bw_failfail", "all_fail");
      await runKind("bw_failfail", "all_fail");
      expect(await windowRow("bw_failfail")).toMatchObject({ state: "failed", attempts: 2, history: 1 });
    },
  },

  // ─── finish: persisted, not remembered ────────────────────────────────────────────────────────
  {
    name: "finish — memory says nothing scored, the rows say everything did: OK, from the rows",
    fn: async () => {
      seedWindow("bw_mem_low");
      const { out } = await runKind("bw_mem_low", "all_ok", { step: "finish", tamper: (p) => ({ ...p, scored: 0, failed: 2 }) });
      expect(out.kind).toBe("done");
      expect(await windowRow("bw_mem_low")).toMatchObject({ state: "ok", scored: 2, failed: 0 });
    },
  },
  {
    name: "finish — memory says everything scored, the rows say nothing did: FAILED / emotion_zero_scored, from the rows",
    fn: async () => {
      seedWindow("bw_mem_high");
      const { out } = await runKind("bw_mem_high", "all_fail", { step: "finish", tamper: (p) => ({ ...p, scored: 2, failed: 0 }) });
      expect(out.kind).toBe("fail");
      expect(await windowRow("bw_mem_high")).toMatchObject({ state: "failed", error: "emotion_zero_scored", scored: 0, failed: 2 });
    },
  },

  // ─── C10: a failure's counts are the rows, or NULL ────────────────────────────────────────────
  {
    name: "C10 — a failure AFTER this attempt's rows (warm) records counts FROM THE ROWS, not the remembered 5 / 3",
    fn: async () => {
      seedWindow("bw_c10_rows");
      const { out } = await runKind("bw_c10_rows", "warm_fail", { step: "warm", tamper: (p) => ({ ...p, scored: 5, failed: 3, skipped: 4 }) });
      expect(out.kind).toBe("fail");
      expect(await segmentStates("bw_c10_rows")).toEqual([]);
      expect(await windowRow("bw_c10_rows")).toMatchObject({ state: "failed", planned: 2, scored: 0, failed: 0, skipped: 0 });
    },
  },
  {
    name: "C10 — a failure BEFORE this attempt's rows (health) records NULL, not an earlier attempt's rows",
    fn: async () => {
      seedWindow("bw_c10_pre");
      await runKind("bw_c10_pre", "all_ok");
      expect(await segmentStates("bw_c10_pre"), "the premise: an earlier attempt's rows are still there").toEqual(["scored", "scored"]);
      const { out } = await runKind("bw_c10_pre", "all_ok", undefined, false);
      expect(out.kind).toBe("fail");
      expect(await segmentStates("bw_c10_pre"), "health fails before the delete").toEqual(["scored", "scored"]);
      expect(await windowRow("bw_c10_pre")).toMatchObject({ state: "failed", planned: null, scored: null, failed: null, skipped: null, calls: null });
    },
  },
  {
    name: "C10 — a THROWN failure (the catch path) records NULL, not the remembered 7",
    fn: async () => {
      seedWindow("bw_c10_throw");
      const { out } = await runKind("bw_c10_throw", "throw", { step: "score", tamper: (p) => ({ ...p, scored: 7, failed: 1 }) });
      expect(out.kind).toBe("fail");
      expect(errorCodeOf(out.error!)).toBe("emotion_window_failed");
      expect(await windowRow("bw_c10_throw")).toMatchObject({ state: "failed", planned: null, scored: null, failed: null, skipped: null });
    },
  },

  // ─── planned = 0 ──────────────────────────────────────────────────────────────────────────────
  {
    name: "planned = 0: no_segments, error null, job done — it never reaches finish",
    fn: async () => {
      seedWindow("bw_quiet", { turns: false });
      const { steps, out } = await runKind("bw_quiet", "all_ok");
      expect(steps).toEqual(["prepare"]);
      expect(out.kind).toBe("done");
      expect(await windowRow("bw_quiet")).toMatchObject({ state: "no_segments", error: null, planned: 0, scored: 0 });
    },
  },
  // ─── C16 (FIX4, X1): the comparison covers what the segment rows can contradict ──────────────
  {
    name: "C16 — X1 as reproduced: same diarize run, identical counts, model AND subfolder changed → the window row IS rewritten and names the new model",
    fn: async () => {
      seedWindow("bw_x1");
      await runKind("bw_x1", "all_ok");
      const before = await windowRow("bw_x1");
      expect(before).toMatchObject({ model: "m", subfolder: "int8" });
      const { out } = await runKind("bw_x1", "all_ok", undefined, true, { model: "m2", subfolder: "fp16" });
      expect(out.result).toMatchObject({ scored: 2, failed: 0, window_row: "written" });
      const after = await windowRow("bw_x1");
      expect(after, "same counts, so only the model can have caused the write").toMatchObject({ state: "ok", scored: 2, failed: 0, model: "m2", subfolder: "fp16" });
      expect(after.at).not.toBe(before.at);
      expect(await segmentFacts("bw_x1"), "window row and segment rows now agree").toEqual([{ model: "m2", model_key: "wavlm", subfolder: "fp16", cap_s: 30, room_day_id: "rd_1" }]);
    },
  },
  {
    name: "C16 — model ALONE changed → rewritten",
    fn: async () => {
      seedWindow("bw_c16_model");
      await runKind("bw_c16_model", "all_ok");
      const before = await windowRow("bw_c16_model");
      await runKind("bw_c16_model", "all_ok", undefined, true, { model: "m2" });
      const after = await windowRow("bw_c16_model");
      expect(after).toMatchObject({ model: "m2", subfolder: "int8", cap_s: 30 });
      expect(after.at).not.toBe(before.at);
    },
  },
  {
    name: "C16 — subfolder ALONE changed → rewritten",
    fn: async () => {
      seedWindow("bw_c16_sub");
      await runKind("bw_c16_sub", "all_ok");
      const before = await windowRow("bw_c16_sub");
      await runKind("bw_c16_sub", "all_ok", undefined, true, { subfolder: "fp16" });
      const after = await windowRow("bw_c16_sub");
      expect(after).toMatchObject({ model: "m", subfolder: "fp16", cap_s: 30 });
      expect(after.at).not.toBe(before.at);
    },
  },
  {
    name: "C16 — cap_s ALONE changed (30 → 20, same two segments planned) → rewritten",
    fn: async () => {
      seedWindow("bw_c16_cap");
      await runKind("bw_c16_cap", "all_ok");
      const before = await windowRow("bw_c16_cap");
      await runKind("bw_c16_cap", "all_ok", undefined, true, { cap: 20 });
      const after = await windowRow("bw_c16_cap");
      expect(after, "the plan did not change under the smaller cap").toMatchObject({ planned: 2, scored: 2, cap_s: 20, model: "m" });
      expect(after.at).not.toBe(before.at);
    },
  },
  {
    name: "C16 — room_day_id NULL → value (a backfilled day) → rewritten; NULL against a value is a difference",
    fn: async () => {
      seedWindow("bw_c16_day", { windowRoomDay: null });
      await runKind("bw_c16_day", "all_ok");
      const before = await windowRow("bw_c16_day");
      expect(before.room_day_id).toBeNull();
      pg.exec("UPDATE bench_window SET room_day_id = 'rd_1' WHERE id = 'bw_c16_day';");
      await runKind("bw_c16_day", "all_ok");
      const after = await windowRow("bw_c16_day");
      expect(after.room_day_id).toBe("rd_1");
      expect(after.at).not.toBe(before.at);
    },
  },
  {
    name: "C16 — model_key ALONE changed, at the store (finish() writes a constant, so the kind cannot vary it) → rewritten; identical → not",
    fn: async () => {
      seedWindow("bw_c16_key", { turns: false });
      const f = { windowId: "bw_c16_key", roomDayId: "rd_1", diarizeRunId: "run_bw_c16_key", planned: 0, calls: 1, model: "m", model_key: "wavlm", subfolder: "int8", cap_s: 30 };
      expect((await finishEmotionWindow(f)).written_state).toBe("ok");
      const first = await windowRow("bw_c16_key");
      expect((await finishEmotionWindow(f)).written_state, "the control: identical, nothing written").toBeNull();
      expect((await windowRow("bw_c16_key")).at).toBe(first.at);
      expect((await finishEmotionWindow({ ...f, model_key: "wavlm_v2" })).written_state).toBe("ok");
      const after = await windowRow("bw_c16_key");
      expect(after.model_key).toBe("wavlm_v2");
      expect(after.at).not.toBe(first.at);
    },
  },
  {
    name: "C16 — cap_s NULL ↔ value is a difference in BOTH directions; NULL ↔ NULL and value ↔ same value are not",
    fn: async () => {
      seedWindow("bw_c16_null", { turns: false });
      const r = { windowId: "bw_c16_null", roomDayId: "rd_1", state: "no_segments" as const, diarizeRunId: "run_bw_c16_null", error: null,
                  counts: { planned: 0, scored: 0, skipped: 0, failed: 0, unscorable: 0, calls: 0 } };
      const at = async () => (await windowRow("bw_c16_null")).at;
      await recordEmotionWindow({ ...r, cap_s: null });
      const t0 = await at();
      await recordEmotionWindow({ ...r, cap_s: null });
      expect(await at(), "NULL against NULL: equal, nothing written").toBe(t0);
      await recordEmotionWindow({ ...r, cap_s: 30 });
      const t1 = await at();
      expect(t1, "NULL → value: written").not.toBe(t0);
      expect((await windowRow("bw_c16_null")).cap_s).toBe(30);
      await recordEmotionWindow({ ...r, cap_s: 30 });
      expect(await at(), "value against the same value: nothing written").toBe(t1);
      await recordEmotionWindow({ ...r, cap_s: null });
      expect(await at(), "value → NULL: written").not.toBe(t1);
      expect((await windowRow("bw_c16_null")).cap_s).toBeNull();
    },
  },
];

describe.skipIf(!HAVE_DOCKER)(`the emotion window — every case seeds its own state${REVERSE ? " (REVERSED ORDER)" : ""}`, () => {
  for (const c of REVERSE ? [...cases].reverse() : cases) it(c.name, c.fn);
});
