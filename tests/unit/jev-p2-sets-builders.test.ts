/**
 * Jev P2 — the first-draft question sets and their state builders. PURE: no database, no network, no Jev.
 *
 *   SETS      every file validates; model pin jev-1.13.0; English; no PHI shapes in the wording; every Choice has escape options and asks both orders;
 *             the option lists the PRD names are exactly those; the hashes are distinct and stable.
 *   BUILDERS  the token budget by script; the pre-gates; the timeline candidates and the End-click mask; the O4 refusal; engine names hidden; locators.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { QUESTION_SET_FILES } from "@/jev/question-sets";
import { validateSetFile, setSha, JEV_MODEL_PIN, type QuestionDef, type QuestionSetFile } from "@/lib/jev/worker/sets";
import { estimateTokens, overBudget, STATE_TOKEN_BUDGET } from "@/lib/jev/worker/builders/tokens";
import { transcriptState, MIN_PATIENT_TURNS } from "@/lib/jev/worker/builders/transcript";
import { candidateRows, timelineJevState, resolveTimelineAnswer, MAX_CANDIDATES } from "@/lib/jev/worker/builders/timeline";
import { buildSttPairState, buildSttRunState, repeatBucket, resolveSttPick, type RunRow } from "@/lib/jev/worker/builders/stt";
import { buildDoubtState, buildPitchState, clearLocators, setLocator } from "@/lib/jev/worker/builders/locators";
import { buildBenchReport } from "@/lib/jev/worker/bench-report";
import { applyGates } from "@/lib/jev/worker/call";
import type { JevAnswer } from "@/lib/jev/types";
import type { WorkerDecision } from "@/lib/jev/worker/persist";
import { buildSegment, type TimelineInput } from "@/lib/encounter-clock/timeline";
import type { Anchor } from "@/lib/encounter-clock/anchors";

const FILES = QUESTION_SET_FILES.map((f) => validateSetFile(f));
const P2 = FILES.filter((f) => f.id !== "smoke");
const byId = (id: string): QuestionSetFile => FILES.find((f) => f.id === id)!;
const opts = (q: QuestionDef): string[] => Object.keys((q.body as { criteria: Record<string, string> }).criteria);
const q = (setId: string, qid: string): QuestionDef => byId(setId).questions.find((x) => x.question_id === qid)!;

describe("the P2 question sets (drafts)", () => {
  it("the eight sets exist, each pinned to jev-1.13.0, none is a status (status is the DB's, starting at draft)", () => {
    expect(P2.map((f) => `${f.id}@${f.version}`).sort()).toEqual(["chair-affect@v0", "doubt@v0", "encounter-end@v0", "pitch-detect@v0", "pitch-uptake@v0", "stt-pick@v0", "stt-quality@v0", "u10-timeline@v2"]);
    for (const f of P2) { expect(f.model_pin, f.id).toBe(JEV_MODEL_PIN); expect("status" in f, `${f.id} must not carry a status`).toBe(false); expect("ratified_by" in f).toBe(false); }
  });

  it("the right subject type and use for each (consult end; encounter end; pitch; per-pitch uptake; affect; doubt; STT)", () => {
    const m = Object.fromEntries(P2.map((f) => [f.id, `${f.use}/${f.subject_type}`]));
    expect(m).toEqual({
      "u10-timeline": "encounter_timeline/encounter", "encounter-end": "encounter_timeline/encounter", "stt-quality": "stt_quality/stt_run", "stt-pick": "stt_pick/stt_pair",
      "pitch-detect": "consult_rubric/consult", "pitch-uptake": "consult_rubric/pitch", "chair-affect": "consult_rubric/consult", doubt: "consult_rubric/doubt",
    });
  });

  it("PRD principle 5: every Choice carries insufficient_evidence as an escape, and every escape is one of its options", () => {
    for (const f of P2) for (const d of f.questions) {
      expect(d.kind, `${f.id}/${d.question_id}`).toBe("choice");
      expect(opts(d), `${f.id}/${d.question_id}`).toContain("insufficient_evidence");
      expect(d.escape_options, `${f.id}/${d.question_id}`).toContain("insufficient_evidence");
      for (const e of d.escape_options ?? []) expect(opts(d)).toContain(e);
    }
  });

  it("PRD principle 4: every Choice is asked in BOTH option orders", () => {
    for (const f of P2) for (const d of f.questions) expect(d.option_order, `${f.id}/${d.question_id}`).toBe("both");
  });

  it("the wording is English and holds no PHI shape: no digit run, e-mail, URL, phone, or non-ASCII letter", () => {
    for (const f of P2) {
      const text = JSON.stringify(f);
      expect(text, f.id).not.toMatch(/\d{5,}/);
      expect(text, f.id).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
      expect(text, f.id).not.toMatch(/https?:\/\//i);
      expect(/[ऀ-෿]/.test(text), `${f.id} wording must be English`).toBe(false);
      expect(text, f.id).not.toMatch(/\b(Dr\.?|Mr\.?|Mrs\.?|Ms\.?)\s+[A-Z]/);
    }
  });

  it("the hashes are distinct, stable, and a one-character change moves them", () => {
    const shas = FILES.map((f) => setSha(f));
    expect(new Set(shas).size).toBe(shas.length);
    expect(FILES.map((f) => setSha(f))).toEqual(shas);
    const f = JSON.parse(JSON.stringify(byId("u10-timeline"))) as QuestionSetFile;
    (f.questions[0]!.body as { instructions: string }).instructions += " ";
    expect(setSha(f)).not.toBe(setSha(byId("u10-timeline")));
  });

  it("QS-PITCH carries the 12:27 ruling: seven pitch types plus no_pitch, uptake per pitch with cost_block, surgery is not a gate", () => {
    expect(opts(q("pitch-uptake", "pitch_type"))).toEqual(["investigation", "procedure", "surgery", "medication", "physio", "follow_up", "other", "no_pitch", "insufficient_evidence"]);
    expect(opts(q("pitch-uptake", "uptake"))).toEqual(["accept", "hedge", "defer", "question", "cost_block", "decline", "unheard", "not_applicable", "insufficient_evidence"]);
    expect(q("pitch-uptake", "uptake").gate_requires).toEqual(["investigation", "procedure", "surgery", "medication", "physio", "follow_up", "other"]);
    expect(byId("pitch-uptake").subject_type).toBe("pitch");
    expect(q("pitch-detect", "pitch_surgery").question_id).toBe("pitch_surgery");   // one detection question per type; surgery is just one of seven
    expect(byId("pitch-detect").questions.map((d) => d.question_id)).toEqual(["pitch_investigation", "pitch_procedure", "pitch_surgery", "pitch_medication", "pitch_physio", "pitch_follow_up", "pitch_other"]);
  });

  it("the gates the PRD names are in the files: recovery, cost, pitch_type, u10_kind", () => {
    expect(q("pitch-uptake", "recovery_appropriateness")).toMatchObject({ gate_question_id: "recovery_discussion", gate_requires: ["mentioned_only", "adequate", "thorough_tailored"] });
    expect(q("pitch-uptake", "cost_answered")).toMatchObject({ gate_question_id: "cost_discussed", gate_requires: ["yes"] });
    for (const id of ["u10_end_row", "u10_end_signal", "u10_start_offset", "u10_walk_in"]) expect(q("u10-timeline", id)).toMatchObject({ gate_question_id: "u10_kind", gate_requires: ["consultation", "multiple_consultations"] });
  });

  it("QS-TIMELINE: the consult ends when the patient leaves; the end row is a candidate key; the encounter end is not an option", () => {
    const endRow = q("u10-timeline", "u10_end_row");
    expect(opts(endRow)).toEqual([...Array.from({ length: 12 }, (_, i) => `cand_${String(i + 1).padStart(2, "0")}`), "continues_past_segment", "no_consultation_in_segment", "insufficient_evidence"]);
    expect(JSON.stringify(endRow.body)).toMatch(/patient leaves the room/);
    expect(JSON.stringify(endRow.body)).toMatch(/Note submission is the encounter end/);
    expect(opts(q("u10-timeline", "u10_kind"))).toEqual(["consultation", "multiple_consultations", "staff_or_admin", "doctor_alone_talk", "empty_room", "insufficient_evidence"]);
    expect(opts(q("u10-timeline", "u10_end_signal"))).toContain("patient_side_voices_stop_doctor_alone");
  });

  it("QS-STT-GATE options are the PRD's, and the engines are only ever version_A / version_B", () => {
    expect(opts(q("stt-quality", "stt_usable"))).toEqual(["usable", "partly_usable", "unusable_garbled", "unusable_wrong_language", "no_speech_text", "not_applicable", "insufficient_evidence"]);
    expect(opts(q("stt-pick", "stt_pick"))).toEqual(["version_A", "version_B", "both_equivalent", "neither", "insufficient_evidence"]);
    expect(opts(q("stt-pick", "meaning_change"))).toEqual(["same_meaning", "negation_flip", "laterality_or_site", "drug_or_procedure_name", "other_clinical_change", "non_clinical_difference", "insufficient_evidence"]);
    for (const id of ["stt-quality", "stt-pick"]) expect(JSON.stringify(byId(id)), id).not.toMatch(/whisper|sarvam|deepgram|indicconformer|eleven/i);
  });

  it("QS-DOUBT and QS-AFFECT carry the v9 additions (not_a_doubt, insufficient_evidence everywhere) and the affect axes", () => {
    expect(opts(q("doubt", "doubt_type"))).toContain("not_a_doubt");
    for (const d of byId("doubt").questions) expect(opts(d)).toContain("insufficient_evidence");
    expect(byId("chair-affect").questions.map((d) => d.question_id)).toEqual(["distress", "confusion", "frustration", "reassurance"]);
    expect(JSON.stringify(byId("chair-affect"))).toMatch(/Default to low/);
  });

  it("encounter-end says the encounter ends at note submission and that the timeline cannot show it (research)", () => {
    expect(JSON.stringify(byId("encounter-end"))).toMatch(/submits the note/);
    expect(JSON.stringify(byId("encounter-end"))).toMatch(/cannot show a note being submitted/);
  });
});

describe("tokens by script and the budget", () => {
  it("Indic script costs ~0.85/char, English ~0.35/char, so the same character count is not the same budget", () => {
    const en = "a".repeat(1000), hi = "क".repeat(1000);
    expect(estimateTokens(en)).toBeLessThan(400);
    expect(estimateTokens(hi)).toBeGreaterThan(800);
    expect(overBudget("क".repeat(40_000))).toBe(true);
    expect(overBudget("a".repeat(40_000))).toBe(false);
    expect(STATE_TOKEN_BUDGET).toBeLessThan(32_000);
  });
});

describe("transcript-v1: pre-gates, focus and excerpt", () => {
  const mk = (n: number, speaker: "doctor" | "other" = "other") => Array.from({ length: n }, (_, i) => ({ t_ms: i * 20_000, speaker, speaker_idx: 0, text: `line ${i}` }));
  const ct = (lines: ReturnType<typeof mk>) => ({ lines, source: "window_english" as const });

  it("under 3 patient-side turns the call is SKIPPED (abstain), never sent", () => {
    expect(transcriptState("ck", ct([...mk(MIN_PATIENT_TURNS - 1, "other"), ...mk(5, "doctor")]))).toEqual({ abstain: "patient_side_speech_lt_3_turns" });
    expect("state" in transcriptState("ck", ct(mk(3)))).toBe(true);
  });
  it("over the token budget is tooLarge (a typed row), not truncated", () => {
    const big = Array.from({ length: 4 }, (_, i) => ({ t_ms: i * 1000, speaker: "other" as const, speaker_idx: 0, text: "क".repeat(40_000) }));
    expect(transcriptState("ck", ct(big))).toMatchObject({ tooLarge: true });
  });
  it("the state has only the transcript (+ focus): no key, room, date or id, and roles are DOCTOR / PATIENT-SIDE", () => {
    const s = transcriptState("ck_secret", ct(mk(4)), { focus: { at_ms: 65_000, hint: "investigation" } });
    if (!("state" in s)) throw new Error("expected a state");
    expect(Object.keys(s.state as object).sort()).toEqual(["focus", "transcript"]);
    expect((s.state as { focus: Record<string, string> }).focus).toEqual({ near: "01:05" });   // the type hint is a scoring label and is NOT sent (F2)
    expect(JSON.stringify(s.state)).not.toMatch(/investigation|suggestion_type_hint|hint/);
    expect(JSON.stringify(s.state)).not.toContain("ck_secret");
    expect(JSON.stringify(s.state)).toMatch(/\[00:00\] PATIENT-SIDE: line 0/);
    expect(s.lane).toBe("text");
  });
  it("F2: no hint reaches Jev state, whatever the locator carries (pitch and doubt builders, direct and via the locator store)", async () => {
    const lines = Array.from({ length: 12 }, (_, i) => ({ t_ms: i * 20_000, speaker: (i % 2 ? "other" : "doctor") as "other" | "doctor", speaker_idx: 0, text: `line ${i}` }));
    const read = { read: async () => ({ ok: true as const, data: { lines, source: "window_english" as const } }) };
    clearLocators();
    setLocator("ckx#p1", { at_ms: 60_000, hint: "SURGERY-HINT-XYZ" });
    setLocator("ckx#d1", { at_ms: 60_000, hint: "SURGERY-HINT-XYZ", text: "is it safe" });
    for (const build of [buildPitchState("ckx#p1", read), buildDoubtState("ckx#d1", read)]) {
      const st = await build;
      if (!st || !("state" in st)) throw new Error("expected a state");
      expect(JSON.stringify(st.state)).not.toContain("SURGERY-HINT-XYZ");
      expect(JSON.stringify(st.state)).not.toMatch(/hint/);
      expect(JSON.stringify(st.evidence)).not.toContain("SURGERY-HINT-XYZ");
    }
    clearLocators();
  });
  it("a doubt excerpt is -45 s .. +150 s around the doubt and nothing else", () => {
    const lines = Array.from({ length: 30 }, (_, i) => ({ t_ms: i * 20_000, speaker: "other" as const, speaker_idx: 0, text: `line ${i}` }));
    const s = transcriptState("ck", ct(lines), { focus: { at_ms: 300_000, text: "will it hurt" }, excerpt: { before_ms: 45_000, after_ms: 150_000 } });
    if (!("state" in s)) throw new Error("expected a state");
    const t = (s.state as { transcript: string }).transcript.split("\n");
    expect(t[0]).toMatch(/^\[04:20\]/);          // 300 s - 45 s = 255 s -> first line at or after is 260 s
    expect(t[t.length - 1]).toMatch(/^\[07:20\]/); // 300 s + 150 s = 450 s -> last line at or before is 440 s
    expect(t.length).toBe(10);
  });
});

describe("timeline candidates and the End-click mask", () => {
  const anchor = (over: Partial<Anchor> = {}): Anchor => ({
    consult_key: "ck", room_id: "room_x", start_ms: 1_000_000, close_kind: "clicked_end", end_clicked: true, end_click_ms: 1_000_000 + 600_000, end_weak_ms: null, end_weak_kind: null,
    next_start_ms: 1_000_000 + 900_000, doctor_uid_warehouse: null, doctor_uid_ext: null, doctor_source: "none", quality: "clean" as never, weak_start: false, ...over,
  });
  // 12 minutes of rows: patient voice B 0-6 min, DOC alone 6-9 min, quiet 9-12 min
  const build = () => {
    const turns = [{ start_ms: 0, end_ms: 360_000, speaker_idx: 1 }, { start_ms: 360_000, end_ms: 540_000, speaker_idx: 0 }];
    const input: TimelineInput = { grid_origin_ms: 1_000_000 - 60_000, energy: [], tape_off: [], windows: [{ window_id: "w1", origin_ms: 1_000_000 - 60_000, window_end_ms: 1_000_000 + 900_000, turns: turns.map((t) => ({ ...t, start_ms: t.start_ms + 60_000, end_ms: t.end_ms + 60_000 })) }],
      role: (_w, idx) => (idx === 0 ? "doc" : "other") };
    const a = anchor();
    return buildSegment({ anchor: a, start_ms: a.start_ms - 60_000, end_ms: a.start_ms + 720_000 }, input);
  };

  it("the state Jev reads has the End clicks MASKED to none, the candidates attached, and no click time anywhere", () => {
    const built = build();
    if (!built.ok) throw new Error("fixture must build");
    expect(built.state.anchor !== "none" && built.state.anchor.end_click !== "none").toBe(true);   // the raw segment DOES carry the click
    const s = timelineJevState(built, "tl_rd_1000000");
    const st = s.state as { anchor: { end_click: string; end_weak: string }; candidates: Array<{ key: string; row: string }>; rows: unknown[] };
    expect(st.anchor.end_click).toBe("none");
    expect(st.anchor.end_weak).toBe("none");
    expect(JSON.stringify(st.anchor)).not.toContain("t+10:00");   // the click was at t+10:00 (a row label may be, the header may not name it)
    expect(st.candidates.length).toBeGreaterThan(0);
    expect(st.candidates.length).toBeLessThanOrEqual(MAX_CANDIDATES);
    expect(s.lane).toBe("timeline");
  });
  it("the candidates are chronological, deduplicated, at most 12, and keyed cand_01.. in order", () => {
    const built = build();
    if (!built.ok) throw new Error("fixture must build");
    const s = timelineJevState(built, "tl_rd_1000000");
    const cands = (s.state as { candidates: Array<{ key: string; row: string }> }).candidates;
    expect(cands.map((c) => c.key)).toEqual(cands.map((_, i) => `cand_${String(i + 1).padStart(2, "0")}`));
    const secs = cands.map((c) => { const m = /^t([+-])(\d+):(\d\d)/.exec(c.row)!; return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])); });
    expect([...secs].sort((a, b) => a - b)).toEqual(secs);
    expect(new Set(secs).size).toBe(secs.length);
  });
  it("candidateRows: the last row of an early patient voice, the active->silent edge, the row before next_start, and the cap", () => {
    const row = (t: string, speech: number | null, spk: Record<string, number> | null, new_spk: string[] = []) => ({ t, sound: "active" as const, speech_s: speech, spk, turns: 1, overlap_s: 0, new_spk });
    const rows = [row("t+00:00", 20, { B: 20 }, ["B"]), row("t+00:30", 20, { B: 20 }), row("t+01:00", 20, { DOC: 20 }), row("t+01:30", 0, {}), row("t+02:00", 0, {}), row("t+02:30", 0, {}), row("t+03:00", 15, { C: 15 }, ["C"])];
    const idx = candidateRows(rows, "t+03:00");
    expect(idx).toContain(1);   // the last row with B (heard in the first 5 minutes)
    expect(idx).toContain(2);   // the last DOC row, and the active row before 2+ silent rows
    expect(idx).toContain(5);   // the row before the new voice after 60 s of quiet / before next_start
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    const many = Array.from({ length: 80 }, (_, i) => row(`t+${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`, i % 7 === 0 ? 0 : 10, { B: 10 }, i === 0 ? ["B"] : []));
    expect(candidateRows(many, null).length).toBeLessThanOrEqual(MAX_CANDIDATES);
    expect(candidateRows([], null)).toEqual([]);
  });
  it("resolveTimelineAnswer maps cand_NN back to its row, and leaves any other key alone", () => {
    const ev = { candidates: { cand_01: "t+02:30", cand_02: "t+05:00" } };
    expect(resolveTimelineAnswer("u10_end_row", "cand_02", ev)).toBe("t+05:00");
    expect(resolveTimelineAnswer("u10_end_row", "continues_past_segment", ev)).toBe("continues_past_segment");
    expect(resolveTimelineAnswer("u10_kind", "consultation", ev)).toBe("consultation");
  });
});

describe("stt builders (O4: consult clips and encounter audio only)", () => {
  const run = (id: string, over: Partial<RunRow> = {}): RunRow => ({ id, subject_type: "encounter", subject_id: "enc_1", detected_language: "hi", transcript_original: "namaste doctor", transcript_english: "hello doctor", ...over });
  const deps = (rows: RunRow[]) => ({ run: async (id: string) => rows.find((r) => r.id === id) ?? null });

  it("a ROOM WINDOW run is refused scope_consult_only: no state is built (run and pair)", async () => {
    expect(await buildSttRunState("r1", deps([run("r1", { subject_type: "bench_window" })]))).toEqual({ abstain: "scope_consult_only" });
    expect(await buildSttRunState("r1", deps([run("r1", { subject_type: "bench_session" })]))).toEqual({ abstain: "scope_consult_only" });
    expect(await buildSttPairState("a+b", deps([run("a", { subject_type: "bench_window" }), run("b")]))).toEqual({ abstain: "scope_consult_only" });
  });
  it("an encounter run builds a state with feature buckets and the native text + EN gloss", async () => {
    const s = await buildSttRunState("r1", deps([run("r1")]));
    if (!s || !("state" in s)) throw new Error("expected a state");
    expect(s.state).toEqual({ features: { repeat_ratio: "none", language: "hi" }, transcript: "namaste doctor\n[EN: hello doctor]" });
    expect(s.evidence).toMatchObject({ stt_run_ids: ["r1"] });
  });
  it("a pair hides the engines (version_A / version_B), is deterministic, and records the assignment server-side only", async () => {
    const rows = [run("a", { transcript_original: "one", transcript_english: null }), run("b", { transcript_original: "two", transcript_english: null })];
    const s1 = await buildSttPairState("a+b", deps(rows)), s2 = await buildSttPairState("a+b", deps(rows));
    if (!s1 || !("state" in s1) || !s2 || !("state" in s2)) throw new Error("expected states");
    expect(s1.state).toEqual(s2.state);
    expect(Object.keys(s1.state as object).sort()).toEqual(["features", "version_A", "version_B"]);
    expect(JSON.stringify(s1.state)).not.toMatch(/"a"|"b"|whisper|sarvam/);
    const ab = (s1.evidence as { ab: Record<string, string> }).ab;
    expect([ab.version_A, ab.version_B].sort()).toEqual(["a", "b"]);
    expect(resolveSttPick("stt_pick", "version_A", s1.evidence)).toBe(ab.version_A);
    expect(resolveSttPick("stt_pick", "both_equivalent", s1.evidence)).toBe("both_equivalent");
  });
  it("two runs of different subjects are not a pair; a missing run is no opinion", async () => {
    expect(await buildSttPairState("a+b", deps([run("a"), run("b", { subject_id: "enc_2" })]))).toEqual({ abstain: "runs_of_different_subjects" });
    expect(await buildSttPairState("a+zz", deps([run("a")]))).toBeNull();
    expect(await buildSttPairState("nopair", deps([]))).toBeNull();
  });
  it("repeatBucket: a hallucinated loop is 'loop', ordinary speech 'none'", () => {
    expect(repeatBucket("please take the tablet twice a day after food and come back in one week")).toBe("none");
    expect(repeatBucket(Array(40).fill("thank you very much").join(" "))).toBe("loop");
  });
});

describe("pitch and doubt locators (enumerated by code or the agent, never by Jev)", () => {
  const lines = Array.from({ length: 20 }, (_, i) => ({ t_ms: i * 20_000, speaker: (i % 2 ? "other" : "doctor") as "other" | "doctor", speaker_idx: 0, text: `line ${i}` }));
  const read = { read: async () => ({ ok: true as const, data: { lines, source: "window_english" as const } }) };

  it("a subject with no locator is an abstain row, never a guess", async () => {
    clearLocators();
    expect(await buildPitchState("ck#p1", read)).toEqual({ abstain: "no_locator" });
    expect(await buildDoubtState("ck#d1", read)).toEqual({ abstain: "no_locator" });
    expect(await buildPitchState("ck_no_pitch_suffix", read)).toBeNull();
  });
  it("a pitch state is the whole clip + a focus marker; a doubt state is the excerpt and never carries any coding", async () => {
    clearLocators();
    setLocator("ck#p1", { at_ms: 100_000, hint: "medication" });
    setLocator("ck#d1", { at_ms: 200_000, text: "will it cost a lot" });
    const p = await buildPitchState("ck#p1", read), d = await buildDoubtState("ck#d1", read);
    if (!p || !("state" in p) || !d || !("state" in d)) throw new Error("expected states");
    expect((p.state as { transcript: string }).transcript.split("\n").length).toBe(20);
    expect(Object.keys(d.state as object).sort()).toEqual(["focus", "transcript"]);   // the agent's coding is not in the state
    expect((d.state as { transcript: string }).transcript.split("\n").length).toBeLessThan(20);
    expect(d.evidence).toMatchObject({ consult_key: "ck", focus_at_s: 200 });
    clearLocators();
  });
});

describe("shadow rows are used by nothing; the bench CLI refuses without arguments", () => {
  it("no code outside lib/jev and the migrations reads jev_decision_current (the view consumers will read in P2.3+): shadow decisions feed no behaviour", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        if (n === "node_modules" || n === ".next") continue;
        const p = `${dir}/${n}`;
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(n) && readFileSync(p, "utf8").includes("jev_decision_current")) hits.push(p);
      }
    };
    for (const d of ["app", "lib", "components", "scripts"]) walk(d);
    expect(hits.filter((h) => !h.startsWith("lib/jev/worker/"))).toEqual([]);
  });

  it("scripts/jev-bench.ts with no arguments prints its usage and exits 2 (it touches nothing)", () => {
    let code = 0, err = "";
    try { execFileSync("npx", ["tsx", "scripts/jev-bench.ts"], { stdio: "pipe", timeout: 90_000, env: { ...process.env, DATABASE_URL: "" } }); } catch (e) { code = (e as { status?: number }).status ?? -1; err = String((e as { stderr?: Buffer }).stderr ?? ""); }
    expect(code).toBe(2);
    expect(err).toMatch(/usage: --use <use> --set <id@version> --subjects/);
  });
});

describe("F1: the bench report scores the POST-gate answer", () => {
  const defs = [
    { question_id: "u10_kind", kind: "choice", body: { type: "choice", instructions: "x", criteria: { consultation: "a", empty_room: "b", insufficient_evidence: "c" } }, escape_options: ["insufficient_evidence"] },
    { question_id: "u10_end_row", kind: "choice", body: { type: "choice", instructions: "x", criteria: { cand_01: "a", cand_02: "b", insufficient_evidence: "c" } }, escape_options: ["insufficient_evidence"], gate_question_id: "u10_kind", gate_requires: ["consultation"] },
  ] as unknown as QuestionDef[];
  const row = (subject_id: string, question_id: string, value: string, gated?: true) => ({ subject_id, question_id, variant: "derived", kind: "choice", value, confidence: 0.7, ...(gated ? { gated } : {}) });
  const outcome = (id: string, rows: ReturnType<typeof row>[]) => ({ subject_id: id, status: "asked" as const, rows, evidence: { candidates: { cand_01: "t+02:00", cand_02: "t+05:00" } }, tokens: 1, calls: 2 });
  const resolve = (_q: string, v: string, ev: Record<string, unknown>) => ((ev.candidates as Record<string, string>)[v] ?? v);

  it("a gated answer is counted as an abstain (n_gated) and is NOT scored against a label", () => {
    const rep = buildBenchReport({
      set: { id: "u10-timeline", version: "v2", sha: "a".repeat(64), use: "encounter_timeline" }, defs, resolve, mock: false, usdPerToken: 0,
      outcomes: [outcome("s1", [row("s1", "u10_kind", "consultation"), row("s1", "u10_end_row", "cand_02")]), outcome("s2", [row("s2", "u10_kind", "empty_room"), row("s2", "u10_end_row", "cand_02", true)])],
      labels: [{ subject_id: "s1", question_id: "u10_end_row", label: "t+05:00" }, { subject_id: "s2", question_id: "u10_end_row", label: "t+05:00" }],
    });
    const q = rep.questions.find((x) => x.question_id === "u10_end_row")!;
    expect(q.n_gated).toBe(1);
    expect(q.distribution).toEqual({ cand_02: 1, gated_overwritten: 1 });
    expect(q.vs_labels).toMatchObject({ n_labeled: 2, n_scored: 1, coverage: 0.5, accuracy: 1 });   // s2's raw cand_02 is NOT scored
    expect(q.vs_labels!.confusion).toEqual({ "t+05:00": { "t+05:00": 1 } });
  });
  it("without the gated flag the same row WOULD be scored (so the flag is what changes the number)", () => {
    const rep = buildBenchReport({
      set: { id: "u10-timeline", version: "v2", sha: "a".repeat(64), use: "encounter_timeline" }, defs, resolve, mock: false, usdPerToken: 0,
      outcomes: [outcome("s2", [row("s2", "u10_kind", "empty_room"), row("s2", "u10_end_row", "cand_01")])],
      labels: [{ subject_id: "s2", question_id: "u10_end_row", label: "t+05:00" }],
    });
    expect(rep.questions.find((x) => x.question_id === "u10_end_row")!.vs_labels).toMatchObject({ n_scored: 1, accuracy: 0 });
  });
});

describe("F5: gates are TRANSITIVE and evaluated against the post-gate value", () => {
  const ch = (choice: string): JevAnswer => ({ type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 1 });
  const rowsFor = (defs: QuestionDef[]): WorkerDecision[] => defs.map((d) => ({ questionId: d.question_id, orderVariant: "derived", outcome: "answered", band: "review", evidence: {} }) as unknown as WorkerDecision);
  const benchFor = (defs: QuestionDef[]) => defs.map((d) => ({ subject_id: "s", question_id: d.question_id, variant: "derived", kind: "choice", value: "x", confidence: 1 }));
  const run = (defs: QuestionDef[], answers: Record<string, string>) => {
    const rows = rowsFor(defs), bench = benchFor(defs);
    applyGates(defs, new Map(Object.entries(answers).map(([k, v]) => [k, ch(v)])), rows, bench);
    return { out: Object.fromEntries(rows.map((r) => [r.questionId, r.outcome])), gated: Object.fromEntries(bench.map((b) => [b.question_id, (b as { gated?: boolean }).gated === true])) };
  };
  const PU = byId("pitch-uptake").questions;
  const PER_PITCH = PU.filter((d) => d.question_id !== "pitch_type").map((d) => d.question_id);

  it("THE REFUTER'S PROBE: pitch_type = no_pitch, recovery_discussion = adequate, cost_discussed = yes -> recovery_appropriateness and cost_answered are gated too", () => {
    const { out, gated } = run(PU, { pitch_type: "no_pitch", recovery_discussion: "adequate", cost_discussed: "yes", recovery_appropriateness: "appropriate", cost_answered: "answered", uptake: "accept" });
    expect(out.pitch_type).toBe("answered");
    for (const id of PER_PITCH) { expect(out[id], id).toBe("gated_overwritten"); expect(gated[id], `${id} bench row marked gated`).toBe(true); }
    expect(gated.pitch_type).toBe(false);
  });
  it("a pitch_type escape (insufficient_evidence) closes the same chain", () => {
    const { out } = run(PU, { pitch_type: "insufficient_evidence", recovery_discussion: "thorough_tailored", cost_discussed: "yes" });
    for (const id of PER_PITCH) expect(out[id], id).toBe("gated_overwritten");
  });
  it("CONTROLS: a real pitch keeps the items open; each middle gate closes only ITS chain (recovery none / cost no)", () => {
    expect(Object.values(run(PU, { pitch_type: "surgery", recovery_discussion: "adequate", cost_discussed: "yes" }).out).every((o) => o === "answered")).toBe(true);
    const a = run(PU, { pitch_type: "medication", recovery_discussion: "none", cost_discussed: "yes" }).out;
    expect(a.recovery_appropriateness).toBe("gated_overwritten");
    expect(a.cost_answered).toBe("answered");
    expect(a.uptake).toBe("answered");
    const b = run(PU, { pitch_type: "medication", recovery_discussion: "adequate", cost_discussed: "no" }).out;
    expect(b.cost_answered).toBe("gated_overwritten");
    expect(b.recovery_appropriateness).toBe("answered");
  });
  const mk = (id: string, gate?: string, requires?: string[]): QuestionDef => ({ question_id: id, kind: "choice", body: { type: "choice", instructions: "x", criteria: { go: "a", stop: "b", insufficient_evidence: "c" } }, escape_options: ["insufficient_evidence"], ...(gate ? { gate_question_id: gate, gate_requires: requires ?? ["go"] } : {}) }) as unknown as QuestionDef;
  it("a THREE-LEVEL chain a > b > c, and a FOUR-level chain: closing the root closes every level, whatever the declaration order", () => {
    const three = [mk("c", "b"), mk("b", "a"), mk("a")];          // dependents declared BEFORE their gates
    const r3 = run(three, { a: "stop", b: "go", c: "go" });
    expect(r3.out).toEqual({ a: "answered", b: "gated_overwritten", c: "gated_overwritten" });
    const four = [mk("d", "c"), mk("c", "b"), mk("b", "a"), mk("a")];
    expect(run(four, { a: "stop", b: "go", c: "go", d: "go" }).out).toEqual({ a: "answered", b: "gated_overwritten", c: "gated_overwritten", d: "gated_overwritten" });
    // the middle of the chain closing closes only what is behind it
    expect(run(three, { a: "go", b: "stop", c: "go" }).out).toEqual({ a: "answered", b: "answered", c: "gated_overwritten" });
    // all open
    expect(Object.values(run(three, { a: "go", b: "go", c: "go" }).out)).toEqual(["answered", "answered", "answered"]);
  });
  it("a closed ancestor closes the chain even through an UNANSWERED link; the unanswered row itself is not rewritten", () => {
    const three = [mk("a"), mk("b", "a"), mk("c", "b")];
    const rows = rowsFor(three); rows[1]!.outcome = "no_answer";
    applyGates(three, new Map([["a", ch("stop")]]), rows, benchFor(three));
    // F6: a (the root) is closed-by-answer for b, so b is closed WHATEVER its own outcome, and c behind it is closed with it (b stays no_answer: only answered rows are rewritten)
    expect(rows.map((r) => r.outcome)).toEqual(["answered", "no_answer", "gated_overwritten"]);
  });
});

describe("F6: a closed gate closes its dependents whatever the OUTCOME of the links in between", () => {
  const ch = (choice: string): JevAnswer => ({ type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 1 });
  const PU = byId("pitch-uptake").questions;
  const mkRows = (defs: QuestionDef[], noAnswer: Set<string>): WorkerDecision[] => defs.map((d) => ({ questionId: d.question_id, orderVariant: "derived", outcome: noAnswer.has(d.question_id) ? "no_answer" : "answered", band: "review", evidence: {} }) as unknown as WorkerDecision);
  const bench = (defs: QuestionDef[]) => defs.map((d) => ({ subject_id: "s", question_id: d.question_id, variant: "derived", kind: "choice", value: "x", confidence: 1 }));

  it("THE REFUTER'S PROBE: pitch_type = no_pitch, recovery_discussion and cost_discussed NO_ANSWER -> recovery_appropriateness and cost_answered are gated_overwritten (rows and bench)", () => {
    const rows = mkRows(PU, new Set(["recovery_discussion", "cost_discussed"])), b = bench(PU);
    applyGates(PU, new Map([["pitch_type", ch("no_pitch")]]), rows, b);
    const out = Object.fromEntries(rows.map((r) => [r.questionId, r.outcome]));
    expect(out.pitch_type).toBe("answered");
    expect(out.recovery_discussion).toBe("no_answer");        // not answered, so not rewritten
    expect(out.cost_discussed).toBe("no_answer");
    expect(out.recovery_appropriateness).toBe("gated_overwritten");
    expect(out.cost_answered).toBe("gated_overwritten");
    for (const id of PU.map((d) => d.question_id).filter((x) => !["pitch_type", "recovery_discussion", "cost_discussed"].includes(x))) expect(out[id], id).toBe("gated_overwritten");
    expect((b.find((x) => x.question_id === "cost_answered") as { gated?: boolean }).gated).toBe(true);
  });

  // an independent reference: walk the chain by hand
  const directClose = (d: QuestionDef, defs: QuestionDef[], ans: Map<string, JevAnswer>): boolean => {
    const g = ans.get(d.gate_question_id!);
    if (!g || g.type !== "choice") return false;
    if (d.gate_requires) return !d.gate_requires.includes(g.choice);
    return Boolean(defs.find((x) => x.question_id === d.gate_question_id)?.escape_options?.includes(g.choice));
  };
  const mulberry = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

  it("PROPERTY over every real set: for random answered/no_answer patterns and random answers, NO dependent of a closed gate stays answered, and nothing else is rewritten", () => {
    let trials = 0, closedSeen = 0;
    for (const f of P2) {
      const defs = f.questions;
      if (!defs.some((d) => d.gate_question_id)) continue;
      const rnd = mulberry(f.id.length * 7919);
      for (let t = 0; t < 600; t += 1) {
        const noAnswer = new Set(defs.filter(() => rnd() < 0.35).map((d) => d.question_id));
        const ans = new Map<string, JevAnswer>();
        for (const d of defs) {
          if (noAnswer.has(d.question_id)) continue;
          const keys = Object.keys((d.body as { criteria: Record<string, string> }).criteria);
          ans.set(d.question_id, ch(keys[Math.floor(rnd() * keys.length)]!));
        }
        const rows = mkRows(defs, noAnswer), b = bench(defs);
        applyGates(defs, ans, rows, b);
        const out = new Map(rows.map((r) => [r.questionId, r.outcome]));
        const by = new Map(defs.map((d) => [d.question_id, d]));
        for (const d of defs) {
          // reference: closed if it or any ancestor is closed by its direct gate's answer
          let closed = false;
          for (let cur: QuestionDef | undefined = d, hops = 0; cur?.gate_question_id && hops < 20; cur = by.get(cur.gate_question_id), hops += 1) if (directClose(cur, defs, ans)) { closed = true; break; }
          const expected = closed && !noAnswer.has(d.question_id) ? "gated_overwritten" : noAnswer.has(d.question_id) ? "no_answer" : "answered";
          expect(out.get(d.question_id), `${f.id}/${d.question_id} trial ${t}`).toBe(expected);
          if (closed) closedSeen += 1;
        }
        trials += 1;
      }
    }
    expect(trials).toBeGreaterThan(1000);
    expect(closedSeen).toBeGreaterThan(500);   // the property really exercised closed chains
  });

  it("G5: a gate with NO gate_requires closes on the gate's own ESCAPE option (and a noul under 0.5); otherwise it stays open", () => {
    const esc = (id: string, gate?: string): QuestionDef => ({ question_id: id, kind: "choice", body: { type: "choice", instructions: "x", criteria: { yes: "a", no: "b", insufficient_evidence: "c" } }, escape_options: ["insufficient_evidence"], ...(gate ? { gate_question_id: gate } : {}) }) as unknown as QuestionDef;
    const defs = [esc("a"), esc("b", "a"), esc("c", "b")];
    const run = (a: JevAnswer) => { const rows = mkRows(defs, new Set()); applyGates(defs, new Map([["a", a]]), rows, bench(defs)); return rows.map((r) => r.outcome); };
    expect(run(ch("insufficient_evidence"))).toEqual(["answered", "gated_overwritten", "gated_overwritten"]);
    expect(run(ch("yes"))).toEqual(["answered", "answered", "answered"]);
    const noul = [{ question_id: "n", kind: "noul", body: { type: "noul", instructions: "x" } }, { question_id: "m", kind: "noul", body: { type: "noul", instructions: "x" }, gate_question_id: "n" }] as unknown as QuestionDef[];
    const lo = mkRows(noul, new Set()); applyGates(noul, new Map([["n", { type: "noul", noul: 0.2 } as JevAnswer]]), lo, bench(noul));
    expect(lo.map((r) => r.outcome)).toEqual(["answered", "gated_overwritten"]);
    const hi = mkRows(noul, new Set()); applyGates(noul, new Map([["n", { type: "noul", noul: 0.8 } as JevAnswer]]), hi, bench(noul));
    expect(hi.map((r) => r.outcome)).toEqual(["answered", "answered"]);
  });

  it("a gate cycle does not hang and closes nothing by itself", () => {
    const x = (id: string, gate: string): QuestionDef => ({ question_id: id, kind: "choice", body: { type: "choice", instructions: "x", criteria: { go: "a", stop: "b", insufficient_evidence: "c" } }, escape_options: ["insufficient_evidence"], gate_question_id: gate, gate_requires: ["go"] }) as unknown as QuestionDef;
    const defs = [x("p", "q"), x("q", "p")];
    const rows = mkRows(defs, new Set());
    expect(() => applyGates(defs, new Map([["p", ch("go")], ["q", ch("go")]]), rows, bench(defs))).not.toThrow();
    expect(rows.map((r) => r.outcome)).toEqual(["answered", "answered"]);
  });
});
