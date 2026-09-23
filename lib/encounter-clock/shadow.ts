/**
 * lib/encounter-clock/shadow.ts — the E-shadow run, PURE (Fable, 23 Sep).
 *
 * One room-day of evidence in, one E-5 run out: E-1 lays the probe grid, E-2 judges each probe from
 * the LEVEL LOG and the transcripts ALREADY STORED for that day, E-4 smooths the verdicts into
 * encounter intervals, and the caller writes them. No audio is fetched and no STT is called — where a
 * day has no transcript the gate's own rule applies and the probe is `unjudged`, which is the honest
 * answer, not an empty one.
 *
 * NOTHING CLINICIAN-FACING IS TOUCHED. This module computes; the only write its caller makes is the
 * E-5 store's own one-statement insert. ENCOUNTER_CLOCK is irrelevant here: the run is operator
 * triggered, and the flag gates the live path that still does not exist.
 *
 * The summary carries numbers only — counts, durations, shares — and every rollback trigger from
 * docs/handoff/ETA-ENCOUNTER-CLOCK-FLAG-ON-PLAN-23-SEP-2026.md is evaluated against it here, so a run
 * that should stop the experiment says so in its own answer rather than waiting for a reader to notice.
 */
import type { BenchLevelSample } from "@/lib/bench-levels";
import type { TextSpan } from "@/lib/stt/window-measure";
import type { HypothesisInterval, HypothesisRunInput } from "@/lib/encounter-hypotheses";
import {
  gateProbe, splitWindowText, levelSamplesIn, GATE_VERSION,
  UNIQUE_CHARS_PER_SECOND_MIN, ENERGY_ACTIVE_MIN, DEAD_MIC_ZERO_RATIO, DEAD_MIC_DBFS,
  type TimelineSpan, type TranscriptEvidence, type GateVerdict,
} from "@/lib/encounter-clock/gate";
import {
  scheduleProbes, PROBE_SECONDS, HOP_SECONDS,
} from "@/lib/encounter-clock/probe";
import {
  smoothEncounters, SMOOTHER_VERSION, ENTER_SPEECH_PROBES, EXIT_NON_SPEECH_PROBES,
  MERGE_GAP_MS, BRIDGE_UNJUDGED_MAX_MS, type Encounter, type TapeOff,
} from "@/lib/encounter-clock/smooth";

export const SHADOW_VERSION = "encounter-clock-shadow-v1";

/** One transcribed window as stored: its text and the timeline that places the text on the clock. */
export type ShadowWindow = { start_ms: number; end_ms: number; text: string; timeline: TimelineSpan[] | null };

export type DayEvidence = {
  room_day_id: string;
  /** The recorded day, from chunk continuity: first chunk start to last chunk end. */
  day_start_ms: number;
  day_end_ms: number;
  level_samples: BenchLevelSample[];
  windows: ShadowWindow[];
  /** Stretches where the recorder was NOT running, from the gaps between chunks. */
  tape_off: TapeOff[];
};

export type TriggerCheck = { trigger: string; value: number | null; limit: number; tripped: boolean };

export type ShadowSummary = {
  room_day_id: string;
  shadow_version: typeof SHADOW_VERSION;
  gate_version: string;
  smoother_version: string;
  probes: { total: number; speech: number; non_speech: number; unjudged: number };
  unjudged_share: number | null;
  /** What the gate said, by reason — the shape of the day's evidence, not just its verdicts. */
  reasons: Record<string, number>;
  /** What the level log let the scheduler decide before any probe was judged. */
  preselect: Record<string, number>;
  windows: { with_text: number; placed: number; unplaceable: number };
  encounters: number;
  median_minutes: number | null;
  longest_minutes: number | null;
  closed_by: Record<string, number>;
  triggers: TriggerCheck[];
  /** True when any rollback trigger tripped. The caller still writes the run: the row is the evidence. */
  triggers_tripped: boolean;
};

const minutes = (ms: number) => ms / 60_000;
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const count = <T extends string>(xs: T[]): Record<string, number> =>
  xs.reduce<Record<string, number>>((acc, x) => ((acc[x] = (acc[x] ?? 0) + 1), acc), {});

/** The interval as the E-5 store takes it: the smoother's own record, minus its version stamp. */
export function toInterval(e: Encounter): HypothesisInterval {
  return {
    start_ms: e.start_ms, end_ms: e.end_ms,
    speech_probes: e.speech_probes, non_speech_probes: e.non_speech_probes,
    unjudged_ms: e.unjudged_ms, longest_unjudged_run_ms: e.longest_unjudged_run_ms,
    dead_mic_ms: e.dead_mic_ms, closed_by: e.closed_by, merged_from: e.merged_from,
    doctor_present: e.doctor_present,
    // E-3 has not run: a clinician is named only together with the match that named it, so nothing.
    identity: null,
  };
}

/**
 * The rollback triggers from the flag-on plan, evaluated on this run. `limit` is the value at which
 * the plan says stop; `tripped` is whether this run reached it. A checksum trigger has no meaning in
 * this version (nothing is extracted), so it is not invented here.
 */
export function checkTriggers(s: Omit<ShadowSummary, "triggers" | "triggers_tripped">): TriggerCheck[] {
  const longest = s.longest_minutes;
  const median_ = s.median_minutes;
  return [
    { trigger: "encounter_over_2h", value: longest, limit: 120, tripped: longest !== null && longest > 120 },
    { trigger: "unjudged_over_90pct", value: s.unjudged_share, limit: 0.9, tripped: s.unjudged_share !== null && s.unjudged_share > 0.9 },
    { trigger: "median_over_60min", value: median_, limit: 60, tripped: median_ !== null && median_ > 60 },
    { trigger: "encounters_over_15", value: s.encounters, limit: 15, tripped: s.encounters > 15 },
    {
      trigger: "no_encounters_on_a_day_with_transcripts",
      value: s.encounters, limit: 0,
      tripped: s.encounters === 0 && s.windows.placed > 0,
    },
  ];
}

export function runShadow(ev: DayEvidence, opts: { probe_s?: number; hop_s?: number } = {}):
  { run: HypothesisRunInput; summary: ShadowSummary; encounters: Encounter[] } {
  // ── transcript evidence: the stored text, placed on the clock. An unplaceable window is MISSING
  //    evidence for its probes, never an empty one.
  const coverage: Array<{ start_ms: number; end_ms: number }> = [];
  const spans: TextSpan[] = [];
  let placed = 0, unplaceable = 0;
  for (const w of ev.windows) {
    const s = w.timeline ? splitWindowText(w.text, w.timeline, w.start_ms) : null;
    if (!s) { unplaceable += 1; continue; }
    placed += 1;
    coverage.push({ start_ms: w.start_ms, end_ms: w.end_ms });
    spans.push(...s);
  }
  const transcript: TranscriptEvidence = { coverage, spans };

  // ── probes, and the level log's own say before any of them is judged
  const probes = scheduleProbes({
    day_start_ms: ev.day_start_ms, day_end_ms: ev.day_end_ms,
    level_samples: ev.level_samples, probe_s: opts.probe_s, hop_s: opts.hop_s,
  });

  const verdicts: Array<{ t: number; verdict: GateVerdict; reason: string }> = [];
  const reasons: string[] = [];
  for (const p of probes) {
    const samples = levelSamplesIn(ev.level_samples, p.start_ms, p.end_ms);
    const g = gateProbe({
      start_ms: p.start_ms, end_ms: p.end_ms,
      energy: samples ? { kind: "levels", samples } : null,
      transcript,
    });
    verdicts.push({ t: (p.start_ms + p.end_ms) / 2, verdict: g.verdict, reason: g.reason });
    reasons.push(g.reason);
  }

  const encounters = smoothEncounters(verdicts as never, { tape_off: ev.tape_off });
  const durations = encounters.map((e) => minutes(e.end_ms - e.start_ms));
  const counts = {
    total: verdicts.length,
    speech: verdicts.filter((v) => v.verdict === "speech").length,
    non_speech: verdicts.filter((v) => v.verdict === "non_speech").length,
    unjudged: verdicts.filter((v) => v.verdict === "unjudged").length,
  };

  const base = {
    room_day_id: ev.room_day_id,
    shadow_version: SHADOW_VERSION as typeof SHADOW_VERSION,
    gate_version: GATE_VERSION,
    smoother_version: SMOOTHER_VERSION,
    probes: counts,
    unjudged_share: counts.total ? counts.unjudged / counts.total : null,
    reasons: count(reasons),
    preselect: count(probes.map((p) => p.preselect)),
    windows: { with_text: ev.windows.length, placed, unplaceable },
    encounters: encounters.length,
    median_minutes: median(durations),
    longest_minutes: durations.length ? Math.max(...durations) : null,
    closed_by: count(encounters.map((e) => e.closed_by)),
  };
  const triggers = checkTriggers(base);
  // ANY trigger tripping stops the experiment: `some`, never `every` — a single three-hour encounter
  // is a stop on its own, and a test pins exactly that (ETA-Refuter T7, 23 Sep).
  const summary: ShadowSummary = { ...base, triggers, triggers_tripped: triggers.some((t) => t.tripped) };

  const run: HypothesisRunInput = {
    room_day_id: ev.room_day_id,
    smoother_version: SMOOTHER_VERSION,
    gate_version: GATE_VERSION,
    params: {
      shadow_version: SHADOW_VERSION,
      probe_s: opts.probe_s ?? PROBE_SECONDS, hop_s: opts.hop_s ?? HOP_SECONDS,
      enter: ENTER_SPEECH_PROBES, exit: EXIT_NON_SPEECH_PROBES,
      merge_gap_ms: MERGE_GAP_MS, bridge_unjudged_max_ms: BRIDGE_UNJUDGED_MAX_MS,
      unique_chars_per_s_min: UNIQUE_CHARS_PER_SECOND_MIN, energy_active_min: ENERGY_ACTIVE_MIN,
      dead_mic_zero_ratio: DEAD_MIC_ZERO_RATIO, dead_mic_dbfs: DEAD_MIC_DBFS,
      energy_source: "bench_level_sample", transcripts: "stored_only_no_stt",
    },
    probes: counts,
    intervals: encounters.map(toInterval),
  };
  return { run, summary, encounters };
}
