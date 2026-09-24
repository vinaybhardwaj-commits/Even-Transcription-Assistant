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
 *
 * ─── E16: A SPAN CARRIES ITS SPEAKER'S SPEECH, NOT ITS WALL DURATION ────────────────────────────
 * A long turn is not a long stretch of speech: Whisper's turn bounds swallow silence (E14 cause 2), so
 * chunk A9 was 29 s holding 2.28 s of its speaker. Every chunk is MEASURED against the diarizer's own
 * intervals for that speaker (room_diarize_window.segments_json) — the speech attributed to the one
 * person the score is for (ETA-E16-RULING §2). A chunk whose measured speech is under the service's
 * `min_speech_s` (read from /health, never a constant) is not planned: it is recorded unscorable with
 * the speech that disqualified it. NO FRACTION CUTOFF is applied — the fraction is recorded, and the
 * floor is set later from a clinic week of it.
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
  return { runs: mergeRunsSharingAStart(runs), skipped };
}

/**
 * ONE RUN PER (speaker, start). room_span_emotion is keyed on (window, run, speaker_idx, run_start_ms, chunk_idx),
 * so two runs of one speaker that start on the same millisecond would be two rows with one key: a batch holding
 * both is refused by Postgres on every retry, and split across batches the second silently overwrites the first.
 * The loop above opens a NEW run whenever the open run belongs to another speaker or a straddle reset it, so
 * [spk0 1000-1200, spk1 1000-1500, spk0 1000-9000] yields two spk0 runs starting at 1000. Same speaker, same
 * start is one stretch of that speaker's speech: fold them, later end, refs unioned in first-seen order. The
 * order of the surviving runs is the order they were first opened.
 */
function mergeRunsSharingAStart(runs: Run[]): Run[] {
  const byKey = new Map<string, Run>();
  for (const r of runs) {
    const key = `${r.speaker_idx}|${r.start_ms}`;
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, r); continue; }
    prev.end_ms = Math.max(prev.end_ms, r.end_ms);
    for (const ref of r.source_refs) if (!prev.source_refs.includes(ref)) prev.source_refs.push(ref);
  }
  return Array.from(byKey.values());
}

/** A diarizer speech interval, as room_diarize_window.segments_json stores it: clip-relative ms. */
export type SpeechInterval = { start_ms: number; end_ms: number; speaker_idx: number };

/**
 * PURE. Milliseconds of `speakerIdx`'s diarized speech inside [clipStartMs, clipEndMs).
 *
 * The UNION of that speaker's intervals, clipped to the span — so two overlapping intervals of one
 * speaker are never counted twice, and the result can never exceed the span. Other speakers' speech
 * does not count: the score is for this speaker.
 */
export function speakerSpeechMs(intervals: readonly SpeechInterval[], speakerIdx: number, clipStartMs: number, clipEndMs: number): number {
  const mine = intervals
    .filter((iv) => iv.speaker_idx === speakerIdx)
    .map((iv) => [Math.max(iv.start_ms, clipStartMs), Math.min(iv.end_ms, clipEndMs)] as const)
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let curA = -Infinity, curB = -Infinity;
  for (const [a, b] of mine) {
    if (a > curB) { if (curB > curA) total += curB - curA; curA = a; curB = b; }
    else curB = Math.max(curB, b);
  }
  if (curB > curA) total += curB - curA;
  return Math.round(total);
}

/** A planned chunk with its speaker's measured speech. */
export type MeasuredSegment = PlannedSegment & { speech_ms: number };

/**
 * PURE. Measure every planned chunk, and split them at the service's minimum.
 *
 * `scorable` is what gets sent. `unscorable` never enters `planned`: its measured speech is under
 * `minSpeechS`, which the service would refuse by arithmetic — and a window of only such spans would
 * otherwise burn every attempt on audio that can never score (A3: two windows exhausted exactly so).
 * The comparison is `speech_ms < minSpeechS * 1000`: at exactly the minimum a span is planned, as the
 * service's own gate scores it (`speech_s_est < MIN_SPEECH_S` refuses).
 */
export function splitByDiarizedSpeech(
  planned: readonly PlannedSegment[], intervals: readonly SpeechInterval[], minSpeechS: number,
): { scorable: MeasuredSegment[]; unscorable: MeasuredSegment[] } {
  if (!Number.isFinite(minSpeechS) || minSpeechS <= 0) throw new Error(`min_speech_s ${minSpeechS} is not a usable minimum`);
  const scorable: MeasuredSegment[] = [];
  const unscorable: MeasuredSegment[] = [];
  for (const p of planned) {
    const m: MeasuredSegment = { ...p, speech_ms: speakerSpeechMs(intervals, p.speaker_idx, Math.round(p.clip_start_s * 1000), Math.round(p.clip_end_s * 1000)) };
    (m.speech_ms < minSpeechS * 1000 ? unscorable : scorable).push(m);
  }
  return { scorable, unscorable };
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
