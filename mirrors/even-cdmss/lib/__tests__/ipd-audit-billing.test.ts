// lib/__tests__/ipd-audit-billing.test.ts — S7 billing-panel invariants.
//
// 1. PHI: kx_billing_records carries patient_name/uhid/age/address/telecom/email. The billing
//    reader must select the ENVELOPE ONLY — a source assertion, because the guarantee is about
//    what the SQL names, which no unit test of the return value could catch.
// 2. SEMANTICS: money is not a verdict. The ₹ panel never renders from the A–E scored-band
//    palette (the sibling line to architecture-advisory-no-band-visuals / ipd-audit-surface).
// 3. RECONCILIATION is coarse and conservative: only an explicit 'missing' NABH field is a gap,
//    facility/admin ₹ is never reconciled, and 'na'/absent assert nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reconcile, documentedFrom, moleculeOf, matchFlaggedToBill, isClinicalCategory, type BillingCategory } from '../ipd-audit/billing';
import type { AuditReport, AuditFinding, FieldStatus } from '../doc-audit-core';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

/** Strip comments before asserting on source: these rules are about what the CODE does, and both
 *  files legitimately NAME the forbidden things in the header comment that documents the rule. */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const cat = (category: string, net: number, lines = 1): BillingCategory =>
  ({ category, net, lines, clinical: isClinicalCategory(category) });

const reportWith = (fields: Record<string, FieldStatus>): AuditReport =>
  ({
    completeness: {
      items: Object.entries(fields).map(([key, status]) => ({
        key, label: key, section: 's', ref: 'r', status, mandatory: true,
      })),
      coverage: 0.8, mandatoryTotal: 1, mandatoryMet: 1, missingMandatory: [],
    },
  } as unknown as AuditReport);

test('PHI: the billing reader never names a PHI column from kx_billing_records', () => {
  const src = code('lib/ipd-audit/billing.ts');
  // the table's real PHI columns (probed 17-Jul-2026) — none may appear in any SELECT here
  for (const col of ['patient_name', 'uhid', 'age', 'gender', 'address_details', 'telecom',
    'primary_email_address', 'secondary_email_address', 'employee_name', 'nationality']) {
    assert.ok(!new RegExp(`\\b${col}\\b`).test(src), `billing.ts must not select '${col}'`);
  }
  // and it must be scoped to IP lines for the admission it was asked about
  assert.ok(src.includes("patient_type='IP'"), 'billing reads are scoped to IP lines');
});

test('semantics: the ₹ panel never touches the scored-band palette', () => {
  const src = code('app/admin/ipd-audit/[id]/billing-panel.tsx');
  assert.ok(!/bandColor|scoreColor/.test(src), 'billing-panel.tsx must not use bandColor/scoreColor');
  // stronger than the name check: the A–E palette module is never imported here at all
  assert.ok(!src.includes('opd-audit-ui'), 'the ₹ panel does not import the scored-band palette module');
  // money is not a verdict: the only band on this panel is the PEER band
  assert.ok(src.includes('PeerBand') && !/scored|A–E/.test(src), 'the panel bands peers, not scores');
});

test('recon: a billed clinical category whose NABH field is missing is a gap', () => {
  const r = reconcile(
    [cat('Pharmacy', 37842, 99), cat('Room Rent', 20475, 3)],
    documentedFrom(reportWith({ medications_administered: 'missing' })),
  );
  assert.equal(r.billedNotDocumented.length, 1);
  assert.equal(r.billedNotDocumented[0].category, 'Pharmacy');
  assert.equal(r.billedNotDocumented[0].evidence, 'medications');
  // facility ₹ is shown but never reconciled — a room-rent line is not a documentation failure
  assert.equal(r.facilityNet, 20475);
  assert.equal(r.reconciledCategories, 1);
});

test('recon: present/partial/na/absent are NOT gaps — only an explicit missing is', () => {
  for (const status of ['present', 'partial', 'na'] as FieldStatus[]) {
    const r = reconcile([cat('Pharmacy', 100)], documentedFrom(reportWith({ medications_administered: status })));
    assert.equal(r.billedNotDocumented.length, 0, `status '${status}' must not raise a gap`);
  }
  // an absent field asserts nothing at all
  const r = reconcile([cat('Pharmacy', 100)], documentedFrom(reportWith({})));
  assert.equal(r.billedNotDocumented.length, 0, 'an absent completeness field raises no gap');
});

test('recon: documented-but-not-billed is the other direction, at the same coarseness', () => {
  const r = reconcile([cat('Room Rent', 5000)], documentedFrom(reportWith({
    medications_administered: 'present', investigations: 'present',
  })));
  const evidence = r.documentedNotBilled.map((d) => d.evidence).sort();
  assert.deepEqual(evidence, ['investigations', 'medications']);
  // and it names the categories that WOULD have carried the ₹
  const meds = r.documentedNotBilled.find((d) => d.evidence === 'medications')!;
  assert.deepEqual(meds.categories, ['Pharmacy']);
});

test('recon: a PACKAGE-billed admission suppresses documented-but-not-billed (bundling artefact)', () => {
  // 32% of IP admissions (468/1,475) bundle the stay into one IP Package line, and only 18 of
  // those also carry separate pathology lines — so firing on the missing category line would be
  // noise on ~96% of packaged admissions, not a finding.
  const packaged = reconcile([cat('IP Package', 110_000)], documentedFrom(reportWith({
    medications_administered: 'present', investigations: 'present', procedures_performed: 'present',
  })));
  assert.equal(packaged.packaged, true);
  assert.equal(packaged.documentedNotBilled.length, 0, 'a bundled bill proves nothing by omission');

  // the same bill WITHOUT the package line does raise the question
  const itemised = reconcile([cat('Room Rent', 110_000)], documentedFrom(reportWith({
    medications_administered: 'present', investigations: 'present', procedures_performed: 'present',
  })));
  assert.equal(itemised.packaged, false);
  assert.equal(itemised.documentedNotBilled.length, 3);

  // …and the other direction still works on a packaged bill: it turns on the summary's own
  // missing NABH field, not on the bill's shape
  const gap = reconcile([cat('IP Package', 110_000), cat('Pharmacy', 9_289, 60)],
    documentedFrom(reportWith({ medications_administered: 'missing' })));
  assert.equal(gap.billedNotDocumented.length, 1, 'billed-not-documented is unaffected by bundling');
});

test('recon: a documented kind of care that IS billed raises nothing in either direction', () => {
  const r = reconcile(
    [cat('Pharmacy', 100), cat('Pathology', 200), cat('Surgery', 90_000)],
    documentedFrom(reportWith({
      medications_administered: 'present', investigations: 'present', procedures_performed: 'present',
    })),
  );
  assert.equal(r.billedNotDocumented.length, 0);
  assert.equal(r.documentedNotBilled.length, 0);
});

test('bill match: only POSITIVE matches are asserted — by molecule or by drug class', () => {
  const findings = [
    { subject: 'Piperacillin-Tazobactam', verdict: 'low-value' },
    { subject: 'Post-operative Antibiotic Course', verdict: 'low-value' },
    { subject: 'Length of Inpatient Stay', verdict: 'context-dependent' },
    { subject: 'documentation gap', verdict: 'appropriate' },
  ] as AuditFinding[];
  const items = ["PIPERACILLIN+TAZOBACTAM-INJECTION-4MG+500MG-TAZACT 4.5GM INJ-1's", "GLOVE-.-35M-MEDICAL EXAMINATION GLOVES-1's"];
  const notes = matchFlaggedToBill(findings, items, ['ANTIBIOTIC/CEPHALOSPORIN']);

  assert.equal(notes.length, 3, 'only low-value/context-dependent findings are considered');
  const byMolecule = notes.find((s) => s.subject === 'Piperacillin-Tazobactam')!;
  assert.equal(byMolecule.billed, true);
  assert.equal(byMolecule.via, 'molecule');

  // the class axis is what bridges 'Post-operative Antibiotic Course' → the billed molecule
  const byClass = notes.find((s) => s.subject === 'Post-operative Antibiotic Course')!;
  assert.equal(byClass.billed, true);
  assert.equal(byClass.via, 'class');

  // …and an unmatchable theme is UNDETERMINED, never "not billed"
  const unknown = notes.find((s) => s.subject === 'Length of Inpatient Stay')!;
  assert.equal(unknown.billed, false);
  assert.equal(unknown.via, undefined, 'no match ⇒ no claimed evidence either way');
});

test('bill match: the panel never asserts the negative (the measured false-"script?" trap)', () => {
  // A naive molecule matcher called 479/497 real flags 'script?' — asserting "no ₹" for drugs that
  // were plainly billed, because findings name classes and the bill names molecules. The UI must
  // therefore render POSITIVES only and describe the remainder as undetermined.
  const src = code('app/admin/ipd-audit/[id]/billing-panel.tsx');
  assert.ok(!/script\?/.test(src), 'the panel never labels an unmatched flag a discharge script');
  assert.ok(src.includes('undetermined'), 'unmatched flags are reported as undetermined');
  assert.ok(/matched\.map/.test(src), 'only matched (positive) flags get a chip');
});

test('moleculeOf: db13 pharmacy item names are MOLECULE-FORM-STRENGTH-BRAND-PACK', () => {
  assert.equal(moleculeOf("PIPERACILLIN+TAZOBACTAM-INJECTION-4MG+500MG-TAZACT 4.5GM INJ-1's"), 'piperacillin+tazobactam');
  assert.equal(moleculeOf("PARACETAMOL-INJECTION-100ML-NEOMOL 100ML IV-1's"), 'paracetamol');
});

test('categories: the clinical/facility split is the reconciliation boundary', () => {
  for (const c of ['Pharmacy', 'Pathology', 'Radiology', 'Surgery', 'Procedure', 'Cardiology']) {
    assert.ok(isClinicalCategory(c), `${c} is reconcilable against the summary`);
  }
  // db13's `billing_category` is the BED CLASS, not a service category — these are service_types
  for (const c of ['Room Rent', 'Administration', 'IP Consultation', 'Equipment', 'IP Package', 'Professional Charges']) {
    assert.ok(!isClinicalCategory(c), `${c} is facility/admin overhead — never a documentation gap`);
  }
});

test('billed_total: the row assembler carries the ₹ scalar and it is still not PHI', () => {
  const src = read('lib/ipd-audit/assemble.ts');
  assert.ok(/billedTotal: meta\.billedTotal/.test(src), 'the assembler passes billedTotal through');
  // the write paths populate it
  for (const p of ['lib/ipd-audit/run.ts', 'app/api/admin/ipd-audit-now/route.ts']) {
    assert.ok(read(p).includes('fetchBilledTotal'), `${p} populates billed_total at audit time`);
  }
});
