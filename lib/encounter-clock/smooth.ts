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
 *   unjudged -> never counts and never resets, and it cannot close an encounter on its own — but it
 *               can only BRIDGE one for BRIDGE_UNJUDGED_MAX_MS (Fable, 22 Sep, after the E-4 eval
 *               produced 352-minute encounters). Past that the encounter closes at its last speech
 *               probe and a later speech run opens a new one. Unjudged time after the last speech is
 *               never claimed as encounter time.
 * A hole in the probe series (no probe at all) is unjudged time, never silence, and the same bridge
 * limit applies to it.
 *
 * TAPE-OFF AND A DEAD MIC CLOSE AN ENCOUNTER IMMEDIATELY (Fable, 22 Sep): no audio means no visit, and
 * a dead mic must never extend a visit. Tape-off comes from the caller as the stretches where the
 * recorder was not running; a dead mic arrives as a probe whose gate reason is `dead_mic`. Both close
 * at the last speech probe, and neither can open an encounter.
 *
 * GAP-MERGE. Encounters whose gap is at most MERGE_GAP_MS are merged — except across a close that
 * evidence forced: a tape-off or dead-mic close is never merged over, and an unjudged-bridge close is
 * merged over only within the bridge limit, so a split the bridge limit made cannot be undone here.
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
/** PROVISIONAL: the most unjudged time (or empty series) an encounter may bridge. Default: the merge
 *  window, so a bridged hole is never longer than a gap the merge step would have joined anyway. */
export const BRIDGE_UNJUDGED_MAX_MS = MERGE_GAP_MS;
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

/** A stretch where the recorder was NOT running, from chunk continuity. */
export type TapeOff = { start_ms: number; end_ms: number };

export type Encounter = {
  version: typeof SMOOTHER_VERSION;
  start_ms: number;
  end_ms: number;
  speech_probes: number;
  non_speech_probes: number;
  /** Unjudged time inside the interval, holes in the probe series included. */
  unjudged_ms: number;
  longest_unjudged_run_ms: number;
  /**
   * The part of unjudged_ms the gate attributed to a dead mic. **0 at the default constants**, and not
   * by accident: a dead mic closes an open encounter and discards a pending run, and the gap a
   * non_speech close leaves (EXIT_NON_SPEECH_PROBES hops) is exactly filled by the non_speech probes
   * that caused it, so no dead-mic probe fits in a merged span either. Lower `exit` and the gap opens:
   * with { exit: 1 } a dead mic between two runs lands inside the merged interval and is counted here
   * (ETA-Refuter, 23 Sep, measured both ways). The constants are provisional, so this is a live field,
   * not dead code.
   */
  dead_mic_ms: number;
  doctor_present: { yes: number; no: number; unknown: number };
  /**
   * "non_speech"    the exit run closed it
   * "unjudged_gap"  evidence went missing for longer than the bridge limit
   * "tape_off"      the recorder stopped
   * "dead_mic"      the gate reported a dead mic
   * "end_of_input"  the probes ran out while it was open
   */
  closed_by: "non_speech" | "unjudged_gap" | "tape_off" | "dead_mic" | "end_of_input";
  /** How many hysteresis intervals the gap-merge joined into this one. */
  merged_from: number;
};

type Opts = { enter?: number; exit?: number; merge_gap_ms?: number; hop_ms?: number; bridge_ms?: number; tape_off?: TapeOff[] };

export function smoothEncounters(probes: ProbeVerdict[], opts: Opts = {}): Encounter[] {
  const enter = opts.enter ?? ENTER_SPEECH_PROBES;
  const exit = opts.exit ?? EXIT_NON_SPEECH_PROBES;
  const hop = opts.hop_ms ?? SMOOTH_HOP_MS;
  const gap = opts.merge_gap_ms ?? MERGE_GAP_MS;
  const bridge = opts.bridge_ms ?? BRIDGE_UNJUDGED_MAX_MS;
  if (!(enter >= 1) || !(exit >= 1) || !(hop > 0) || !(gap >= 0) || !(bridge >= 0)) throw new Error("smoother constants out of range");
  const ps = [...probes].sort((a, b) => a.t - b.t);
  const off = [...(opts.tape_off ?? [])].sort((a, b) => a.start_ms - b.start_ms);
  const half = hop / 2;

  const raw: Encounter[] = [];
  let state: "idle" | "pending" | "open" = "idle";
  let enterCount = 0, exitCount = 0;
  let first = -1, lastSpeech = -1, lastJudged = -1;    // indexes into ps

  const close = (by: Encounter["closed_by"]) => {
    raw.push(summarise(ps, first, lastSpeech, hop, by));
    state = "idle"; enterCount = 0; exitCount = 0; first = -1; lastSpeech = -1; lastJudged = -1;
  };
  /** A tape-off stretch that starts after `from` and begins at or before `to`. */
  const tapeOffBetween = (from: number, to: number): TapeOff | undefined =>
    off.find((o) => o.start_ms > from && o.start_ms <= to);

  for (let i = 0; i < ps.length; i++) {
    const p = ps[i], v = p.verdict;
    // A BREAK IS JUDGED BEFORE THE STATE. The bridge limit, a tape-off and a dead mic apply to a run
    // that has not opened yet just as much as to an open encounter (ETA-Refuter, 23 Sep: guarding
    // these on `state === "open"` let a single speech probe bridge 16.7 hours, because `pending` is
    // reset only by non_speech and production almost never produces one — every probe reads active
    // against the floor, so an empty room returns unjudged, not non_speech). A pending run has no
    // encounter to close, so it is DISCARDED; the probe that broke it may start a new run below.
    if (state !== "idle") {
      const broken: Encounter["closed_by"] | null =
        tapeOffBetween(ps[lastSpeech].t, p.t) ? "tape_off"
          : p.reason === "dead_mic" ? "dead_mic"
            : lastJudged >= 0 && p.t - ps[lastJudged].t > bridge ? "unjudged_gap"
              : null;
      if (broken) {
        if (state === "open") close(broken);
        else { state = "idle"; enterCount = 0; first = -1; lastSpeech = -1; lastJudged = -1; }
      }
    }
    if (v === "unjudged") continue;                 // never counts, never resets, never closes by itself
    if (state === "idle") {
      if (v === "speech") { state = "pending"; enterCount = 1; first = i; lastSpeech = i; lastJudged = i; if (enterCount >= enter) state = "open"; }
      else lastJudged = i;
    } else if (state === "pending") {
      lastJudged = i;
      if (v === "speech") { enterCount++; lastSpeech = i; if (enterCount >= enter) { state = "open"; exitCount = 0; } }
      else { state = "idle"; enterCount = 0; first = -1; lastSpeech = -1; }
    } else {
      lastJudged = i;
      if (v === "speech") { lastSpeech = i; exitCount = 0; }
      else if (++exitCount >= exit) close("non_speech");
    }
  }
  if (state === "open") {
    // the recorder stopping after the last speech still closes it, not the end of input
    close(tapeOffBetween(ps[lastSpeech].t, Infinity) ? "tape_off" : "end_of_input");
  }

  // gap-merge — never over a close that evidence forced
  const out: Encounter[] = [];
  for (const e of raw) {
    const prev = out[out.length - 1];
    const forced = prev && (prev.closed_by === "tape_off" || prev.closed_by === "dead_mic");
    const overBridge = prev && prev.closed_by === "unjudged_gap" && e.start_ms - prev.end_ms > bridge;
    if (prev && !forced && !overBridge && e.start_ms - prev.end_ms <= gap) {
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
