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

import { OPEN_STATES, type ArmOutput, type ClinicianSource, type DraftVisit, type FuseCue, type OpenedByKind, type UnboundEvidence, type VisitState } from "./types";

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

/**
 * The value that goes into visit.ambiguity (0049). Reasons are emitted in CLOSED-SET ORDER —
 * the declaration order of RULES_REASONS above, not alphabetical and not the order the rules
 * happened to notice them — and joined with a comma. Slice 5 can therefore split on "," and
 * count exact tokens. Null when the visit is confident. NEVER prose.
 */
export function ambiguityOf(reasons: readonly string[]): string | null {
  if (reasons.length === 0) return null;
  const order = (r: string) => {
    const i = ALL_RULES_REASONS.indexOf(r);
    return i < 0 ? ALL_RULES_REASONS.length : i;
  };
  return [...new Set(reasons)].sort((a, b) => order(a) - order(b) || (a < b ? -1 : 1)).join(",");
}

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
 * How long the LAST mark of a room-day stays open (A4).
 *
 * Every other mark's window is defined by the marks themselves — [this mark, the next mark) —
 * and invents nothing. The last mark of the day has no next mark, so it needs one number, and
 * this is it: 45 minutes, because Pulse often opens after the talking has stopped, so a
 * consult's warehouse clock can land well after the mark that recorded it.
 *
 * It is a NAMED PRIOR, not a measurement. It replaces the 30-minute constant arm A invented in
 * slice 4, which applied to every mark; this one applies to at most one mark per day.
 */
export const LAST_MARK_WINDOW_MS = 45 * 60 * 1000;

/**
 * What a visit's end_reason may say. Written ONLY when state === 'ended' (A6), and a CLOSED
 * SET — 0042 declares the column open, but arm A's vocabulary is not, so slice 5 can count
 * these tokens against ALL_END_REASONS rather than against free strings.
 */
export const END_REASONS = {
  /** the individual's Pulse note landed: this visit is finished */
  PULSE_NOTE: "pulse_note",
  /** still open when the day was fused: closed by the day boundary, per 0042 */
  DAY_ROLLOVER: "day_rollover",
  /**
   * At the day boundary this visit was AT DIAGNOSTICS — the patient was sent out and the
   * warehouse never recorded them coming back. That is the diagnostics hole, and it is not
   * the same event as a visit that simply never closed. Before this token the two were
   * indistinguishable in the row, and the hole — the hard join the Brain PRD spends a page
   * on — vanished at the moment the day was fused.
   */
  DAY_ROLLOVER_AT_DIAGNOSTICS: "day_rollover_at_diagnostics",
  /**
   * K2 B1 — the next visit in this room OPENED. One room cannot hold two consults at once, so
   * the arrival of the next opening evidence is itself the end of the previous visit, and its
   * instant is that opening instant.
   *
   * CONSEQUENCE, stated because it is easy to miss: this outranks day_rollover in the B5
   * precedence, so DAY_ROLLOVER and DAY_ROLLOVER_AT_DIAGNOSTICS are now reachable only by a
   * visit with NO later opener — in practice the last visit of the day. The diagnostics hole
   * is still nameable, but on the last visit only.
   */
  NEXT_OPENER: "next_opener",
  /**
   * K2 B2 — a visit opened by a kiosk mark, with no next opener, closes LAST_MARK_WINDOW_MS
   * after the mark. This reuses the prior that already exists for the last mark of a day; it
   * invents nothing and defines no second constant.
   */
  MARK_WINDOW_ELAPSED: "mark_window_elapsed",
  /**
   * K2 B3 — closed by the day boundary while still `unknown`.
   *
   * Kept DISTINCT from DAY_ROLLOVER on purpose. A visit that rolls over from in_chair is one
   * we established and watched fail to close; one that rolls over from `unknown` is a kiosk
   * mark whose window held no warehouse evidence at all — the unrecorded-care case. Before K2
   * the second kind closed by NOTHING, ever, and sat open for all time. It closes now, and the
   * token is what stops that being mistaken for the first kind.
   */
  DAY_ROLLOVER_UNKNOWN: "day_rollover_unknown",
} as const;

export const ALL_END_REASONS: readonly string[] = Object.values(END_REASONS);

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

/**
 * One bench session, as the arm sees it. The RUNNER reads these; the arm only intersects them
 * with spans it already computed. Passing them IN is what keeps this file free of I/O.
 */
export type TapeSession = { id: string; started_at: string; ended_at: string | null };

/**
 * Everything the arm needs that it must not go and fetch. Both fields are OPTIONAL and their
 * absence is a legitimate, tested state, not a degraded one:
 *
 *   rolloverAt  the IST day boundary, ISO. Absent → a day_rollover close still happens and
 *               ended_at is null, because the arm genuinely does not know the instant. It
 *               will NOT read a clock to find out; that is the whole point of this parameter.
 *   sessions    the tape. Absent or non-overlapping → session_id and both tape bounds are
 *               null and the visit is still emitted. A visit the warehouse knows about that
 *               the tape missed is a FINDING, not an error, and is never forced into a tape.
 *
 * Purity is preserved because these are INPUTS: runRulesArm(cues, opts) twice with the same
 * two arguments returns deeply equal output, which is what U7 asserts.
 */
export type RulesArmOptions = {
  /**
   * B1 — IS THE DAY OVER? The day-rollover pass runs only when this is true.
   *
   * DEFAULTS TO FALSE, because the safe answer to "may I close every open visit" is no. On a
   * live day the boundary is in the FUTURE, and rolling over to it wrote every visit
   * already-ended at an instant that had not happened — which made the update path in
   * visit-update.ts unreachable (every K2 live run reported `frozen: 5` and exercised it zero
   * times) and is where the timestamptz/Date precision bug sat unnoticed.
   *
   * The ARM DOES NOT DECIDE THIS. It cannot: knowing whether a day is over means reading a
   * clock, and this file reads none. The caller knows and says so.
   */
  day_complete?: boolean;
  /** the IST day boundary, ISO — the instant a rollover close is stamped with */
  rolloverAt?: string | null;
  /**
   * The latest instant the arm may treat as HAVING PASSED. Supplied separately from
   * `rolloverAt` because on a live day those are different instants and conflating them is
   * exactly the bug B1 fixes: the boundary is hours away, while "now" is what has actually
   * elapsed.
   *
   * It governs ONE thing — whether a mark's LAST_MARK_WINDOW_MS window has finished (B2). A
   * mark pressed four minutes ago has not had its 45 minutes yet, and closing its visit at
   * mark+45 would stamp an ended_at in the future just as surely as the rollover did.
   *
   * Absent, it falls back to `rolloverAt`; absent both, a COMPLETE day treats every window as
   * elapsed (the day is over, so they all are) and an INCOMPLETE one treats none as elapsed
   * (nothing is known to have passed, so nothing may be closed on the strength of it).
   */
  asOf?: string | null;
  sessions?: readonly TapeSession[];
};

/**
 * The cue payload key that can carry a clinician, and the two cue types allowed to carry it.
 *
 * DERIVATION, NOT DECLARATION. The SOURCE label is decided by WHICH CUE TYPE the id arrived
 * on — never by a `clinician_source` field in a payload. A caller that stamps
 * clinician_source:'roster' into a cue gets no roster attribution out of this arm; the field
 * is not read, anywhere, at all. That is A3's "never accept a typed clinician_source", and it
 * is why the mapping lives here as code rather than as a lookup on the payload.
 */
const CLINICIAN_ID_KEY = "clinician_id";
const OPERATOR_CUE_TYPE = "operator_pin";
const MARK_CUE_TYPE = "consult_mark";

type Working = DraftVisit & { _calendar_uid: string | null; _openedAtMs: number };

const clamp = (n: number): number => Math.max(0, Math.min(CONF_MAX, Math.round(n * 1000) / 1000));

function addReason(v: Working, reason: string): void {
  if (!v.reasons.includes(reason)) v.reasons.push(reason);
  v.confidence = Math.min(v.confidence, CONF_AMBIGUOUS_CAP);
}

export function runRulesArm(cues: FuseCue[], opts: RulesArmOptions = {}): ArmOutput {
  const sorted = [...cues].sort(byAtThenId);
  const of = (type: string) => sorted.filter((c) => c.type === type);
  const visits: Working[] = [];
  const unbound: UnboundEvidence[] = [];
  /** opener cue id → the visit it produced (or was folded into). Used by the mark pass. */
  const visitByOpenerCue = new Map<string, Working>();

  // -- 0. the mark windows, which are defined BY THE MARKS (A4) --------------
  // [this mark, the next mark) for every mark but the last; [last, last + 45 min) for the
  // last. Nothing here is invented except LAST_MARK_WINDOW_MS, which is named above.
  const markCues = sorted.filter((c) => c.type === "consult_mark");
  const markWindows = markCues.map((c, i) => {
    const from = ms(c.at);
    const next = markCues[i + 1];
    return { cue: c, from, to: next ? ms(next.at) : from + LAST_MARK_WINDOW_MS };
  });
  const windowFor = (atMs: number) => markWindows.find((w) => atMs >= w.from && atMs < w.to) ?? null;

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
      end_reason: null,
      // The seven K2 fields start empty and are filled by the passes below — the closers set
      // ended_at, and the last pass sets the tape binding and the clinician. A visit that
      // reaches the end of the arm with these still null is a visit nothing could say more
      // about, which is a legitimate row.
      ended_at: null,
      session_id: null,
      tape_start_ms: null,
      tape_end_ms: null,
      clinician_id: null,
      clinician_source: null,
      clinician_confidence: null,
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
  const seenBooking = new Map<string, Working>();
  for (const c of of("pstart")) {
    const uid = str(c.payload, "individual_uid");
    const cal = str(c.payload, "calendar_uid");
    const ref = c.source_ref ?? str(c.payload, "source_ref") ?? c.id;
    // §10.3 lives on this key. A DIFFERENT calendar_uid for the same person on the same day is
    // a second booking and therefore a second visit; the SAME calendar_uid twice is one booking
    // the warehouse reported twice. calendar_uid reaches the payload from A3 onward — before
    // that it reached no cue at all, which is why this row was untestable.
    const bookingKey = `${uid ?? "∅"}|${cal ?? ref}`;
    const already = seenBooking.get(bookingKey);
    if (already) {
      // Same booking, reported twice. Not a visit — but the duplicate row is still evidence a
      // mark can bind to, so it points at the visit the first report opened.
      visitByOpenerCue.set(c.id, already);
      continue;
    }
    const inferred = str(c.payload, "attribution") === "inferred";
    const v = mint(c, "pstart", "in_chair", inferred ? CONF_PSTART_INFERRED : CONF_PSTART_DIRECT, c.at);
    seenBooking.set(bookingKey, v);
    visitByOpenerCue.set(c.id, v);
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
      visitByOpenerCue.set(c.id, target);
      continue;
    }
    const inferred = str(c.payload, "attribution") === "inferred";
    const v = mint(c, "pqm_called", "called", inferred ? CONF_CALLED_INFERRED : CONF_CALLED_DIRECT, null);
    visitByOpenerCue.set(c.id, v);
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

  // -- 4. pulse_note is a LATER LOCK: it CLOSES, and it never opens (A5) -----
  // It closes THAT INDIVIDUAL'S open visit and nobody else's — the match is on
  // individual_uid, so a mark-only visit (uid null) can never be closed by a note, which is
  // exactly right: we never established who that consult was.
  for (const c of of("pulse_note")) {
    const uid = str(c.payload, "individual_uid");
    const candidates = uid ? visits.filter((v) => v.individual_uid === uid) : [];
    if (candidates.length === 0) {
      unbound.push({ cue_id: c.id, type: c.type, reason: RULES_REASONS.PULSE_NOTE_WITHOUT_VISIT });
      continue;
    }
    // The note belongs to the latest visit that had already OPENED by the time it landed;
    // failing that, the latest STILL-OPEN one; failing that, NOTHING.
    //
    // There is deliberately no third fallback. An earlier build fell back to "the latest of
    // any", which meant a second note for the same person found the visit the FIRST note had
    // already closed, bumped its confidence, and vanished — reported neither as a close nor
    // as unbound. A note must never touch a visit that is already ended, so a note with no
    // open target does nothing at all and says so in `unbound`.
    const atMs = ms(c.at);
    const open = candidates.filter((v) => OPEN_STATES.includes(v.state));
    const started = open.filter((v) => v._openedAtMs <= atMs);
    const pool = started.length > 0 ? started : open;
    if (pool.length === 0) {
      unbound.push({ cue_id: c.id, type: c.type, reason: RULES_REASONS.PULSE_NOTE_WITHOUT_VISIT });
      continue;
    }
    const target = pool[pool.length - 1]!;
    // `target` is open by construction, so its end_reason is null and this cannot overwrite
    // one. The guard is belt to that braces: a set end_reason is never rewritten.
    if (target.end_reason !== null) continue;
    target.confidence = clamp(target.confidence + CONFIRM_BONUS);
    target.state = "ended";
    target.end_reason = END_REASONS.PULSE_NOTE;
    // A1 — the arm always knew this instant and used to throw it away. The note's own clock is
    // when the visit ended; not the arm's clock, and not the cue's arrival time.
    target.ended_at = c.at;
  }

  // -- 5. the kiosk mark: its window binds warehouse clocks, or it stands alone -
  // Room-to-doctor is already baked into the corpus — every warehouse cue on a scratch day
  // belongs to this room's doctor — so a mark is bound by CLOCK alone. Nothing is re-queried
  // and nothing is re-derived (§7).
  for (const w of markWindows) {
    // Which warehouse clocks fell inside THIS mark's window? Openers only — a dx_event or a
    // pulse_note inside a window is not a consult starting, and must not stop the mark from
    // reporting an empty window.
    const inside = sorted.filter(
      (c) => (c.type === "pstart" || c.type === "pqm_called") && ms(c.at) >= w.from && ms(c.at) < w.to,
    );
    if (inside.length > 0) {
      // Bound: ONE visit, and its identity comes from the warehouse clock, not from the mark.
      // The mark corroborates what the warehouse already opened and mints no second row.
      const bound = new Set<Working>();
      for (const c of inside) {
        const v = visitByOpenerCue.get(c.id);
        if (v) bound.add(v);
      }
      for (const v of bound) v.confidence = clamp(v.confidence + CONFIRM_BONUS);
      continue;
    }
    // An EMPTY window: a consult happened on the tape and the warehouse says nothing about it
    // anywhere near it. That is a visit — with no identity, at 0.3, saying so. This is the
    // OPD 7 six-hour gap, and it stays a gap.
    const v = mint(w.cue, "mark", "unknown", CONF_MARK_ONLY, null);
    v.individual_uid = null;
    addReason(v, RULES_REASONS.MARK_WITHOUT_WAREHOUSE_EVIDENCE);
  }

  // -- 6. THE CLOSERS, in B5 precedence order (K2 Part B) ---------------------
  //
  // Before K2 a visit closed on a pulse_note or at day rollover, and the rollover pass skipped
  // `unknown`. The consequence was not a rough edge, it was a hole: a visit opened by a kiosk
  // mark with no warehouse evidence — the unrecorded-care case, which is the whole product —
  // was closed by NOTHING, EVER. It could only ever be found still open.
  //
  // The precedence below is a chain, not a set: the FIRST closer that fires wins and the rest
  // are not consulted for that visit.
  //
  //   pulse_note  (pass 4, already applied)   the individual's own note landed
  //   next_opener                             the next visit in this room opened
  //   mark_window_elapsed                     a mark-opened visit, LAST_MARK_WINDOW_MS on
  //   day_rollover / _at_diagnostics /        the day boundary, saying which state it was in
  //     _unknown
  //
  // WHAT IS DELIBERATELY NOT HERE: a silence-gap closer. It was measured against the 19 August
  // OPD 7 tape and removed. 73% of inter-turn gaps are exactly ZERO because whisper.cpp emits
  // contiguous segments — one turn's end_ms IS the next turn's start_ms — so an inter-turn gap
  // is structurally blind to silence. A proven-dead 15-minute window showed a 20 ms internal
  // gap, and one turn inside it spanned 668 seconds carrying six words. There is no bimodality
  // and therefore no threshold to pick. Deriving silence from turn timing would mint the end of
  // a clinical record out of a heuristic, so it is not done, here or anywhere.
  const dayComplete = opts.day_complete === true;
  const rolloverAtMs = opts.rolloverAt ? ms(opts.rolloverAt) : null;
  /**
   * The elapsed horizon for B2. See RulesArmOptions.asOf — a complete day with no instant
   * given means "everything has elapsed"; an incomplete one means "nothing is known to have".
   */
  const horizonMs: number | null = opts.asOf
    ? ms(opts.asOf)
    : rolloverAtMs !== null
      ? rolloverAtMs
      : dayComplete
        ? Number.POSITIVE_INFINITY
        : null;

  /** Close a visit once. A visit already `ended` is never re-closed and its reason never rewritten. */
  const close = (v: Working, reason: string, atMs: number | null): void => {
    if (v.state === "ended") return;
    v.state = "ended";
    v.end_reason = reason;
    v.ended_at = atMs === null ? null : new Date(atMs).toISOString();
  };

  // Every opening instant on this room-day, ascending. "The next visit" is by the CLOCK, not by
  // array position — the visits array is in mint order, which is pass order, not time order.
  const openings = visits.map((v) => v._openedAtMs).sort((a, b) => a - b);

  for (const v of visits) {
    if (v.state === "ended") continue; // pulse_note (pass 4) already closed this one

    // B1 — strictly AFTER, so two visits opening on the same instant do not close each other.
    const nextOpening = openings.find((t) => t > v._openedAtMs);
    if (nextOpening !== undefined) {
      close(v, END_REASONS.NEXT_OPENER, nextOpening);
      continue;
    }

    // B2 — the last visit of the day, opened by a mark. Reuses the existing named prior; this
    // build defines no second constant, and LAST_MARK_WINDOW_MS is still the only invented one.
    //
    // THE WINDOW MUST ACTUALLY HAVE ELAPSED. A mark pressed inside the last 45 minutes of the
    // day has a window that runs past the boundary, so it did NOT elapse — the day ended
    // first, and saying `mark_window_elapsed` would assert an interval that never finished.
    // That case falls through to B3 and closes as `day_rollover_unknown`, which is the only
    // reason that token is reachable at all: every `unknown` visit is mark-opened, so without
    // this test B2 would swallow all of them and B3's token could never be produced.
    if (v.opened_by_kind === "mark") {
      const windowEnds = v._openedAtMs + LAST_MARK_WINDOW_MS;
      if (horizonMs !== null && windowEnds <= horizonMs) {
        close(v, END_REASONS.MARK_WINDOW_ELAPSED, windowEnds);
        continue;
      }
    }

    // B3 — the boundary. K5 B1: ONLY when the caller says the day is over. On a live day this
    // does not run at all, and a visit that reaches here simply stays open in whatever state it
    // is in — which is the truth, and which is what finally makes the "while open" update path
    // reachable on a real room.
    if (!dayComplete) continue;

    // WHAT it was doing when the day ended is the finding, not just THAT it was open, so the
    // three tokens stay distinct and the scoreboard can still tell them apart.
    const reason =
      v.state === "unknown"
        ? END_REASONS.DAY_ROLLOVER_UNKNOWN
        : v.state === "at_diagnostics"
          ? END_REASONS.DAY_ROLLOVER_AT_DIAGNOSTICS
          : END_REASONS.DAY_ROLLOVER;
    close(v, reason, rolloverAtMs);
  }

  // -- 7. the tape binding (A2) ----------------------------------------------
  // A visit's span is [opened, ended); the tape's is [started, ended). Where they overlap, the
  // visit is bound to that session and carries the overlap in epoch ms.
  //
  // NEITHER MISS IS AN ERROR, and neither is forced:
  //   · a visit the warehouse knows about that no session covers keeps its warehouse truth and
  //     gets a NULL binding — 35 of the 43 warehouse events on the reference day fall outside
  //     every tape window, and pretending otherwise would invent tape that does not exist;
  //   · a tape window with no warehouse evidence keeps its binding and has no individual_uid,
  //     which is the mark-only visit and is exactly the row worth having.
  const sessions = [...(opts.sessions ?? [])].sort(
    (a, b) => ms(a.started_at) - ms(b.started_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  for (const v of visits) {
    const startMs = v._openedAtMs;
    const endMs = v.ended_at ? ms(v.ended_at) : null;
    // The session running at the moment the visit OPENED. Deterministic: sessions are sorted,
    // and the first cover wins rather than the longest or the closest.
    const cover = sessions.find((sess) => {
      const sStart = ms(sess.started_at);
      const sEnd = sess.ended_at ? ms(sess.ended_at) : null;
      return sStart <= startMs && (sEnd === null || startMs < sEnd);
    });
    if (!cover) continue; // null session_id, null bounds — a finding, left as one
    const sStart = ms(cover.started_at);
    const sEnd = cover.ended_at ? ms(cover.ended_at) : null;
    const tapeStart = Math.max(sStart, startMs);
    // The earlier of the two ends. Both open (a live visit on a running tape) → null, which
    // 0056's CHECK explicitly allows: tape_end_ms IS NULL is legal beside a set tape_start_ms.
    let tapeEnd: number | null =
      endMs !== null && sEnd !== null ? Math.min(endMs, sEnd) : endMs !== null ? endMs : sEnd;
    // 0056 CHECKs tape_end_ms > tape_start_ms. A non-positive overlap is not a zero-length
    // visit, it is no overlap at all — drop the end rather than write a row the CHECK refuses.
    if (tapeEnd !== null && tapeEnd <= tapeStart) tapeEnd = null;
    v.session_id = cover.id;
    v.tape_start_ms = tapeStart;
    v.tape_end_ms = tapeEnd;
  }

  // -- 8. the clinician (A3) -------------------------------------------------
  // DERIVED, never declared. The id may arrive on exactly two cue types and the type it arrived
  // on IS the source label:
  //   operator_pin  → 'operator'   a human named them
  //   consult_mark  → 'mark'       the kiosk press carried it
  // 'roster' has no source system in this build and 'voice' is slice B, so neither can be
  // produced here — asserted by U8, not merely intended. A payload that spells out
  // clinician_source is ignored: that field is never read, which is what stops a caller
  // laundering a guess into a roster attribution.
  //
  // Nothing found → 'unknown' with a null id and a null confidence. That is a FIRST-CLASS
  // TERMINAL ANSWER: the arm looked and could not tell. It is never upgraded to a guess to
  // avoid the word.
  const clinicianCues = sorted.filter(
    (c) => (c.type === OPERATOR_CUE_TYPE || c.type === MARK_CUE_TYPE) && str(c.payload, CLINICIAN_ID_KEY) !== null,
  );
  for (const v of visits) {
    const startMs = v._openedAtMs;
    const endMs = v.ended_at ? ms(v.ended_at) : null;
    const own = clinicianCues.filter((c) => {
      // The cue that OPENED this visit always belongs to it, whatever the clock says.
      if ((c.source_ref ?? str(c.payload, "source_ref") ?? c.id) === v.opened_by) return true;
      // An operator naming a person names THAT person's visit, wherever it sits on the clock.
      const cUid = str(c.payload, "individual_uid");
      if (cUid !== null && v.individual_uid !== null && cUid === v.individual_uid) return true;
      // Otherwise: did it land inside this visit's own span?
      const at = ms(c.at);
      return at >= startMs && (endMs === null || at < endMs);
    });
    if (own.length === 0) {
      v.clinician_source = "unknown";
      continue;
    }
    // Operator outranks mark; within a rank the LATEST statement wins, because a human
    // correcting themselves an hour later meant the correction. `sorted` is (at, id), so the
    // last match in it is the latest deterministically, ties included.
    const operators = own.filter((c) => c.type === OPERATOR_CUE_TYPE);
    const pool = operators.length > 0 ? operators : own;
    const chosen = pool[pool.length - 1]!;
    const source: ClinicianSource = chosen.type === OPERATOR_CUE_TYPE ? "operator" : "mark";
    v.clinician_id = str(chosen.payload, CLINICIAN_ID_KEY);
    v.clinician_source = source;
    // REUSED, not invented — both are constants this file already had. A human naming the
    // clinician is as sure as this system gets (CONF_MAX); a mark carrying the id is the same
    // weight arm A already gives direct, non-inferred warehouse evidence (CONF_PSTART_DIRECT).
    v.clinician_confidence = source === "operator" ? CONF_MAX : CONF_PSTART_DIRECT;
  }

  // -- 7. finalise: strip bookkeeping, clamp, and order deterministically -----
  const out: DraftVisit[] = visits
    .map((v) => ({
      individual_uid: v.individual_uid,
      consult_uid: v.consult_uid,
      state: v.state,
      pstart_at: v.pstart_at,
      confidence: clamp(v.confidence),
      opened_by: v.opened_by,
      opened_by_kind: v.opened_by_kind,
      // closed-set order, not alphabetical — the same order ambiguityOf() joins them in
      reasons: (ambiguityOf(v.reasons) ?? "").split(",").filter((r) => r.length > 0),
      // A6: end_reason answers "why did it END", so it is null unless it ended. The ambiguity
      // reasons above never come near this field again.
      end_reason: v.state === "ended" ? v.end_reason : null,
      // ended_at travels with end_reason and by the same rule: a visit that is not ended has
      // no end instant, and one that IS ended may still legitimately have none (a rollover the
      // arm was given no boundary for).
      ended_at: v.state === "ended" ? v.ended_at : null,
      session_id: v.session_id,
      tape_start_ms: v.tape_start_ms,
      tape_end_ms: v.tape_end_ms,
      clinician_id: v.clinician_id,
      clinician_source: v.clinician_source,
      clinician_confidence: v.clinician_confidence,
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
