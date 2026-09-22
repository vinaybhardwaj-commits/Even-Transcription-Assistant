/**
 * lib/encounter-clock/smooth.ts — E-4, the hysteresis smoother (PLAN v2.1 §3C). PURE.
 *
 * Per-probe E-2 verdicts in, encounter intervals out.
 *
 * TIME BASE. Each probe is given by `t`, its representative instant (the probe's centre), and owns
 * the hop around it: [t - hop/2, t + hop/2). Probes overlap (180 s every 60 s), so ownership by hop
 * is what keeps boundaries at hop resolution instead of smearing them across the overlap.
 *
 * HYSTERESIS.
 *   idle     -> an encounter OPENS once ENTER_SPEECH_PROBES speech probes accumulate with no
 *               non_speech between them; its start is the first of them.
 *   open     -> it CLOSES once EXIT_NON_SPEECH_PROBES non_speech probes accumulate with no speech
 *               between them; its end is the LAST SPEECH PROBE — the last positive evidence, never
 *               the non_speech run that closed it.
 *   unjudged -> never counts, never resets, never closes. It is missing evidence. An encounter stays
 *               open across an unjudged stretch, so speech after it continues the same encounter;
 *               unjudged time after the last speech is never claimed as encounter time.
 * A hole in the probe series (no probe at all) is unjudged time, never silence.
 *
 * GAP-MERGE. Encounters whose gap is at most MERGE_GAP_MS are merged.
 *
 * `doctor_present` is carried, not decided on: each interval reports it among its speech probes.
 * Every constant is exported and PROVISIONAL.
 */
import type { GateVerdict, GateReason } from "@/lib/encounter-clock/gate";
import { HOP_SECONDS } from "@/lib/encounter-clock/probe";

export const SMOOTHER_VERSION = "encounter-clock-smooth-v1";
/** PROVISIONAL: speech probes to open an encounter. */
export const ENTER_SPEECH_PROBES = 2;
/** PROVISIONAL: non_speech probes to close one. */
export const EXIT_NON_SPEECH_PROBES = 3;
/** PROVISIONAL: encounters this close or closer are one encounter (PLAN: ±2–3 min). */
export const MERGE_GAP_MS = 180_000;
export const SMOOTH_HOP_MS = HOP_SECONDS * 1000;
/** A gap between consecutive probes wider than this many hops is a hole in the series. */
const HOLE_HOPS = 1.5;

export type ProbeVerdict = {
  /** The probe's representative instant (its centre), epoch ms. */
  t: number;
  verdict: GateVerdict;
  /** The gate's reason, when known — lets an interval report how much of it was a dead mic. */
  reason?: GateReason;
  doctor_present?: boolean | null;
};

export type Encounter = {
  version: typeof SMOOTHER_VERSION;
  start_ms: number;
  end_ms: number;
  speech_probes: number;
  non_speech_probes: number;
  /** Unjudged time inside the interval, holes in the probe series included. */
  unjudged_ms: number;
  longest_unjudged_run_ms: number;
  /** The part of unjudged_ms the gate attributed to a dead mic. */
  dead_mic_ms: number;
  doctor_present: { yes: number; no: number; unknown: number };
  /** "non_speech" when the exit run closed it; "end_of_input" when the probes ran out while open. */
  closed_by: "non_speech" | "end_of_input";
  /** How many hysteresis intervals the gap-merge joined into this one. */
  merged_from: number;
};

type Opts = { enter?: number; exit?: number; merge_gap_ms?: number; hop_ms?: number };

export function smoothEncounters(probes: ProbeVerdict[], opts: Opts = {}): Encounter[] {
  const enter = opts.enter ?? ENTER_SPEECH_PROBES;
  const exit = opts.exit ?? EXIT_NON_SPEECH_PROBES;
  const hop = opts.hop_ms ?? SMOOTH_HOP_MS;
  const gap = opts.merge_gap_ms ?? MERGE_GAP_MS;
  if (!(enter >= 1) || !(exit >= 1) || !(hop > 0) || !(gap >= 0)) throw new Error("smoother constants out of range");
  const ps = [...probes].sort((a, b) => a.t - b.t);
  const half = hop / 2;

  const raw: Encounter[] = [];
  let state: "idle" | "pending" | "open" = "idle";
  let enterCount = 0, exitCount = 0;
  let first = -1, lastSpeech = -1;                  // indexes into ps

  const close = (by: Encounter["closed_by"]) => {
    raw.push(summarise(ps, first, lastSpeech, hop, by));
    state = "idle"; enterCount = 0; exitCount = 0; first = -1; lastSpeech = -1;
  };

  for (let i = 0; i < ps.length; i++) {
    const v = ps[i].verdict;
    if (v === "unjudged") continue;                 // never counts, never resets, never closes
    if (state === "idle") {
      if (v === "speech") { state = "pending"; enterCount = 1; first = i; lastSpeech = i; if (enterCount >= enter) state = "open"; }
    } else if (state === "pending") {
      if (v === "speech") { enterCount++; lastSpeech = i; if (enterCount >= enter) { state = "open"; exitCount = 0; } }
      else { state = "idle"; enterCount = 0; first = -1; lastSpeech = -1; }
    } else {
      if (v === "speech") { lastSpeech = i; exitCount = 0; }
      else if (++exitCount >= exit) close("non_speech");
    }
  }
  if (state === "open") close("end_of_input");      // a pending run at the end never opened

  // gap-merge
  const out: Encounter[] = [];
  for (const e of raw) {
    const prev = out[out.length - 1];
    if (prev && e.start_ms - prev.end_ms <= gap) {
      out[out.length - 1] = mergeTwo(prev, e, ps, half);
    } else out.push(e);
  }
  return out;
}

/** Build one interval from the probe indexes of its first and last speech probe. */
function summarise(ps: ProbeVerdict[], a: number, b: number, hop: number, by: Encounter["closed_by"]): Encounter {
  const half = hop / 2;
  const start = ps[a].t - half, end = ps[b].t + half;
  const e: Encounter = {
    version: SMOOTHER_VERSION, start_ms: start, end_ms: end, speech_probes: 0, non_speech_probes: 0,
    unjudged_ms: 0, longest_unjudged_run_ms: 0, dead_mic_ms: 0, doctor_present: { yes: 0, no: 0, unknown: 0 },
    closed_by: by, merged_from: 1,
  };
  tally(e, ps, a, b, hop);
  return e;
}

/** Counts and unjudged time for probes a..b inclusive, holes in the series counted as unjudged. */
function tally(e: Encounter, ps: ProbeVerdict[], a: number, b: number, hop: number): void {
  let run = 0;
  const bump = (ms: number) => { e.unjudged_ms += ms; run += ms; if (run > e.longest_unjudged_run_ms) e.longest_unjudged_run_ms = run; };
  for (let i = a; i <= b; i++) {
    if (i > a) {
      const hole = ps[i].t - ps[i - 1].t - hop;
      if (ps[i].t - ps[i - 1].t > HOLE_HOPS * hop && hole > 0) bump(hole);
    }
    const p = ps[i];
    if (p.verdict === "unjudged") {
      bump(hop);
      if (p.reason === "dead_mic") e.dead_mic_ms += hop;
      continue;
    }
    run = 0;
    if (p.verdict === "speech") {
      e.speech_probes++;
      if (p.doctor_present === true) e.doctor_present.yes++;
      else if (p.doctor_present === false) e.doctor_present.no++;
      else e.doctor_present.unknown++;
    } else e.non_speech_probes++;
  }
}

/** Merge two adjacent intervals: the span between them is re-tallied, so its unjudged time counts. */
function mergeTwo(x: Encounter, y: Encounter, ps: ProbeVerdict[], half: number): Encounter {
  const hop = half * 2;
  const a = ps.findIndex((p) => p.t - half === x.start_ms);
  let b = -1;
  for (let i = ps.length - 1; i >= 0; i--) if (ps[i].t + half === y.end_ms) { b = i; break; }
  const e: Encounter = {
    version: SMOOTHER_VERSION, start_ms: x.start_ms, end_ms: y.end_ms, speech_probes: 0, non_speech_probes: 0,
    unjudged_ms: 0, longest_unjudged_run_ms: 0, dead_mic_ms: 0, doctor_present: { yes: 0, no: 0, unknown: 0 },
    closed_by: y.closed_by, merged_from: x.merged_from + y.merged_from,
  };
  tally(e, ps, a, b, hop);
  return e;
}
