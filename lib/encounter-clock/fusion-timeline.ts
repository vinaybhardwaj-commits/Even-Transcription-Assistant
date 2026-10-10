/**
 * lib/encounter-clock/fusion-timeline.ts — place one consult's START and END from the Pulse anchor, the diarized
 * speech and Jev's reading of the timeline (epic #23, ticket f). PURE.
 *
 * START = Pulse t_open − 60 s. It moves later only if Jev says the consult began late at P ≥ LATE_START_P AND no
 * doctor-plus-other diarized speech precedes the new start.
 *
 * END RANK (first that applies wins; constants PROVISIONAL):
 *   1 endConsult within ±2 min of the last diarized speech               → pulse_end   origin anchor
 *   2 Jev end_row at the act band (≥ 0.9), snapped to the last turn in it → jev_end     origin jev
 *   3 acoustic close (non_speech, tape_off, dead_mic)                     → by its kind origin acoustic
 *   4 next START − 15 s                                                   → next_start  origin anchor
 *   5 last DOC turn + 30 s                                                → last_doc_turn origin acoustic
 *   6 90-minute cap                                                       → cap_90m     origin anchor
 * An End click AFTER the next Start, or more than 10 min past the last speech, is LATE: it is not rank 1 and the
 * end falls to rank 4 at the latest (a late click never wins, a Jev or acoustic end earlier than it still can).
 *
 * ACOUSTIC VETO. A Jev end in a row with ≥ 20 s of speech where the SAME voices go on into the next row is
 * rejected (a new voice arriving does not veto). A Jev end over zero diarized speech is DROPPED, never chosen. Every veto and contradiction is COUNTED, never silent.
 * JEV MAY VETO, NEVER PERFORM: with no Jev answer the ranks 1, 3–6 still produce an end.
 */
import type { Anchor } from "@/lib/encounter-clock/anchors";
import type { RowMeta } from "@/lib/encounter-clock/timeline";
import type { ClosedBy, Origin } from "@/lib/encounter-hypotheses";

export const FUSION_TIMELINE_VERSION = "encounter-clock-fusion-timeline-v1";
export const PRE_START_MS = 60_000;
export const LATE_START_P = 0.9;
export const END_ACT = 0.9;
export const CLICK_NEAR_MS = 2 * 60_000;
export const CLICK_LATE_MS = 10 * 60_000;
export const NEXT_START_BACKOFF_MS = 15_000;
export const DOC_TAIL_MS = 30_000;
export const CAP_MS = 90 * 60_000;
export const VETO_SPEECH_S = 20;
/** Consecutive quiet rows that close a consult acoustically (3 rows = 90 s). PROVISIONAL. */
export const ACOUSTIC_QUIET_ROWS = 3;
export const END_CONTINUES = "continues_past_segment";
export const END_CANNOT_TELL = "cannot_tell";

/** What the segment's timeline measured, per 30 s row. Built by the runner from the state and its row map. */
export type RowFact = {
  start_ms: number;
  end_ms: number;
  sound: string;
  speech_s: number | null;
  doc_s: number;
  other_s: number;
  /** Speaker letters heard in the row (DOC, B, C, …), segment-local. [] for a silent or compressed row. */
  voices: ReadonlyArray<string>;
};

export type JevReading = {
  end_row: string | null;
  end_conf: number | null;
  late_start_p: number | null;
  kind: string | null;
  kind_conf: number | null;
};

export type SegmentFusionInput = {
  anchor: Anchor;
  /** Row meta from the built segment, same order as `rows`. */
  meta: ReadonlyArray<RowMeta>;
  rows: ReadonlyArray<RowFact>;
  /** Merged diarized speech spans (ms) inside the segment, any speaker. */
  speech: ReadonlyArray<{ start_ms: number; end_ms: number }>;
  /** Merged spans of the consult doctor's speech (ms). */
  doc_speech: ReadonlyArray<{ start_ms: number; end_ms: number }>;
  jev: JevReading | null;
};

export type SegmentFusionCounts = {
  veto_end_speech_continues: number;
  veto_kind_no_speech: number;
  /** A Jev end in a segment with zero diarized speech: DROPPED, never chosen at rank 2. */
  veto_end_no_speech: number;
  contradiction_end_vs_click: number;
  click_late: number;
  late_start_applied: number;
  late_start_refused: number;
};

export type SegmentFusion = {
  start_ms: number;
  end_ms: number;
  closed_by: ClosedBy;
  origin: Origin;
  rank: 1 | 2 | 3 | 4 | 5 | 6;
  counts: SegmentFusionCounts;
};

const maxEnd = (spans: ReadonlyArray<{ end_ms: number }>): number | null => (spans.length ? Math.max(...spans.map((s) => s.end_ms)) : null);

/** PURE — the first run of ACOUSTIC_QUIET_ROWS rows that are quiet, dead_mic or tape_off at or after `from_ms`; its start and kind. */
export function acousticClose(rows: ReadonlyArray<RowFact>, from_ms: number): { ms: number; by: "non_speech" | "tape_off" | "dead_mic" } | null {
  const closing = (s: string) => s === "quiet" || s === "dead_mic" || s === "tape_off";
  const rs = rows.filter((r) => r.end_ms > from_ms);
  for (let i = 0; i + ACOUSTIC_QUIET_ROWS <= rs.length; i++) {
    const run = rs.slice(i, i + ACOUSTIC_QUIET_ROWS);
    if (!run.every((r) => closing(r.sound))) continue;
    const kinds = run.map((r) => r.sound);
    const by = kinds.includes("tape_off") ? "tape_off" : kinds.includes("dead_mic") ? "dead_mic" : "non_speech";
    return { ms: Math.max(run[0]!.start_ms, from_ms), by };
  }
  return null;
}

export function fuseSegment(input: SegmentFusionInput): SegmentFusion {
  const { anchor, rows, meta, jev } = input;
  const counts: SegmentFusionCounts = {
    veto_end_speech_continues: 0, veto_kind_no_speech: 0, veto_end_no_speech: 0, contradiction_end_vs_click: 0, click_late: 0,
    late_start_applied: 0, late_start_refused: 0,
  };
  let start = anchor.start_ms - PRE_START_MS;

  // ── start: only a confident late start, and only if NO doctor+other speech precedes the new start. The rows
  //    before the anchor ([START − 60 s, START)) count: speech there means the consult began on time.
  if (jev?.late_start_p != null && jev.late_start_p >= LATE_START_P) {
    const firstBoth = rows.find((r) => r.doc_s > 0 && r.other_s > 0);
    if (firstBoth && firstBoth.start_ms >= anchor.start_ms && firstBoth.start_ms > start) { start = firstBoth.start_ms; counts.late_start_applied++; }
    else counts.late_start_refused++;
  }

  const lastSpeech = maxEnd(input.speech);
  const zeroSpeech = input.speech.length === 0;
  if (jev?.kind === "consultation" && zeroSpeech) counts.veto_kind_no_speech++;

  const cap = Math.min(anchor.start_ms + CAP_MS, anchor.next_start_ms ?? Infinity);
  const make = (end_ms: number, closed_by: ClosedBy, origin: Origin, rank: SegmentFusion["rank"]): SegmentFusion => ({
    start_ms: start, end_ms: Math.max(end_ms, start + 1), closed_by, origin, rank, counts,
  });

  // ── rank 1: a real End click near the last diarized speech, and not late
  const click = anchor.end_click_ms;
  let clickOk = false;
  if (click != null) {
    const late = (anchor.next_start_ms != null && click > anchor.next_start_ms) || (lastSpeech != null && click - lastSpeech > CLICK_LATE_MS);
    if (late) counts.click_late++;
    else if (lastSpeech != null && Math.abs(click - lastSpeech) <= CLICK_NEAR_MS) clickOk = true;
  }

  // ── rank 2: Jev's end row (computed first so a contradiction with the click is counted either way)
  let jevEnd: number | null = null;
  if (jev?.end_row && zeroSpeech && jev.end_row !== END_CONTINUES && jev.end_row !== END_CANNOT_TELL && (jev.end_conf ?? 0) >= END_ACT) {
    counts.veto_end_no_speech++; // a Jev end over zero diarized speech is dropped
  } else if (jev?.end_row && jev.end_row !== END_CONTINUES && jev.end_row !== END_CANNOT_TELL && (jev.end_conf ?? 0) >= END_ACT) {
    const k = meta.findIndex((m) => m.t === jev.end_row);
    if (k >= 0) {
      const row = rows[k]!, next = rows[k + 1];
      // ≥ 20 s in the row AND the SAME voices go on into the next row; a new voice arriving does not veto
      const sameVoicesContinue = !!next && row.voices.some((v) => next.voices.includes(v));
      if ((row.speech_s ?? 0) >= VETO_SPEECH_S && sameVoicesContinue) counts.veto_end_speech_continues++;
      else {
        const inRow = input.speech.filter((s) => s.end_ms > row.start_ms && s.start_ms < row.end_ms).map((s) => Math.min(s.end_ms, row.end_ms));
        jevEnd = inRow.length ? Math.max(...inRow) : row.start_ms;
      }
    }
  }
  if (click != null && jevEnd != null && Math.abs(click - jevEnd) > CLICK_NEAR_MS) counts.contradiction_end_vs_click++;

  if (clickOk) return make(click!, "pulse_end", "anchor", 1);
  if (jevEnd != null) return make(jevEnd, "jev_end", "jev", 2);

  // ── rank 3: acoustic close after the last speech (or the start when there was none)
  const ac = acousticClose(rows, lastSpeech ?? anchor.start_ms);
  if (ac && ac.ms > start) return make(ac.ms, ac.by, "acoustic", 3);

  // ── rank 4: the next Start, backed off
  if (anchor.next_start_ms != null && anchor.next_start_ms - NEXT_START_BACKOFF_MS > start) {
    return make(Math.min(anchor.next_start_ms - NEXT_START_BACKOFF_MS, cap), "next_start", "anchor", 4);
  }
  // ── rank 5: the doctor's last turn
  const lastDoc = maxEnd(input.doc_speech);
  if (lastDoc != null && lastDoc + DOC_TAIL_MS > start) return make(Math.min(lastDoc + DOC_TAIL_MS, cap), "last_doc_turn", "acoustic", 5);
  // ── rank 6: the ceiling
  return make(cap, "cap_90m", "anchor", 6);
}

/**
 * PURE — order the day's fused consults and make them disjoint: a consult starts no earlier than the previous one
 * ended. A consult left with no length is dropped and counted.
 */
export function disjoint<T extends { start_ms: number; end_ms: number }>(items: ReadonlyArray<T>): { kept: T[]; dropped: number } {
  const sorted = [...items].sort((a, b) => a.start_ms - b.start_ms);
  const kept: T[] = [];
  let dropped = 0, prevEnd = -Infinity;
  for (const it of sorted) {
    const s = Math.max(it.start_ms, prevEnd);
    if (!(it.end_ms > s)) { dropped++; continue; }
    kept.push({ ...it, start_ms: s });
    prevEnd = it.end_ms;
  }
  return { kept, dropped };
}
