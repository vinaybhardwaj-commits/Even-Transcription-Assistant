/**
 * encounter-fusion.test.ts — E-6: the fusion arbitration (fusion.ts), the state builder (fusion-state.ts),
 * the flag, the 0118 vocabularies, and shadow-runner v2 (shadow-v2.ts) with every dependency injected.
 * `sql` is mocked to THROW: nothing here may reach a database except through an injected dep. All values
 * synthetic; no transcript text exists in this file beyond made-up placeholder phrases.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  sql: () => { throw new Error("no database in this test"); },
}));

import { join } from "node:path";
import {
  clinicalVerdict, fuseEncounters, phaseOf, startVerdict, START_P, FUSION_VERSION, type ProbeJudgement,
  proposeFromJev, inConsultation, END_P, JEV_MIN_RUN,
} from "@/lib/encounter-clock/fusion";
import {
  slotsFromCentres, textForSlots, probeSubjectId, windowState, boundaryState, FUSION_HOP_MS,
} from "@/lib/encounter-clock/fusion-state";
import { SMOOTHER_VERSION, type Encounter } from "@/lib/encounter-clock/smooth";
import type { AcousticProbe, DayEvidence } from "@/lib/encounter-clock/shadow";
import { runShadow } from "@/lib/encounter-clock/shadow";
import { encounterFusionShadowEnabled, ENCOUNTER_FUSION_SHADOW } from "@/lib/encounter-clock/flag";
import { runFusionShadowForRoomDay, type FusionDeps } from "@/lib/encounter-clock/shadow-v2";
import { RUN_SOURCES, checkRunInput, isMissingSourceColumn, type HypothesisRunInput, type WriteRunResult } from "@/lib/encounter-hypotheses";
import { JEV_SUBJECT_TYPES, JevDisabledError } from "@/lib/jev/types";
import type { JevAsk, JevAskOutcome } from "@/lib/jev/ask";
import {
  U1_OPTIONS, U1_PROMPT_VERSION, U2_PROMPT_VERSION, U6_PROMPT_VERSION,
} from "@/lib/jev/prompts/encounter-v1";
import type { BenchLevelSample } from "@/lib/bench-levels";
import { effectiveCheckValues } from "../support/sql-check";

const MIGRATIONS = join(process.cwd(), "db/migrations");
const T0 = Date.parse("2026-09-23T03:30:00.000Z");
const MIN = 60_000;
const HOP = FUSION_HOP_MS;

// ── fixtures for the pure fusion ────────────────────────────────────────────────────────────────
/** n speech probes one hop apart from T0 (centres T0 + i*HOP). */
const grid = (n: number): AcousticProbe[] =>
  Array.from({ length: n }, (_, i) => ({ t: T0 + i * HOP, verdict: "speech", reason: "speech", start_ms: T0 + i * HOP - 90_000, end_ms: T0 + i * HOP + 90_000 }));
/** The acoustic encounter covering probes a..b, written out by hand (not by the code under test). */
const enc = (a: number, b: number, over: Partial<Encounter> = {}): Encounter => ({
  version: SMOOTHER_VERSION, start_ms: T0 + a * HOP - HOP / 2, end_ms: T0 + b * HOP + HOP / 2,
  speech_probes: b - a + 1, non_speech_probes: 0, unjudged_ms: 0, longest_unjudged_run_ms: 0, dead_mic_ms: 0,
  doctor_present: { yes: 0, no: 0, unknown: b - a + 1 }, closed_by: "non_speech", merged_from: 1, ...over,
});
const clinical = (index: number, over: Partial<ProbeJudgement> = {}): ProbeJudgement => ({
  index, judged: true,
  phase: { choice: "history_taking", phase: "consult", confidence: 0.95, band: "act" },
  kind: { choice: "clinical_consultation", confidence: 0.95, band: "act" },
  start: 0.1, end: 0.1, ...over,
});
const chatter = (index: number, over: Partial<ProbeJudgement> = {}): ProbeJudgement => ({
  index, judged: true,
  phase: { choice: "not_a_consultation", phase: "none", confidence: 0.95, band: "act" },
  kind: { choice: "social_chatter", confidence: 0.95, band: "act" },
  start: 0.1, end: 0.1, ...over,
});

describe("phaseOf — the nine trialled U1 options onto the order's four phases", () => {
  it("maps every option, and exactly these", () => {
    const want: Record<string, string> = {
      greeting: "pre", history_taking: "consult", examination: "consult", diagnosis_explained: "consult",
      prescribing: "consult", counselling_or_advice: "consult", closing: "post", not_a_consultation: "none",
      cannot_tell: "unknown",
    };
    expect([...U1_OPTIONS].sort()).toEqual(Object.keys(want).sort());
    for (const o of U1_OPTIONS) expect(phaseOf(o)).toBe(want[o]);
  });
});

describe("clinicalVerdict / startVerdict — code arbitrates", () => {
  it("clinical needs U6 clinical_consultation outside the review band", () => {
    expect(clinicalVerdict(clinical(0))).toEqual({ clinical: true, contradiction: false });
    expect(clinicalVerdict(clinical(0, { kind: { choice: "clinical_consultation", confidence: 0.6, band: "caution" } })).clinical).toBe(true);
    expect(clinicalVerdict(clinical(0, { kind: { choice: "clinical_consultation", confidence: 0.4, band: "review" } })).clinical).toBe(false);
    expect(clinicalVerdict(chatter(0))).toEqual({ clinical: false, contradiction: false });
    expect(clinicalVerdict({ index: 0, judged: false })).toEqual({ clinical: false, contradiction: false });
  });
  it("U6 clinical against a CONFIDENT U1 not_a_consultation is not clinical, and is counted", () => {
    const j = clinical(0, { phase: { choice: "not_a_consultation", phase: "none", confidence: 0.95, band: "act" } });
    expect(clinicalVerdict(j)).toEqual({ clinical: false, contradiction: true });
    // the same U1 answer at the caution band does not overrule U6
    const k = clinical(0, { phase: { choice: "not_a_consultation", phase: "none", confidence: 0.7, band: "caution" } });
    expect(clinicalVerdict(k)).toEqual({ clinical: true, contradiction: false });
  });
  it("a start needs P >= 0.9 on a clinical probe; a confident start on a non-clinical probe is a contradiction", () => {
    expect(START_P).toBe(0.9);
    expect(startVerdict(clinical(0, { start: 0.9 }))).toEqual({ boundary: true, contradiction: false });
    expect(startVerdict(clinical(0, { start: 0.89 }))).toEqual({ boundary: false, contradiction: false });
    expect(startVerdict(chatter(0, { start: 0.95 }))).toEqual({ boundary: false, contradiction: true });
    expect(startVerdict({ index: 0, judged: false, start: 0.99 })).toEqual({ boundary: false, contradiction: false });
  });
});

describe("fuseEncounters", () => {
  it("CONFIRMS an encounter with a clinical probe and no confident start inside", () => {
    const probes = grid(6);
    const e = enc(1, 4);
    const r = fuseEncounters([e], probes, [chatter(1), clinical(2), clinical(3), chatter(4)], HOP);
    expect(r.version).toBe(FUSION_VERSION);
    expect(r.encounters).toEqual([e]);
    expect(r.decisions[0]).toMatchObject({ action: "confirm", probes: 4, judged_probes: 4, clinical_probes: 2, contradictions: 0 });
    expect(r.counts).toEqual({ confirm: 1, split: 0, reject: 0, rejected_no_evidence: 0, contradictions: 0 });
  });

  it("REJECTS an encounter whose judged probes hold nothing clinical (needs-clinical)", () => {
    const r = fuseEncounters([enc(0, 2)], grid(3), [chatter(0), chatter(1), chatter(2)], HOP);
    expect(r.encounters).toEqual([]);
    expect(r.decisions[0]).toMatchObject({ action: "reject", reject_reason: "no_clinical_probe", judged_probes: 3, clinical_probes: 0 });
    expect(r.counts).toMatchObject({ reject: 1, rejected_no_evidence: 0 });
  });

  it("REJECTS for lack of evidence, and says so, when no probe inside was judged", () => {
    const r = fuseEncounters([enc(0, 2)], grid(3), [], HOP);
    expect(r.encounters).toEqual([]);
    expect(r.decisions[0]).toMatchObject({ action: "reject", reject_reason: "no_judged_probe", judged_probes: 0 });
    expect(r.counts).toMatchObject({ reject: 1, rejected_no_evidence: 1 });
  });

  it("SPLITS at a confident start on a clinical probe; each piece re-tallied, the earlier closed by content_boundary", () => {
    const probes = grid(6);
    const e = enc(0, 5, { closed_by: "end_of_input" });
    const js = [clinical(0), clinical(1), clinical(2), clinical(3, { start: 0.97 }), clinical(4), clinical(5)];
    const r = fuseEncounters([e], probes, js, HOP);
    expect(r.decisions[0]).toMatchObject({ action: "split", pieces_kept: 2, pieces_dropped: 0 });
    expect(r.encounters).toHaveLength(2);
    const [a, b] = r.encounters;
    // numbers written from the grid: probes 0..2 and 3..5, 60 s each, owned half a hop either side
    expect(a).toMatchObject({ start_ms: T0 - 30_000, end_ms: T0 + 2 * HOP + 30_000, speech_probes: 3, closed_by: "content_boundary" });
    expect(b).toMatchObject({ start_ms: T0 + 3 * HOP - 30_000, end_ms: T0 + 5 * HOP + 30_000, speech_probes: 3, closed_by: "end_of_input" });
    expect(a!.end_ms).toBe(b!.start_ms);
  });

  it("never splits at the encounter's own first probe", () => {
    const r = fuseEncounters([enc(0, 2)], grid(3), [clinical(0, { start: 0.99 }), clinical(1), clinical(2)], HOP);
    expect(r.decisions[0]!.action).toBe("confirm");
  });

  it("drops a split piece with no clinical probe in it", () => {
    // 0..1 chatter, a confident start at 2 (clinical), 2..3 clinical: the first piece is not an encounter
    const js = [chatter(0), chatter(1), clinical(2, { start: 0.95 }), clinical(3)];
    const r = fuseEncounters([enc(0, 3)], grid(4), js, HOP);
    expect(r.decisions[0]).toMatchObject({ action: "split", pieces_kept: 1, pieces_dropped: 1 });
    expect(r.encounters).toHaveLength(1);
    expect(r.encounters[0]).toMatchObject({ start_ms: T0 + 2 * HOP - 30_000, speech_probes: 2, closed_by: "non_speech" });
  });

  it("counts contradictions it resolves, on both rules", () => {
    const js = [
      clinical(0),
      clinical(1, { phase: { choice: "not_a_consultation", phase: "none", confidence: 0.95, band: "act" } }),
      chatter(2, { start: 0.95 }),
    ];
    const r = fuseEncounters([enc(0, 2)], grid(3), js, HOP);
    expect(r.decisions[0]).toMatchObject({ action: "confirm", clinical_probes: 1, contradictions: 2 });
    expect(r.counts.contradictions).toBe(2);
  });

  it("keeps a probe outside every encounter out of every decision, and orders output by start", () => {
    const probes = grid(8);
    const r = fuseEncounters([enc(5, 7), enc(0, 2)], probes, probes.map((_, i) => clinical(i)), HOP);
    expect(r.decisions.map((d) => d.probes)).toEqual([3, 3]);
    expect(r.encounters.map((e) => e.start_ms)).toEqual([T0 - 30_000, T0 + 5 * HOP - 30_000]);
  });
});

describe("E-6.1 — Jev proposes where acoustics proposed nothing", () => {
  const phase = (p: "pre" | "consult" | "post" | "none") => ({
    choice: ({ pre: "greeting", consult: "history_taking", post: "closing", none: "not_a_consultation" } as const)[p],
    phase: p, confidence: 0.95, band: "act" as const,
  });
  /** A clinical probe in the given phase, with U2 start/end probabilities. */
  const cj = (index: number, p: "pre" | "consult" | "post", start = 0.1, end = 0.1): ProbeJudgement =>
    clinical(index, { phase: phase(p), start, end });
  /** The textbook consultation: greeting with a start marker, consult, closing with an end marker. */
  const visit = (a: number, len: number): ProbeJudgement[] =>
    Array.from({ length: len }, (_, k) => cj(a + k, k === 0 ? "pre" : k === len - 1 ? "post" : "consult", k === 0 ? 0.95 : 0.1, k === len - 1 ? 0.95 : 0.1));
  const withVerdicts = (n: number, v: Record<number, "non_speech" | "unjudged">): AcousticProbe[] =>
    grid(n).map((p, i) => (v[i] ? { ...p, verdict: v[i]!, reason: v[i] === "non_speech" ? "non_speech" : "no_energy_evidence" } : p));

  it("the order's constants: at least 3 probes; start and end at the act band", () => {
    expect(JEV_MIN_RUN).toBe(3);
    expect(END_P).toBe(0.9);
    expect(FUSION_VERSION).toBe("encounter-fusion-v1.1");
  });

  it("consultation phases are pre, consult and post, on a clinical probe", () => {
    expect(inConsultation(cj(0, "pre"))).toBe(true);
    expect(inConsultation(cj(0, "consult"))).toBe(true);
    expect(inConsultation(cj(0, "post"))).toBe(true);
    expect(inConsultation(clinical(0, { phase: phase("none") }))).toBe(false);
    // U6 clinical with U1 "none" at the CAUTION band: clinical (no contradiction fires), but not in a consultation phase
    const cautiousNone = clinical(0, { phase: { ...phase("none"), confidence: 0.7, band: "caution" } });
    expect(clinicalVerdict(cautiousNone).clinical).toBe(true);
    expect(inConsultation(cautiousNone)).toBe(false);
    expect(inConsultation(clinical(0, { phase: undefined }))).toBe(false);
    expect(inConsultation(chatter(0, { phase: phase("consult") }))).toBe(false);
  });

  it("start marker → consultation run → end marker, 3 probes, no acoustic encounter: one candidate, origin jev", () => {
    const r = proposeFromJev([], grid(6), visit(1, 3), HOP);
    expect(r.counts).toEqual({ proposed: 1, unclosed: 0, short: 0, trimmed_away: 0, no_speech: 0, trimmed_probes: 0 });
    expect(r.encounters).toHaveLength(1);
    // probes 1..3 by hand: centres T0+HOP..T0+3*HOP, each owning half a hop either side
    expect(r.encounters[0]).toMatchObject({ start_ms: T0 + HOP - 30_000, end_ms: T0 + 3 * HOP + 30_000, speech_probes: 3, closed_by: "content_boundary" });
  });

  it("markers at exactly the act band count: start 0.9 opens, end 0.9 closes", () => {
    const js = visit(1, 3).map((j, k) => ({ ...j, start: k === 0 ? START_P : j.start, end: k === 2 ? END_P : j.end }));
    expect(proposeFromJev([], grid(6), js, HOP).counts).toMatchObject({ proposed: 1 });
    const below = js.map((j, k) => (k === 2 ? { ...j, end: 0.8999 } : j));
    expect(proposeFromJev([], grid(6), below, HOP).counts).toMatchObject({ proposed: 0, unclosed: 1 });
  });

  it("two probes is too short", () => {
    const r = proposeFromJev([], grid(6), visit(1, 2), HOP);
    expect(r.encounters).toEqual([]);
    expect(r.counts).toMatchObject({ proposed: 0, short: 1 });
  });

  it("no start marker, no candidate — however long the consultation run", () => {
    const js = visit(0, 5).map((j, k) => (k === 0 ? { ...j, start: 0.5 } : j));
    const r = proposeFromJev([], grid(6), js, HOP);
    expect(r.encounters).toEqual([]);
    expect(r.counts).toMatchObject({ proposed: 0, unclosed: 0 });
  });

  it("no end marker: unclosed, and no end is invented", () => {
    const js = visit(0, 5).map((j, k) => (k === 4 ? { ...j, end: 0.5 } : j));
    const r = proposeFromJev([], grid(6), js, HOP);
    expect(r.encounters).toEqual([]);
    expect(r.counts).toMatchObject({ proposed: 0, unclosed: 1 });
  });

  it("a non-consultation probe, a review-band probe, or an unjudged probe breaks the run", () => {
    const breakAt2 = (b: ProbeJudgement | null) => {
      const js = visit(0, 5).filter((j) => j.index !== 2);
      return proposeFromJev([], grid(6), b ? [...js, b] : js, HOP).counts;
    };
    expect(breakAt2(chatter(2))).toMatchObject({ proposed: 0, unclosed: 1 });
    expect(breakAt2(cj(2, "consult"))).toMatchObject({ proposed: 1, unclosed: 0 }); // control: the unbroken run
    expect(breakAt2(clinical(2, { phase: phase("consult"), kind: { choice: "clinical_consultation", confidence: 0.4, band: "review" } }))).toMatchObject({ proposed: 0, unclosed: 1 });
    expect(breakAt2(null)).toMatchObject({ proposed: 0, unclosed: 1 });
  });

  it("a hole in the probe series breaks the run", () => {
    const probes = grid(6).map((p, i) => (i >= 3 ? { ...p, t: p.t + 5 * HOP } : p));
    const r = proposeFromJev([], probes, visit(1, 4), HOP);
    expect(r.counts).toMatchObject({ proposed: 0, unclosed: 1 });
  });

  it("a second start marker before any end is a new patient: the first is abandoned, the second is proposed", () => {
    const js = [cj(0, "pre", 0.95), cj(1, "consult"), ...visit(2, 3)];
    const r = proposeFromJev([], grid(6), js, HOP);
    expect(r.counts).toMatchObject({ proposed: 1, unclosed: 1 });
    expect(r.encounters[0]!.start_ms).toBe(T0 + 2 * HOP - 30_000);
  });

  it("never proposes inside an acoustic encounter: acoustics already proposed there, fusion arbitrates it", () => {
    expect(proposeFromJev([enc(1, 3)], grid(6), visit(1, 3), HOP).counts).toMatchObject({ proposed: 0 });
    // an acoustic encounter covering the middle probe only breaks the run
    expect(proposeFromJev([enc(2, 2)], grid(6), visit(1, 3), HOP).counts).toMatchObject({ proposed: 0, unclosed: 1 });
  });

  it("ACOUSTICS TRIMS: non_speech edges are cut, the rest kept", () => {
    const probes = withVerdicts(7, { 1: "non_speech", 5: "non_speech" });
    const r = proposeFromJev([], probes, visit(1, 5), HOP);
    expect(r.counts).toEqual({ proposed: 1, unclosed: 0, short: 0, trimmed_away: 0, no_speech: 0, trimmed_probes: 2 });
    expect(r.encounters[0]).toMatchObject({ start_ms: T0 + 2 * HOP - 30_000, end_ms: T0 + 4 * HOP + 30_000, speech_probes: 3 });
  });

  it("trimmed below the floor is dropped; unjudged edges are NOT trimmed (no evidence is not silence)", () => {
    const cut = proposeFromJev([], withVerdicts(7, { 1: "non_speech", 2: "non_speech", 5: "non_speech" }), visit(1, 5), HOP);
    expect(cut.counts).toMatchObject({ proposed: 0, trimmed_away: 1 });
    const kept = proposeFromJev([], withVerdicts(7, { 1: "unjudged", 5: "unjudged" }), visit(1, 5), HOP);
    expect(kept.counts).toMatchObject({ proposed: 1, trimmed_probes: 0 });
    expect(kept.encounters[0]).toMatchObject({ start_ms: T0 + HOP - 30_000, end_ms: T0 + 5 * HOP + 30_000, speech_probes: 3, unjudged_ms: 2 * HOP });
  });

  it("NOBODY HEARD IT: a run with no acoustically speech-judged probe is not proposed, however good the text", () => {
    // the Refuter's probe: three acoustically unjudged probes, a textbook consultation on top
    const none = proposeFromJev([], withVerdicts(3, { 0: "unjudged", 1: "unjudged", 2: "unjudged" }), visit(0, 3), HOP);
    expect(none.encounters).toEqual([]);
    expect(none.counts).toMatchObject({ proposed: 0, no_speech: 1 });
    // one heard probe anywhere in the run is enough
    const one = proposeFromJev([], withVerdicts(3, { 0: "unjudged", 2: "unjudged" }), visit(0, 3), HOP);
    expect(one.counts).toMatchObject({ proposed: 1, no_speech: 0 });
    expect(one.encounters[0]).toMatchObject({ speech_probes: 1, unjudged_ms: 2 * HOP });
    // non_speech edges are not heard either: after the trim only unjudged probes remain (the trim cuts only
    // non_speech, so no speech probe is ever trimmed off — counting before or after the trim is equivalent)
    const trimmedOff = proposeFromJev([], withVerdicts(5, { 0: "non_speech", 1: "unjudged", 2: "unjudged", 3: "unjudged", 4: "non_speech" }), visit(0, 5), HOP);
    expect(trimmedOff.counts).toMatchObject({ proposed: 0, no_speech: 1 });
  });

  it("fuseEncounters carries both origins, in time order, index for index", () => {
    const probes = grid(10);
    const acoustic = enc(6, 8);
    const js = [...visit(1, 3), clinical(6), clinical(7), clinical(8)];
    const r = fuseEncounters([acoustic], probes, js, HOP);
    expect(r.encounters.map((e) => e.start_ms)).toEqual([T0 + HOP - 30_000, acoustic.start_ms]);
    expect(r.origins).toEqual(["jev", "acoustic"]);
    expect(r.counts).toMatchObject({ confirm: 1 });
    expect(r.proposals.proposed).toBe(1);
  });

  it("a rejected acoustic encounter does not become a Jev proposal on the same probes", () => {
    // acoustics proposed 1..3, Jev says none of it is clinical: rejected, and not re-proposed
    const r = fuseEncounters([enc(1, 3)], grid(6), [chatter(1, { start: 0.95 }), chatter(2), chatter(3, { end: 0.95 })], HOP);
    expect(r.encounters).toEqual([]);
    expect(r.origins).toEqual([]);
  });
});

describe("state builder", () => {
  it("slots own [t - 30 s, t + 30 s) of the acoustic centres", () => {
    expect(slotsFromCentres([T0, T0 + HOP])).toEqual([
      { index: 0, t: T0, start_ms: T0 - 30_000, end_ms: T0 + 30_000 },
      { index: 1, t: T0 + HOP, start_ms: T0 + 30_000, end_ms: T0 + 90_000 },
    ]);
  });

  it("keeps null (never covered), '' (covered, silent) and text apart; a span goes to its midpoint's slot", () => {
    const slots = slotsFromCentres([T0, T0 + HOP, T0 + 2 * HOP, T0 + 3 * HOP]);
    const spans = [
      { start_ms: T0 - 10_000, end_ms: T0 + 10_000, text: "alpha" },
      // midpoint T0 + 25 s: slot 0, although it runs into slot 1
      { start_ms: T0 + 10_000, end_ms: T0 + 40_000, text: "beta" },
      { start_ms: T0 - 20_000, end_ms: T0 - 15_000, text: "zero" },
      { start_ms: T0 + 2 * HOP, end_ms: T0 + 2 * HOP + 1_000, text: "   " },
    ];
    const coverage = [{ start_ms: T0 - 30_000, end_ms: T0 + 2 * HOP + 30_000 }];
    const out = textForSlots(slots, spans, coverage);
    expect(out.map((p) => p.text)).toEqual(["zero alpha beta", "", "", null]);
  });

  it("probe subject ids are stable per room-day and start", () => {
    expect(probeSubjectId("rd_x", 1234.4)).toBe("pr_rd_x_1234");
    expect(probeSubjectId("rd_x", 1234.4)).toBe(probeSubjectId("rd_x", 1234));
  });

  it("the trialled state shapes: {window_text} and {W1, W2, W3} with '' for a missing neighbour", () => {
    expect(windowState("x")).toEqual({ window_text: "x" });
    expect(boundaryState(null, "b", "c")).toEqual({ W1: "", W2: "b", W3: "c" });
    expect(boundaryState("a", "b", null)).toEqual({ W1: "a", W2: "b", W3: "" });
    expect(Object.keys(boundaryState("a", "b", "c"))).toEqual(["W1", "W2", "W3"]);
  });
});

describe("ENCOUNTER_FUSION_SHADOW", () => {
  it("is off by default and when empty or falsy", () => {
    expect(encounterFusionShadowEnabled({})).toBe(false);
    expect(encounterFusionShadowEnabled({ [ENCOUNTER_FUSION_SHADOW]: "" })).toBe(false);
    expect(encounterFusionShadowEnabled({ [ENCOUNTER_FUSION_SHADOW]: "0" })).toBe(false);
    expect(encounterFusionShadowEnabled({ [ENCOUNTER_FUSION_SHADOW]: "false" })).toBe(false);
  });
  it("is on for a truthy value", () => {
    expect(encounterFusionShadowEnabled({ [ENCOUNTER_FUSION_SHADOW]: "1" })).toBe(true);
    expect(encounterFusionShadowEnabled({ [ENCOUNTER_FUSION_SHADOW]: " TRUE " })).toBe(true);
  });
  it("throws on an unrecognised value rather than reading it as off", () => {
    expect(() => encounterFusionShadowEnabled({ [ENCOUNTER_FUSION_SHADOW]: "maybe" })).toThrow(/unrecognised/);
  });
  it("reads its own name, not the clock's", () => {
    expect(encounterFusionShadowEnabled({ ENCOUNTER_CLOCK: "1" })).toBe(false);
  });
});

describe("0118 vocabularies match the code", () => {
  it("encounter_hypothesis_run.source is exactly RUN_SOURCES", () => {
    const eff = effectiveCheckValues(MIGRATIONS, "encounter_hypothesis_run_source_chk", "source");
    expect(eff.file).toBe("0118_encounter_fusion.sql");
    expect([...eff.values].sort()).toEqual([...RUN_SOURCES].sort());
  });
  it("jev_decision.subject_type is exactly JEV_SUBJECT_TYPES, probe included", () => {
    const eff = effectiveCheckValues(MIGRATIONS, "jev_decision_subject_type_chk", "subject_type");
    expect(eff.file).toBe("0118_encounter_fusion.sql");
    expect([...eff.values].sort()).toEqual([...JEV_SUBJECT_TYPES].sort());
    expect(JEV_SUBJECT_TYPES).toContain("probe");
  });
  it("a run's source is checked: an unknown one is refused before any write", () => {
    const base: HypothesisRunInput = {
      room_day_id: "rd_x", smoother_version: "s", gate_version: "g", params: {},
      probes: { total: 0, speech: 0, non_speech: 0, unjudged: 0 }, intervals: [],
    };
    expect(checkRunInput({ ...base, source: "fused" })).not.toContain("bad_source");
    expect(checkRunInput({ ...base, source: "made_up" as never })).toContain("bad_source");
  });
});

describe("isMissingSourceColumn — the pre-0118 fallback fires on exactly one error", () => {
  it("the Postgres code, or the message naming the source column", () => {
    expect(isMissingSourceColumn({ code: "42703", message: "anything" })).toBe(true);
    expect(isMissingSourceColumn(new Error('ERROR:  column "source" does not exist'))).toBe(true);
    expect(isMissingSourceColumn(new Error("column encounter_hypothesis_run.source does not exist"))).toBe(true);
  });
  it("not another column, not another error, not nothing", () => {
    expect(isMissingSourceColumn(new Error('column "sources" does not exist'))).toBe(false);
    expect(isMissingSourceColumn(new Error('column "match_source" does not exist'))).toBe(false);
    expect(isMissingSourceColumn({ code: "08006", message: "connection reset" })).toBe(false);
    expect(isMissingSourceColumn(null)).toBe(false);
    expect(isMissingSourceColumn(undefined)).toBe(false);
  });
});

// ── shadow-runner v2, orchestration with every dep injected ─────────────────────────────────────
const levels = (a: number, b: number): BenchLevelSample[] => {
  const out: BenchLevelSample[] = [];
  for (let t = a; t < b; t += 2_000) out.push({ t_ms: t, peak: 0.07, avg: null, zero_ratio: 0, session_open: true, tape_advancing: true, samples: 1 });
  return out;
};
/** 30 minutes of loud level and a line of placeholder text every minute: one long acoustic encounter. */
const day = (): DayEvidence => {
  const lines = Array.from({ length: 30 }, (_, i) => `placeholder line ${i}`);
  return {
    room_day_id: "rd_v2", day_start_ms: T0, day_end_ms: T0 + 30 * MIN, level_samples: levels(T0, T0 + 30 * MIN),
    tape_off: [], day_complete: true,
    windows: [{ start_ms: T0, end_ms: T0 + 30 * MIN, text: lines.join("\n"), timeline: lines.map((l, i) => ({ start_s: i * 60, end_s: i * 60 + 55, chars: l.length })) }],
  };
};
const answers = (asks: JevAsk[], pick: (a: JevAsk) => JevAskOutcome["results"][string]["answer"]): JevAskOutcome => ({
  model: "m", latencyMs: 5, persisted: { ok: true, written: asks.length },
  results: Object.fromEntries(asks.map((a) => {
    const answer = pick(a);
    const confidence = answer.type === "noul" ? 0.95 : answer.confidence;
    return [a.answerKey, { answer, confidence, band: confidence >= 0.9 ? "act" : confidence >= 0.5 ? "caution" : "review",
      questionId: a.questionId, promptVersion: a.promptVersion, subjectType: a.subjectType, subjectId: a.subjectId }];
  })),
});
/** Jev says every probe is a clinical history-taking window with no boundary. */
const allClinical: FusionDeps["ask"] = async (_state, asks) => answers(asks, (a) =>
  a.answerKey === "phase" ? { type: "choice", choice: "history_taking", probabilities: {}, confidence: 0.95 }
  : a.answerKey === "kind" ? { type: "choice", choice: "clinical_consultation", probabilities: {}, confidence: 0.95 }
  : { type: "noul", noul: 0.02 });

const harness = (over: Partial<FusionDeps> = {}) => {
  const writes: HypothesisRunInput[] = [];
  const states: unknown[] = [];
  const asked: JevAsk[][] = [];
  let n = 0;
  const deps: Partial<FusionDeps> = {
    load: async () => day(),
    // distinct per probe (the line number), so a neighbour can be told from the probe itself
    translate: async (text) => ({ status: "ok", english: `tr(${text.replace(/\D+/g, ".")})`, model: "t", latency_ms: 1, input_chars: text.length }),
    ask: async (state, asks) => { states.push(state); asked.push(asks); return allClinical(state, asks); },
    write: async (input): Promise<WriteRunResult> => { writes.push(input); n++; return { ok: true, run_id: `ehr_${n}`, n_hypotheses: input.intervals.length }; },
    readLatest: async () => ({ run: null }) as never,
    ...over,
  };
  return { deps, writes, states, asked };
};
const INPUT = { room_id: "room_v2", room_day_id: "rd_v2", ist_date: "2026-09-23", now: new Date(T0 + 24 * 60 * MIN) };

describe("shadow-runner v2", () => {
  it("the fixture is one acoustic encounter over thirty probes (checked, not assumed)", () => {
    const { encounters, verdicts } = runShadow(day());
    expect(encounters).toHaveLength(1);
    expect(verdicts.length).toBeGreaterThanOrEqual(28);
  });

  it("writes an acoustic run and a fused run, with the right source, from one load", async () => {
    const h = harness();
    const res = await runFusionShadowForRoomDay(INPUT, h.deps);
    {
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(h.writes.map((w) => w.source)).toEqual(["acoustic", "fused"]);
      expect(res.acoustic_run_id).toBe("ehr_1");
      expect(res.fused_run_id).toBe("ehr_2");
      // every probe clinical, no start: the fused intervals ARE the acoustic ones
      expect(h.writes[1]!.intervals).toEqual(h.writes[0]!.intervals);
      expect(h.writes[1]!.params).toMatchObject({
        fusion_version: FUSION_VERSION, prompt_versions: { u1: U1_PROMPT_VERSION, u2: U2_PROMPT_VERSION, u6: U6_PROMPT_VERSION },
      });
      expect(res.summary.fusion).toMatchObject({ confirm: 1, split: 0, reject: 0, acoustic_encounters: 1, fused_encounters: 1 });
      expect(res.summary.jev.calls).toBe(2 * res.summary.probes.judged);
    }
  });

  it("asks two calls per probe, subject 'probe', prompt_version on every ask, in the trialled state shapes", async () => {
    const h = harness();
    await runFusionShadowForRoomDay(INPUT, h.deps);
    expect(h.asked.length % 2).toBe(0);
    for (const asks of h.asked) {
      for (const a of asks) {
        expect(a.subjectType).toBe("probe");
        expect(a.subjectId).toMatch(/^pr_rd_v2_\d+$/);
        expect(a.promptVersion).toBeTruthy();
      }
    }
    const shapes = new Set(h.states.map((s) => Object.keys(s as object).sort().join(",")));
    expect(shapes).toEqual(new Set(["window_text", "W1,W2,W3"]));
    // U2 context is the REAL neighbours: every non-empty W1/W3 is some other probe's own W2
    const boundaries = h.states.filter((s): s is { W1: string; W2: string; W3: string } => typeof s === "object" && s !== null && "W2" in s);
    const own = new Set(boundaries.map((b) => b.W2));
    expect(boundaries.filter((b) => b.W1 !== "").length).toBeGreaterThan(boundaries.length / 2);
    expect(boundaries.filter((b) => b.W3 !== "").length).toBeGreaterThan(boundaries.length / 2);
    // ...and in time order: W1 before W2 before W3 (the fake English carries the placeholder line numbers)
    const line = (x: string) => Math.max(...(x.match(/\d+/g) ?? []).map(Number));
    for (const b of boundaries) {
      if (b.W1) { expect(own.has(b.W1)).toBe(true); expect(line(b.W1)).toBeLessThan(line(b.W2)); }
      if (b.W3) { expect(own.has(b.W3)).toBe(true); expect(line(b.W3)).toBeGreaterThan(line(b.W2)); }
    }
    // each probe's two calls share one subject id
    const ids = h.asked.map((asks) => asks[0]!.subjectId);
    for (const id of new Set(ids)) expect(ids.filter((x) => x === id)).toHaveLength(2);
  });

  it("Jev disabled: asks once, writes NOTHING, says why", async () => {
    let calls = 0;
    const h = harness({ ask: async () => { calls++; throw new JevDisabledError(); } });
    const r = await runFusionShadowForRoomDay(INPUT, h.deps);
    expect(r).toEqual({ ok: false, error: "jev_disabled" });
    expect(calls).toBe(1);
    expect(h.writes).toEqual([]);
  });

  it("Jev failing on every probe: writes NOTHING (a fused run of all-rejects would be a finding that did not happen)", async () => {
    const h = harness({ ask: async () => { throw new Error("upstream 502"); } });
    const r = await runFusionShadowForRoomDay(INPUT, h.deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("jev_failed_all");
    expect(h.writes).toEqual([]);
  });

  it("a probe Jev did not answer is unjudged, not rejected-on-evidence", async () => {
    let i = 0;
    const h = harness({ ask: async (s, asks) => { if (i++ % 4 < 2) throw new Error("flaky"); return allClinical(s, asks); } });
    const r = await runFusionShadowForRoomDay(INPUT, h.deps);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.summary.probes.jev_failed).toBeGreaterThan(0);
      expect(r.summary.probes.judged + r.summary.probes.jev_failed).toBe(r.summary.probes.english);
    }
  });

  it("the fused write refused after the acoustic landed: the answer names the acoustic run", async () => {
    let n = 0;
    const h = harness({
      write: async (input) => (++n === 1
        ? { ok: true, run_id: "ehr_a", n_hypotheses: input.intervals.length }
        : { ok: false, error: "invalid_input", problems: ["bad_source"] }),
    });
    const r = await runFusionShadowForRoomDay(INPUT, h.deps);
    expect(r).toMatchObject({ ok: false, error: "write_refused", detail: { acoustic_run_id: "ehr_a" } });
  });

  it("translation failures leave probes unjudged; nothing to judge at all still writes both runs (all rejected for lack of evidence)", async () => {
    const h = harness({ translate: async () => ({ status: "failed", reason: "x" }) });
    const r = await runFusionShadowForRoomDay(INPUT, h.deps);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.summary.probes.english).toBe(0);
      expect(r.summary.fusion).toMatchObject({ reject: 1, rejected_no_evidence: 1, fused_encounters: 0 });
    }
  });

  it("the summary is numbers and version labels only — no probe text, no English", async () => {
    const h = harness();
    const r = await runFusionShadowForRoomDay(INPUT, h.deps);
    const s = JSON.stringify(r);
    expect(s).not.toMatch(/placeholder/);
    expect(s).not.toMatch(/tr\(/);
  });

  // E-6.1 end to end. Jev answers by the placeholder line number in the English it is shown: a greeting with
  // a start marker on line 5, consultation through line 9, a closing with an end marker on line 9.
  const e61Ask: FusionDeps["ask"] = async (state, asks) => {
    const st = state as { W2?: string; window_text?: string };
    const n = Math.max(...(String(st.W2 ?? st.window_text).match(/\d+/g) ?? ["-1"]).map(Number));
    return answers(asks, (a) =>
      a.answerKey === "phase" ? { type: "choice", choice: n === 5 ? "greeting" : n === 9 ? "closing" : "history_taking", probabilities: {}, confidence: 0.95 }
      : a.answerKey === "kind" ? { type: "choice", choice: n >= 5 && n <= 9 ? "clinical_consultation" : "social_chatter", probabilities: {}, confidence: 0.95 }
      : a.answerKey === "start" ? { type: "noul", noul: n === 5 ? 0.97 : 0.02 }
      : { type: "noul", noul: n === 9 ? 0.97 : 0.02 });
  };
  /**
   * The acoustic run with its encounters removed and every probe acoustically `unjudged` except those at the
   * given centres, judged `speech`. Line i (i*60 s .. i*60+55 s) falls in the probe centred at T0 + i*60 + 30 s.
   */
  const acousticsHearing = (heardLines: number[]): FusionDeps["shadow"] => (ev) => {
    const r = runShadow(ev);
    const heard = new Set(heardLines.map((i) => T0 + i * MIN + 30_000));
    return {
      ...r, encounters: [], run: { ...r.run, intervals: [] },
      verdicts: r.verdicts.map((v) => (heard.has(v.t) ? { ...v, verdict: "speech", reason: "speech" } : { ...v, verdict: "unjudged", reason: "no_energy_evidence" })),
    };
  };

  it("E-6.1: a heard Jev start → end run with no acoustic encounter is written as a fused interval marked origin jev", async () => {
    const h = harness({ ask: e61Ask, shadow: acousticsHearing([7]) });
    const r = await runFusionShadowForRoomDay(INPUT, h.deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.fusion).toMatchObject({ acoustic_encounters: 0, jev_encounters: 1, fused_encounters: 1 });
    expect(r.summary.proposals).toMatchObject({ proposed: 1, no_speech: 0 });
    const [acousticRun, fusedRun] = h.writes;
    expect(acousticRun!.intervals).toEqual([]);
    expect(fusedRun!.source).toBe("fused");
    expect(fusedRun!.intervals).toHaveLength(1);
    const iv = fusedRun!.intervals[0]!;
    expect(iv).toMatchObject({ closed_by: "content_boundary", speech_probes: 1, unjudged_ms: 4 * MIN });
    expect(fusedRun!.params).toMatchObject({ jev_origin: [{ start_ms: iv.start_ms, end_ms: iv.end_ms }], jev_min_run: 3, end_p: 0.9, fusion_version: "encounter-fusion-v1.1" });
    // lines 5..9 are a minute each: five probes, 5 minutes of span, starting at line 5
    expect(iv.start_ms).toBe(T0 + 5 * MIN);
    expect(iv.end_ms - iv.start_ms).toBe(5 * MIN);
  });

  it("E-6.1: the SAME run that nobody heard (a day with no level data) is not proposed, and is counted (ETA-Refuter)", async () => {
    const h = harness({ ask: e61Ask, load: async () => ({ ...day(), level_samples: [] }) });
    const r = await runFusionShadowForRoomDay(INPUT, h.deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.fusion).toMatchObject({ acoustic_encounters: 0, jev_encounters: 0, fused_encounters: 0 });
    expect(r.summary.proposals).toMatchObject({ proposed: 0, no_speech: 1 });
    expect(h.writes[1]!.intervals).toEqual([]);
    expect(h.writes[1]!.params).toMatchObject({ jev_origin: [] });
  });

  it("no recorded audio: nothing asked, nothing written", async () => {
    const h = harness({ load: async () => null });
    expect(await runFusionShadowForRoomDay(INPUT, h.deps)).toEqual({ ok: false, error: "no_recorded_audio" });
    expect(h.asked).toEqual([]);
    expect(h.writes).toEqual([]);
  });
});
