/**
 * lib/stt/window-measure.ts — the free-signal stack, pure half (Build 1 §3.B).
 *
 * Everything in this file is a PURE FUNCTION over rows that somebody else read. No database, no
 * fetch, no clock. That is deliberate and it is the reason the whole measurement rule can be
 * tested without a live database — which matters more here than usual, because the sandbox this
 * was built in has none and every SQL string in the sibling runner is INFERRED until an
 * orchestrator validates it against production.
 *
 * ─── THE ONE RULE THIS FILE EXISTS TO KEEP ────────────────────────────────────────────────
 * `peak_level IS NULL` IS UNKNOWN, NEVER SILENCE. Migration 0066 states it, this build restates
 * it, and it has its own column (`unknown_ms`) rather than being folded into `silent_ms`,
 * because the whole natural-silence experiment (PRD §6 E1) is built on the claim that a window's
 * quiet stretches are KNOWN-ZERO references. Unmeasured tape counted as quiet would manufacture
 * those references out of nothing, and every hallucination number taken afterwards would be
 * measuring the manufacture rather than the engine.
 *
 * NULL is an absence of evidence. Below-floor is evidence. They are not the same and this file
 * never lets them meet.
 *
 * ─── WHAT MEASURABILITY MEANS ─────────────────────────────────────────────────────────────
 * m = (energy_ms + silent_ms) / window_ms — the fraction of the window the meter could actually
 * speak to. PRD §2 asks for it "discounted for gaps and unverified chunks", and the discount
 * here is STRUCTURAL rather than a subtraction: gap time, unverified-chunk time and unknown time
 * are partitioned into buckets of their own and can never enter the numerator. Subtracting them
 * a second time would double-count, which is the kind of arithmetic that produces a floor
 * comparison nobody can reproduce six weeks later.
 *
 * The window is therefore partitioned exhaustively, and `partitionSumsToWindow` is a test, not a
 * comment: energy + silent + unknown + unverified + gap + uncovered === window_ms.
 */

import { isEnglishCode } from "@/lib/language-route";

/**
 * The version stamped onto every row this rule produces.
 *
 * BUMP THIS whenever the floor, the bucketing, the partition or the quarantine precedence
 * changes. A trend that silently mixes two instruments is worse than no trend, and
 * `proxy_version` is the only thing that makes the mixing visible after the fact.
 */
export const PROXY_VERSION = "window-measure-v1";

/**
 * The measurability floor. Below this a window is quarantined and never scored, trended or
 * batched (PRD §3).
 */
export const MEASURABILITY_FLOOR = 0.5;

/**
 * The per-room energy floor, as an RMS amplitude in 0..1 — the level at or above which a chunk's
 * `peak_level` is called ENERGY rather than SILENCE.
 *
 * WHERE THE NUMBER COMES FROM, since a guessed floor would silently decide the whole experiment.
 * The room recorder's own VAD (`ArchiveLevelSidecar.swift`, `LevelVADHistory.threshold`) uses a
 * fixed −48 dBFS until its history fills, then an adaptive noise floor clamped so it never falls
 * BELOW −48 dBFS. bench_chunk.peak_level is stored as an RMS amplitude in 0..1 (migration 0066),
 * and −48 dBFS as amplitude is 10^(−48/20) = 0.0039810…, i.e. 0.00398 to three significant
 * figures — which is the value below, NOT a tidier 0.004. The rounding direction is deliberate:
 * a floor set slightly LOW calls borderline tape energy, and over-reporting energy costs a
 * known-zero reference, whereas over-reporting silence would MANUFACTURE one.
 *
 * So this floor is not invented: it is the same threshold the device already uses to decide
 * `voiceActive`, converted into the units the server actually stores.
 *
 * FLAGGED, NOT SETTLED. The PRD says "per-room floor" and settles neither the value nor where a
 * per-room value would be stored — there is no floor column on `room` and adding one is outside
 * this build's file contract. So this is a single default that `roomEnergyFloor` may override
 * from the environment, and the orchestrator is asked to validate it against real level data
 * before any silence number is trusted. Migration 0070 cleared the spare-mic levels, so how much
 * usable `peak_level` exists at all is itself unknown until this job runs once.
 */
export const DEFAULT_ROOM_ENERGY_FLOOR = 0.00398;

/** Closed set, mirrored by the CHECK on stt_window_measure.quarantine_reason (migration 0071). */
export type QuarantineReason = "NO_LEVELS" | "LOW_COVERAGE" | "UNVERIFIED_CHUNKS" | "NO_AUDIO";

/**
 * The fields of a bench_chunk this measurement reads. A structural type rather than an import,
 * so the pure rule can be exercised with literals and never drags a database row type in.
 *
 * `started_at`/`ended_at` are what the server stored (timestamptz); `peak_level` is the 0..1 RMS
 * from migration 0066 and is NULL on every chunk an older kiosk uploaded.
 */
export type MeasureChunk = {
  started_at: string | Date;
  ended_at: string | Date;
  upload_state: string;
  peak_level: number | null;
  gap_before_ms?: number | null;
};

export type WindowPartition = {
  energy_ms: number;
  silent_ms: number;
  unknown_ms: number;
  /** Covered by a chunk that never reached upload_state='verified'. Not measurable. */
  unverified_ms: number;
  /** Recorded capture dead time (bench_chunk.gap_before_ms) that lands inside this window. */
  gap_ms: number;
  /** Window time no chunk covers at all, once gaps are accounted for. */
  uncovered_ms: number;
};

export type WindowMeasure = WindowPartition & {
  window_ms: number;
  m: number;
  quarantine_reason: QuarantineReason | null;
  proxy_version: string;
};

const msOf = (t: string | Date): number => (t instanceof Date ? t.getTime() : Date.parse(t));

/** The env var holding per-room floors: a JSON object of `{ "<room_id>": <floor> }`. */
export const ROOM_ENERGY_FLOORS_KEY = "ROOM_ENERGY_FLOORS";

/**
 * PURE — one room's floor, or the global one.
 *
 * IT NOW USES ITS ROOM. It did not: the argument was `_roomId` and every room got the single
 * global value, though a 9 Sep measurement showed one floor cannot work across rooms — they
 * differ in mic, room size and ambient noise, so a floor that is right for a quiet room calls a
 * noisy one permanently loud.
 *
 * ─── WHERE THE PER-ROOM VALUES COME FROM ────────────────────────────────────────────────────
 *
 * NOT FROM HERE, and not from this build. This function reads `ROOM_ENERGY_FLOORS`, a JSON map of
 * room id to floor, and the map is EMPTY until someone measures it. No value in it is invented:
 * a floor is a measured property of a room, and the measurement that would produce one is the
 * closed-hours distribution of that room's own energy — the hours when nothing is happening are
 * exactly the hours that say what "nothing happening" sounds like IN THAT ROOM.
 *
 * Until that measurement exists, every room falls back to the global value and behaviour is
 * unchanged. An env map rather than a `room` column because there is still nowhere on the `room`
 * row to put one, and inventing a schema for numbers nobody has measured would be the worse half
 * of the same mistake.
 *
 * FAIL-SAFE, TWICE OVER: unparseable JSON is ignored in favour of the global floor, and a
 * per-room entry that is non-finite or out of range is ignored in favour of it too. A floor of
 * NaN would call every comparison false and report a room as silent all day, which is the
 * confident falsehood this build exists to stop.
 */
export function roomEnergyFloor(roomId?: string | null, env: Record<string, string | undefined> = process.env): number {
  const global = globalEnergyFloor(env);
  if (!roomId) return global;
  const raw = env[ROOM_ENERGY_FLOORS_KEY];
  if (raw === undefined || raw.trim() === "") return global;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Length only: an env value is not something to echo into a log.
    console.warn(`[window-measure] ${ROOM_ENERGY_FLOORS_KEY} is not valid JSON (length ${raw.length}) — using the global floor`);
    return global;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return global;
  const value = (parsed as Record<string, unknown>)[roomId];
  if (value === undefined) return global;
  // A NUMBER, not something Number() will coerce into one. `null` coerces to 0, which is a finite
  // in-range floor that would call the room never-silent — a wrong answer arrived at confidently.
  const n = typeof value === "number" ? value : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    console.warn(`[window-measure] ${ROOM_ENERGY_FLOORS_KEY} entry for ${roomId} is out of range — using the global floor`);
    return global;
  }
  return n;
}

/** PURE — the global floor: `ROOM_ENERGY_FLOOR`, or the default when unset or unusable. */
export function globalEnergyFloor(env: Record<string, string | undefined> = process.env): number {
  const raw = env.ROOM_ENERGY_FLOOR;
  if (raw === undefined || raw === "") return DEFAULT_ROOM_ENERGY_FLOOR;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return DEFAULT_ROOM_ENERGY_FLOOR;
  return n;
}

/**
 * PURE — partition a window's milliseconds across the six buckets, exhaustively.
 *
 * Every millisecond of [windowStartMs, windowEndMs) lands in exactly one bucket, and the buckets
 * sum to window_ms by construction. Overlaps are clamped to the window, so a chunk that
 * straddles the boundary contributes only the part that is actually inside it.
 *
 * ORDER OF JUDGEMENT PER CHUNK, and it matters:
 *   1. not verified          → unverified_ms. An unverified chunk's level is not evidence about
 *                              the room, because the bytes it describes may never have arrived.
 *   2. peak_level IS NULL    → unknown_ms. THE 0066 RULE. Never silence.
 *   3. peak_level >= floor   → energy_ms.
 *   4. otherwise             → silent_ms.
 *
 * Chunks are assumed non-overlapping in time (bench_chunk is a sequential recording, one piece
 * after another per source). Should two overlap anyway, the later one's overlap is clipped
 * against what has already been claimed rather than double-counted — a partition that sums to
 * more than the window would make m > 1 and quietly un-quarantine a window that deserves it.
 */
export function partitionWindow(
  chunks: readonly MeasureChunk[],
  windowStartMs: number,
  windowEndMs: number,
  floor: number,
): WindowPartition {
  const windowMs = Math.max(0, windowEndMs - windowStartMs);
  const zero: WindowPartition = {
    energy_ms: 0, silent_ms: 0, unknown_ms: 0, unverified_ms: 0, gap_ms: 0, uncovered_ms: windowMs,
  };
  if (windowMs === 0) return { ...zero, uncovered_ms: 0 };

  // Sort by start so the claimed-time clip below is monotonic.
  const ordered = [...chunks]
    .map((c) => ({ c, s: msOf(c.started_at), e: msOf(c.ended_at) }))
    .filter((x) => Number.isFinite(x.s) && Number.isFinite(x.e) && x.e > x.s)
    .sort((a, b) => a.s - b.s);

  let energy = 0, silent = 0, unknown = 0, unverified = 0, gap = 0;
  let claimedTo = windowStartMs;

  for (const { c, s, e } of ordered) {
    // The gap recorded BEFORE this chunk is dead capture time immediately preceding it. Count
    // only the part of it that falls inside the window, and only as far back as time already
    // unclaimed — a gap that reaches behind the window start is not this window's loss.
    const gapMs = Math.max(0, Math.trunc(Number(c.gap_before_ms ?? 0)) || 0);
    if (gapMs > 0) {
      const gapStart = Math.max(windowStartMs, Math.max(claimedTo, s - gapMs));
      const gapEnd = Math.min(windowEndMs, s);
      const overlap = Math.max(0, gapEnd - gapStart);
      if (overlap > 0) {
        gap += overlap;
        claimedTo = Math.max(claimedTo, gapEnd);
      }
    }

    const start = Math.max(s, windowStartMs, claimedTo);
    const end = Math.min(e, windowEndMs);
    const ms = Math.max(0, end - start);
    if (ms === 0) continue;
    claimedTo = Math.max(claimedTo, end);

    if (c.upload_state !== "verified") {
      unverified += ms;
    } else if (c.peak_level === null || c.peak_level === undefined || !Number.isFinite(c.peak_level)) {
      // THE 0066 RULE. Not silence. Not energy. Unknown.
      unknown += ms;
    } else if (c.peak_level >= floor) {
      energy += ms;
    } else {
      silent += ms;
    }
  }

  const accounted = energy + silent + unknown + unverified + gap;
  return {
    energy_ms: energy,
    silent_ms: silent,
    unknown_ms: unknown,
    unverified_ms: unverified,
    gap_ms: gap,
    uncovered_ms: Math.max(0, windowMs - accounted),
  };
}

/**
 * PURE — the quarantine decision, and its precedence.
 *
 * Only reached when m is below the floor; a measurable window is never quarantined. The
 * precedence answers "what is the MOST specific true thing about why this window cannot be
 * measured", most specific first:
 *
 *   NO_AUDIO           nothing covers the window at all. There is no tape, so there is nothing
 *                      to say about levels — reporting NO_LEVELS here would blame the meter for
 *                      a recording that never happened.
 *   NO_LEVELS          tape exists and not one covering chunk carries a level. This is the
 *                      coverage question §3 calls the job's first honest output.
 *   UNVERIFIED_CHUNKS  the largest unmeasured bucket is chunks that never verified. An upload
 *                      problem, not a metering problem.
 *   LOW_COVERAGE       everything else: gaps, partial coverage, a mix below the floor.
 */
export function quarantineFor(p: WindowPartition, windowMs: number): QuarantineReason {
  const covered = p.energy_ms + p.silent_ms + p.unknown_ms + p.unverified_ms;
  if (covered === 0) return "NO_AUDIO";
  const measured = p.energy_ms + p.silent_ms;
  if (measured === 0 && p.unknown_ms > 0 && p.unknown_ms >= p.unverified_ms) return "NO_LEVELS";
  const unmeasured = p.unknown_ms + p.unverified_ms + p.gap_ms + p.uncovered_ms;
  if (unmeasured > 0 && p.unverified_ms > p.unknown_ms && p.unverified_ms >= p.gap_ms + p.uncovered_ms) {
    return "UNVERIFIED_CHUNKS";
  }
  if (measured === 0 && p.unknown_ms > 0) return "NO_LEVELS";
  void windowMs;
  return "LOW_COVERAGE";
}

/** PURE — the whole measurement for one window. */
export function measureWindow(
  chunks: readonly MeasureChunk[],
  windowStartMs: number,
  windowEndMs: number,
  floor: number = DEFAULT_ROOM_ENERGY_FLOOR,
): WindowMeasure {
  const windowMs = Math.max(0, windowEndMs - windowStartMs);
  const p = partitionWindow(chunks, windowStartMs, windowEndMs, floor);
  // m is the fraction the meter could speak to. Gaps, unverified time and unknown time are
  // already excluded — they are in their own buckets and never reach this numerator.
  const m = windowMs > 0 ? (p.energy_ms + p.silent_ms) / windowMs : 0;
  const rounded = Math.round(m * 1e6) / 1e6;
  return {
    ...p,
    window_ms: windowMs,
    m: rounded,
    quarantine_reason: rounded < MEASURABILITY_FLOOR ? quarantineFor(p, windowMs) : null,
    proxy_version: PROXY_VERSION,
  };
}

/** Test affordance and invariant: the partition is exhaustive. */
export function partitionSumsToWindow(p: WindowPartition, windowMs: number): boolean {
  return p.energy_ms + p.silent_ms + p.unknown_ms + p.unverified_ms + p.gap_ms + p.uncovered_ms === windowMs;
}

// ---------------------------------------------------------------------------
// Confusability — the three language opinions the drain has always written
// ---------------------------------------------------------------------------

/**
 * The three opinions, exactly as `transcription_run.metrics_json` has carried them since K4b:
 * `probe_language` (Whisper on the first 30 s), `full_window_language` (Whisper on the whole
 * window) and `sarvam_language` (the paid engine's own label).
 *
 * A NULL OPINION IS MISSING EVIDENCE, NOT AGREEMENT (PRD §2). That is why `opinions_present` is
 * reported beside the score and never folded into it: a 0 computed over one opinion and a 0
 * computed over three are different claims, and a reader who cannot tell them apart will read
 * "no disagreement" off a window that nobody disagreed about because nobody spoke.
 */
export type LanguageOpinions = {
  probe_language?: string | null;
  full_window_language?: string | null;
  sarvam_language?: string | null;
};

export type ConfusabilityResult = {
  confusability: number | null;
  opinions_present: number;
};

/**
 * PURE — normalise an opinion to a comparable code, or null when it says nothing.
 *
 * whisper.cpp answers full language NAMES ("english", "hindi") while Sarvam answers BCP-47
 * locales ("en-IN", "hi-IN") — comparing those raw would score every window as a disagreement.
 * Both are reduced to a base code here, and the sentinels whisper.cpp uses for "I do not know"
 * are reduced to null, because "unknown" is not a language anyone disagreed about.
 */
export function normalizeOpinion(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const l = raw.trim().toLowerCase();
  if (l === "" || l === "auto" || l === "und" || l === "unknown") return null;
  // "en-IN" → "en"; "english" stays "english" and is folded to "en" by the name map below.
  const base = l.split(/[-_]/)[0] ?? l;
  return WHISPER_NAME_TO_ISO[base] ?? base;
}

/**
 * whisper.cpp's full language names → ISO-639-1, so a name and a code that mean the same
 * language compare equal. This is the comparison-side twin of the SARVAM_LOCALES table in
 * room-drain.ts; it is deliberately a superset (it need not refuse an unmapped name, because
 * comparing two unmapped names to each other is still a valid comparison).
 */
const WHISPER_NAME_TO_ISO: Record<string, string> = {
  english: "en", hindi: "hi", kannada: "kn", tamil: "ta", telugu: "te", malayalam: "ml",
  marathi: "mr", bengali: "bn", gujarati: "gu", punjabi: "pa", urdu: "ur", odia: "od",
  oriya: "od",
};

/**
 * PURE — the disagreement score over the language opinions (PRD §2).
 *
 *   0  every present opinion is the same code
 *   1  codes differ but all sit in the same routing bucket (bucketFor: english | indic)
 *   2  the buckets split
 *   3  all three codes differ
 *
 * PRECEDENCE. "All differ" outranks "buckets split", because en/hi/ta is both (buckets 2-1 AND
 * three distinct codes) and 3 is the more specific statement about it.
 *
 * PARTIAL OPINIONS. With fewer than three present the score is computed over the ones that are,
 * and `opinions_present` says so. Two opinions can reach 0, 1 or 2 but never 3 — "all three
 * differ" is unreachable without three codes, and reporting 3 for a 1-1 split would overstate
 * evidence that does not exist. With no opinion at all the score is NULL rather than 0: nothing
 * agreed, because nothing spoke.
 */
export function confusabilityOf(op: LanguageOpinions): ConfusabilityResult {
  const codes = [op.probe_language, op.full_window_language, op.sarvam_language]
    .map(normalizeOpinion)
    .filter((c): c is string => c !== null);

  const opinions_present = codes.length;
  if (opinions_present === 0) return { confusability: null, opinions_present: 0 };
  if (opinions_present === 1) return { confusability: 0, opinions_present: 1 };

  const distinct = new Set(codes);
  if (distinct.size === 1) return { confusability: 0, opinions_present };

  // All three codes distinct is the most specific disagreement there is.
  if (codes.length === 3 && distinct.size === 3) return { confusability: 3, opinions_present };

  const buckets = new Set(codes.map((c) => (isEnglishCode(c) ? "english" : "indic")));
  if (buckets.size > 1) return { confusability: 2, opinions_present };

  return { confusability: 1, opinions_present };
}

// ---------------------------------------------------------------------------
// Scores — only where a transcript exists
// ---------------------------------------------------------------------------

/** A transcript span on the wall clock, as the stt_turn cue payload records it. */
export type TextSpan = { start_ms: number; end_ms: number; text?: string | null };

export type WindowScoreMetrics = {
  /**
   * Transcript time that lands inside chunk-grained QUIET. On a known-zero span every character
   * is a hallucination (PRD §6 E1), so this is the headline free signal of the whole build.
   */
  text_on_silence_ms: number;
  /** Metered sound that produced no words at all. The opposite failure: deafness, not invention. */
  energy_no_text_ms: number;
  proxy_version: string;
};

/**
 * PURE — merge overlapping spans into a disjoint, ordered set.
 *
 * Whisper's segments overlap each other more often than anyone expects, and summing overlapping
 * spans would report more transcript milliseconds than the window contains.
 */
export function mergeSpans(spans: readonly { start_ms: number; end_ms: number }[]): Array<{ start_ms: number; end_ms: number }> {
  const ordered = spans
    .filter((s) => Number.isFinite(s.start_ms) && Number.isFinite(s.end_ms) && s.end_ms > s.start_ms)
    .map((s) => ({ start_ms: s.start_ms, end_ms: s.end_ms }))
    .sort((a, b) => a.start_ms - b.start_ms);
  const out: Array<{ start_ms: number; end_ms: number }> = [];
  for (const s of ordered) {
    const last = out[out.length - 1];
    if (last && s.start_ms <= last.end_ms) last.end_ms = Math.max(last.end_ms, s.end_ms);
    else out.push({ ...s });
  }
  return out;
}

/** PURE — total overlap in ms between two disjoint, ordered span sets. */
export function overlapMs(
  a: readonly { start_ms: number; end_ms: number }[],
  b: readonly { start_ms: number; end_ms: number }[],
): number {
  let total = 0;
  for (const x of a) {
    for (const y of b) {
      if (y.end_ms <= x.start_ms) continue;
      if (y.start_ms >= x.end_ms) break;
      total += Math.min(x.end_ms, y.end_ms) - Math.max(x.start_ms, y.start_ms);
    }
  }
  return total;
}

/**
 * PURE — the level-derived spans of a window, split into quiet and energy.
 *
 * ONLY VERIFIED CHUNKS WITH A NON-NULL LEVEL PRODUCE A SPAN. Unknown time appears in NEITHER
 * set, so a hallucination cannot be attributed to silence that was never measured and a
 * no-text stretch cannot be blamed on energy nobody metered. This is the 0066 rule again, in the
 * one other place it could be broken.
 */
export function levelSpans(
  chunks: readonly MeasureChunk[],
  windowStartMs: number,
  windowEndMs: number,
  floor: number,
): { quiet: Array<{ start_ms: number; end_ms: number }>; energy: Array<{ start_ms: number; end_ms: number }> } {
  const quiet: Array<{ start_ms: number; end_ms: number }> = [];
  const energy: Array<{ start_ms: number; end_ms: number }> = [];
  for (const c of chunks) {
    if (c.upload_state !== "verified") continue;
    if (c.peak_level === null || c.peak_level === undefined || !Number.isFinite(c.peak_level)) continue;
    const start = Math.max(msOf(c.started_at), windowStartMs);
    const end = Math.min(msOf(c.ended_at), windowEndMs);
    if (!(Number.isFinite(start) && Number.isFinite(end)) || end <= start) continue;
    (c.peak_level >= floor ? energy : quiet).push({ start_ms: start, end_ms: end });
  }
  return { quiet: mergeSpans(quiet), energy: mergeSpans(energy) };
}

/**
 * PURE — the per-engine window score.
 *
 * A span with no text is not transcript time: `buildTurns` already drops blank segments, but a
 * cue read back from the brain can still carry an empty string, and counting it would report
 * hallucinated silence that nobody wrote.
 */
export function scoreWindow(
  chunks: readonly MeasureChunk[],
  spans: readonly TextSpan[],
  windowStartMs: number,
  windowEndMs: number,
  floor: number = DEFAULT_ROOM_ENERGY_FLOOR,
): WindowScoreMetrics {
  const { quiet, energy } = levelSpans(chunks, windowStartMs, windowEndMs, floor);
  const text = mergeSpans(
    spans
      .filter((s) => typeof s.text !== "string" || s.text.trim().length > 0)
      .map((s) => ({
        start_ms: Math.max(s.start_ms, windowStartMs),
        end_ms: Math.min(s.end_ms, windowEndMs),
      })),
  );
  const textOnSilence = overlapMs(quiet, text);
  const energyWithText = overlapMs(energy, text);
  const energyTotal = energy.reduce((a, s) => a + (s.end_ms - s.start_ms), 0);
  return {
    text_on_silence_ms: textOnSilence,
    energy_no_text_ms: Math.max(0, energyTotal - energyWithText),
    proxy_version: PROXY_VERSION,
  };
}
