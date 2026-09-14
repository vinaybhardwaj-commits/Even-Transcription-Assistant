/**
 * E16 — an emotion score records how much of its span was this speaker speaking, and a span the service
 * cannot score is not a failure.
 *
 * THE DISCRIMINATING CASE IS REAL. `tests/fixtures/e16-a9-window.json` is E14's window, read from the
 * database as timings only: the diarizer's per-speaker intervals, the two turns Whisper produced, and
 * what the pre-E16 planner made of them. Chunk A9 was scored `neutral` over 29.07 s holding 2.28 s of its
 * speaker. Nothing here is a hand-typed span.
 *
 * The client is REAL (fetch is faked with the service's own response shapes, from app.py
 * score_segments). The planner and the store are real. The database is a recorder: it answers the reads
 * the job makes and records every write. The zero-scored rule itself is SQL and is proven against a real
 * postgres in s1-emotion-zero-scored.test.ts — which needs Docker, and did not run this round.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

type Row = Record<string, unknown>;
type Fixture = {
  window_ms: number;
  diarize_segments: Array<{ start_ms: number; end_ms: number; speaker_idx: number }>;
  turns: Array<{ speaker_idx: number; no_role_reason: string | null; start_ms: number; end_ms: number }>;
  pre_e16_spans: Array<{ speaker_idx: number; chunk_idx: number; chunk_count: number; clip_start_s: number; clip_end_s: number; state: string; reason: string | null; has_label: boolean }>;
};
const A9 = JSON.parse(readFileSync("tests/fixtures/e16-a9-window.json", "utf8")) as Fixture;
const WSTART = 1_789_289_100_000;

const DB = vi.hoisted(() => ({
  segmentsJson: null as unknown,
  turns: [] as Row[],
  writes: [] as Array<{ text: string; values: unknown[] }>,
  finishAnswer: { scored: 0, failed: 0, skipped: 0, unscorable: 0, zero_scored: false, written_state: "ok" } as Row,
}));
const REC = vi.hoisted(() => ({ calls: [] as Array<{ fn: string; seg: Row; score?: Row }>, finish: [] as Row[], window: [] as Row[] }));

vi.mock("@/lib/db", () => ({
  sql: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ");
    if (text.includes("FROM bench_window w LEFT JOIN room_diarize_window d"))
      return [{ id: "bw_e16", room_day_id: "rd_1", start_ms: WSTART, end_ms: WSTART + A9.window_ms, clip_r2_key: "clips/e16.webm", diarize_state: "ok", last_run_id: "run_1", segments_json: DB.segmentsJson }];
    if (text.includes("FROM room_turn_speaker t")) return DB.turns;
    if (text.includes("SELECT state, last_run_id FROM room_diarize_window")) return [{ state: "ok", last_run_id: "run_1" }];
    if (text.includes("WITH seg AS")) { DB.writes.push({ text, values }); return [DB.finishAnswer]; }
    if (/INSERT INTO|DELETE FROM/.test(text)) { DB.writes.push({ text, values }); return []; }
    return [];
  },
}));
vi.mock("@/lib/r2", () => ({ signGetUrl: async () => "https://r2.example/clip" }));
vi.mock("@/lib/emotion/store", async (orig) => {
  const real = await orig<typeof import("@/lib/emotion/store")>();
  return {
    ...real,
    writeScoredOrFailed: async (w: never, seg: Row, score: Row) => { REC.calls.push({ fn: "sent", seg, score }); return real.writeScoredOrFailed(w, seg as never, score as never); },
    writeUnscorable: async (w: never, seg: Row) => { REC.calls.push({ fn: "unsent", seg }); return real.writeUnscorable(w, seg as never); },
    finishEmotionWindow: async (f: Row) => { REC.finish.push(f); return real.finishEmotionWindow(f as never); },
    recordEmotionWindow: async (r: Row) => { REC.window.push(r); return real.recordEmotionWindow(r as never); },
  };
});

const { EMOTION_MODEL_ID, parseSegmentsResponse, emotionHealth, UNSCORABLE_UNNAMED } = await import("@/lib/emotion/client");
const { buildRuns, planSegments, speakerSpeechMs, splitByDiarizedSpeech } = await import("@/lib/emotion/segments");
const { PREFILTER_REASON, SPEECH_BASIS, writeScoredOrFailed } = await import("@/lib/emotion/store");
const { emotionWindowKind } = await import("@/lib/jobs/kinds/emotion-window");

const LABELS = { anger: 0.02, disgust: 0.01, enthusiasm: 0.05, fear: 0.02, happiness: 0.05, neutral: 0.8, sadness: 0.05 };
const env = (b: Row) => ({ ok: true, model_key: "wavlm", model: EMOTION_MODEL_ID, device: "mps", subfolder: null, max_duration_s: 60, results: b.results });
/** The service's classified answer, as app.py score_segments returns it. */
const classified = (index: number, seg: { start_s: number; end_s: number }) => ({ index, start_s: seg.start_s, end_s: seg.end_s, ok: true, labels: LABELS, top: [], duration_s: +(seg.end_s - seg.start_s).toFixed(3), inference_s: 1.1 });
/** The service's gate refusal, as app.py score_segments returns it since 11:46 on 14 Sep. */
const gateRefused = (index: number, seg: { start_s: number; end_s: number }, speech_s_est: number) => ({
  index, start_s: seg.start_s, end_s: seg.end_s, ok: true, unscorable: true, status: "skipped", skip_reason: "insufficient_speech",
  labels: {}, top: [], duration_s: +(seg.end_s - seg.start_s).toFixed(3), speech_s_est, rms: 0.004, inference_s: 0.0,
});

/** The fixture's turns on the room-day clock, as room_turn_speaker ⋈ cue returns them. */
const fixtureTurns = () => A9.turns.map((t, i) => ({ source_ref: `t${i}`, speaker_idx: t.speaker_idx, no_role_reason: t.no_role_reason, start_ms: WSTART + t.start_ms, end_ms: WSTART + t.end_ms }));

let HEALTH: Row = {};
let ANSWER: (index: number, seg: { start_s: number; end_s: number }) => Row = classified;
let SENT: Array<{ start_s: number; end_s: number }> = [];

beforeEach(() => {
  DB.segmentsJson = A9.diarize_segments; DB.turns = fixtureTurns(); DB.writes = [];
  DB.finishAnswer = { scored: 0, failed: 0, skipped: 0, unscorable: 0, zero_scored: false, written_state: "ok" };
  REC.calls = []; REC.finish = []; REC.window = []; SENT = [];
  HEALTH = { ok: true, max_duration_s: 60, min_speech_s: 1.5, silence_rms: 0.008, loaded: true };
  ANSWER = classified;
  process.env.EMOTION_ENABLED = "1";
  process.env.EMOTION_SEGMENTS_SECRET = "test-secret";
  process.env.EMOTION_BASE_URL = "https://emotion.test";
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/health")) return new Response(JSON.stringify(HEALTH), { status: 200 });
    const body = JSON.parse(String(init!.body)) as { segments: Array<{ start_s: number; end_s: number }> };
    const warm = body.segments.length === 1 && body.segments[0]!.start_s === 0 && body.segments[0]!.end_s === 1;
    if (!warm) SENT.push(...body.segments);
    return new Response(JSON.stringify(env({ results: body.segments.map((s, i) => (warm ? gateRefused(i, s, 0) : ANSWER(i, s))) })), { status: 200 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

async function drive(maxSteps = 12) {
  let step = emotionWindowKind.first;
  let progress: Row = {};
  const steps: string[] = [];
  for (let i = 0; i < maxSteps; i += 1) {
    steps.push(step);
    const out = await emotionWindowKind.run({ step, args: { window_id: "bw_e16" }, progress, job: {} as never, runner: "r1" });
    if (out.kind !== "next") return { steps, out: out as Row };
    step = (out as { step: string }).step;
    progress = (out as { progress: Row }).progress;
  }
  throw new Error("did not settle");
}

const ms = (s: number) => Math.round(s * 1000);

// ---------------------------------------------------------------------------------------------
describe("P1 — a span carries its speaker's measured speech, from the diarizer's own intervals", () => {
  it("the fixture is faithful: today's planner reproduces the 13 spans E14 analysed, bound for bound", () => {
    const { runs } = buildRuns(fixtureTurns());
    const planned = planSegments(runs, WSTART, 60);
    expect(planned.map((p) => [p.speaker_idx, p.chunk_idx, p.chunk_count, +p.clip_start_s.toFixed(2), +p.clip_end_s.toFixed(2)]))
      .toEqual(A9.pre_e16_spans.map((s) => [s.speaker_idx, s.chunk_idx, s.chunk_count, +s.clip_start_s.toFixed(2), +s.clip_end_s.toFixed(2)]));
  });

  it("A9: 2,280 ms of its speaker in 29,070 ms — and the other chunks as the database measured them", () => {
    const { runs } = buildRuns(fixtureTurns());
    const speech = planSegments(runs, WSTART, 60).map((p) => speakerSpeechMs(A9.diarize_segments, p.speaker_idx, ms(p.clip_start_s), ms(p.clip_end_s)));
    // Computed independently in SQL over the live rows (ETA-E16-REPORT §2), which reported seconds to 2 dp:
    // run A chunks 0–9, then run B. Compared at that 10 ms resolution; the exact values follow.
    expect(speech.map((v) => Math.round(v / 10) / 100)).toEqual([0, 0, 0, 0, 0, 3.73, 0, 0, 0, 2.28, 0.32, 4.53, 4.99]);
    expect(speech).toEqual([0, 0, 0, 0, 0, 3729, 0, 0, 0, 2280, 320, 4532, 4985]);
  });

  it("the union is the speaker's own: overlapping intervals count once, other speakers not at all, clipped to the span", () => {
    const iv = [{ start_ms: 0, end_ms: 1000, speaker_idx: 0 }, { start_ms: 500, end_ms: 1500, speaker_idx: 0 }, { start_ms: 0, end_ms: 5000, speaker_idx: 1 }, { start_ms: 4000, end_ms: 9000, speaker_idx: 0 }];
    expect(speakerSpeechMs(iv, 0, 0, 5000)).toBe(1500 + 1000);
    expect(speakerSpeechMs(iv, 1, 1000, 2000)).toBe(1000);
    expect(speakerSpeechMs(iv, 2, 0, 9000)).toBe(0);
  });
});

describe("P2 / V5 — planned MEANS scorable, at the service's min_speech_s read from /health", () => {
  it("/health's min_speech_s is read and required: a non-default value comes through; missing or unusable is refused", async () => {
    const f = (body: Row) => async () => new Response(JSON.stringify(body), { status: 200 });
    expect(await emotionHealth(f({ ok: true, max_duration_s: 60, min_speech_s: 2.5 }))).toMatchObject({ ok: true, min_speech_s: 2.5 });
    for (const min_speech_s of [undefined, "1.5", 0, -1, 60, Number.NaN]) {
      expect(await emotionHealth(f({ ok: true, max_duration_s: 60, min_speech_s })), String(min_speech_s)).toEqual({ ok: false, error: "health_min_speech_unreadable" });
    }
  });

  it("at the live minimum (1.5 s) four of A9's thirteen spans are sent; at a non-default 2.5 s A9 itself is not", () => {
    const planned = planSegments(buildRuns(fixtureTurns()).runs, WSTART, 60);
    const at = (min: number) => splitByDiarizedSpeech(planned, A9.diarize_segments, min);
    expect(at(1.5).scorable.map((s) => s.speech_ms)).toEqual([3729, 2280, 4532, 4985]);
    expect(at(1.5).unscorable).toHaveLength(9);
    expect(at(2.5).scorable.map((s) => s.speech_ms)).toEqual([3729, 4532, 4985]);
    // Exactly at the minimum is planned, as the service's own `speech_s_est < MIN_SPEECH_S` refusal scores it.
    expect(at(2.28).scorable.map((s) => s.speech_ms)).toContain(2280);
  });

  it("the job reads it from /health: min_speech_s 2.5 on the wire sends three spans, not four", async () => {
    HEALTH = { ...HEALTH, min_speech_s: 2.5 };
    await drive();
    expect(SENT.map((s) => +s.start_s.toFixed(2))).toEqual([151.21, 743.78, 771.41]);
  });
});

describe("V1 (as ruled: no cutoff this round) — A9 is scored, and its row says it was 7.8% its speaker", () => {
  it("the A9 window: 9 spans never sent, 4 sent; every row carries speech_ms and basis diarize_segments", async () => {
    DB.finishAnswer = { scored: 4, failed: 0, skipped: 0, unscorable: 9, zero_scored: false, written_state: "ok" };
    const { steps, out } = await drive();
    expect(steps).toEqual(["prepare", "warm", "score", "finish"]);
    expect(out.kind).toBe("done");
    const unsent = REC.calls.filter((c) => c.fn === "unsent");
    const sent = REC.calls.filter((c) => c.fn === "sent");
    expect(unsent.map((c) => c.seg.speech_ms)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 320]);
    expect(sent.map((c) => c.seg.speech_ms)).toEqual([3729, 2280, 4532, 4985]);
    expect(SENT, "only the scorable spans reach the service").toHaveLength(4);
    const a9 = sent.find((c) => c.seg.speech_ms === 2280)!;
    const spanMs = ms((a9.seg.clip_end_s as number) - (a9.seg.clip_start_s as number));
    expect(spanMs).toBe(29_070);
    expect(+((a9.seg.speech_ms as number) / spanMs).toFixed(3), "the fraction a reader weighs the label by").toBe(0.078);
    expect(REC.finish[0]!.planned, "planned is what was sent").toBe(4);
    // The never-sent rows carry their measured speech in the INSERT itself, not only in memory.
    const unsentInserts = DB.writes.filter((w) => w.text.includes("INSERT INTO room_span_emotion") && w.values.includes(PREFILTER_REASON));
    expect(unsentInserts).toHaveLength(9);
    expect(unsentInserts.some((w) => w.values.includes(320))).toBe(true);
    for (const w of unsentInserts) expect(w.values).toContain(SPEECH_BASIS);
  });

  it("a diarize row whose segments cannot be read fails BY NAME with a window row — never a silent no_segments", async () => {
    DB.segmentsJson = null;
    const { steps, out } = await drive();
    expect(steps).toEqual(["prepare"]);
    expect(out.kind).toBe("fail");
    expect(String(out.error)).toContain("diarize_not_ok");
    expect(REC.window[0], "a failed row, so the attempt bound applies").toMatchObject({ state: "failed" });
    expect(SENT).toHaveLength(0);
  });
});

describe("P5 — an ok:true answer carrying no labels is unscorable, not malformed", () => {
  it("the service's gate refusal parses as unscorable, with its reason and its own speech estimate", () => {
    const r = parseSegmentsResponse(env({ results: [gateRefused(0, { start_s: 0, end_s: 3.73 }, 0.42)] }), 1);
    expect(r.ok && r.results[0]).toEqual({ index: 0, ok: false, unscorable: true, reason: "insufficient_speech", service_speech_s: 0.42, duration_s: 3.73 });
  });
  it("ok:true with an EMPTY labels object and no flag is unscorable too, by name", () => {
    const r = parseSegmentsResponse(env({ results: [{ index: 0, ok: true, labels: {}, duration_s: 2, inference_s: 0 }] }), 1);
    expect(r.ok && r.results[0]).toMatchObject({ ok: false, unscorable: true, reason: UNSCORABLE_UNNAMED, service_speech_s: null });
  });
  it("but PARTIAL labels are still malformed_scores — a model fault is not silence", () => {
    const { sadness: _s, ...six } = LABELS; void _s;
    const r = parseSegmentsResponse(env({ results: [{ index: 0, ok: true, labels: six, duration_s: 2, inference_s: 1 }] }), 1);
    expect(r.ok && r.results[0]).toEqual({ index: 0, ok: false, reason: "malformed_scores" });
  });
  it("and ok:false stays a failure, whatever it says", () => {
    const r = parseSegmentsResponse(env({ results: [{ index: 0, ok: false, error: "inference_failed: RuntimeError" }] }), 1);
    expect(r.ok && r.results[0]).toEqual({ index: 0, ok: false, reason: "inference_failed: RuntimeError" });
  });
});

describe("V2 — a window of only unscorable spans does not trip zero-scored and spends no attempt", () => {
  it("E14's exhausted shape — one sub-1.5 s span — ends no_segments in prepare: nothing sent, no failed row", async () => {
    // The two windows that burned all three attempts each held ONE span of 0.50 s / 0.38 s.
    DB.turns = [{ source_ref: "t0", speaker_idx: 0, no_role_reason: "no_match", start_ms: WSTART + 81_000, end_ms: WSTART + 81_500 }];
    DB.segmentsJson = [{ start_ms: 81_000, end_ms: 81_500, speaker_idx: 0 }];
    const { steps, out } = await drive();
    expect(steps).toEqual(["prepare"]);
    expect(out).toMatchObject({ kind: "done", result: { segments: 0, unscorable: 1 } });
    expect(SENT).toHaveLength(0);
    expect(REC.window).toHaveLength(1);
    expect(REC.window[0]).toMatchObject({ state: "no_segments", counts: { planned: 0, unscorable: 1, failed: 0 } });
    expect(REC.calls.map((c) => c.fn)).toEqual(["unsent"]);
  });

  it("every SENT span refused by the gate: rows are unscorable (never failed), and finish is asked with planned = sent", async () => {
    ANSWER = (i, s) => gateRefused(i, s, 0.9);
    DB.finishAnswer = { scored: 0, failed: 0, skipped: 0, unscorable: 13, zero_scored: false, written_state: "ok" };
    const { out } = await drive();
    expect(out.kind).toBe("done");
    const sent = REC.calls.filter((c) => c.fn === "sent");
    expect(sent).toHaveLength(4);
    // The row is written through stateFor: the store's own classification.
    const inserts = DB.writes.filter((w) => w.text.includes("INSERT INTO room_span_emotion") && w.values.includes("insufficient_speech"));
    expect(inserts).toHaveLength(4);
    for (const w of inserts) {
      expect(w.values).toContain("unscorable");
      expect(w.values).not.toContain("failed");
    }
  });

  it("the zero-scored statement subtracts only SENT unscorable rows, keyed by the never-sent reason it is bound", async () => {
    await drive();
    const finish = DB.writes.find((w) => w.text.includes("WITH seg AS"))!;
    expect(finish.values, "the never-sent reason travels as a bound parameter").toContain(PREFILTER_REASON);
    expect(finish.text).toMatch(/- seg\.unscorable_sent > 0 AND seg\.scored = 0/);
  });
});

describe("V3 — a scorable span the service genuinely fails still fails, and still counts", () => {
  it("inference_failed on a sent span is written failed — not unscorable — and a zero-scored finish fails the job", async () => {
    ANSWER = (i, s) => ({ index: i, start_s: s.start_s, end_s: s.end_s, ok: false, error: "inference_failed: RuntimeError" });
    DB.finishAnswer = { scored: 0, failed: 4, skipped: 0, unscorable: 9, zero_scored: true, written_state: "failed" };
    const { out } = await drive();
    const failedInserts = DB.writes.filter((w) => w.text.includes("INSERT INTO room_span_emotion") && w.values.includes("failed"));
    expect(failedInserts).toHaveLength(4);
    expect(failedInserts.every((w) => !w.values.includes("unscorable"))).toBe(true);
    expect(out.kind).toBe("fail");
    expect(String(out.error)).toContain("emotion_zero_scored");
  });
});

describe("V4 — speech_ms reaches room_span_emotion, with both numbers where both exist", () => {
  const seg = { speaker_idx: 0, source_refs: ["t0"], run_start_ms: 1, run_end_ms: 2, chunk_idx: 0, chunk_count: 1, start_ms: 10, end_ms: 3740, clip_start_s: 0, clip_end_s: 3.73, speech_ms: 3730 };
  const w = { windowId: "bw", roomDayId: "rd", diarizeRunId: "run", clipR2Key: "k", windowStartMs: 0, cap_s: 60, model: { model: null, model_key: null, subfolder: null, device: null } };
  it("a gate refusal writes the diarizer's speech_ms AND the service's speech_s_est in ms, basis diarize_segments", async () => {
    DB.writes = [];
    await writeScoredOrFailed(w, seg, { index: 0, ok: false, unscorable: true, reason: "insufficient_speech", service_speech_s: 0.42, duration_s: 3.73 });
    const ins = DB.writes[0]!;
    expect(ins.text).toMatch(/speech_ms, service_speech_ms, speech_basis/);
    expect(ins.values).toEqual(expect.arrayContaining(["unscorable", 3730, 420, SPEECH_BASIS]));
  });
  it("a scored span writes speech_ms and no service number — the service does not return one for a score", async () => {
    DB.writes = [];
    await writeScoredOrFailed(w, seg, { index: 0, ok: true, labels: LABELS, top_label: "neutral", top_score: 0.8, duration_s: 3.73, inference_s: 1 });
    const v = DB.writes[0]!.values;
    const i = v.indexOf(3730);
    expect(i).toBeGreaterThan(-1);
    expect(v[i + 1], "service_speech_ms").toBeNull();
    expect(v[i + 2]).toBe(SPEECH_BASIS);
  });
});

describe("V6 — pre-fix rows are marked by the migration, not by memory", () => {
  it("0097 stamps every row not written by E16 code with pre_speech_fraction, and reserves service_speech_est", () => {
    // A source-text SUPPLEMENT (rule 2): the behavioural proof is the pg suite's pre-fix case, UNRUN without Docker.
    const m = readFileSync("db/migrations/0097_room_span_emotion_speech.sql", "utf8");
    expect(m).toMatch(/ADD COLUMN IF NOT EXISTS speech_basis text NOT NULL DEFAULT 'pre_speech_fraction'/);
    expect(m).toMatch(/CHECK \(speech_basis IN \('pre_speech_fraction', 'diarize_segments', 'service_speech_est'\)\)/);
    expect(m).toMatch(/CHECK \(state IN \('scored', 'skipped', 'failed', 'unscorable'\)\)/);
    expect(m).toMatch(/ADD COLUMN IF NOT EXISTS segments_unscorable integer/);
  });
});
