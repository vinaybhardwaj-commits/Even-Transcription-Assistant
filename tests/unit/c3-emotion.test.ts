/**
 * Slice C3 — emotion, the pure parts: the flags, the gate, runs and chunks, and the service contract.
 * The job itself runs against real Postgres in c2-e2e-runner.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { repoFiles, textOf } from "../support/repo-files";

describe("the flag parser — one rule for every on/off flag", () => {
  it("1/true/yes/on enable, 0/false/no/off/empty/unset disable, trimmed and case-insensitive", async () => {
    const { parseFlag } = await import("@/lib/flags");
    for (const v of ["1", " true ", "YES", "On"]) expect(parseFlag("X", { X: v }), v).toBe(true);
    for (const v of [undefined, "", "  ", "0", "FALSE", "no", " off"]) expect(parseFlag("X", { X: v }), String(v)).toBe(false);
  });
  it("anything else THROWS, and the message never echoes the value", async () => {
    const { parseFlag, FlagValueError } = await import("@/lib/flags");
    for (const v of ["2", "enabled", "y", "tru"]) expect(() => parseFlag("X", { X: v }), v).toThrow(FlagValueError);
    try { parseFlag("X", { X: "sekrit-value" }); } catch (e) { expect(String((e as Error).message)).not.toContain("sekrit"); }
  });
  it("ROOM_DIARIZE_ENABLED reads through the same parser", async () => {
    const { roomDiarizeEnabled, FlagValueError } = await import("@/lib/stt/diarize-job");
    expect(roomDiarizeEnabled({ ROOM_DIARIZE_ENABLED: " yes " }, () => {})).toBe(true);
    expect(() => roomDiarizeEnabled({ ROOM_DIARIZE_ENABLED: "maybe" }, () => {})).toThrow(FlagValueError);
  });
});

describe("the two emotion gates", () => {
  it("EMOTION_ENABLED gates compute; canSurfaceEmotion needs BOTH flags", async () => {
    const { emotionEnabled, canSurfaceEmotion } = await import("@/lib/emotion/gate");
    expect(emotionEnabled({})).toBe(false);
    expect(emotionEnabled({ EMOTION_ENABLED: "1" })).toBe(true);
    expect(canSurfaceEmotion({})).toBe(false);
    expect(canSurfaceEmotion({ EMOTION_SURFACE_ENABLED: "1" }), "nothing surfaces that is not computed").toBe(false);
    expect(canSurfaceEmotion({ EMOTION_ENABLED: "1" })).toBe(false);
    expect(canSurfaceEmotion({ EMOTION_ENABLED: "1", EMOTION_SURFACE_ENABLED: "on" })).toBe(true);
    expect(() => canSurfaceEmotion({ EMOTION_ENABLED: "1", EMOTION_SURFACE_ENABLED: "sure" })).toThrow();
  });

  it("DORMANCY STATED: nothing in lib/ or app/ calls canSurfaceEmotion today — an API awaiting a surface", () => {
    const callers = repoFiles()
      .filter((f) => /^(lib|app)\//.test(f) && f !== "lib/emotion/gate.ts")
      .filter((f) => /\bcanSurfaceEmotion\s*\(/.test(textOf(f) ?? ""));
    expect(callers, "when a surface is built, it calls the gate — and this test changes with it").toEqual([]);
  });
});

describe("runs — consecutive single-speaker turns merged before anything is scored", () => {
  const t = (ref: string, spk: number, s: number, e: number, reason: string | null = null) => ({ source_ref: ref, speaker_idx: spk, no_role_reason: reason, start_ms: s, end_ms: e });

  it("merges same-speaker turns within 2 s, splits on a speaker change or a longer gap", async () => {
    const { buildRuns, RUN_MERGE_GAP_MS } = await import("@/lib/emotion/segments");
    expect(RUN_MERGE_GAP_MS).toBe(2000);
    const { runs, skipped } = buildRuns([
      t("a", 0, 0, 1000), t("b", 0, 2500, 4000), t("c", 0, 6000, 7000), // a+b merge (1.5 s gap); b+c merge at exactly the 2 s limit
      t("d", 1, 7100, 9000), t("e", 0, 9100, 9500),
    ]);
    expect(runs.map((r) => [r.speaker_idx, r.start_ms, r.end_ms, r.source_refs])).toEqual([
      [0, 0, 7000, ["a", "b", "c"]],
      [1, 7100, 9000, ["d"]],
      [0, 9100, 9500, ["e"]],
    ]);
    expect(skipped).toEqual([]);
    const far = buildRuns([t("a", 0, 0, 1000), t("b", 0, 3001, 4000)]);
    expect(far.runs).toHaveLength(2);
  });

  it("a STRADDLED turn is skipped with its reason and breaks the run it sits in", async () => {
    const { buildRuns } = await import("@/lib/emotion/segments");
    const { runs, skipped } = buildRuns([t("a", 0, 0, 1000), t("x", 0, 1200, 2000, "straddle"), t("b", 0, 2100, 3000), t("n", 2, 3100, 4000, "no_match")]);
    expect(skipped).toEqual([{ speaker_idx: 0, start_ms: 1200, end_ms: 2000, source_refs: ["x"], reason: "straddle" }]);
    expect(runs.map((r) => r.source_refs)).toEqual([["a"], ["b"], ["n"]]);
  });

  it("an UNNAMED speaker's turns are scored like any other — no_match is not a skip", async () => {
    const { buildRuns } = await import("@/lib/emotion/segments");
    const { runs, skipped } = buildRuns([t("n1", 3, 0, 1000, "no_match"), t("n2", 3, 1500, 2500, "no_match")]);
    expect(skipped).toEqual([]);
    expect(runs).toHaveLength(1);
  });
});

describe("chunks — the cap comes from the service, runs are split evenly, never truncated", () => {
  const run = (s: number, e: number) => ({ speaker_idx: 0, start_ms: s, end_ms: e, source_refs: ["r"] });

  it("target is min(cap - 1 s, 30 s); a 70 s run at cap 60 is three equal chunks that tile it exactly", async () => {
    const { planSegments, chunkTargetS } = await import("@/lib/emotion/segments");
    expect(chunkTargetS(60)).toBe(30);
    expect(chunkTargetS(20)).toBe(19);
    const segs = planSegments([run(100_000, 170_000)], 100_000, 60);
    expect(segs.map((s) => [s.chunk_idx, s.chunk_count, s.start_ms, s.end_ms])).toEqual([[0, 3, 100_000, 123_333], [1, 3, 123_333, 146_667], [2, 3, 146_667, 170_000]]);
    expect(segs.every((s) => s.end_ms - s.start_ms <= 30_000)).toBe(true);
    expect(segs[0]!.clip_start_s).toBe(0);
    expect(segs[2]!.clip_end_s).toBe(70);
  });

  it("a cap read as 20 s gives chunks no longer than 19 s", async () => {
    const { planSegments } = await import("@/lib/emotion/segments");
    const segs = planSegments([run(0, 60_000)], 0, 20);
    expect(segs.length).toBe(4);
    expect(Math.max(...segs.map((s) => s.end_ms - s.start_ms))).toBeLessThanOrEqual(19_000);
  });

  it("a cap that leaves no room is an error, not a guess", async () => {
    const { chunkTargetS } = await import("@/lib/emotion/segments");
    expect(() => chunkTargetS(1)).toThrow();
    expect(() => chunkTargetS(Number.NaN)).toThrow();
  });

  it("there is NO length floor: a 300 ms run is planned (the service's own 0.1 s minimum is its refusal to name)", async () => {
    const { planSegments } = await import("@/lib/emotion/segments");
    expect(planSegments([run(0, 300)], 0, 60)).toHaveLength(1);
  });
});

describe("the service contract — parsed strictly", () => {
  const LABELS = { anger: 0.01, disgust: 0.02, enthusiasm: 0.03, fear: 0.04, happiness: 0.05, neutral: 0.72, sadness: 0.13 };
  const good = (results: unknown[]) => ({ ok: true, model_key: "wavlm", model: "Aniemore/wavlm-emotion-v1-crosslingual", device: "mps", subfolder: "int8", max_duration_s: 60, results });
  const okResult = (index: number, labels: Record<string, unknown> = LABELS) => ({ index, ok: true, labels, top: [], duration_s: 10, inference_s: 1.2 });

  it("a full answer yields all seven scores and the top label, per segment, in order", async () => {
    const { parseSegmentsResponse } = await import("@/lib/emotion/client");
    const r = parseSegmentsResponse(good([okResult(0), { index: 1, ok: false, error: "segment_too_short_for_model" }]), 2);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected a parsed response");
    expect(r.cap_s).toBe(60);
    expect(r.results[0]).toMatchObject({ ok: true, top_label: "neutral", top_score: 0.72, labels: LABELS });
    expect(r.results[1]).toEqual({ index: 1, ok: false, reason: "segment_too_short_for_model" });
  });

  it("refuses: ok:false, another model, a count or order mismatch, a missing cap", async () => {
    const { parseSegmentsResponse } = await import("@/lib/emotion/client");
    expect(parseSegmentsResponse({ ok: false, error: "boom" }, 1)).toMatchObject({ ok: false, error: "emotion_service_refused: boom" });
    expect(parseSegmentsResponse({ ...good([okResult(0)]), model_key: "emotion2vec" }, 1)).toMatchObject({ ok: false, error: "emotion_unexpected_model" });
    expect(parseSegmentsResponse(good([okResult(0)]), 2)).toMatchObject({ ok: false, error: "emotion_result_count_mismatch" });
    expect(parseSegmentsResponse(good([okResult(1)]), 1)).toMatchObject({ ok: false, error: "emotion_result_order_mismatch" });
    expect(parseSegmentsResponse({ ...good([okResult(0)]), max_duration_s: undefined }, 1)).toMatchObject({ ok: false, error: "emotion_response_missing_cap" });
    expect(parseSegmentsResponse([], 0)).toMatchObject({ ok: false });
  });

  it("a missing, non-numeric or out-of-range score makes THAT segment malformed — never a partial distribution", async () => {
    const { parseSegmentsResponse } = await import("@/lib/emotion/client");
    const { sadness: _drop, ...six } = LABELS;
    void _drop;
    for (const labels of [six, { ...LABELS, fear: "0.1" }, { ...LABELS, anger: 1.2 }, { ...LABELS, anger: -0.01 }, { ...LABELS, anger: Number.NaN }]) {
      const r = parseSegmentsResponse(good([okResult(0, labels)]), 1);
      expect(r.ok && r.results[0]).toEqual({ index: 0, ok: false, reason: "malformed_scores" });
    }
  });

  it("health: the cap is required; `loaded` is reported as unknown when the service does not say", async () => {
    const { emotionHealth } = await import("@/lib/emotion/client");
    const f = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });
    expect(await emotionHealth(f({ max_duration_s: 60, loaded: true, models: { wavlm: { loaded: true, subfolder: "int8" } } }))).toEqual({ ok: true, cap_s: 60, loaded: true, model: null, subfolder: "int8" });
    expect(await emotionHealth(f({ max_duration_s: 60 }))).toMatchObject({ ok: true, loaded: "unknown" });
    expect(await emotionHealth(f({ loaded: true }))).toEqual({ ok: false, error: "health_cap_unreadable" });
    expect(await emotionHealth(async () => { throw new TypeError("fetch failed"); })).toMatchObject({ ok: false });
  });

  it("the client only ever calls the batch wavlm path — never emotion2vec, never the bare /inference", () => {
    const src = readFileSync("lib/emotion/client.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(src).toContain("/inference/wavlm/segments");
    expect(src).not.toMatch(/emotion2vec|inference\/emotion|\/inference[`"']/);
  });
});

describe("G — nothing in C3 names, indexes or describes a speaker as a particular kind of person", () => {
  it("no C3 file — code, SQL, comments or descriptions — uses the word", () => {
    const WORD = ["pat", "ient"].join("");
    const files = [
      "db/migrations/0089_room_emotion.sql",
      "lib/emotion/gate.ts", "lib/emotion/segments.ts", "lib/emotion/client.ts", "lib/emotion/store.ts", "lib/emotion/enqueue.ts",
      "lib/jobs/kinds/emotion-window.ts", "app/api/admin/emotion-windows/route.ts",
    ];
    const hits = files.filter((f) => new RegExp(WORD, "i").test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });

  it("the emotion tables carry no identity or role column — identity is joined, from a match, never stored beside a score", () => {
    const sql = readFileSync("db/migrations/0089_room_emotion.sql", "utf8").replace(/--[^\n]*/g, "");
    const columns = [...sql.matchAll(/^\s+([a-z_]+)\s+(?:text|integer|bigint|double precision|jsonb|timestamptz)\b/gm)].map((m) => m[1]!);
    expect(columns.length, "the column parse found the tables").toBeGreaterThan(40);
    expect(columns.filter((c) => /clinician|role|name|type|person|who/.test(c))).toEqual([]);
  });

  it("no budget or admission check on a realtime factor", () => {
    const files = ["lib/emotion/segments.ts", "lib/emotion/client.ts", "lib/jobs/kinds/emotion-window.ts", "lib/emotion/enqueue.ts"];
    for (const f of files) expect(readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, ""), f).not.toMatch(/realtime|real_time|\brtf\b/i);
  });
});
