/**
 * lib/emotion/segments.ts — PURE. From a window's attributed turns to the segments the emotion
 * service scores.
 *
 * ─── RUNS, NOT TURNS ─────────────────────────────────────────────────────────────────────────────
 * room_turn_speaker holds one row per whisper TURN. Scored one by one, a busy window is 100+ calls
 * of mostly sub-second audio. Consecutive turns held by ONE speaker (not straddled) with a gap of at
 * most RUN_MERGE_GAP_MS are merged into a run first. Measured on a real 826 s OPD window's /diarize
 * output (95 segments, 3 speakers): no gap merging leaves 80 runs, <=1 s gives 48, <=2 s gives 38,
 * <=5 s gives 32. 2 s takes most of the reduction without bridging a long pause between utterances,
 * where the audio in between would be silence scored as affect.
 *
 * ─── STRADDLED TURNS ARE SKIPPED ─────────────────────────────────────────────────────────────────
 * A turn diarize marked `straddle` holds two voices. It cannot carry one speaker's affect, so it is
 * recorded as skipped with that reason, and it breaks any run it sits inside.
 *
 * ─── CHUNKS ──────────────────────────────────────────────────────────────────────────────────────
 * A run longer than the chunk target is split EVENLY — never truncated, never left with a tiny tail.
 * The target is min(cap - 1 s, 30 s): the cap is read from the service's /health at run time; 1 s
 * of margin because a cut can decode a frame long and the service refuses over-cap audio; 30 s
 * because a seven-way distribution over a longer stretch averages away the shifts it exists to show.
 *
 * ─── NO LENGTH FLOOR ─────────────────────────────────────────────────────────────────────────────
 * Measured on real clinician audio (1/2/3/5/10 s cuts, 4 speakers x 6 offsets): short clips are
 * noisier against their 10 s context (total variation 0.30 at 1 s, 0.16 at 3 s) but the output does
 * not go degenerate — it still varies with the audio at 1 s. No degenerate length, so no floor. The
 * service refuses below 0.1 s (its model's own minimum) with a named reason, and every row stores
 * its duration, so a query can filter by length.
 */
export const RUN_MERGE_GAP_MS = 2_000;
export const CHUNK_TARGET_MAX_S = 30;
export const CAP_MARGIN_S = 1;

/**
 * The service's per-call segment cap. The tunnel in front of it closes a request at 100 s. At the
 * worst warm per-segment inference measured (3.5 s), 16 segments is 56 s, plus fetching and decoding
 * a 900 s window (~2 s each, measured on a real 300 s chunk at 1.0 s and 0.9 s) — about 60 s, with
 * room to wait behind another caller on the service's inference lock. Live: 16 segments of 18.8 s
 * took 10.6 s end to end.
 */
export const SEGMENTS_PER_CALL = 16;

export type AttributedTurn = {
  source_ref: string;
  speaker_idx: number;
  no_role_reason: string | null;
  start_ms: number;
  end_ms: number;
};

export type Run = { speaker_idx: number; start_ms: number; end_ms: number; source_refs: string[] };
export type SkippedSpan = { speaker_idx: number; start_ms: number; end_ms: number; source_refs: string[]; reason: "straddle" };

export type PlannedSegment = {
  speaker_idx: number;
  source_refs: string[];
  run_start_ms: number;
  run_end_ms: number;
  chunk_idx: number;
  chunk_count: number;
  /** Wall-clock bounds of this chunk, on the room-day clock the turns use. */
  start_ms: number;
  end_ms: number;
  /** Seconds from the start of the window clip — what the service slices. */
  clip_start_s: number;
  clip_end_s: number;
};

export function buildRuns(turns: AttributedTurn[], mergeGapMs = RUN_MERGE_GAP_MS): { runs: Run[]; skipped: SkippedSpan[] } {
  const sorted = [...turns].sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
  const runs: Run[] = [];
  const skipped: SkippedSpan[] = [];
  let open: Run | null = null;
  for (const t of sorted) {
    if (!(t.end_ms > t.start_ms)) continue;
    if (t.no_role_reason === "straddle") {
      skipped.push({ speaker_idx: t.speaker_idx, start_ms: t.start_ms, end_ms: t.end_ms, source_refs: [t.source_ref], reason: "straddle" });
      open = null;
      continue;
    }
    if (open && open.speaker_idx === t.speaker_idx && t.start_ms - open.end_ms <= mergeGapMs) {
      open.end_ms = Math.max(open.end_ms, t.end_ms);
      open.source_refs.push(t.source_ref);
      continue;
    }
    open = { speaker_idx: t.speaker_idx, start_ms: t.start_ms, end_ms: t.end_ms, source_refs: [t.source_ref] };
    runs.push(open);
  }
  return { runs, skipped };
}

export function chunkTargetS(capS: number): number {
  if (!Number.isFinite(capS) || capS - CAP_MARGIN_S <= 0) throw new Error(`emotion cap ${capS}s leaves no room for a chunk`);
  return Math.min(capS - CAP_MARGIN_S, CHUNK_TARGET_MAX_S);
}

export function planSegments(runs: Run[], windowStartMs: number, capS: number): PlannedSegment[] {
  const target = chunkTargetS(capS);
  const out: PlannedSegment[] = [];
  for (const r of runs) {
    const lenMs = r.end_ms - r.start_ms;
    const n = Math.max(1, Math.ceil(lenMs / (target * 1000)));
    for (let i = 0; i < n; i += 1) {
      const start = r.start_ms + Math.round((lenMs * i) / n);
      const end = i === n - 1 ? r.end_ms : r.start_ms + Math.round((lenMs * (i + 1)) / n);
      out.push({
        speaker_idx: r.speaker_idx,
        source_refs: r.source_refs,
        run_start_ms: r.start_ms,
        run_end_ms: r.end_ms,
        chunk_idx: i,
        chunk_count: n,
        start_ms: start,
        end_ms: end,
        clip_start_s: (start - windowStartMs) / 1000,
        clip_end_s: (end - windowStartMs) / 1000,
      });
    }
  }
  return out;
}
