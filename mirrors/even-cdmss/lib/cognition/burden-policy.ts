/**
 * lib/cognition/burden-policy.ts — WM1: may the agent speak?
 *
 * PURE, dependency-free, total, never throws. THIS FILE IS THE WHOLE POLICY. Nothing else in the
 * programme may decide to ask; if a caller wants a different answer it changes the numbers here and
 * bumps BURDEN_POLICY_VERSION, so every stored decision remains attributable to a stated rule.
 *
 * ── WHY A BUDGET, AND WHY IT IS THE POINT OF WM1 ────────────────────────────────────────────────
 *
 * A system that asks a clinician a question every time it notices something is not an assistant; it
 * is an interruption generator, and it gets muted. The scarce resource is not compute, it is a
 * doctor's attention — so the agent's competence is measured by how much it DOESN'T say. The two
 * budgets below are deliberately severe:
 *
 *   BURDEN_PER_ELIGIBLE = 10   at most one ask per ten eligible events, GLOBALLY. Not per doctor,
 *                              not per day — a single running counter across the whole system, reset
 *                              only when an ask actually happens. This is what makes "1-in-10" a
 *                              measurable claim rather than an aspiration.
 *   PER_DOCTOR_DAILY_CAP = 1   and regardless of the global budget, no clinician is asked more than
 *                              once in a day. The global rate could otherwise concentrate every ask
 *                              onto whichever doctor happens to see the most headaches.
 *
 * Both must pass. The global budget limits total noise; the per-doctor cap limits noise felt by ONE
 * person, which is the thing that actually causes a system to be ignored.
 *
 * ── EVERY SILENCE IS NAMED ─────────────────────────────────────────────────────────────────────
 *
 * `reason` is never null and never empty. An agent that stays quiet for an unrecorded reason cannot
 * be audited, and "it didn't fire" is indistinguishable from "it crashed". The five silences are
 * distinct answers to distinct questions, and the ORDER they are checked in is itself the design:
 * cheapest and most structural first, so a row is never attributed to a budget when the real reason
 * was that the agent had no business speaking at all.
 */

import type { CognitionObjective } from './schema';

/** At most one ask per this many eligible events, globally. */
export const BURDEN_PER_ELIGIBLE = 10;

/** And never more than this many asks to one clinician in one day. */
export const PER_DOCTOR_DAILY_CAP = 1;

/**
 * Why the agent stayed quiet. Exactly one of these is stored on every non-asking row.
 *
 * · not_microworld — outside headache. The agent has no competence here.
 * · no_doctor      — no doctor_uid on the row, so there is nobody to ask and nobody to attribute.
 * · stale_era      — the row was produced by an engine version that is no longer current, so its
 *                    findings are not what today's engine would say. Asking about them would be
 *                    asking about a system that no longer exists.
 * · budget_global  — eligible, but fewer than BURDEN_PER_ELIGIBLE eligible events have passed since
 *                    the last ask.
 * · budget_doctor  — eligible and globally affordable, but this clinician has already been asked
 *                    today.
 */
export type SilenceReason = 'not_microworld' | 'no_doctor' | 'stale_era' | 'budget_global' | 'budget_doctor';

/** The reason stored when the agent WOULD have spoken. Not a silence — recorded in the same column
 *  so every row carries a reason and no reader has to interpret a null. */
export const WOULD_ASK_REASON = 'would_ask' as const;

export type BurdenReason = SilenceReason | typeof WOULD_ASK_REASON;

export interface BurdenInput {
  /** Did the event clear microworld + doctor + era? Computed by the caller; see `eligibilityOf`. */
  eligible: boolean;
  /** Eligible events observed since the last time an ask actually happened, globally. */
  globalEligibleSinceLastAsk: number;
  /** Asks already spent on THIS clinician today (IST). */
  doctorAsksToday: number;
  /** The named reason the event was ineligible. Required when `eligible` is false. */
  ineligibleReason?: SilenceReason | null;
}

export interface BurdenDecision {
  wouldAsk: boolean;
  /** v0 emits 'close_snapshot' or nothing. See CognitionObjective — the other three are unreachable. */
  objective: CognitionObjective | null;
  reason: BurdenReason;
}

/**
 * THE decision. Total: every input shape yields a wouldAsk and a named reason.
 *
 * Ineligible events carry the caller's `ineligibleReason` through unchanged, so the histogram
 * distinguishes "not our world" from "we couldn't afford it" — the difference between the agent
 * being wrong about its scope and being right but rationed.
 */
export function decideBurden(input: BurdenInput): BurdenDecision {
  if (!input.eligible) {
    // A missing reason would be a silent silence, which is the one thing this module exists to
    // prevent. Fall back to the most structural explanation rather than to null.
    return { wouldAsk: false, objective: null, reason: input.ineligibleReason ?? 'not_microworld' };
  }
  if (!(input.globalEligibleSinceLastAsk >= BURDEN_PER_ELIGIBLE)) {
    return { wouldAsk: false, objective: null, reason: 'budget_global' };
  }
  if (!(input.doctorAsksToday < PER_DOCTOR_DAILY_CAP)) {
    return { wouldAsk: false, objective: null, reason: 'budget_doctor' };
  }
  return { wouldAsk: true, objective: 'close_snapshot', reason: WOULD_ASK_REASON };
}

/**
 * The eligibility half, kept pure and separate so the burden numbers can be tested without a
 * database and so the ORDER of the three refusals is explicit and reviewable.
 *
 * Checked most-structural-first: a note outside the microworld is `not_microworld` even if it also
 * lacks a doctor, because "we don't work here" is the truer statement.
 */
export function eligibilityOf(input: {
  microworld: 'headache' | 'none';
  doctorUid: string | null | undefined;
  engineVersion: string | null | undefined;
  currentEra: string | null;
}): { eligible: boolean; reason: SilenceReason | null } {
  if (input.microworld !== 'headache') return { eligible: false, reason: 'not_microworld' };
  if (!String(input.doctorUid ?? '').trim()) return { eligible: false, reason: 'no_doctor' };
  // A null currentEra means the era probe found nothing (no rows in 14 days, or the read failed).
  // FAIL CLOSED: with no known current era we cannot claim a row is current, so nothing is eligible.
  if (!input.currentEra || String(input.engineVersion ?? '') !== input.currentEra) {
    return { eligible: false, reason: 'stale_era' };
  }
  return { eligible: true, reason: null };
}
