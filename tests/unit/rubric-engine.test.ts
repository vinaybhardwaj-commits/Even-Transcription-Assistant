/**
 * S7-0 — the rubric engine without a database: the registry and its files, the pure engines, the bench scoring, the tool. Nothing here reads a secret or calls a model.
 */
import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;
vi.mock("@/lib/db", () => ({ sql: async () => [] }));

const { RUBRICS, REGISTERED_IDS, getRubric, canRun, unitsOf } = await import("@/lib/rubrics/registry");
const T = await import("@/lib/rubrics/types");
const { evaluateRoomMicQuality, MIC_FLAGS } = await import("@/lib/rubrics/engines/room-mic-quality");
const { evaluateTalkTime, unionMs, overlapMs } = await import("@/lib/rubrics/engines/talk-time");
const B = await import("@/lib/rubrics/bench");
const { evidenceKey } = await import("@/lib/rubrics/store");
const L = await import("@/lib/sarvam-lab");

const ROOT = "rubrics";
const folders = readdirSync(ROOT).filter((n) => statSync(join(ROOT, n)).isDirectory()).sort();

describe("the rubric files and the registry", () => {
  it("the registry covers exactly the rubrics/ folders, each folder holds a rubric.json whose id is the folder name", () => {
    expect([...REGISTERED_IDS].sort()).toEqual(folders);
    for (const f of folders) expect(JSON.parse(readFileSync(join(ROOT, f, "rubric.json"), "utf8")).id).toBe(f);
    expect(RUBRICS.map((r) => r.id)).toEqual([...REGISTERED_IDS]);
  });
  it("every file passes the schema and the cross-field rules; nothing is production or benched yet; status changes only by commit", () => {
    for (const r of RUBRICS) {
      expect(T.RubricFile.safeParse(r).success, r.id).toBe(true);
      expect(T.rubricProblems(r, r.id, (f: string) => f.endsWith("/prompt.json") && !!r.prompt), r.id).toEqual([]);
      expect(r.status, r.id).toBe("draft");
    }
  });
  it("the two code rubrics and the four definition-only drafts", () => {
    expect(RUBRICS.filter((r) => r.engine === "code").map((r) => r.id)).toEqual(["room_mic_quality", "talk_time"]);
    expect(unitsOf(getRubric("talk_time")!)).toEqual(["window", "consult"]);
    expect(unitsOf(getRubric("room_mic_quality")!)).toEqual(["room_hour"]);
    const defs = ["consult_chair_affect", "consult_surgical_pitch", "ehrc_surgical_outcome", "care_sentiment"].map((i) => getRubric(i)!);
    for (const d of defs) { expect(d.engine).toBe("llm_zdr"); expect(d.source).toMatch(/@/); }
    // S7-1: the two consult rubrics have an engine and a prompt file (v1.0.0); the other two stay definition-only
    for (const d of defs.slice(0, 2)) { expect(d.version).toBe(d.id === "consult_surgical_pitch" ? "1.1.1" : "1.1.0"); expect(d.prompt).toBe("prompt.json"); } // 1.1.1: the pitch output changed (recommendation_kind decided in code)
    expect(defs[2]!.prompt).toBe("prompt.json"); // S7-3: ehrc_surgical_outcome has an engine (draft, lab only); care_sentiment stays definition-only
    expect(defs[2]!.version).toBe("0.2.0");
    expect(defs[3]!.prompt).toBeUndefined();
    expect(getRubric("care_sentiment")!.inputs).toEqual(["external"]);
    expect(getRubric("consult_chair_affect")!.source).toBe("consult-chair-affect@v0.2");
    expect(getRubric("ehrc_surgical_outcome")!.source).toBe("ehrc-surgical-outcome@md");
  });
  it("NO identifier, quote, example, gold row or placeholder id in any rubric file (the repo is public)", () => {
    for (const f of folders) {
      const text = readFileSync(join(ROOT, f, "rubric.json"), "utf8");
      expect(T.identifierTokens(text), f).toEqual([]);
      expect(/[^\x00-\x7f]/.test(text), `${f} has a non-ASCII character (a quoted phrase in another script?)`).toBe(false);
      expect(/"examples?"\s*:|"gold|"quotes?"\s*:\s*[\["]|_PRIVATE|Poornima|Srikanth|Nayar|Veda\b/i.test(text), f).toBe(false); // (the placeholder-id tokens are caught by identifierTokens above)
    }
    expect(readdirSync(join(ROOT)).filter((n) => !statSync(join(ROOT, n)).isDirectory())).toEqual([]); // no stray files
    for (const f of folders) expect(readdirSync(join(ROOT, f)), f).toEqual(f === "consult_chair_affect" || f === "consult_surgical_pitch" || f === "encounter_vs_record" || f === "ehrc_surgical_outcome" ? ["prompt.json", "rubric.json"] : ["rubric.json"]); // a prompt file (S7-1) but no gold set, no bench with text, no linkage
  });
  it("a bad file fails: unknown key, bad semver, id not the folder, a draft-only gap on a benched rubric, a code rubric with a prompt, a consult rubric with no consult input", () => {
    const ok = JSON.parse(JSON.stringify(getRubric("talk_time")));
    expect(T.RubricFile.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(T.RubricFile.safeParse({ ...ok, version: "1.0" }).success).toBe(false);
    expect(T.RubricFile.safeParse({ ...ok, status: "published" }).success).toBe(false);
    expect(T.RubricFile.safeParse({ ...ok, inputs: ["nope"] }).success).toBe(false);
    expect(T.rubricProblems({ ...ok }, "other", () => true).join()).toMatch(/must equal its folder name/);
    expect(T.rubricProblems({ ...ok, status: "benched" }, "talk_time", () => false).join()).toMatch(/bench file/);
    expect(T.rubricProblems({ ...ok, prompt: "p.md" }, "talk_time", () => true).join()).toMatch(/engine code takes no/);
    expect(T.rubricProblems({ ...ok, unit: "consult", units: ["consult"], inputs: ["turns"] }, "talk_time", () => true).join()).toMatch(/consult rubric needs/);
    expect(T.rubricProblems({ ...ok, engine: "llm_zdr", status: "production" }, "talk_time", () => true).join()).toMatch(/needs a prompt/);
  });
  it("canRun: a non-production rubric needs lab:true; only engine code runs; the unit must be one the rubric supports", () => {
    const tt = getRubric("talk_time")!;
    expect(canRun(null, { lab: true })).toMatchObject({ error: "unknown_rubric" });
    expect(canRun(tt, { lab: false })).toMatchObject({ error: "lab_required" });
    expect(canRun(tt, { lab: true, unit: "window" })).toBeNull();
    expect(canRun(tt, { lab: true, unit: "room_hour" })).toMatchObject({ error: "unit_not_supported" });
    expect(canRun(getRubric("care_sentiment")!, { lab: true })).toMatchObject({ error: "engine_not_available" });
    expect(canRun({ ...tt, status: "production" }, { lab: false, unit: "consult" })).toBeNull();
  });
});

describe("room_mic_quality engine (pure)", () => {
  const H0 = Date.parse("2026-10-08T10:00:00+05:30");
  const hour = (ivs: Array<[string, number, number]>, samples = { n: 0, zero_ratio_mean: null as number | null, peak_max: null as number | null }) => ({
    room_id: "r1", ist_date: "2026-10-08", hour: 10, window_start_ms: H0, window_end_ms: H0 + 3_600_000, day: null,
    intervals: ivs.map(([state, a, b]) => ({ state, start_ms: H0 + a * 60_000, end_ms: H0 + b * 60_000 })), samples,
  });
  it("minutes recorded vs expected, muted / off / dead / speech, zero ratio, headroom and the flags — the thresholds are the rubric file's", () => {
    const r = evaluateRoomMicQuality(hour([["speech", 0, 50], ["muted", 50, 60]], { n: 120, zero_ratio_mean: 0.01, peak_max: 0.99 }));
    expect(r.status).toBe("ok");
    expect(r.score).toMatchObject({ expected_min: 60, recorded_min: 50, recorded_ratio: 0.833, muted_min: 10, off_min: 0, dead_min: 0, speech_min: 50, zero_ratio: 0.01, peak_headroom: 0.01, samples: 120 });
    expect(r.findings).toEqual(["muted", "clipping"]);
    const off = evaluateRoomMicQuality(hour([["recorder_off", 0, 30], ["audio_present", 30, 60]]));
    expect(off.score).toMatchObject({ recorded_min: 30, recorded_ratio: 0.5, off_min: 30, speech_min: 0, zero_ratio: null, peak_headroom: null });
    expect(off.findings).toEqual(["low_recording", "off", "no_speech"]);
    const dead = evaluateRoomMicQuality(hour([["device_dead", 0, 60]], { n: 60, zero_ratio_mean: 1, peak_max: 0 }));
    expect(dead.score).toMatchObject({ recorded_min: 0, dead_min: 60 });
    expect(dead.findings).toEqual(["low_recording", "dead", "zero_heavy"]);
    const def = (getRubric("room_mic_quality")!.definition as { flags: Record<string, string> }).flags;
    expect(def.low_recording).toContain(String(MIC_FLAGS.low_recording_ratio));
    expect(def.muted).toContain(String(MIC_FLAGS.muted_min));
    expect(def.clipping).toContain(String(MIC_FLAGS.clipping_headroom));
    expect(def.zero_heavy).toContain(String(MIC_FLAGS.zero_heavy_ratio));
  });
  it("intervals are clipped to the hour; overlapping rows never push a total past 60", () => {
    const r = evaluateRoomMicQuality(hour([["speech", -30, 45], ["audio_present", 20, 80]]));
    expect(r.score).toMatchObject({ recorded_min: 60, recorded_ratio: 1, speech_min: 45 });
  });
});

describe("talk_time engine (pure)", () => {
  const turn = (s: number, e: number, speaker: number | null, role: string | null = null) => ({ source_ref: `t${s}`, start_ms: s, end_ms: e, speaker_idx: speaker, role, overlap_ms: speaker === null ? null : e - s });
  const turns = [turn(0, 10_000, 0, "clinician"), turn(8_000, 20_000, 1), turn(25_000, 35_000, 0, "clinician"), turn(40_000, 42_000, null)];
  it("doctor vs other share, turns, interruptions, overlap, longest monologue, silence share", () => {
    const r = evaluateTalkTime(turns, { start_ms: 0, end_ms: 60_000 });
    expect(r.status).toBe("ok");
    expect(r.score).toMatchObject({ span_ms: 60_000, doctor_talk_ms: 20_000, other_talk_ms: 12_000, unattributed_talk_ms: 2_000, doctor_share: 0.625, doctor_turns: 2, other_turns: 1, unattributed_turns: 1, interruptions: 1, overlap_ms: 2_000, longest_monologue_ms: 12_000, speakers: 2 });
    expect(r.score!.silence_share).toBeCloseTo(0.467, 3);
    expect(r.findings).toEqual([]);
  });
  it("a nested turn is overlap, not an interruption; consecutive turns of one speaker under 2 s apart are one monologue", () => {
    const r = evaluateTalkTime([turn(0, 20_000, 0, "clinician"), turn(5_000, 8_000, 1), turn(21_000, 30_000, 0, "clinician")], { start_ms: 0, end_ms: 40_000 });
    expect(r.score).toMatchObject({ interruptions: 0, overlap_ms: 3_000 });
    const mono = evaluateTalkTime([turn(0, 5_000, 0, "clinician"), turn(6_000, 12_000, 0, "clinician"), turn(20_000, 22_000, 1)], { start_ms: 0, end_ms: 30_000 });
    expect(mono.score).toMatchObject({ longest_monologue_ms: 12_000 });
  });
  it("skips with a closed reason: no_turns, no_diarization (turns but nobody attributed), bad span; no doctor identified is a finding, not a skip", () => {
    expect(evaluateTalkTime([], { start_ms: 0, end_ms: 1000 })).toMatchObject({ status: "skipped", reason: "no_turns" });
    expect(evaluateTalkTime([turn(0, 500, null)], { start_ms: 0, end_ms: 1000 })).toMatchObject({ status: "skipped", reason: "no_diarization" });
    expect(evaluateTalkTime([turn(0, 500, 0)], { start_ms: 5, end_ms: 5 })).toMatchObject({ status: "failed", reason: "bad_span" });
    expect(evaluateTalkTime([turn(0, 500, 0), turn(600, 900, 1)], { start_ms: 0, end_ms: 1000 })).toMatchObject({ status: "ok", findings: ["no_doctor_identified"] });
  });
  it("turns are clipped to the span (a consult)", () => {
    const r = evaluateTalkTime(turns, { start_ms: 0, end_ms: 30_000 });
    expect(r.score).toMatchObject({ doctor_talk_ms: 15_000, other_talk_ms: 12_000, unattributed_turns: 0 });
  });
  it("interval helpers", () => {
    expect(unionMs([[0, 10], [5, 15], [20, 25]])).toBe(20);
    expect(overlapMs([{ speaker: 0, s: 0, e: 10 }, { speaker: 1, s: 5, e: 8 }, { speaker: 0, s: 6, e: 20 }])).toBe(3); // the same speaker twice is not overlap
  });
});

describe("bench scoring (through lib/jev/bench.ts)", () => {
  const set = { unit: "room_hour", items: [
    { unit_key: "a", expected: { recorded_min: 50, flags: ["muted"] } },
    { unit_key: "b", expected: { recorded_min: 30, flags: ["low_recording", "off"] }, tolerance: 0.5 },
  ] };
  it("parseBenchSet is strict; compareItem uses the tolerance and compares arrays as sets", () => {
    expect(B.parseBenchSet(set)).not.toBeNull();
    for (const bad of [null, {}, { unit: "x", items: [] }, { unit: "room_hour", items: [] }, { unit: "room_hour", items: [{ unit_key: "", expected: { a: 1 } }] }, { unit: "room_hour", items: [{ unit_key: "a", expected: {} }] }]) expect(B.parseBenchSet(bad)).toBeNull();
    const c = B.compareItem(set.items[1]!, { recorded_min: 30.4, flags: ["off", "low_recording"] });
    expect(c.every((x) => x.equal)).toBe(true);
    expect(B.compareItem(set.items[0]!, { recorded_min: 49, flags: ["muted"] }).map((x) => x.equal)).toEqual([false, true]);
    expect(B.compareItem(set.items[0]!, null).every((x) => x.got === "unscored")).toBe(true);
  });
  it("field_accuracy and accuracy, pass / fail against the threshold, per-field counts; metrics the engine cannot score are refused", () => {
    const cmp = [B.compareItem(set.items[0]!, { recorded_min: 50, flags: ["muted"] }), B.compareItem(set.items[1]!, { recorded_min: 10, flags: ["off", "low_recording"] })];
    const fa = B.scoreBench("field_accuracy", 0.7, cmp) as Exclude<ReturnType<typeof B.scoreBench>, { error: string }>;
    expect(fa).toMatchObject({ value: 0.75, passed: true, items: 2, fields: 4, items_all_equal: 1, unscored: 0 });
    expect(fa.per_field).toEqual({ recorded_min: { n: 2, equal: 1 }, flags: { n: 2, equal: 2 } });
    expect(fa.metrics.n).toBe(4);
    expect(B.scoreBench("accuracy", 0.75, cmp)).toMatchObject({ value: 0.5, passed: false });
    expect(B.scoreBench("weighted_kappa", 0.5, cmp)).toEqual({ error: "metric_not_supported" });
  });
});

describe("the lab allowlist (S7-0): rubric/ in, reb/ out", () => {
  it("rubric evidence keys are writable and readable; reb/, other prefixes and path tricks are not", () => {
    const k = evidenceKey("room_mic_quality", "0.1.0", "r1:2026-10-08:10");
    expect(k).toBe("rubric/room_mic_quality/0.1.0/r1:2026-10-08:10.json");
    expect(L.labWritable(k)).toBe(true);
    expect(L.labReadable(k)).toBe(true);
    expect(L.labWritable(evidenceKey("talk_time", "0.1.0", "bw_1"))).toBe(true);
    for (const bad of ["reb/x.json", "rubric/x.json", "rubric/Room/0.1.0/a.json", "rubric/room_mic_quality/0.1/a.json", "rubric/room_mic_quality/0.1.0/../../reb/x.json", "rubric/room_mic_quality/0.1.0/a.txt", "other/rubric/room_mic_quality/0.1.0/a.json"]) expect(L.labWritable(bad), bad).toBe(false);
    expect(L.labReadable("reb/x.json")).toBe(false);
    expect(evidenceKey("a_b", "1.0.0", "x/y z").includes("/y")).toBe(false); // a unit key cannot add path segments
  });
});

describe("the blind room-days (S7-0-R2): the held-out set, 14 fixed (IST day, room) pairs", () => {
  it("14 pairs, all distinct, ids and dates only; a known pair is refused, a neighbour day of the same room is not; malformed input is not blind", async () => {
    const B2 = await import("@/lib/rubrics/blind-room-days");
    expect(B2.BLIND_ROOM_DAYS).toHaveLength(14);
    expect(new Set(B2.BLIND_ROOM_DAYS.map(([d, r]) => `${d}|${r}`)).size).toBe(14);
    for (const [d, r] of B2.BLIND_ROOM_DAYS) { expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/); expect(r).toMatch(/^room_[a-z0-9]{8}$/); }
    expect(B2.BLIND_ROOM_DAYS_SOURCE).toEqual({ heldout: "heldout.py f672c1ef", union_sha16: "f07171dcb708d080" });
    expect(B2.isBlindRoomDay("2026-09-13", "room_ux92qpws")).toBe(true);
    expect(B2.isBlindRoomDay("2026-09-13T04:00:00Z", "room_ux92qpws")).toBe(true); // a timestamp is cut to its date
    expect(B2.isBlindRoomDay("2026-09-12", "room_ux92qpws")).toBe(false);
    expect(B2.isBlindRoomDay("2026-09-14", "room_qyzghzaf")).toBe(false); // same day as another pair, other room
    expect(B2.isBlindRoomDay("2026-09-13", "room_qyzghzaf")).toBe(false);
    for (const bad of [[null, "x"], ["2026-09-13", null], [undefined, undefined], ["", ""]] as const) expect(B2.isBlindRoomDay(bad[0], bad[1])).toBe(false);
  });
  it("it matches the held-out set from heldout.py (union sha16 pinned inline; the 14 pairs pinned by a sha256 of the sorted list), and the module holds no label or name", async () => {
    const B2 = await import("@/lib/rubrics/blind-room-days");
    const { createHash } = await import("node:crypto");
    const src = readFileSync("lib/rubrics/blind-room-days.ts", "utf8");
    expect(/OPD\d|label/i.test(src.replace(/label\.?s?\b[^\n]*\n/gi, ""))).toBe(false);
    expect(B2.BLIND_ROOM_DAYS).toHaveLength(14);
    expect(B2.BLIND_ROOM_DAYS_SOURCE).toEqual({ heldout: "heldout.py f672c1ef", union_sha16: "f07171dcb708d080" });
    const sorted = B2.BLIND_ROOM_DAYS.map(([d, r]) => `${d}|${r}`).sort();
    expect(createHash("sha256").update(`${sorted.join("\n")}\n`).digest("hex")).toBe("9f8e9c9bf0f9dee88bb6c514c9cf57668c4f6067681e41ff1756aaa124041b71");
  });
  it("the old heuristic is gone: the readers module exports no database-backed isBlindRoomDay, and the audio_state reader refuses the pair too", async () => {
    const C = await import("@/lib/rubrics/readers/common");
    expect((C as Record<string, unknown>).isBlindRoomDay).toBeUndefined();
    const { readAudioHour } = await import("@/lib/rubrics/readers/audio-state");
    expect(await readAudioHour("room_ux92qpws", "2026-09-13", 10)).toMatchObject({ ok: false, reason: "blind_room_day" });
  });
});

describe("identifierTokens (the guard that keeps the public repo clean)", () => {
  it("catches person / visit / tape placeholders and ids, and nothing in ordinary rubric prose", () => {
    const bad = ["P" + "07", "CONSUL" + "T-12", "MEE" + "T-03", "UHI" + "D 4411", "VISI" + "T-9", "CHAR" + "T-2", "R" + "X-1", "INDIVIDUA" + "L-1"];
    for (const t of bad) expect(T.identifierTokens(`see ${t} here`), t).toEqual([t]);
    expect(T.identifierTokens("distress, confusion, frustration; 12 minutes; Pxx; the rate of P-values")).toEqual([]);
  });
});
