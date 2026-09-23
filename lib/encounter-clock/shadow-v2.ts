/**
 * lib/encounter-clock/shadow-v2.ts — shadow-runner v2 (E-6): one evidence load, TWO runs written.
 *
 *   acoustic  — exactly the E-shadow's run (probes → E-2 gate → E-4 smoother), source 'acoustic';
 *   fused     — the same encounters after Jev's content judgement confirms, splits or rejects each one
 *               (lib/encounter-clock/fusion.ts), source 'fused'.
 *
 * PER PROBE (the acoustic grid, 60 s hop each): the stored native text is translated on the Jev-English
 * path (§1.2), then two Jev calls with the TRIALLED state shapes — {window_text} for U1 phase + U6
 * clinical-or-not (one call, fanned out), and {W1, W2, W3} for U2 start + end. Every answer is stored in
 * jev_decision (subject_type 'probe', prompt_version on every row), metadata only.
 *
 * NOTHING INVENTED:
 *   · Jev disabled or unreachable for every probe → no run of EITHER source is written, and the answer
 *     says why. A fused run built on no answers would read as "every encounter rejected" — a finding
 *     that did not happen.
 *   · The two runs are two writes. If the fused write is refused after the acoustic one landed, the
 *     acoustic run stands on its own — it is exactly the run the E-shadow writes — and the answer names
 *     it; there is no fused row pretending to be complete.
 *   · A probe with no transcript, or with no English, or whose Jev call failed, is UNJUDGED — carried as
 *     judged:false into the fusion, which records the difference between rejecting on evidence and
 *     rejecting for lack of it.
 *   · Transcript and state text never leave this module except as the Jev and translate requests; the
 *     summary is numbers only.
 *
 * Shadow only. Gated by ENCOUNTER_FUSION_SHADOW at the caller; `replay` bypasses the flag on purpose
 * (E-7 scoring of past days), per call, never as a standing switch.
 */
import { loadDayEvidence } from "@/lib/encounter-clock/shadow-io";
import { runShadow, toInterval, type ShadowSummary } from "@/lib/encounter-clock/shadow";
import { HOP_SECONDS } from "@/lib/encounter-clock/probe";
import {
  fuseEncounters, phaseOf, FUSION_VERSION, START_P,
  type FusionResult, type ProbeJudgement,
} from "@/lib/encounter-clock/fusion";
import { slotsFromCentres, textForSlots, probeSubjectId, windowState, boundaryState, type ProbeText } from "@/lib/encounter-clock/fusion-state";
import { writeHypothesisRun, readLatestRun, type HypothesisRunInput, type WriteRunResult } from "@/lib/encounter-hypotheses";
import { askJev, type JevAsk, type JevAskOutcome } from "@/lib/jev/ask";
import { translateToEnglish, type TranslateOutcome } from "@/lib/jev/translate";
import { JevDisabledError } from "@/lib/jev/types";
import {
  registerEncounterQuestions,
  U1_QUESTION_ID, U1_PROMPT_VERSION, U2_START_QUESTION_ID, U2_END_QUESTION_ID, U2_PROMPT_VERSION,
  U6_QUESTION_ID, U6_PROMPT_VERSION, U1_OPTIONS, U6_OPTIONS, type U1Option, type U6Option,
} from "@/lib/jev/prompts/encounter-v1";

export const SHADOW_V2_VERSION = "encounter-clock-shadow-v2";
/** Probes judged at once: bounded, so one room-day cannot flood Jev or the translator. */
export const FUSION_CONCURRENCY = 4;

export type FusionDeps = {
  load: typeof loadDayEvidence;
  translate: (text: string) => Promise<TranslateOutcome>;
  ask: typeof askJev;
  write: typeof writeHypothesisRun;
  readLatest: typeof readLatestRun;
};

const defaultDeps: FusionDeps = {
  load: loadDayEvidence,
  translate: (text) => translateToEnglish(text, "auto"),
  ask: askJev,
  write: writeHypothesisRun,
  readLatest: readLatestRun,
};

export type FusionRunSummary = {
  shadow_v2_version: typeof SHADOW_V2_VERSION;
  fusion_version: typeof FUSION_VERSION;
  prompt_versions: { u1: string; u2: string; u6: string };
  acoustic: ShadowSummary;
  probes: {
    total: number; no_transcript: number; silent: number; with_text: number;
    english: number; translate_failed: number; judged: number; jev_failed: number;
  };
  jev: { calls: number; latency_ms_total: number; persisted: number };
  fusion: FusionResult["counts"] & { acoustic_encounters: number; fused_encounters: number };
};

export type FusionRunResult =
  | {
      ok: true;
      acoustic_run_id: string;
      fused_run_id: string;
      supersedes: { acoustic: string | null; fused: string | null };
      summary: FusionRunSummary;
    }
  | { ok: false; error: "no_recorded_audio" | "jev_disabled" | "jev_failed_all" | "write_refused"; detail?: unknown };

/** PURE — a Jev choice answer as one of the trialled options, or undefined if it is not one. */
function choiceOf<T extends string>(options: readonly T[], a: JevAskOutcome["results"][string] | undefined): { choice: T; confidence: number; band: "act" | "caution" | "review" } | undefined {
  if (!a || a.answer.type !== "choice") return undefined;
  const c = (a.answer as { choice?: unknown }).choice;
  return typeof c === "string" && (options as readonly string[]).includes(c)
    ? { choice: c as T, confidence: a.confidence, band: a.band }
    : undefined;
}

function noulOf(a: JevAskOutcome["results"][string] | undefined): number | undefined {
  if (!a || a.answer.type !== "noul") return undefined;
  const p = (a.answer as { noul?: unknown }).noul;
  return typeof p === "number" && Number.isFinite(p) ? p : undefined;
}

async function pool<T, R>(items: readonly T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
}

/**
 * Run v2 over one room-day. `now` places the day as complete or not, exactly as the E-shadow does.
 * Writes nothing when Jev cannot judge the day; otherwise the acoustic run, then the fused one.
 */
export async function runFusionShadowForRoomDay(
  input: { room_id: string; room_day_id: string; ist_date: string; now?: Date },
  deps: Partial<FusionDeps> = {},
): Promise<FusionRunResult> {
  const d: FusionDeps = { ...defaultDeps, ...deps };
  const evidence = await d.load(input.room_id, input.room_day_id, input.ist_date, input.now ?? new Date());
  if (!evidence) return { ok: false, error: "no_recorded_audio" };

  const hopMs = HOP_SECONDS * 1000;
  const { run: acousticRun, summary: acoustic, encounters, verdicts, transcript } = runShadow(evidence);
  const slots = slotsFromCentres(verdicts.map((v) => v.t), hopMs);
  const texts: ProbeText[] = textForSlots(slots, transcript.spans, transcript.coverage);

  // ── English per probe (Jev-English path). null = no English to show Jev.
  const english: Array<string | null> = new Array(texts.length).fill(null);
  let translateFailed = 0;
  const withText = texts.filter((p) => p.text);
  await pool(withText, FUSION_CONCURRENCY, async (p) => {
    const r = await d.translate(p.text!);
    if (r.status === "ok" && r.english) english[p.index] = r.english;
    else translateFailed++;
  });

  // ── Jev per probe with English.
  registerEncounterQuestions();
  const eligible = texts.filter((p) => english[p.index]);
  const judgements: ProbeJudgement[] = texts.map((p) => ({ index: p.index, judged: false }));
  let calls = 0, latency = 0, persisted = 0, jevFailed = 0;

  const judge = async (p: ProbeText): Promise<void> => {
    const subjectId = probeSubjectId(input.room_day_id, p.start_ms);
    const cur = english[p.index]!;
    const asksWindow: JevAsk[] = [
      { answerKey: "phase", subjectType: "probe", subjectId, questionId: U1_QUESTION_ID, promptVersion: U1_PROMPT_VERSION },
      { answerKey: "kind", subjectType: "probe", subjectId, questionId: U6_QUESTION_ID, promptVersion: U6_PROMPT_VERSION },
    ];
    const asksBoundary: JevAsk[] = [
      { answerKey: "start", subjectType: "probe", subjectId, questionId: U2_START_QUESTION_ID, promptVersion: U2_PROMPT_VERSION },
      { answerKey: "end", subjectType: "probe", subjectId, questionId: U2_END_QUESTION_ID, promptVersion: U2_PROMPT_VERSION },
    ];
    try {
      const w = await d.ask(windowState(cur), asksWindow);
      const b = await d.ask(boundaryState(english[p.index - 1] ?? null, cur, english[p.index + 1] ?? null), asksBoundary);
      calls += 2;
      latency += w.latencyMs + b.latencyMs;
      persisted += w.persisted.written + b.persisted.written;
      const phase = choiceOf<U1Option>(U1_OPTIONS, w.results.phase);
      const kind = choiceOf<U6Option>(U6_OPTIONS, w.results.kind);
      judgements[p.index] = {
        index: p.index,
        // judged means Jev actually answered the content question the fusion anchors on
        judged: kind !== undefined,
        phase: phase ? { ...phase, phase: phaseOf(phase.choice) } : undefined,
        kind,
        start: noulOf(b.results.start),
        end: noulOf(b.results.end),
      };
    } catch (e) {
      if (e instanceof JevDisabledError) throw e;
      jevFailed++;
    }
  };

  // The first eligible probe runs alone: if Jev is switched off it fails HERE, before the rest of the
  // day is translated and asked, and before anything is written.
  if (eligible.length) {
    try {
      await judge(eligible[0]!);
    } catch (e) {
      if (e instanceof JevDisabledError) return { ok: false, error: "jev_disabled" };
      throw e;
    }
    await pool(eligible.slice(1), FUSION_CONCURRENCY, judge);
  }
  const judgedCount = judgements.filter((j) => j.judged).length;
  if (eligible.length > 0 && judgedCount === 0) {
    return { ok: false, error: "jev_failed_all", detail: { eligible: eligible.length, jev_failed: jevFailed } };
  }

  // ── Fuse, then write both runs.
  const fused = fuseEncounters(encounters, verdicts, judgements, hopMs);
  const promptVersions = { u1: U1_PROMPT_VERSION, u2: U2_PROMPT_VERSION, u6: U6_PROMPT_VERSION };
  const fusedRun: HypothesisRunInput = {
    ...acousticRun,
    source: "fused",
    params: {
      ...acousticRun.params,
      shadow_v2_version: SHADOW_V2_VERSION, fusion_version: FUSION_VERSION, start_p: START_P,
      prompt_versions: promptVersions, fusion_counts: fused.counts,
      probes_judged: judgedCount, probes_eligible: eligible.length,
    },
    intervals: fused.encounters.map(toInterval),
  };
  const acousticInput: HypothesisRunInput = {
    ...acousticRun,
    source: "acoustic",
    params: { ...acousticRun.params, shadow_v2_version: SHADOW_V2_VERSION },
  };

  const [prevAcoustic, prevFused] = await Promise.all([
    d.readLatest(input.room_day_id, acousticRun.smoother_version, "acoustic"),
    d.readLatest(input.room_day_id, acousticRun.smoother_version, "fused"),
  ]);
  const a: WriteRunResult = await d.write(acousticInput);
  if (!a.ok) return { ok: false, error: "write_refused", detail: { acoustic: a.problems } };
  const f: WriteRunResult = await d.write(fusedRun);
  if (!f.ok) return { ok: false, error: "write_refused", detail: { fused: f.problems, acoustic_run_id: a.run_id } };

  const noTranscript = texts.filter((p) => p.text === null).length;
  const silent = texts.filter((p) => p.text === "").length;
  return {
    ok: true,
    acoustic_run_id: a.run_id,
    fused_run_id: f.run_id,
    supersedes: { acoustic: prevAcoustic.run?.id ?? null, fused: prevFused.run?.id ?? null },
    summary: {
      shadow_v2_version: SHADOW_V2_VERSION,
      fusion_version: FUSION_VERSION,
      prompt_versions: promptVersions,
      acoustic,
      probes: {
        total: texts.length, no_transcript: noTranscript, silent, with_text: withText.length,
        english: eligible.length, translate_failed: translateFailed, judged: judgedCount, jev_failed: jevFailed,
      },
      jev: { calls, latency_ms_total: latency, persisted },
      fusion: { ...fused.counts, acoustic_encounters: encounters.length, fused_encounters: fused.encounters.length },
    },
  };
}
