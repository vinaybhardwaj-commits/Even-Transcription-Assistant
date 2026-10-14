/**
 * lib/stewardship-danger-core.ts — who belongs in the danger queue, and what state they are in
 * (CDMSS-STEWARDSHIP-MS-AGENT-KICKOFF-v2-29-AUG-2026, A5; spec §4 D-escalate, acceptance #7 / #16).
 *
 * PURE AND DEPENDENCY-FREE except for `tierFor`, which is itself pure and is the ONLY thing allowed
 * to decide an OPD finding's severity. Nothing here re-derives a tier, invents an IPD regex table,
 * or writes anything. No ./db, no next/*.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE TWO LEGS OF "DANGEROUS", and why they are two.
 *
 *   1. SEVERITY — `tierFor` says tier 1 (E-1 / E-2, the ratified escalation entries). Tier 3 is
 *      log-only and never becomes a row; tier 2 is the week's work, not the queue's. PRAISE is
 *      outside the tier list entirely and is excluded unconditionally, including when it carries a
 *      contested pill: a finding that praises an appropriate ACS referral must not land in a queue
 *      whose whole meaning is "possible active patient risk".
 *
 *   2. DISPUTE — the latest human pill on the finding is `contested`. This is not a severity claim
 *      at all. It is an unresolved disagreement between the engine and a reviewer, and the reason
 *      it belongs in the same queue is that nobody has decided which of them is right yet.
 *
 * A finding qualifies on either leg. Whether it is COUNTED as open is a separate question, decided
 * by the pill, below.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A5 — THE IPD VOCABULARY IS SEVEN WORDS, NOT FOUR, AND THE ROUTE STAYS UNTOUCHED. The IPD feedback
 * route has accepted `agree`, `disagree` and `needs_action` since before the OPD-grade vocabulary
 * replaced them, and rows carrying all seven are in the table. The kickoff's decision is that the
 * READER maps them and the WRITER is not touched this ship — so the seven are mapped here, once,
 * and `app/api/admin/ipd-audit-feedback/route.ts` is not edited at all.
 */
import { tierFor, type TierableFinding } from './severity-tier-core';

// ── the pill → state mapping (spec §4 for OPD, A5 for IPD) ────────────────────────────────

/**
 * What the latest pill on a finding means for the queue.
 *   confirmed — a human agreed the finding is real. It stays VISIBLE as confirmed and is NOT open.
 *   open      — nobody has ruled, or a human disputed the ruling. This is what the count counts.
 *   dropped   — a human said it is noise or wrong. It leaves the queue.
 */
export type DangerPillState = 'confirmed' | 'open' | 'dropped';

/**
 * OPD, spec §4: "Open = no pill, or pill is `contested`. `true_positive` stays visible as confirmed.
 * `false` / `nitpick` drop off the open count."
 */
export const OPD_PILL_STATE: Readonly<Record<string, DangerPillState>> = Object.freeze({
  true_positive: 'confirmed',
  contested: 'open',
  needs_action: 'open',
  nitpick: 'dropped',
  false: 'dropped',
});

/**
 * The pill values that OPEN a finding, as a set the SQL and the membership rule both read. It exists
 * because "which verdicts open the queue" was, until the 29 Aug validation, expressed three times —
 * in this table, in `opdDangerVerdict`'s `=== 'contested'` test, and in two SQL WHERE clauses — and
 * the three had already drifted: `needs_action` mapped to `open` here and opened nothing there.
 * One list, four readers.
 */
export const DISPUTE_PILLS = ['contested', 'needs_action'] as const;
const isDispute = (v: unknown): boolean => (DISPUTE_PILLS as readonly string[]).includes(String(v ?? '').trim());

/**
 * IPD, A5 verbatim: "`agree` counts as confirmed (like `true_positive`), `disagree` and `false` and
 * `nitpick` drop off the open count, `needs_action` and `contested` count as open, no pill counts as
 * open."
 *
 * Note what `needs_action` is doing here and why it is not `confirmed`: it says a human read the
 * finding and thinks something must still happen about it. That is the definition of open, whatever
 * else it also asserts.
 */
export const IPD_PILL_STATE: Readonly<Record<string, DangerPillState>> = Object.freeze({
  true_positive: 'confirmed',
  agree: 'confirmed',
  contested: 'open',
  needs_action: 'open',
  nitpick: 'dropped',
  false: 'dropped',
  disagree: 'dropped',
});

/** The seven verdicts the IPD feedback route accepts today. Listed so a drift is visible, not so it
 *  can be changed from here — the route is untouched this ship (A5). */
export const IPD_STORED_VERDICTS = [
  'true_positive', 'nitpick', 'false', 'contested', 'agree', 'disagree', 'needs_action',
] as const;

const stateFrom = (table: Readonly<Record<string, DangerPillState>>, verdict: unknown): DangerPillState => {
  const v = String(verdict ?? '').trim();
  // No pill is OPEN, and so is a pill this table has never heard of. The conservative direction is
  // the only safe one for a danger queue: an unmapped verdict that silently dropped a finding would
  // remove a possible patient risk from the list on the strength of a string nobody recognised.
  return (v && table[v]) || 'open';
};

export function opdPillState(verdict: unknown): DangerPillState { return stateFrom(OPD_PILL_STATE, verdict); }
export function ipdPillState(verdict: unknown): DangerPillState { return stateFrom(IPD_PILL_STATE, verdict); }

// ── membership ────────────────────────────────────────────────────────────────────────────

export interface DangerVerdict {
  /** Does this finding belong in the queue at all? */
  included: boolean;
  /** Which leg put it there — severity, dispute, or both. */
  leg: 'escalation' | 'contested' | 'both' | null;
  state: DangerPillState;
  /** Counted in the board's open-dangerous column. */
  open: boolean;
  tier: 1 | 2 | 3 | 'praise';
  escalatedBy?: 'E-1' | 'E-2';
  reason: string;
}

const NOT_INCLUDED = (state: DangerPillState, tier: DangerVerdict['tier'], reason: string): DangerVerdict =>
  ({ included: false, leg: null, state, open: false, tier, reason });

/**
 * OPD membership. `tierFor` is the only severity authority (§7 — it is not touched, extended or
 * mirrored); this function only asks it a question and reads the pill.
 */
export function opdDangerVerdict(finding: TierableFinding, pillVerdict: unknown): DangerVerdict {
  const t = tierFor(finding);
  const state = opdPillState(pillVerdict);
  if (t.tier === 'praise') return NOT_INCLUDED(state, 'praise', 'praise — never a danger row, whatever pill it carries');

  const escalated = t.tier === 1;
  const contested = isDispute(pillVerdict);
  if (!escalated && !contested) {
    return NOT_INCLUDED(state, t.tier, `tier ${t.tier} and not contested — the tiered action list, not the danger queue`);
  }
  const leg: DangerVerdict['leg'] = escalated && contested ? 'both' : escalated ? 'escalation' : 'contested';
  return {
    included: true,
    leg,
    state,
    open: state === 'open',
    tier: t.tier,
    ...(t.escalatedBy ? { escalatedBy: t.escalatedBy } : {}),
    reason: escalated
      ? `escalated by ${t.escalatedBy}${contested ? ' and disputed by a reviewer' : ''}`
      : disputeReason(pillVerdict),
  };
}

/** One inpatient finding, as the audit stored it. There is no `finding_ref` on the IPD shape — the
 *  subject IS the pill's key on this surface (`app/admin/ipd-audit/[id]/report-with-triage.tsx`). */
export interface IpdDangerFinding { subject?: string; domain?: string; verdict?: string }

/**
 * IPD membership. Spec §4: "IPD has **no** `tierFor` twin today. Do not invent IPD regex. Use stored
 * domain + pill state until a named IPD severity table exists."
 *
 * So the severity leg is exactly one stored enum value — `domain === 'safety'`, the Care-Value axis
 * the model tagged the finding against — and nothing is inferred from its text. `high-value` is the
 * inpatient side's praise and is excluded on the same principle as OPD's.
 */
export function ipdDangerVerdict(finding: IpdDangerFinding, pillVerdict: unknown): DangerVerdict {
  const state = ipdPillState(pillVerdict);
  const praise = String(finding?.verdict ?? '').trim() === 'high-value';
  if (praise) return NOT_INCLUDED(state, 'praise', 'high-value — the inpatient side\'s praise, never a danger row');

  const safety = String(finding?.domain ?? '').trim().toLowerCase() === 'safety';
  const contested = isDispute(pillVerdict);
  if (!safety && !contested) return NOT_INCLUDED(state, 2, 'not a safety-domain finding and carries no open dispute');
  const leg: DangerVerdict['leg'] = safety && contested ? 'both' : safety ? 'escalation' : 'contested';
  return {
    included: true,
    leg,
    state,
    open: state === 'open',
    // No tier is claimed for an inpatient finding, because no ratified inpatient tier table exists.
    // `2` is the placeholder the shared shape needs, and the surface renders the DOMAIN, not this.
    tier: 2,
    reason: safety ? 'a safety-domain finding on this stay' : disputeReason(pillVerdict),
  };
}

/**
 * A5 draws a real distinction between the two dispute pills and the queue should not flatten it.
 * `contested` says a reviewer disagrees with the engine and nobody has settled who is right;
 * `needs_action` says a reviewer AGREES enough that something still has to happen. Both are open.
 * Only one of them is an argument.
 */
function disputeReason(pillVerdict: unknown): string {
  return String(pillVerdict ?? '').trim() === 'needs_action'
    ? 'a reviewer marked this as still needing action and nobody has closed it'
    : 'a reviewer contested this finding and nobody has resolved it';
}

// ── the board's sort (D-no-composite, spec §4) ────────────────────────────────────────────

export interface BoardSortable {
  openDangerous: number;
  /** The board's OPD column — `avg(note_quality_index)` on the canonical 90-day set. */
  avgNqi: number;
  /** The IPD column. `null` means the hop has not resolved this row: it sorts LAST, never as a 0. */
  ipdCvi: number | null;
  /** A stable final key so two identical rows do not swap places between renders. */
  label: string;
}

/**
 * Spec §4: "open dangerous desc, then OPD Avg NQI asc (worse first) unless V names another, then
 * IPD." There is no weighting here and there must never be one — D-no-composite forbids
 * `0.4*NQI + 0.4*CVI + 0.2*avoidable`, and a lexicographic sort is the shape that cannot become one
 * by accident. An unresolved IPD cell sorts last rather than as a zero: `IPD unjoined` is an absence
 * of a measurement, and ranking it as the worst possible score would be a claim nobody made.
 */
export function sortBoardRows<T extends BoardSortable>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) =>
    b.openDangerous - a.openDangerous
    || a.avgNqi - b.avgNqi
    || cmpNullableAsc(a.ipdCvi, b.ipdCvi)
    || a.label.localeCompare(b.label));
}

function cmpNullableAsc(a: number | null, b: number | null): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a - b;
}

// ── the copy the room owns (spec §3, acceptance #3) ───────────────────────────────────────

/**
 * The honesty line, replacing the "not a standalone clinician score" copy ON THIS PAGE ONLY
 * (acceptance #3). NABH B3 still binds the INSTRUMENT — CVI and NQI remain episode-level process
 * scores — and that sentence stays true everywhere else in the app. What changed, and only for this
 * extra-gated internal room, is the clause that said the artefacts may not be used to adjudicate a
 * clinician. V rejected using B3 to veto this room; the instrument's limits are stated here instead
 * of being used as a reason not to show the board.
 */
export const STEWARDSHIP_HONESTY =
  'Internal medical-superintendent stewardship. Named clinicians. Never shown to the clinician being reviewed or to any patient. The audits are advisory rule and model outputs on the notes and stays a clinician wrote — read them beside the evidence, not as a disciplinary conclusion.';

/** The banner the board shows wherever the inpatient side cannot be attributed to a named clinician
 *  (A1 / D-identity). It is the split, said plainly, and it never becomes a silent merge. */
export const IPD_SPLIT_BANNER =
  'OPD and IPD are not the same physician key on this spine.';

/** The cell that stands where an inpatient number would be, until the hop resolves. */
export const IPD_UNJOINED_CELL = 'IPD unjoined';

/**
 * §1.4 — the reporting unit, stated on the surface that renders cross-note finding rows. TWO units,
 * because the queue has two: the COUNTS are over every eligible finding, and only the LIST groups.
 *
 * The old sentence said "one row per finding" and stopped, which invited the reader to assume the
 * headline number was counted the same way the rows were. It is not, on either leg. `opdOpen`
 * accumulates `r.occurrences`, so a twin collapsed into one row still counts twice; the inpatient
 * count comes from a grouped SQL aggregate over every eligible row and does no twin grouping at all.
 * Both are deliberate — a danger COUNT should not shrink because two findings landed on one day —
 * but a surface that shows 12 above a list of 9 rows has to say which is which.
 */
export const DANGER_QUEUE_UNIT =
  'Open counts are over every eligible finding. In the list below, the same finding written twice for one clinician on one day is grouped into one row, with a count.';
