/**
 *   node --test --import tsx lib/__tests__/direction-field.test.ts
 *
 * Phase 3a — the `direction` field (ruling R-5, register bugs 5b + 7c).
 *
 * MEASURED: 1,771 findings carry a concept_id beginning `underuse:` across 1,508 notes, and ALL
 * 1,771 carry verdict low-value — NetValue has no member meaning underuse, so underuse fell
 * through to low-value. 1,180 polluted the low-value-care count; 78 landed inside ANTIBIOTIC
 * OVERUSE, so a recommendation to prescribe MORE antibiotics was counted as overuse.
 *
 * ⚠️ The concept_id prefix is NOT trustworthy alone: bug 7c carries
 * `overuse:antibiotic therapy:antibiotic` on content recommending an antibiotic be STARTED.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  stampDirection, noAntibioticClassOnNote, type OpdFinding,
} from '../opd-note-audit-core.ts';
import { computeOpdScore, SEVERITY, PENALTY_BASE } from '../opd-note-score-core.ts';
import { stampLvcMetadata } from '../opd-lvc-classify-core.ts';
import type { DeidOpdCase, OpdMed } from '../opd-ingest-core.ts';

function mkCase(p: Partial<DeidOpdCase> = {}): DeidOpdCase {
  return {
    consultType: null, reasonForConsult: null, presentingComplaints: [], diagnosisCodes: [],
    impressionCodes: [], impressions: [], history: [], comorbidities: [], medications: [],
    investigations: [], advice: [], examination: [], allergies: null, followUpType: null, followUpDateSet: false, ...p,
  };
}
function mkFinding(p: Partial<OpdFinding> & { concept_id?: string }): OpdFinding {
  return {
    subject: 'x', verdict: 'low-value', confidence: 0.9, domain: 'appropriateness',
    rationale: '', evidence: [], estimates: [], citation_ids: [], source: 'llm', ...p,
  } as OpdFinding;
}
const ABX_NOTE = mkCase({ medications: [{ brand: 'Augmentin 625', generic: 'Amoxicillin + Clavulanate', therapeuticClass: 'Antibiotic' } as OpdMed] });
const NO_ABX_NOTE = mkCase({ medications: [{ brand: 'Dolo 650', generic: 'Paracetamol', therapeuticClass: 'Analgesic' } as OpdMed] });

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · The three ordered checks
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§4.1 CHECK 1: the prefix alone does NOT set direction when class-absence objects', () => {
  // "overuse:" on a note carrying no antibiotic class — the prefix says overuse, the structure says
  // there is nothing to over-use.
  const f = mkFinding({
    subject: 'Unindicated antibiotic prescription',
    rationale: 'Antibiotics are not indicated for a viral URTI.',
    concept_id: 'overuse:rx:antibiotic',
  });
  const out = stampDirection([f], NO_ABX_NOTE);
  assert.equal(out[0].direction, undefined, 'no direction may be claimed on an absent class');
});

test('with no objection, the prefix sets direction — both values', () => {
  const under = mkFinding({ subject: 'Consider systemic therapy', concept_id: 'underuse:systemic therapy:consideration' });
  assert.equal(stampDirection([under], NO_ABX_NOTE)[0].direction, 'underuse');
  const over = mkFinding({ subject: 'Duplicate PPI therapy', rationale: 'Two proton-pump inhibitors prescribed.', concept_id: 'overuse:rx:ppi' });
  assert.equal(stampDirection([over], ABX_NOTE)[0].direction, 'overuse');
});

test('an absent/blank/foreign concept_id yields NO direction — undetermined is the honest default', () => {
  for (const concept_id of [undefined, '', 'something-else', 'lvc:antibiotic']) {
    assert.equal(stampDirection([mkFinding({ concept_id })], ABX_NOTE)[0].direction, undefined);
  }
});

test('deterministic findings are never stamped', () => {
  const det = mkFinding({ source: 'deterministic', concept_id: 'underuse:x:y' });
  assert.equal(stampDirection([det], NO_ABX_NOTE)[0].direction, undefined);
});

test('the class-absence predicate has ONE implementation', () => {
  assert.equal(noAntibioticClassOnNote(NO_ABX_NOTE), true);
  assert.equal(noAntibioticClassOnNote(ABX_NOTE), false);
  assert.equal(noAntibioticClassOnNote(mkCase({ medications: [] })), true, 'zero meds satisfies it');
  const core = readFileSync('lib/opd-note-audit-core.ts', 'utf8');
  assert.ok(core.includes('const classAbsent = noAntibioticClassOnNote(c);'),
    'stampDirection reuses the extracted predicate rather than a second copy');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · Scoring — underuse contributes ZERO
// ═════════════════════════════════════════════════════════════════════════════════════════════

const scoreWith = (findings: { verdict: 'low-value'; confidence: number; domain: 'appropriateness'; direction?: 'overuse' | 'underuse' }[]) =>
  computeOpdScore({ findings, completenessCoverage: 1, pdqi9: null, patientCentred: { present: 1, total: 1 } });

test('§4.3: an underuse finding scores IDENTICALLY to a note with no finding at all', () => {
  const none = scoreWith([]);
  const underuse = scoreWith([{ verdict: 'low-value', confidence: 1.0, domain: 'appropriateness', direction: 'underuse' }]);
  assert.equal(underuse.headline, none.headline);
  assert.equal(underuse.domains.find((d) => d.domain === 'appropriateness')!.score,
               none.domains.find((d) => d.domain === 'appropriateness')!.score);
});

test('…while the SAME finding marked overuse (or unmarked) still penalises — the control', () => {
  const none = scoreWith([]);
  for (const direction of ['overuse', undefined] as const) {
    const scored = scoreWith([{ verdict: 'low-value', confidence: 1.0, domain: 'appropriateness', direction }]);
    assert.ok(scored.headline < none.headline, `direction=${direction} must still penalise`);
  }
});

test('§4.4: SEVERITY and PENALTY_BASE are BYTE-IDENTICAL — no new member, no re-weighting', () => {
  assert.equal(PENALTY_BASE, 45);
  assert.deepEqual(SEVERITY, { 'low-value': 1.0, 'context-dependent': 0.5, uncertain: 0.2, 'high-value': 0 });
  const core = readFileSync('lib/opd-note-score-core.ts', 'utf8');
  assert.ok(core.includes("export const SEVERITY: Record<NetValue, number> = { 'low-value': 1.0, 'context-dependent': 0.5, uncertain: 0.2, 'high-value': 0 };"));
  // the early return is at the TOP of findingPenalty, not a SEVERITY branch
  assert.ok(core.includes(`function findingPenalty(f: { verdict: NetValue; confidence: number; direction?: string }): number {`));
  assert.ok(core.includes(`  if (f.direction === 'underuse') return 0;`));
});

test('NetValue is untouched — no member meaning underuse was added', () => {
  // NetValue is declared in doc-audit-core and re-exported through value-score-core.
  const vs = readFileSync('lib/doc-audit-core.ts', 'utf8');
  const m = vs.match(/export type NetValue =[^;]+;/);
  assert.ok(m, 'NetValue is declared in doc-audit-core');
  assert.ok(!/underuse/i.test(m![0]), 'direction is a SEPARATE field — NetValue feeds scoring and stays closed');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · The taxonomy gate
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§4.5: an underuse finding receives NO lvc_category', () => {
  const under = mkFinding({ subject: 'Consider antibiotic therapy', rationale: 'Antibiotic may be warranted for the febrile pilonidal sinus.', direction: 'underuse' } as never);
  // The engine gates BEFORE calling stampLvcMetadata; proving the gate is in finalize, not here:
  const src = readFileSync('lib/opd-note-audit.ts', 'utf8');
  assert.ok(src.includes("out = out.map((f, i) => {"), 'the 1:1 gate map');
  assert.ok(src.includes("if (f.direction !== 'underuse') return stamped[i];"), 'underuse skips the stamp');
  // …and the stamper itself would otherwise have categorised it (the control):
  const stamped = stampLvcMetadata([under], []);
  assert.ok(stamped[0].lvc_category, 'unGATED, the stamper does assign a category — hence the gate');
});

test('§4.5: an underuse finding does not keep signal_type low_value_care', () => {
  // A-4 renamed the branch's binding f → rest (the lvc_category strip destructure); the semantic
  // claim pinned here is unchanged.
  const src = readFileSync('lib/opd-note-audit.ts', 'utf8');
  assert.ok(src.includes("return rest.signal_type === 'low_value_care'"), 'the collapse is undone for underuse');
  assert.ok(src.includes("? { ...rest, signal_type: opdSignalType(rest.subject, rest.domain, { verdict: rest.verdict }) }"),
    'restored with the SAME pure function the stamper used — never an invented label');
});

test('§4.6 THE REGRESSION THAT MATTERS: an OVERUSE finding is stamped exactly as before', () => {
  const over = mkFinding({ subject: 'Unnecessary antibiotic for viral URTI', rationale: 'Azithromycin prescribed for a viral illness.', direction: 'overuse' } as never);
  const stamped = stampLvcMetadata([over], []);
  assert.equal(stamped[0].lvc_category, 'antibiotic', 'overuse still categorises');
  // and the gate lets it through untouched
  const src = readFileSync('lib/opd-note-audit.ts', 'utf8');
  assert.ok(src.includes("if (f.direction !== 'underuse') return stamped[i];"));
});

test('finding ORDER is preserved by the gate — the report numbers findings by position', () => {
  const src = readFileSync('lib/opd-note-audit.ts', 'utf8');
  assert.ok(src.includes('const stamped = stampLvcMetadata(out, lvcRules);'), '1:1 map, not filter+concat');
  assert.ok(!src.includes('.concat(underuse'), 'no reordering');
});

test('direction is stamped BEFORE stampLvcMetadata', () => {
  const src = readFileSync('lib/opd-note-audit.ts', 'utf8');
  const dirIdx = src.indexOf('out = stampDirection(out, oc);');
  const lvcIdx = src.indexOf('const stamped = stampLvcMetadata(out, lvcRules);');
  assert.ok(dirIdx > 0 && dirIdx < lvcIdx, 'before the LVC stamp (the gate keys on direction)');
});

test('the contradicted-by-structure neutraliser is GONE (0.81.19) and CODING_GAP_RE is byte-identical', () => {
  const core = readFileSync('lib/opd-note-audit-core.ts', 'utf8');
  const orch = readFileSync('lib/opd-note-audit.ts', 'utf8');
  assert.ok(!core.includes('function neutralizeContradictedByStructure'), 'the function is deleted');
  assert.ok(!orch.includes('neutralizeContradictedByStructure'), 'no call site remains');
  for (const s of ['contradicted_medication_present', 'contradicted_investigation_absent',
    'contradicted_drug_class_absent', 'contradicted_route', 'contradicted_indication_present',
    'contradicted_history', 'contradicted_ratified_rule', 'incoherent_with_suggestion']) {
    assert.ok(!core.includes(`signal_type: '${s}'`), `nothing may set ${s} any more — stored rows only`);
  }
  assert.ok(core.includes(String.raw`const CODING_GAP_RE = /(?:missing|absent|no|add|assign|map|include)[^.]*\bicd(?:[- ]?10)?\b|\bicd(?:[- ]?10)?\b[^.]*(?:code|mapping|missing|absent)|coding (?:gap|completeness|error|omission)|\bcode (?:is )?(?:not )?(?:documented|assigned|mapped|present)|should be coded|uncoded diagnosis/i;`));
});
