/**
 * app/api/admin/rule-governance/propose-pattern/route.ts — R3-A §3.7: the pattern → proposal
 * bridge. ADMIN ROUTE ONLY (S7): there is no Promote control on the LVP shelf and no admin page in
 * this unit. DORMANT — behind LVC_RULE_GOVERNANCE_ENABLED === '1', which ships UNSET.
 *
 * IT DOES NOT RUN ITSELF. No cron, no build hook, no deploy step.
 *
 * WHAT IT DOES. Takes one `lvp_pattern_id` plus the full evidence tuple, VERIFIES the pattern
 * against the SERVER-COMPUTED current Suggested set (loadShelf(), never a client-supplied card),
 * FREEZES the shelf reading — including the S8 provenance bit and the three shelf constants in
 * force — and writes a proposal row, an immutable rule version and a rule_pattern_map row in ONE
 * statement (O2).
 *
 * WHAT IT DOES NOT DO (§3.7, S4): it creates NO activation event and NO lvc_recommendations row.
 * It does not run ensureRuleGovernanceTables() — that belongs to the migrate route alone (kickoff
 * §6 trap 3). It touches nothing on the shelf: loadShelf() is a pure read and lvp_hidden is not
 * written. Hide stays cosmetic; an lvp_pattern_id never becomes a rule_ref.
 *
 * WHY THE EVIDENCE MUST BE FROZEN. The Suggested shelf is computed on read over a MOVING
 * seven-day IST window, and hide filtering happens BEFORE the floor and the cap
 * (lib/lvp-store.ts:160-185). Nothing about a card is reproducible tomorrow. The snapshot
 * therefore records the reading AND the constants that produced it — LVP_FLOOR, LVP_CAP and
 * LVP_NON_OVERUSE_CAP, which changed on 20 Aug 2026 when Addendum B split one cap into a
 * per-block pair, so a snapshot omitting them cannot be replayed.
 *
 * FLAG BEFORE AUTH. requireAdmin() fails OPEN when ADMIN_TOKEN is unset (lib/admin-gate.ts:6), so
 * the flag is what genuinely fails closed (kickoff §6 trap 5, acceptance 6).
 */
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { requireAdmin } from '@/lib/admin-gate';
import { LVP_CAP, LVP_FLOOR, LVP_NON_OVERUSE_CAP } from '@/lib/lvp-core';
import { loadShelf } from '@/lib/lvp-store';
import {
  asEvidence, missingSnapshotKeys, validateEvidence,
  type PatternEvidenceSnapshot,
} from '@/lib/rule-governance-core';
import {
  mintRuleRef, proposePatternAsRule, ruleGovernanceEnabled, slotsProvenanceFor,
} from '@/lib/rule-governance-store';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  if (!ruleGovernanceEnabled()) return NextResponse.json({ ok: false, error: 'disabled' }, { status: 404 });
  if (!(await isAdminUnlocked())) { const denied = requireAdmin(req); if (denied) return denied; }

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ ok: false, error: 'body must be a JSON object' }, { status: 400 });
  }

  const patternId = typeof body.lvp_pattern_id === 'string' ? body.lvp_pattern_id.trim() : '';
  if (!patternId) {
    return NextResponse.json({ ok: false, error: 'lvp_pattern_id: required' }, { status: 400 });
  }

  // The evidence tuple may arrive nested under `evidence` or flat beside lvp_pattern_id.
  const rawEvidence = (body.evidence && typeof body.evidence === 'object') ? body.evidence : body;
  const problems = validateEvidence(rawEvidence);
  if (problems.length) {
    return NextResponse.json({ ok: false, error: 'invalid evidence', problems }, { status: 400 });
  }
  const evidence = asEvidence(rawEvidence);

  // ── verification against the SERVER-COMPUTED current Suggested set (§3.7) ──────────────────────
  // A client-supplied card is not evidence. If the shelf cannot be read we refuse rather than
  // proceed unverified — the same fail-closed posture F14's mandatory dedup gate takes.
  let card;
  try {
    const shelf = await loadShelf();
    card = shelf.suggested.find((s) => s.pattern_id === patternId);
    if (!card) {
      const hidden = shelf.hidden.some((h) => h.pattern_id === patternId);
      return NextResponse.json({
        ok: false,
        error: hidden
          ? 'pattern is HIDDEN — it is not in the current Suggested set'
          : 'pattern is not in the current server-computed Suggested set (below the floor, outside the block cap, or absent from this week)',
        lvp_pattern_id: patternId,
        suggested_now: shelf.suggested.length,
      }, { status: 409 });
    }
  } catch {
    return NextResponse.json({
      ok: false, error: 'cannot read the Suggested shelf to verify the pattern — refusing to propose unverified',
    }, { status: 503 });
  }

  // ── freeze the evidence (§3.7, S8) ────────────────────────────────────────────────────────────
  // slots_provenance is re-asked with the SAME predicate loadShelf() uses and discards: does
  // lvc_concepts hold this concept_id. The shelf module is on the untouched list, so the bit is
  // recomputed here rather than surfaced by editing lib/lvp-store.ts.
  const slots_provenance = await slotsProvenanceFor(card.concept_id);

  const snapshot: PatternEvidenceSnapshot = {
    pattern_id: card.pattern_id,
    concept_id: card.concept_id,
    volume_week: card.volume_week,
    doctor_count: card.doctor_count,
    direction: card.direction,
    action: card.action,
    target: card.target,
    slots_provenance,
    first_seen: card.first_seen,
    examples: card.examples,
    generated_at: card.generated_at,
    model: card.model,
    lvp_floor: LVP_FLOOR,
    lvp_cap: LVP_CAP,
    lvp_non_overuse_cap: LVP_NON_OVERUSE_CAP,
  };
  const missing = missingSnapshotKeys(snapshot as unknown as Record<string, unknown>);
  if (missing.length) {
    return NextResponse.json({ ok: false, error: 'incomplete evidence snapshot', missing }, { status: 500 });
  }

  // ── the single-statement write (O2) ───────────────────────────────────────────────────────────
  // keywords is DELIBERATELY EMPTY: the shelf carries volume evidence, not matcher evidence, and
  // `target` is a display string. A proposal-origin version row freezes what is known, and what is
  // known about a shelf pattern does not include how a matcher should fire on it. The executable
  // definition is written when the rule is actually drafted, not here.
  const ruleRef = mintRuleRef();
  try {
    const result = await proposePatternAsRule({
      ruleRef,
      statement: `Proposed from the low-value patterns shelf: ${card.title} (concept ${card.concept_id}).`,
      precondition: null,
      rationale_text: card.why,
      evidence_note: `Frozen shelf reading of ${card.pattern_id} at ${card.generated_at}: ${card.volume_week} findings this week, slots from ${slots_provenance}, shelf constants floor ${LVP_FLOOR} / overuse cap ${LVP_CAP} / non-overuse cap ${LVP_NON_OVERUSE_CAP}.`,
      category: null,
      action_type: card.action || null,
      keywords: [],
      lvpPatternId: card.pattern_id,
      snapshot,
      evidence,
    });
    if (!result.written) {
      return NextResponse.json({
        ok: false,
        error: 'an identical pending proposal already exists — nothing was written',
        lvp_pattern_id: patternId,
      }, { status: 409 });
    }
    return NextResponse.json({
      ok: true,
      proposal_id: result.proposal_id,
      rule_ref: result.rule_ref,
      definition_hash: result.definition_hash,
      map_id: result.map_id,
      activation_events_created: 0,
      lvc_recommendations_rows_written: 0,
      snapshot,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
