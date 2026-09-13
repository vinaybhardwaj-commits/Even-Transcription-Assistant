/**
 * lib/stt/speaker-roles.ts — C2 item 3. WHEN A SPAN MAY CARRY A NAME.
 *
 * ─── THE RULE ──────────────────────────────────────────────────────────────────────────────────
 * A span is labelled with a clinician ONLY when the diarize service's cosine match against an
 * ENROLLED centroid succeeded. Where no centroid matched, the span keeps its `speaker_idx` and
 * gets no role. Role is NEVER derived from speaker order.
 *
 * ─── WHY THE ORDER IS THE TEMPTING WRONG ANSWER ────────────────────────────────────────────────
 * `server.py:191` sorts clusters by total speaking time, descending. So `speaker_idx: 0` means "the
 * voice that talked most in this window" — nothing else. In an OPD consultation that is usually the
 * doctor, which is precisely the trap: the heuristic would be right often enough to look correct
 * and wrong often enough to matter. And the service's own `type` field is no better. With an empty
 * centroid list it labels the longest-speaking cluster `Patient` by a first-match cascade
 * (`server.py:218-252`) — a label produced by the same ordering, wearing a clinical word.
 *
 * The cost of being wrong is not symmetric with the cost of saying nothing. An unlabelled span is
 * a span someone can still read. A span that attributes a patient's distress to their clinician,
 * or a clinician's instruction to the patient, is a false clinical record — and it is worse than
 * no label precisely because it looks like an answer.
 *
 * So this module reads exactly two things from a speaker: `clinician_id` and `confidence`, both of
 * which the service sets ONLY on a successful match (`server.py:219-225`). It never reads `idx`,
 * `label`, `type` or `total_speech_sec` — and a test asserts that reordering or relabelling the
 * speakers changes nothing about who gets a name.
 */
import type { DiarizeSpeaker } from "@/lib/diarize";

/**
 * WHY a span has no name, recorded ON THE ROW.
 *
 * `straddle` is STRUCTURAL and permanent: the turn really was held by more than one speaker, so no
 * later step can attribute it. `no_match` is merely unresolved: the service recognised nobody this
 * time. The distinction lives on the row so that nothing downstream has to guess which kind of
 * unnamed a span is.
 */
export type NoRoleReason = "straddle" | "no_match";

export type SpanRole =
  | { role: "clinician"; clinician_id: string; match_confidence: number; no_role_reason: null }
  | { role: null; clinician_id: null; match_confidence: null; no_role_reason: NoRoleReason };

/** No name, and the reason it may not have one. */
export const noRole = (reason: NoRoleReason): SpanRole =>
  ({ role: null, clinician_id: null, match_confidence: null, no_role_reason: reason });

/** The service matched nobody. UNRESOLVED, not structural. */
export const UNATTRIBUTED: SpanRole = noRole("no_match");

/**
 * THE ONE TEST FOR A USABLE MATCH CONFIDENCE. Every gate that reads the field uses this.
 *
 * There used to be two gates and they disagreed on exactly one value: one required `Number.isFinite`
 * and the other accepted anything with `typeof === "number"`, which NaN satisfies — so NaN was
 * refused a role by one and admitted by the other, surfacing as a Postgres CHECK violation rather
 * than a code refusal. The database is the tripwire for what the code failed to think of; it is
 * not the first line.
 *
 * Range, not just finiteness: a cosine outside [0,1] is not a weak match, it is a bug, and 0085's
 * `room_turn_speaker_confidence_ck` says so. Refusing it here means that check never has to fire.
 */
export function usableConfidence(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

/**
 * PURE. The role for one speaker index, from the service's own match and nothing else.
 *
 * A speaker carries `clinician_id` and `confidence` if and only if a centroid matched at or above
 * `batch_threshold`. Both must be present and well-formed: a `clinician_id` with no confidence is
 * not a match this system will assert, because the number is what a reviewer needs to judge it.
 */
export function roleForSpeaker(speaker: DiarizeSpeaker | undefined): SpanRole {
  if (!speaker) return UNATTRIBUTED;
  const id = typeof speaker.clinician_id === "string" ? speaker.clinician_id.trim() : "";
  const conf = usableConfidence(speaker.confidence) ? speaker.confidence : null;
  if (!id || conf === null) return UNATTRIBUTED;
  return { role: "clinician", clinician_id: id, match_confidence: conf, no_role_reason: null };
}

/**
 * PURE. Roles for every speaker in a window, keyed by index.
 *
 * The index is used ONLY as a lookup key — it is how a span says which speaker it belongs to. It is
 * never an input to the decision: `roleForSpeaker` cannot see it.
 */
export function rolesByIndex(speakers: readonly DiarizeSpeaker[]): Map<number, SpanRole> {
  const out = new Map<number, SpanRole>();
  for (const s of speakers) {
    if (typeof s.idx !== "number" || !Number.isFinite(s.idx)) continue;
    out.set(s.idx, roleForSpeaker(s));
  }
  return out;
}

/** How many of a window's speakers were actually named. The coverage question, per window. */
export function attributionCoverage(speakers: readonly DiarizeSpeaker[]): { speakers: number; attributed: number } {
  const roles = rolesByIndex(speakers);
  let attributed = 0;
  for (const r of roles.values()) if (r.role === "clinician") attributed += 1;
  return { speakers: roles.size, attributed };
}


// ---------------------------------------------------------------------------
// D1 — WHERE A SPEAKER CHANGES INSIDE A TURN, THE TURN GETS NO NAME
// ---------------------------------------------------------------------------

/**
 * The defect this closes, concretely. A turn spanning 0-1000 ms, with the service reporting speaker
 * 0 from 0-600 (matched to a clinician) and speaker 1 from 600-1000 (unmatched), used to be bound
 * by pure overlap-max: speaker 0 wins 600 ms to 400 ms, and the whole turn is written
 * `role='clinician'`. Four hundred milliseconds of someone else's speech is then on the record as
 * the doctor's.
 *
 * Overlap-max is the right answer for "which cluster does this turn mostly belong to" — it stays,
 * and `speaker_idx` still carries it, because a diagnostic reader wants it. It is the WRONG answer
 * for "may this turn carry a person's name", and those two questions had been answered by one
 * number. A turn that contains a speaker boundary is a turn nobody can attribute without splitting
 * it, and splitting a turn is not something a speaker-diarizer's timings license.
 *
 * So: `exclusive` is false whenever more than one speaker holds any of the turn, and the caller
 * must not grant a role when it is false. The invariant is enforced ON THE ROW, not inside
 * `roleForSpeaker` — that function answers "who is this speaker", which is a different question
 * from "does this turn belong to exactly one speaker".
 */
export type ExclusiveBinding = {
  source_ref: string;
  speaker_idx: number;
  overlap_ms: number;
  /** True only when ONE speaker overlaps this turn at all. */
  exclusive: boolean;
  /** How many distinct speakers touched it. >1 is the straddle. */
  speaker_count: number;
};

type Span = { start_ms: number; end_ms: number };
const overlapMs = (a: Span, b: Span) => Math.max(0, Math.min(a.end_ms, b.end_ms) - Math.max(a.start_ms, b.start_ms));

/**
 * PURE. Overlap-max binding, plus the fact the caller actually needs to decide about a name.
 *
 * Ties break on the LOWER speaker index so the answer does not depend on iteration order, exactly
 * as the original does — a turn split down the middle is a straddle anyway and gets no role.
 */
export function bindTurnsExclusive(
  segments: readonly (Span & { speaker_idx: number })[],
  turns: readonly (Span & { source_ref: string })[],
): ExclusiveBinding[] {
  const out: ExclusiveBinding[] = [];
  for (const t of turns) {
    const totals = new Map<number, number>();
    for (const s of segments) {
      const ms = overlapMs(t, s);
      if (ms > 0) totals.set(s.speaker_idx, (totals.get(s.speaker_idx) ?? 0) + ms);
    }
    let best: { idx: number; ms: number } | null = null;
    for (const [idx, ms] of totals) {
      if (!best || ms > best.ms || (ms === best.ms && idx < best.idx)) best = { idx, ms };
    }
    if (!best) continue;
    out.push({
      source_ref: t.source_ref,
      speaker_idx: best.idx,
      overlap_ms: best.ms,
      exclusive: totals.size === 1,
      speaker_count: totals.size,
    });
  }
  return out;
}
