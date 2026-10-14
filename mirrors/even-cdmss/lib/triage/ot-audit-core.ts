/**
 * lib/triage/ot-audit-core.ts — v0 OT note audit findings (pure, deterministic).
 *
 * Minimal rubric: documentation completeness flags shaped like OPD findings so
 * stampFindingIdentity + the Action queue card fields work unchanged. Not a full
 * clinical OT rubric — deepen later under Triage/CAT ratification.
 */

import { stampFindingIdentity, type OpdFinding } from '@/lib/opd-note-audit-core';

export const OT_ENGINE_VERSION = 'ot-note-audit/0.1';
export const OT_ENGINE_VERSIONS_CURRENT = [OT_ENGINE_VERSION] as const;

export interface OtAuditInput {
  note: string | null;
  surgery_name: string | null;
  surgeon: string | null;
}

function finding(partial: Omit<OpdFinding, 'evidence' | 'estimates' | 'citation_ids' | 'source'>): OpdFinding {
  return {
    ...partial,
    evidence: [],
    estimates: [],
    citation_ids: [],
    source: 'deterministic',
  };
}

/** Deterministic documentation findings for one OT note body. Always returns ≥1 stamped finding
 *  so a landed note can appear on the Action queue for spot-check. */
export function auditOtNote(input: OtAuditInput): OpdFinding[] {
  const raw: OpdFinding[] = [];
  const body = String(input.note ?? '').trim();
  const surgery = String(input.surgery_name ?? '').trim();
  const surgeon = String(input.surgeon ?? '').trim();

  if (!body || body.length < 80) {
    raw.push(finding({
      subject: 'Documentation completeness: OT note body is thin or empty',
      verdict: 'context-dependent',
      confidence: 0.9,
      domain: 'appropriateness',
      rationale: 'Final OT note text is missing or shorter than a minimal operative narrative.',
    }));
  }
  if (!surgery) {
    raw.push(finding({
      subject: 'Documentation completeness: surgery name missing',
      verdict: 'context-dependent',
      confidence: 0.85,
      domain: 'appropriateness',
      rationale: 'surgery_name is blank on the final OT template row.',
    }));
  }
  if (!surgeon) {
    raw.push(finding({
      subject: 'Documentation completeness: surgeon attribution missing',
      verdict: 'context-dependent',
      confidence: 0.85,
      domain: 'appropriateness',
      rationale: 'surgeon free-text is blank; cannot attribute the note for routing.',
    }));
  }
  if (!raw.length) {
    raw.push(finding({
      subject: 'OT documentation review: operative note present for triage',
      verdict: 'context-dependent',
      confidence: 0.5,
      domain: 'appropriateness',
      rationale: 'v0 lander check — note body, surgery name, and surgeon string are present. Clinical OT rubric deferred.',
    }));
  }
  return stampFindingIdentity(raw);
}
