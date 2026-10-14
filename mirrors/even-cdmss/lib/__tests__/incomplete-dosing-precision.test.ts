/**
 *   node --test --import tsx lib/__tests__/incomplete-dosing-precision.test.ts
 *
 * INCOMPLETE-DOSING-PRECISION PRD v1.0 (2 Aug 2026, V ruled DEC-1/2/3) — gap-level exemptions.
 *
 * incomplete_dosing is the worst-performing signal doctors actually see: precision 0.22 at 0.81.8,
 * and 14 of the 23 findings ever triaged were CONTESTED. Twelve of those fourteen are a combination
 * product or a topical. For a combination the product fixes each component's strength; for a cream
 * the strength and route ARE the dosage form.
 *
 * DEC-1: drop the GAP, never the finding — a combination that also lacks frequency still fires.
 * DEC-2: a combination the formulary cannot resolve still gets the strength gap.
 * DEC-3: dosageForm comes from the FORMULARY ROW, and only 'topical'/'drops' qualify.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prescribingChecks } from '../opd-note-audit-core.ts';
import type { DeidOpdCase, OpdMed } from '../opd-ingest-core.ts';

const mkCase = (meds: OpdMed[]): DeidOpdCase => ({
  consultType: null, reasonForConsult: null, presentingComplaints: [], diagnosisCodes: [],
  impressionCodes: [], impressions: [], history: [], comorbidities: [], medications: meds,
  investigations: [], advice: [], examination: [], allergies: null, followUpType: null, followUpDateSet: false,
});
/** A line that resolved in the formulary: nonFormulary undefined. Fields omitted = missing. */
const med = (o: Partial<OpdMed>): OpdMed => ({ ...o } as OpdMed);
/** The incomplete_dosing finding for a single-med case, or null. */
function dosingFinding(m: OpdMed): { subject: string; rationale: string } | null {
  const f = prescribingChecks(mkCase([m])).find((x) => /^Incomplete dosing: /.test(x.subject));
  return f ? { subject: f.subject, rationale: f.rationale || '' } : null;
}
/** The parsed missing-field list, in emitted order — the same string severity-tier-core reads. */
function gapsOf(m: OpdMed): string[] | null {
  const f = dosingFinding(m);
  if (!f) return null;
  const mm = f.rationale.match(/^Missing ([^—]+?)\s*—/);
  assert.ok(mm, `rationale did not parse: ${f.rationale}`);
  return mm![1].split(',').map((s) => s.trim());
}

// A COMPLETE line — every field present. Each case below removes exactly what it names.
const COMPLETE = { frequency: 'TDS', duration: '5 days', route: 'oral', strength: '500 mg' };

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · Rule 1 — formulary-resolved combinations (DEC-1, DEC-2)
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('a formulary-resolved combination missing ONLY strength → NO finding', () => {
  assert.equal(dosingFinding(med({
    resolvedGeneric: 'Diclofenac+Paracetamol', frequency: 'TDS', duration: '5 days', route: 'oral',
  })), null, 'the product fixes each component strength — not a documentation gap');
});

test('a formulary-resolved combination missing strength AND frequency → finding, gaps list frequency ONLY', () => {
  assert.deepEqual(gapsOf(med({
    resolvedGeneric: 'Diclofenac+Paracetamol', duration: '5 days', route: 'oral',
  })), ['frequency'], 'DEC-1: the gap is dropped, the finding is not');
});

test('a combination with nonFormulary set → finding, strength gap STILL present (DEC-2)', () => {
  const gaps = gapsOf(med({
    resolvedGeneric: 'Someacid+Otheracid', nonFormulary: 'non-formulary',
    frequency: 'TDS', duration: '5 days', route: 'oral',
  }));
  assert.deepEqual(gaps, ['dose/strength'], 'we cannot confirm what is in a product the formulary does not know');
});

test('a single-molecule drug missing strength → finding, unchanged', () => {
  assert.deepEqual(gapsOf(med({
    resolvedGeneric: 'Thyroxine', frequency: 'OD', duration: '30 days', route: 'oral',
  })), ['dose/strength'], 'thyroxine strength genuinely varies — PRD §5 keeps it firing');
});

test('the combination exemption needs BOTH conditions — a "+" alone is not enough', () => {
  // nonFormulary set ⇒ no exemption (above). Here: resolved, but no '+' ⇒ no exemption.
  assert.deepEqual(gapsOf(med({ resolvedGeneric: 'Paracetamol', frequency: 'TDS', duration: '5 days', route: 'oral' })),
    ['dose/strength']);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · Rule 2 — topicals and drops (DEC-3)
// ═════════════════════════════════════════════════════════════════════════════════════════════

test("dosageForm 'topical' missing strength AND route → NO finding", () => {
  assert.equal(dosingFinding(med({
    resolvedGeneric: 'Clotrimazole', dosageForm: 'topical', frequency: 'BD', duration: '14 days',
  })), null, 'strength and route are inherent in the form');
});

test("dosageForm 'topical' missing duration → finding, duration ONLY", () => {
  assert.deepEqual(gapsOf(med({
    resolvedGeneric: 'Clotrimazole', dosageForm: 'topical', frequency: 'BD',
  })), ['duration']);
});

test("dosageForm 'drops' behaves exactly like topical", () => {
  assert.equal(dosingFinding(med({
    resolvedGeneric: 'Moxifloxacin', dosageForm: 'drops', frequency: 'QID', duration: '7 days',
  })), null);
  assert.deepEqual(gapsOf(med({ resolvedGeneric: 'Moxifloxacin', dosageForm: 'drops', frequency: 'QID' })), ['duration']);
});

test("dosageForm 'inhaler' and 'injection' are UNCHANGED — strength and route still gap", () => {
  for (const form of ['inhaler', 'injection'] as const) {
    const gaps = gapsOf(med({ resolvedGeneric: 'Budesonide', dosageForm: form, frequency: 'BD', duration: '30 days' }));
    assert.ok(gaps, `${form} must still fire`);
    assert.ok(gaps!.includes('dose/strength'), `${form}: strength must still gap — variable strengths`);
  }
  // …and a form whose route cannot be inferred still gaps route.
  const gaps = gapsOf(med({ resolvedGeneric: 'Somedrug', dosageForm: 'injection', frequency: 'BD', duration: '3 days' }));
  assert.ok(gaps!.includes('route'), 'route is still a real gap outside topical/drops');
});

test("the other four DosageForm members are untouched: tablet, capsule, syrup, other", () => {
  for (const form of ['tablet', 'capsule', 'syrup', 'other'] as const) {
    const gaps = gapsOf(med({ resolvedGeneric: 'Somedrug', dosageForm: form, frequency: 'BD', duration: '3 days' }));
    assert.ok(gaps?.includes('dose/strength'), `${form}: strength must still gap`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · Rule 3 — everything else unchanged
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('a complete line emits nothing, before and after', () => {
  assert.equal(dosingFinding(med({ resolvedGeneric: 'Paracetamol', ...COMPLETE })), null);
  assert.equal(dosingFinding(med({ resolvedGeneric: 'Diclofenac+Paracetamol', ...COMPLETE })), null);
});

test('the existing isDoseExempt cases behave exactly as before — wholesale suppression intact', () => {
  // nutraceutical / cosmetic by nonFormulary tag
  assert.equal(dosingFinding(med({ resolvedGeneric: 'Multivitamin', nonFormulary: 'nutraceutical-cosmetic' })), null);
  // nutraceutical by therapeutic class
  assert.equal(dosingFinding(med({ resolvedGeneric: 'Some Blend', therapeuticClass: 'Nutraceutical' })), null);
  // cosmetic by name
  assert.equal(dosingFinding(med({ resolvedGeneric: 'Gentle Face Wash' })), null);
  // UNRESOLVED proprietary line (no gen at all) — suppressed wholesale, and surfaced elsewhere
  assert.equal(dosingFinding(med({ brand: 'ZZZOTONIC' })), null);
  // …and that unresolved line still produces its OWN unverified-brand finding (not swallowed here)
  const fs = prescribingChecks(mkCase([med({ brand: 'ZZZOTONIC' })]));
  assert.ok(fs.some((f) => /^Unverified brand: /.test(f.subject)), 'the other check is unaffected');
});

test('the rationale wording is byte-identical — only the gap list inside it changes', () => {
  const f = dosingFinding(med({ resolvedGeneric: 'Thyroxine', frequency: 'OD', duration: '30 days', route: 'oral' }));
  assert.equal(f!.rationale,
    'Missing dose/strength — incomplete prescription (strength read from the drug name and route inferred from the dosage form where possible).');
});

test('the emitted rationale still parses for severity-tier-core (the tier keys on this string)', () => {
  // tier 3 = only dose/strength and/or duration; tier 2 = anything that changes what the patient does.
  assert.deepEqual(gapsOf(med({ resolvedGeneric: 'Clotrimazole', dosageForm: 'topical', frequency: 'BD' })), ['duration']);
  assert.deepEqual(gapsOf(med({ resolvedGeneric: 'Diclofenac+Paracetamol', duration: '5 days', route: 'oral' })), ['frequency']);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · The four real contested subjects (MEASURED, PRD §3.1) — none may produce a strength gap
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the four contested subjects produce NO strength gap', () => {
  const cases: [string, OpdMed][] = [
    ['Chlorzoxazone+Diclofenac Sodium+Paracetamol', med({ resolvedGeneric: 'Chlorzoxazone+Diclofenac Sodium+Paracetamol', frequency: 'TDS', duration: '5 days', route: 'oral' })],
    ['Ferrous Ascorbate+Folic Acid', med({ resolvedGeneric: 'Ferrous Ascorbate+Folic Acid', frequency: 'OD', duration: '30 days', route: 'oral' })],
    ['Diclofenac+Paracetamol', med({ resolvedGeneric: 'Diclofenac+Paracetamol', frequency: 'TDS', duration: '5 days', route: 'oral' })],
    ['Clotrimazole (topical)', med({ resolvedGeneric: 'Clotrimazole', dosageForm: 'topical', frequency: 'BD', duration: '14 days' })],
  ];
  for (const [label, m] of cases) {
    const gaps = gapsOf(m);
    assert.ok(!gaps?.includes('dose/strength'), `${label}: strength must NOT gap — this is a contested row`);
    assert.equal(dosingFinding(m), null, `${label}: with every other field present, nothing fires at all`);
  }
});

test('…but each of the four still fires when a REAL gap is present (DEC-1)', () => {
  // Same four lines, frequency removed. The exemption is gap-level, never finding-level.
  assert.deepEqual(gapsOf(med({ resolvedGeneric: 'Chlorzoxazone+Diclofenac Sodium+Paracetamol', duration: '5 days', route: 'oral' })), ['frequency']);
  assert.deepEqual(gapsOf(med({ resolvedGeneric: 'Ferrous Ascorbate+Folic Acid', duration: '30 days', route: 'oral' })), ['frequency']);
  assert.deepEqual(gapsOf(med({ resolvedGeneric: 'Diclofenac+Paracetamol', duration: '5 days', route: 'oral' })), ['frequency']);
  assert.deepEqual(gapsOf(med({ resolvedGeneric: 'Clotrimazole', dosageForm: 'topical', duration: '14 days' })), ['frequency']);
});

test('a topical combination gets BOTH exemptions and still fires on frequency', () => {
  // Tretinoin 0.025% + Azelaic acid 10% — contested, a combination AND a topical.
  assert.equal(dosingFinding(med({
    resolvedGeneric: 'Tretinoin+Azelaic Acid', dosageForm: 'topical', frequency: 'HS', duration: '30 days',
  })), null);
  assert.deepEqual(gapsOf(med({ resolvedGeneric: 'Tretinoin+Azelaic Acid', dosageForm: 'topical', duration: '30 days' })), ['frequency']);
});
