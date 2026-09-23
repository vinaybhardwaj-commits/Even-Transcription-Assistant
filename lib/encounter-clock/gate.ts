/**
 * lib/encounter-clock/gate.ts — E-2, the speech gate for one probe (PLAN v2.1 §3C). PURE.
 *
 * Two halves, and a verdict of speech | non_speech | unjudged:
 *   ENERGY      from the level log (bench_level_sample) or from RMS frames decoded off the original
 *               chunks. Dead mic = zero_ratio >= 0.98, or a median level at or below -90 dBFS.
 *               A level sample is read by its `avg` when the recorder reports one, else by its `peak`.
 *               ACCEPTED AS INERT FOR NOW (Fable, 22 Sep): the level log only began at 19:53 on 22 Sep,
 *               so no full room-day has one yet and every probe is still fetched and decoded. The code
 *               stays; it becomes meaningful the first full day the recorder reports levels.
 *               Production reported no `avg` on 22 Sep (0 of 2,160 rows), so the level half ran on
 *               `peak` alone. That has since changed: `avg` is now populated on 72.3% of rows
 *               (51,309 of 70,927, ETA-LOW-SIGNAL-MARKER-REFUTER-VERDICT-23-SEP-2026.md) — on most
 *               probes the basis is now `avg`, not `peak`. The `peak` fallback (a sample with no
 *               `avg`) is still safe in one direction only, which is the direction that matters:
 *               peak >= RMS always, so a peak under the floor proves the RMS is under it too.
 *               A peak-based "quiet" is a strict subset of the RMS-based one: it can call a quiet room
 *               active (and the probe then gets fetched), never an active room quiet.
 *   TRANSCRIPT  unique characters per second of the text placed inside the probe (see
 *               uniqueCharsPerSecond), passing at UNIQUE_CHARS_PER_SECOND_MIN.
 *
 * MISSING EVIDENCE IS UNJUDGED, NEVER SILENCE. A probe with no level samples and no decoded frames
 * is not quiet; a probe no transcript covers has not been read as empty. Only evidence can say
 * non_speech, and only both halves together can say speech.
 *
 * The truth table, in the order it is decided:
 *   dead mic                          -> unjudged   (dead_mic: the mic heard nothing, so it says
 *                                                     nothing about the room)
 *   no energy evidence                -> unjudged   (no_energy_evidence)
 *   energy quiet, text present        -> unjudged   (halves_disagree: ETA-Refuter, 22 Sep. Text
 *                                                     reaching 0.15 unique chars/s is not the looping
 *                                                     signature — repeats count once — and a
 *                                                     soft-spoken or far-field consult can sit under
 *                                                     the quiet line. Until a bench shows how often
 *                                                     quiet-with-text is real speech, the gate does
 *                                                     not pick a side.)
 *   energy quiet                      -> non_speech (quiet_room)
 *   energy active, no transcript      -> unjudged   (no_transcript_evidence: at the production
 *                                                     floor a room's ambient passes the energy
 *                                                     half on its own, so energy alone is not
 *                                                     speech)
 *   energy active, text >= threshold  -> speech
 *   energy active, text below it      -> non_speech (no_text: sound in the room, no speech in it)
 *
 * Thresholds are PROVISIONAL and exported so a bench can move them without touching the logic.
 */
import type { BenchLevelSample } from "@/lib/bench-levels";
import { DEFAULT_ROOM_ENERGY_FLOOR, type TextSpan } from "@/lib/stt/window-measure";

export const GATE_VERSION = "encounter-clock-gate-v1";

/** PROVISIONAL (PLAN v2.1 §3C): unique characters per second a probe's text must reach. */
export const UNIQUE_CHARS_PER_SECOND_MIN = 0.15;
/** PROVISIONAL: share of level samples or 20 ms frames at or above the room floor for "active". */
export const ENERGY_ACTIVE_MIN = 0.05;
/** Dead mic: the share of exactly-zero samples at or above which the input is taken as lost. */
export const DEAD_MIC_ZERO_RATIO = 0.98;
/** Dead mic: a median level at or below this is below any real room's ambient. */
export const DEAD_MIC_DBFS = -90;
/** Level evidence counts only when the samples span at least this share of the probe. */
export const LEVEL_MIN_COVERAGE = 0.8;

export const dbfs = (amplitude: number): number => (amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity);

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ── energy half ──────────────────────────────────────────────────────────────────────────────────

export type EnergyEvidence =
  | { kind: "levels"; samples: BenchLevelSample[] }
  | { kind: "frames"; frame_rms: number[] };

export type EnergyState = "dead_mic" | "quiet" | "active" | "missing";

export type EnergyResult = {
  state: EnergyState;
  source: "levels" | "frames" | null;
  /** Which level field was read: "avg" when every usable sample had one, "peak" otherwise. */
  level_basis: "avg" | "peak" | null;
  active_frac: number | null;
  median_dbfs: number | null;
  median_zero_ratio: number | null;
  n: number;
};

const missingEnergy = (source: EnergyResult["source"], n = 0): EnergyResult =>
  ({ state: "missing", source, level_basis: null, active_frac: null, median_dbfs: null, median_zero_ratio: null, n });

/**
 * Level samples inside [t0, t1). Evidence only when they span LEVEL_MIN_COVERAGE of the probe: a
 * handful of samples at one end of a probe does not describe the rest of it.
 */
export function levelSamplesIn(samples: BenchLevelSample[], t0: number, t1: number): BenchLevelSample[] | null {
  const inside = samples.filter((s) => s.t_ms >= t0 && s.t_ms < t1).sort((a, b) => a.t_ms - b.t_ms);
  if (inside.length < 2) return null;
  const span = inside[inside.length - 1].t_ms - inside[0].t_ms;
  return span >= LEVEL_MIN_COVERAGE * (t1 - t0) ? inside : null;
}

/**
 * The energy half. Level samples are read by `avg` when EVERY usable sample has one, otherwise by
 * `peak` for all of them — never a mix of the two scales in one probe. A sample with neither is
 * absent, not zero. Frames are RMS amplitudes in 0..1, one per 20 ms, decoded from the chunks.
 */
export function energyHalf(ev: EnergyEvidence | null | undefined, floor: number = DEFAULT_ROOM_ENERGY_FLOOR): EnergyResult {
  if (!ev) return missingEnergy(null);
  let levels: number[];
  let zero: number | null = null;
  let basis: EnergyResult["level_basis"] = null;
  if (ev.kind === "levels") {
    const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
    const usable = ev.samples.filter((s) => fin(s.avg) || fin(s.peak));
    basis = usable.length > 0 && usable.every((s) => fin(s.avg)) ? "avg" : "peak";
    levels = usable.map((s) => (basis === "avg" ? s.avg : s.peak)).filter(fin);
    zero = median(ev.samples.map((s) => s.zero_ratio).filter(fin));
    if (levels.length === 0 && zero === null) return missingEnergy("levels", ev.samples.length);
    if (levels.length === 0) basis = null;
  } else {
    levels = ev.frame_rms.filter((v) => Number.isFinite(v));
    if (levels.length === 0) return missingEnergy("frames");
  }
  const med = median(levels);
  const medDb = med === null ? null : dbfs(med);
  const dead = (zero !== null && zero >= DEAD_MIC_ZERO_RATIO) || (medDb !== null && medDb <= DEAD_MIC_DBFS);
  const activeFrac = levels.length ? levels.filter((v) => v >= floor).length / levels.length : null;
  const state: EnergyState = dead ? "dead_mic" : activeFrac === null ? "missing" : activeFrac >= ENERGY_ACTIVE_MIN ? "active" : "quiet";
  return { state, source: ev.kind, level_basis: basis, active_frac: activeFrac, median_dbfs: medDb, median_zero_ratio: zero, n: levels.length };
}

// ── transcript half ──────────────────────────────────────────────────────────────────────────────

/** Case, punctuation and spacing do not make a line new. */
export function normaliseLine(line: string): string {
  return line.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * Unique characters per second inside [t0, t1): the characters of the DISTINCT normalised lines
 * of every span that overlaps the probe, each weighted by the share of its span inside the probe,
 * over the probe's seconds. A line the recogniser repeats counts once, which is the point: looping
 * output on noise is long and not unique.
 */
export function uniqueCharsPerSecond(spans: TextSpan[], t0: number, t1: number): number {
  const seen = new Map<string, number>();
  for (const s of spans) {
    const ov = Math.min(s.end_ms, t1) - Math.max(s.start_ms, t0);
    if (ov <= 0 || s.end_ms <= s.start_ms || !s.text) continue;
    const w = ov / (s.end_ms - s.start_ms);
    for (const raw of s.text.split("\n")) {
      const l = normaliseLine(raw);
      if (l && !seen.has(l)) seen.set(l, l.length * w);
    }
  }
  let chars = 0;
  for (const v of seen.values()) chars += v;
  return chars / ((t1 - t0) / 1000);
}

/**
 * The transcript for a probe: `coverage` is the wall-clock ranges a transcript EXISTS for (the
 * transcribed windows); `spans` are its text placed on the clock. Silence has no spans, so spans
 * alone cannot tell "read and empty" from "never read" — coverage can.
 */
export type TranscriptEvidence = { coverage: Array<{ start_ms: number; end_ms: number }>; spans: TextSpan[] };

export type TranscriptResult = { state: "text" | "no_text" | "missing"; unique_chars_per_s: number | null };

/** Covered only when the transcribed ranges, merged, contain the whole probe. */
export function covers(coverage: TranscriptEvidence["coverage"], t0: number, t1: number): boolean {
  const iv = [...coverage].sort((a, b) => a.start_ms - b.start_ms);
  let reach = t0;
  for (const c of iv) {
    if (c.start_ms > reach) break;
    reach = Math.max(reach, c.end_ms);
    if (reach >= t1) return true;
  }
  return reach >= t1;
}

export function transcriptHalf(ev: TranscriptEvidence | null | undefined, t0: number, t1: number): TranscriptResult {
  if (!ev || !covers(ev.coverage, t0, t1)) return { state: "missing", unique_chars_per_s: null };
  const u = uniqueCharsPerSecond(ev.spans, t0, t1);
  return { state: u >= UNIQUE_CHARS_PER_SECOND_MIN ? "text" : "no_text", unique_chars_per_s: u };
}

/**
 * A window's stored text placed back on the clock. The router joins its segments' texts with "\n"
 * (verified on 22 Sep: text length = the timeline's span chars + one per separator), so slicing by
 * each span's `chars` recovers each span's text. Returns null when the lengths do not reconcile
 * within `tolerance` characters: an unplaceable window is missing evidence, never guessed at.
 */
export type TimelineSpan = { start_s: number; end_s: number; chars: number };

export function splitWindowText(text: string, spans: TimelineSpan[], windowStartMs: number, tolerance = 3): TextSpan[] | null {
  const sp = spans.filter((s) => s.chars > 0);
  if (sp.length === 0) return text.trim() ? null : [];
  const expected = sp.reduce((n, s) => n + s.chars, 0) + (sp.length - 1);
  if (Math.abs(text.length - expected) > tolerance) return null;
  const out: TextSpan[] = [];
  let off = 0;
  for (const s of sp) {
    out.push({ start_ms: windowStartMs + s.start_s * 1000, end_ms: windowStartMs + s.end_s * 1000, text: text.slice(off, off + s.chars) });
    off += s.chars + 1;
  }
  return out;
}

// ── the verdict ──────────────────────────────────────────────────────────────────────────────────

export type GateVerdict = "speech" | "non_speech" | "unjudged";
export type GateReason =
  | "dead_mic" | "no_energy_evidence" | "halves_disagree" | "quiet_room"
  | "no_transcript_evidence" | "speech" | "no_text";

export type GateResult = {
  version: typeof GATE_VERSION;
  start_ms: number;
  end_ms: number;
  verdict: GateVerdict;
  reason: GateReason;
  energy: EnergyResult;
  transcript: TranscriptResult;
};

export function gateProbe(input: {
  start_ms: number;
  end_ms: number;
  energy: EnergyEvidence | null | undefined;
  transcript: TranscriptEvidence | null | undefined;
  floor?: number;
}): GateResult {
  const { start_ms, end_ms } = input;
  const energy = energyHalf(input.energy, input.floor ?? DEFAULT_ROOM_ENERGY_FLOOR);
  const transcript = transcriptHalf(input.transcript, start_ms, end_ms);
  const out = (verdict: GateVerdict, reason: GateReason): GateResult =>
    ({ version: GATE_VERSION, start_ms, end_ms, verdict, reason, energy, transcript });
  if (energy.state === "dead_mic") return out("unjudged", "dead_mic");
  if (energy.state === "missing") return out("unjudged", "no_energy_evidence");
  if (energy.state === "quiet") return transcript.state === "text" ? out("unjudged", "halves_disagree") : out("non_speech", "quiet_room");
  if (transcript.state === "missing") return out("unjudged", "no_transcript_evidence");
  return transcript.state === "text" ? out("speech", "speech") : out("non_speech", "no_text");
}
