/**
 * lib/brain/fuse/rules.ts — ARM A, the rules fuse (Fuse slice 4, §6.3).
 *
 * A PURE FUNCTION. No I/O, no clock, no randomness, no id generation. Running it twice on the
 * same cue list returns deeply equal output — same visits, same states, same confidences, same
 * opened_by, same reasons, same order. That is asserted, not asserted-about (§9.1).
 *
 * It implements the §5 grammar, which arms B and C are then measured against:
 *
 *   · The visit key is individual_uid + IST date CONCEPTUALLY, and deliberately not in the
 *     database: §10.3 needs two visits for one person on one day, so the persisted key is
 *     (arm, opened_by) and the person is not in it.
 *   · A pstart may open in_chair, and a pstart with NO mark still mints a visit — official
 *     start, strong identity.
 *   · A pqm_called with no mark may open `called`.
 *   · A pulse_note is a LATER LOCK, never an opener.
 *   · A dx_event opens a HOLE — at_diagnostics on the existing visit — and never a new visit.
 *   · A second pstart with a different calendar_uid IS a second visit for the same person on
 *     the same day. This is §10.3 and it is why the key is not the person.
 *   · attribution:'inferred' is evidence, not a binder: identity is never minted from an
 *     inferred dx_event alone.
 *   · in_tape_window is NOT READ AT ALL — it neither drops a visit nor attaches tape, and 35
 *     of the 43 warehouse events fall outside every tape window. That is the finding.
 *   · Voice is a prior, not a binder. 0.78 appears nowhere in this file, by name or by value.
 *   · Where the rules cannot settle a case the visit is still emitted, with low confidence and
 *     a named reason. An arm that never says "I cannot tell" across a six-hour evidence gap
 *     loses that row however plausible its output.
 */

import type { ArmOutput, DraftVisit, FuseCue, OpenedByKind, UnboundEvidence, VisitState } from "./types";

/**
 * THE CLOSED SET of ambiguity reasons arm A can emit. Closed on purpose: slice 5 scores these,
 * and a free-text reason cannot be counted. Adding one is a deliberate change here, not
 * something a branch can do in passing.
 */
export const RULES_REASONS = {
  /** a kiosk consult_mark with no warehouse cue anywhere near it — the six-hour gap */
  MARK_WITHOUT_WAREHOUSE_EVIDENCE: "mark_without_warehouse_evidence",
  /** someone was called and no official start ever followed */
  PQM_CALLED_WITHOUT_PSTART: "pqm_called_without_pstart",
  /** more calls than starts for one person: which call opened which visit is not decidable */
  MULTIPLE_CALLS_ONE_START: "multiple_calls_one_start",
  /** a diagnostics clock for a person with no visit that day — never mints one */
  DX_EVENT_WITHOUT_VISIT: "dx_event_without_visit",
  /** more than one candidate visit for the hole */
  DX_EVENT_AMBIGUOUS_VISIT: "dx_event_ambiguous_visit",
  /** a note for a person with no visit that day */
  PULSE_NOTE_WITHOUT_VISIT: "pulse_note_without_visit",
  /** the only thing binding this identity is attribution:'inferred' */
  INFERRED_ATTRIBUTION_ONLY: "inferred_attribution_only",
  /** no calendar_uid, so a repeat booking cannot be told from a duplicate warehouse row */
  PSTART_WITHOUT_CALENDAR_UID: "pstart_without_calendar_uid",
} as const;

export const ALL_RULES_REASONS: readonly string[] = Object.values(RULES_REASONS);

// --- the numbers, all in one place so slice 5 can argue with them ------------
// None of these is 0.78, and none is derived from a voice score. Voice is a prior in this
// system, never a binder, and this slice attaches no speaker_cluster at all (X5).
const CONF_PSTART_DIRECT = 0.9;
const CONF_PSTART_INFERRED = 0.65;
const CONF_CALLED_DIRECT = 0.6;
const CONF_CALLED_INFERRED = 0.45;
const CONF_MARK_ONLY = 0.3;
/** any named ambiguity caps the visit here, however good the rest of the evidence looked */
const CONF_AMBIGUOUS_CAP = 0.5;
const CONF_MAX = 0.95;
const CONFIRM_BONUS = 0.05;

/**
 * The ONE number arm A invents: how close a kiosk mark must be to an official start before the
 * rules will call them the same consult. Nothing in the corpus or the PRD fixes it, so it is
 * named here rather than buried, and slice 5 should score it rather than inherit it.
 */
export const MARK_BIND_WINDOW_MS = 30 * 60 * 1000;

// --- payload access: everything is optional and an absent key is ABSENT ------
// A null in a payload means the warehouse gave a null; it is not the same as the key being
// missing, and neither is ever turned into a guess.
const str = (p: Record<string, unknown> | null, k: string): string | null => {
  const v = p?.[k];
  return typeof v === "string" && v.length > 0 ? v : null;
};

const ms = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

/** Deterministic evidence order: the clock, then the cue id. Never insertion order. */
const byAtThenId = (a: FuseCue, b: FuseCue): number => ms(a.at) - ms(b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

type Working = DraftVisit & { _calendar_uid: string | null; _openedAtMs: number };

const clamp = (n: number): number => Math.max(0, Math.min(CONF_MAX, Math.round(n * 1000) / 1000));

function addReason(v: Working, reason: string): void {
  if (!v.reasons.includes(reason)) v.reasons.push(reason);
  v.confidence = Math.min(v.confidence, CONF_AMBIGUOUS_CAP);
}

export function runRulesArm(cues: FuseCue[]): ArmOutput {
  const sorted = [...cues].sort(byAtThenId);
  const of = (type: string) => sorted.filter((c) => c.type === type);
  const visits: Working[] = [];
  const unbound: UnboundEvidence[] = [];

  const mint = (c: FuseCue, kind: OpenedByKind, state: VisitState, confidence: number, pstartAt: string | null): Working => {
    const v: Working = {
      individual_uid: str(c.payload, "individual_uid"),
      consult_uid: str(c.payload, "consult_uid"),
      state,
      pstart_at: pstartAt,
      confidence,
      // A warehouse cue is keyed by the row it came from; a kiosk mark has no source_ref, so
      // its own cue id IS the opening evidence (§6.1). Never empty — the unique index needs it.
      opened_by: c.source_ref ?? str(c.payload, "source_ref") ?? c.id,
      opened_by_kind: kind,
      reasons: [],
      _calendar_uid: str(c.payload, "calendar_uid"),
      _openedAtMs: ms(c.at),
    };
    visits.push(v);
    return v;
  };

  // -- 1. pstart opens in_chair. A pstart with no mark still mints. -----------
  // The §10.3 row lives here: the key is (individual_uid, calendar_uid), so a SECOND pstart
  // with a DIFFERENT calendar_uid is a second visit for the same person on the same day.
  // Identical (uid, calendar_uid) twice is one booking reported twice, not two visits.
  const seenBooking = new Set<string>();
  for (const c of of("pstart")) {
    const uid = str(c.payload, "individual_uid");
    const cal = str(c.payload, "calendar_uid");
    const ref = c.source_ref ?? str(c.payload, "source_ref") ?? c.id;
    const bookingKey = `${uid ?? "∅"}|${cal ?? ref}`;
    if (seenBooking.has(bookingKey)) continue;
    seenBooking.add(bookingKey);
    const inferred = str(c.payload, "attribution") === "inferred";
    const v = mint(c, "pstart", "in_chair", inferred ? CONF_PSTART_INFERRED : CONF_PSTART_DIRECT, c.at);
    if (inferred) addReason(v, RULES_REASONS.INFERRED_ATTRIBUTION_ONLY);
    // Without a calendar_uid a repeat booking is indistinguishable from a duplicate row, so
    // this visit's very existence is uncertain — say so rather than pick.
    if (!cal) addReason(v, RULES_REASONS.PSTART_WITHOUT_CALENDAR_UID);
  }

  // -- 2. pqm_called: the call for a start, or a visit of its own -------------
  const callsByUid = new Map<string, number>();
  for (const c of of("pqm_called")) {
    const uid = str(c.payload, "individual_uid");
    if (uid) callsByUid.set(uid, (callsByUid.get(uid) ?? 0) + 1);
    const started = uid ? visits.filter((v) => v.individual_uid === uid && v.opened_by_kind === "pstart") : [];
    if (started.length > 0) {
      // The call belongs to a start that already exists. Corroboration, not a new visit.
      const target = started[0]!;
      target.confidence = clamp(target.confidence + CONFIRM_BONUS);
      continue;
    }
    const inferred = str(c.payload, "attribution") === "inferred";
    const v = mint(c, "pqm_called", "called", inferred ? CONF_CALLED_INFERRED : CONF_CALLED_DIRECT, null);
    // Called, never started: a real and interesting state, and an uncertain one.
    addReason(v, RULES_REASONS.PQM_CALLED_WITHOUT_PSTART);
    if (inferred) addReason(v, RULES_REASONS.INFERRED_ATTRIBUTION_ONLY);
  }
  // More calls than starts for one person: which call opened which visit is not decidable.
  for (const [uid, n] of callsByUid) {
    const starts = visits.filter((v) => v.individual_uid === uid && v.opened_by_kind === "pstart");
    if (starts.length > 0 && n > starts.length) for (const v of starts) addReason(v, RULES_REASONS.MULTIPLE_CALLS_ONE_START);
  }

  // -- 3. dx_event opens a HOLE on an existing visit, and NEVER mints one -----
  for (const c of of("dx_event")) {
    const uid = str(c.payload, "individual_uid");
    const inferred = str(c.payload, "attribution") === "inferred";
    const candidates = uid ? visits.filter((v) => v.individual_uid === uid) : [];
    if (candidates.length === 0) {
      // Identity is never minted from a dx_event, and least of all an inferred one.
      unbound.push({
        cue_id: c.id,
        type: c.type,
        reason: inferred ? RULES_REASONS.INFERRED_ATTRIBUTION_ONLY : RULES_REASONS.DX_EVENT_WITHOUT_VISIT,
      });
      continue;
    }
    // The hole opens AFTER the start it belongs to: the latest visit that had already begun.
    const atMs = ms(c.at);
    const priors = candidates.filter((v) => v._openedAtMs <= atMs);
    const pool = priors.length > 0 ? priors : candidates;
    const target = pool[pool.length - 1]!;
    target.state = "at_diagnostics";
    if (candidates.length > 1) addReason(target, RULES_REASONS.DX_EVENT_AMBIGUOUS_VISIT);
    if (inferred) addReason(target, RULES_REASONS.INFERRED_ATTRIBUTION_ONLY);
  }

  // -- 4. pulse_note is a LATER LOCK: it confirms, it never opens or closes ---
  // It deliberately does NOT change state. 0042 lists pulse_note among end_reason's values,
  // but nothing in the §5 grammar says a note ends a visit, and inventing a close would be a
  // guess dressed as a rule.
  for (const c of of("pulse_note")) {
    const uid = str(c.payload, "individual_uid");
    const candidates = uid ? visits.filter((v) => v.individual_uid === uid) : [];
    if (candidates.length === 0) {
      unbound.push({ cue_id: c.id, type: c.type, reason: RULES_REASONS.PULSE_NOTE_WITHOUT_VISIT });
      continue;
    }
    const target = candidates[candidates.length - 1]!;
    target.confidence = clamp(target.confidence + CONFIRM_BONUS);
  }

  // -- 5. the kiosk mark: tape-side corroboration, or a visit with no identity -
  // Room-to-doctor is already baked into the corpus — every warehouse cue on a scratch day
  // belongs to this room's doctor — so a mark is bound by CLOCK alone. Nothing is re-queried
  // and nothing is re-derived (§7).
  for (const c of of("consult_mark")) {
    const atMs = ms(c.at);
    const near = visits
      .filter((v) => v.pstart_at !== null && Math.abs(ms(v.pstart_at) - atMs) <= MARK_BIND_WINDOW_MS)
      .sort((a, b) => Math.abs(ms(a.pstart_at!) - atMs) - Math.abs(ms(b.pstart_at!) - atMs));
    if (near.length > 0) {
      near[0]!.confidence = clamp(near[0]!.confidence + CONFIRM_BONUS);
      continue;
    }
    // A consult happened on the tape and the warehouse says nothing about it. This is the
    // six-hour gap, and it is a visit — with no identity and low confidence, saying so.
    const v = mint(c, "mark", "unknown", CONF_MARK_ONLY, null);
    v.individual_uid = null;
    addReason(v, RULES_REASONS.MARK_WITHOUT_WAREHOUSE_EVIDENCE);
  }

  // -- 6. finalise: strip bookkeeping, clamp, and order deterministically -----
  const out: DraftVisit[] = visits
    .map((v) => ({
      individual_uid: v.individual_uid,
      consult_uid: v.consult_uid,
      state: v.state,
      pstart_at: v.pstart_at,
      confidence: clamp(v.confidence),
      opened_by: v.opened_by,
      opened_by_kind: v.opened_by_kind,
      reasons: [...v.reasons].sort(),
    }))
    .sort((a, b) => {
      // Visits with a start come first, in start order; then by opening evidence, which is
      // unique per visit. No clock, no insertion order, no id — the same list every run.
      const at = a.pstart_at ? ms(a.pstart_at) : Number.MAX_SAFE_INTEGER;
      const bt = b.pstart_at ? ms(b.pstart_at) : Number.MAX_SAFE_INTEGER;
      return at - bt || (a.opened_by < b.opened_by ? -1 : a.opened_by > b.opened_by ? 1 : 0);
    });

  return { visits: out, unbound: [...unbound].sort((a, b) => (a.cue_id < b.cue_id ? -1 : a.cue_id > b.cue_id ? 1 : 0)) };
}
