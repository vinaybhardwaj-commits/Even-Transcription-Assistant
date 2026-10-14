/**
 *   node --experimental-strip-types --test lib/__tests__/readmission-substrate.test.ts
 *
 * Phase 1.5 — the reconciliation substrate (CDMSS-READMISSION-PHASE-1.5-SUBSTRATE-
 * ADDENDUM §2/§3/§4). The Phase-1 rules are asserted in readmission-reconcile-core.test.ts
 * and are deliberately NOT restated here: that file passing unmodified is the invariance
 * proof for everything 1.5 did not intend to change.
 *
 * What this file pins:
 *   · tier routing — structured labs in window → tier1; none → tier2; no index case → tier3
 *   · the DERIVED numeric omission audit and its §8c.3 timing rule
 *   · the tier-2 confidence ceiling (a summary-vs-summary contradiction is not high)
 *   · same-condition by LOINC BUNDLE across a renamed diagnosis
 *
 * The shared extraction store's own fail-safe contract is in
 * discharge-extract-store.test.ts — it imports lib/db, so it runs under the tsx suite
 * (`npm test`) rather than the bare strip-types command this file is written for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileFinding, resolveLabTier, inferLabTier, deriveNumericOmissions, mergeOmissions,
  findStabilityClaims, latestValuePerAnalyte, scoreOmissions,
  analyteFromLoinc, canonicalAnalyte, canonicalAnalyteFor, bundlesForLoinc, LOINC_BUNDLES,
  parseRefRange, refRangeDisplay, labAbnormal,
  type EvidenceCatalog, type EvidenceItem, type PassClaims,
} from '../readmission-reconcile-core.ts';

const DISCH = '2026-01-10T10:00:00Z';
const H = 3_600_000;
const ago = (h: number) => new Date(Date.parse(DISCH) - h * H).toISOString();

const item = (o: Partial<EvidenceItem> & { id: string }): EvidenceItem => ({
  source: 'index_summary', text: 'text', ...o,
});

/** A structured potassium value, abnormal against its own reference range. */
const structuredK = (id: string, at: string | null) => item({
  id, source: 'lab', side: 'index', at, analyte: 'potassium', abnormal: true,
  value: 2.9, refRange: '3.5-5.1', labProvenance: 'structured',
  text: `Potassium: 2.9 mmol/L (ref 3.5-5.1) [LOINC 2823-3] @ ${at}`,
});

const stableClaim = item({ id: 'S1', source: 'index_summary', side: 'index', text: 'Condition at discharge: patient stable, afebrile.' });

// ── §3 tier routing ─────────────────────────────────────────────────────────────

test('tier routing: structured labs in window → tier1; none → tier2; no index case → tier3', () => {
  assert.equal(resolveLabTier({ hasIndexCase: true, structuredLabsInWindow: 4 }).tier, 'tier1');
  assert.equal(resolveLabTier({ hasIndexCase: true, structuredLabsInWindow: 0 }).tier, 'tier2');
  const t3 = resolveLabTier({ hasIndexCase: false, structuredLabsInWindow: 9 });
  assert.equal(t3.tier, 'tier3');
  assert.match(t3.notAuditableReason ?? '', /not auditable/i);
  // A tier-3 pair is never rescued by having labs — with no index document there is no
  // claim to audit the numbers against.
  assert.equal(resolveLabTier({ hasIndexCase: false, structuredLabsInWindow: 0 }).tier, 'tier3');
});

test('inferLabTier reads a catalog for pre-1.5 callers: structured lab → tier1, narrative only → tier2, nothing → tier3', () => {
  assert.equal(inferLabTier({ items: [stableClaim, structuredK('L1', ago(12))] }), 'tier1');
  assert.equal(inferLabTier({ items: [stableClaim] }), 'tier2');
  assert.equal(inferLabTier({ items: [] }), 'tier3');
  // A lab the DOCTOR wrote is not a structured value and cannot lift a pair to tier 1.
  const caseLab = item({ id: 'IX1', source: 'lab', side: 'index', analyte: 'potassium', abnormal: true, labProvenance: 'extracted_case', text: 'K 2.9' });
  assert.equal(inferLabTier({ items: [stableClaim, caseLab] }), 'tier2');
});

// ── the derived numeric omission audit (tier 1) ─────────────────────────────────

test('tier-1 numeric omission: index "stable" contradicted by an abnormal value near discharge → high-confidence finding', () => {
  const catalog: EvidenceCatalog = { items: [stableClaim, structuredK('L1', ago(12))] };
  const f = reconcileFinding({
    findingClass: 'even_even', catalog, labProfile: 'has_late_labs', labTier: 'tier1',
    indexDischargeAt: DISCH, passA: null, passB: null,
  });
  assert.equal(f.omissions.length, 1);
  assert.equal(f.omissions[0].confidence, 'high');
  assert.equal(f.omissions[0].danger, 'high');            // potassium is in the renal bundle
  assert.equal(f.omissions[0].source, 'derived');         // found from the number, not from the model
  assert.equal(f.stabilityAssessment, 'contradicted');
  assert.deepEqual(f.omissions[0].evidenceIds, ['S1', 'L1']);
});

test('the SAME value dated only at admission lowers the confidence and says why (§8c.3)', () => {
  const catalog: EvidenceCatalog = { items: [stableClaim, structuredK('L1', ago(6 * 24))] };
  const f = reconcileFinding({
    findingClass: 'even_even', catalog, labProfile: 'admission_only', labTier: 'tier1',
    indexDischargeAt: DISCH, passA: null, passB: null,
  });
  assert.equal(f.omissions[0].confidence, 'low');
  assert.match(f.omissions[0].caveat ?? '', /admission workup|may have corrected/);
  assert.match(f.omissions[0].caveat ?? '', /not a "discharged unstable" claim/);
});

test('no stability claim in the index narrative → no derived omission (there is nothing to contradict)', () => {
  const catalog: EvidenceCatalog = {
    items: [
      item({ id: 'S1', source: 'index_summary', side: 'index', text: 'Diagnosis: acute kidney injury; potassium replaced.' }),
      structuredK('L1', ago(12)),
    ],
  };
  const f = reconcileFinding({
    findingClass: 'even_even', catalog, labProfile: 'has_late_labs', labTier: 'tier1',
    indexDischargeAt: DISCH, passA: null, passB: null,
  });
  assert.equal(f.omissions.length, 0);
  // And absence of a contradiction is still never read as confirmation.
  assert.notEqual(f.stabilityAssessment, 'contradicted');
});

test('only the LATEST value at/before discharge is audited — a corrected analyte is not flagged', () => {
  const corrected = item({
    id: 'L2', source: 'lab', side: 'index', at: ago(6), analyte: 'potassium', abnormal: false,
    value: 4.1, refRange: '3.5-5.1', labProvenance: 'structured', text: 'Potassium: 4.1 (ref 3.5-5.1)',
  });
  const catalog: EvidenceCatalog = { items: [stableClaim, structuredK('L1', ago(6 * 24)), corrected] };
  assert.equal(latestValuePerAnalyte(catalog, DISCH).get('potassium')?.id, 'L2');
  const omissions = deriveNumericOmissions({ catalog, tier: 'tier1', labProfile: 'has_late_labs', indexDischargeAt: DISCH });
  assert.equal(omissions.length, 0);   // the abnormal admission value WAS followed and corrected
});

test('a value drawn AFTER discharge cannot be an omission — the discharge decision could not have known it', () => {
  const after = item({
    id: 'L9', source: 'lab', side: 'index', at: new Date(Date.parse(DISCH) + 24 * H).toISOString(),
    analyte: 'creatinine', abnormal: true, value: 3.4, refRange: '0.6-1.2',
    labProvenance: 'structured', text: 'Creatinine: 3.4 (ref 0.6-1.2)',
  });
  const latest = latestValuePerAnalyte({ items: [stableClaim, after] }, DISCH);
  assert.equal(latest.has('creatinine'), false);
});

test('the derived audit runs ONLY on an explicitly stated tier 1, never on an inferred one', () => {
  const catalog: EvidenceCatalog = { items: [stableClaim, structuredK('L1', ago(12))] };
  const inferred = reconcileFinding({
    findingClass: 'even_even', catalog, labProfile: 'has_late_labs',
    indexDischargeAt: DISCH, passA: null, passB: null,   // no labTier stated
  });
  assert.equal(inferred.omissions.length, 0);
  assert.equal(inferred.labTier, 'tier1');               // still REPORTED, just not acted on
  assert.equal(deriveNumericOmissions({ catalog, tier: 'tier2', labProfile: 'short_stay', indexDischargeAt: DISCH }).length, 0);
});

test('stability claims are the discharge-condition kind, not any use of the word', () => {
  const claims = findStabilityClaims({
    items: [
      item({ id: 'S1', text: 'Patient stable at discharge.' }),
      item({ id: 'S2', text: 'Diagnosis: stable angina.' }),
      item({ id: 'S3', text: 'Patient remained haemodynamically unstable overnight.' }),
      item({ id: 'R1', source: 'readmit_summary', side: 'readmit', text: 'Reported stable on arrival.' }),
    ],
  }).map((c) => c.id);
  assert.deepEqual(claims, ['S1']);   // S2/S3 are not claims; R1 is the other team's note
});

// ── tier-2 ceiling ──────────────────────────────────────────────────────────────

test('tier 2 caps an omission at moderate — a summary-vs-summary contradiction is never high-confidence', () => {
  const caseLab = item({
    id: 'IX1', source: 'lab', side: 'index', at: ago(12), analyte: 'potassium', abnormal: true,
    labProvenance: 'extracted_case', text: 'Potassium 2.9 (3.5-5.1)',
  });
  const claim: NonNullable<PassClaims['omissions']> = [{
    claim: 'note says stable, potassium 2.9', claimEvidenceId: 'S1',
    contradictingEvidenceIds: ['IX1'], danger: 'high',
  }];
  const catalog: EvidenceCatalog = { items: [stableClaim, caseLab] };
  const tier2 = scoreOmissions(claim, catalog, 'short_stay', DISCH, 'tier2');
  assert.equal(tier2[0].confidence, 'moderate');
  assert.match(tier2[0].caveat ?? '', /no structured lab value|as the doctor wrote/);
  // The identical claim on the identical timing IS high under tier 1.
  assert.equal(scoreOmissions(claim, catalog, 'short_stay', DISCH, 'tier1')[0].confidence, 'high');
});

test('tier 3 emits no omissions at all and records the refusal', () => {
  const catalog: EvidenceCatalog = { items: [item({ id: 'F1', source: 'cm_form', text: 'patient says they went back in' })] };
  const f = reconcileFinding({
    findingClass: 'even_even', catalog, labProfile: 'no_labs', labTier: 'tier3',
    indexDischargeAt: DISCH,
    passA: { omissions: [{ claim: 'invented', contradictingEvidenceIds: ['F1'], danger: 'high' }] },
    passB: { avoidable: { verdict: 'uncertain', evidenceIds: [] } },
  });
  assert.equal(f.omissions.length, 0);
  assert.equal(f.labTier, 'tier3');
  assert.ok(f.refusalRecord.some((r) => /index discharge-summary PDF/i.test(r.lookedFor) && r.found === false));
});

test('only a STRUCTURED value can corroborate a stability claim', () => {
  const caseLab = item({ id: 'IX1', source: 'lab', side: 'index', at: ago(12), analyte: 'sodium', abnormal: false, labProvenance: 'extracted_case', text: 'Na 140' });
  const f = reconcileFinding({
    findingClass: 'even_even', catalog: { items: [stableClaim, caseLab] }, labProfile: 'short_stay',
    labTier: 'tier2', indexDischargeAt: DISCH, passA: null, passB: null,
  });
  assert.equal(f.stabilityAssessment, 'unverifiable');   // the doctor cannot corroborate the doctor
  assert.ok(f.refusalRecord.some((r) => /structured lab values/i.test(r.lookedFor)));
});

// ── the live reference-range shape (corrected 6 Aug 2026) ───────────────────────

test('the range is a JSON OBJECT: bounds come from .l/.h numerically', () => {
  // The exact shape db13 returns, confirmed live.
  const live = { h: 17, l: 13, t: '13.0 - 17.0', s: 2 };
  assert.deepEqual(parseRefRange(live), { lo: 13, hi: 17 });
  // A driver that hands the same object back as TEXT must not lose it.
  assert.deepEqual(parseRefRange(JSON.stringify(live)), { lo: 13, hi: 17 });
  // String bounds inside the object (a lab that quotes its numbers) still resolve.
  assert.deepEqual(parseRefRange({ h: '5.1', l: '3.5', t: '3.5 - 5.1', s: 2 }), { lo: 3.5, hi: 5.1 });
  // .t is read ONLY when l/h are absent or unusable — never in preference to them.
  assert.deepEqual(parseRefRange({ t: '0.6 - 1.2' }), { lo: 0.6, hi: 1.2 });
  assert.deepEqual(parseRefRange({ h: null, l: null, t: '3.5-5.1' }), { lo: 3.5, hi: 5.1 });
  // The plain-string form the tier-2 path extracts from doctor-written text still works.
  assert.deepEqual(parseRefRange('3.5-5.1'), { lo: 3.5, hi: 5.1 });
  assert.deepEqual(parseRefRange('13.0 to 17.0'), { lo: 13, hi: 17 });
});

test('an UNPARSEABLE range yields no numeric flag — never a guessed one', () => {
  for (const bad of [
    null, undefined, '', {}, { s: 2 }, { h: 17 }, { l: 13 },              // no usable bounds
    { h: 'high', l: 'low', t: 'see report' },                             // non-numeric
    { h: 3, l: 17, t: 'inverted' },                                       // hi < lo — refuse
    '{ not json at all',                                                  // looked like JSON, was not
    'Normal', 'WNL', 'refer to report', 42, true,                         // not a range at all
  ]) {
    assert.equal(parseRefRange(bad), null, `expected null for ${JSON.stringify(bad)}`);
    // …and the abnormality decision must be UNKNOWN, not false — "we could not check"
    // is not "the value was fine".
    assert.equal(labAbnormal(2.9, null, bad), null, `expected unknown for ${JSON.stringify(bad)}`);
  }
});

test('an abnormal value against the live object range flags; an in-range one does not', () => {
  const k = { h: 5.1, l: 3.5, t: '3.5 - 5.1', s: 2 };
  assert.equal(labAbnormal(2.9, null, k), true);
  assert.equal(labAbnormal(5.4, null, k), true);
  assert.equal(labAbnormal(4.1, null, k), false);
  assert.equal(labAbnormal(3.5, null, k), false);   // bounds are inclusive
  assert.equal(labAbnormal(null, null, k), null);   // no value → unknown, not normal
});

test('a value whose range will not parse produces NO derived omission, even under an explicit tier 1', () => {
  const unparseable = item({
    id: 'L1', source: 'lab', side: 'index', at: ago(12), analyte: 'potassium',
    // This is the honest end state of an unparseable range: abnormal is UNKNOWN.
    abnormal: labAbnormal(2.9, null, { t: 'see report' }),
    value: 2.9, refRange: { t: 'see report' }, labProvenance: 'structured',
    text: 'Potassium: 2.9 (ref see report)',
  });
  assert.equal(unparseable.abnormal, null);
  const f = reconcileFinding({
    findingClass: 'even_even', catalog: { items: [stableClaim, unparseable] },
    labProfile: 'has_late_labs', labTier: 'tier1', indexDischargeAt: DISCH, passA: null, passB: null,
  });
  assert.equal(f.omissions.length, 0);                  // no flag on an unchecked number
  assert.notEqual(f.stabilityAssessment, 'contradicted');
});

test('refRangeDisplay prefers the lab\'s own wording over our reconstruction', () => {
  assert.equal(refRangeDisplay({ h: 17, l: 13, t: '13.0 - 17.0 g/dL', s: 2 }), '13.0 - 17.0 g/dL');
  assert.equal(refRangeDisplay({ h: 17, l: 13, s: 2 }), '13 - 17');   // no `t` → reconstruct
  assert.equal(refRangeDisplay('3.5-5.1'), '3.5-5.1');
  assert.equal(refRangeDisplay({ s: 2 }), null);
  assert.equal(refRangeDisplay(null), null);
});

// ── §4 same condition by analyte bundle ─────────────────────────────────────────

test('the analyte-name matcher handles the real db13 names (LOINC is absent, so this is the primary path)', () => {
  // Names taken from the live structured rows.
  assert.equal(canonicalAnalyte('Creatinine'), 'creatinine');
  assert.equal(canonicalAnalyte('Potassium'), 'potassium');
  assert.equal(canonicalAnalyte('Sodium'), 'sodium');
  assert.equal(canonicalAnalyte('Total Bilirubin'), 'bilirubin');
  assert.equal(canonicalAnalyte('Blood Urea Nitrogen'), 'bun');
  assert.equal(canonicalAnalyte('Urea'), 'bun');
  assert.equal(canonicalAnalyte('INR'), 'inr');
  assert.equal(canonicalAnalyte('NT-proBNP'), 'bnp');
  // Real values that are simply outside the three organ bundles — null is correct.
  assert.equal(canonicalAnalyte('Haemoglobin'), null);
  assert.equal(canonicalAnalyte('Platelet Count'), null);
  // A different SPECIMEN is a different measurement with a different range.
  assert.equal(canonicalAnalyte('Urine Sodium'), null);
  assert.equal(canonicalAnalyte('Creatinine Clearance'), null);
  assert.equal(canonicalAnalyte('24 Hr Urine Protein'), null);
});

test('with loinc_id absent the NAME decides; the code is only the fallback', () => {
  assert.equal(canonicalAnalyteFor(null, 'Creatinine'), 'creatinine');
  assert.equal(canonicalAnalyteFor('', 'Potassium'), 'potassium');
  // Name wins when both are present and they disagree — the name is the validated path.
  assert.equal(canonicalAnalyteFor('2951-2', 'Creatinine'), 'creatinine');
  // A code still rescues a row whose name we do not recognise.
  assert.equal(canonicalAnalyteFor('2160-0', 'Renal Panel'), 'creatinine');
  assert.equal(canonicalAnalyteFor(null, 'Renal Panel'), null);
});


test('the LOINC table still resolves where a code exists — kept as the fallback, not the primary path', () => {
  assert.equal(analyteFromLoinc('2823-3'), 'potassium');
  assert.equal(analyteFromLoinc('33762-6'), 'bnp');
  assert.equal(analyteFromLoinc('99999-9'), null);
  assert.equal(canonicalAnalyteFor(null, 'Serum Creatinine'), 'creatinine');
  assert.equal(canonicalAnalyteFor('99999-9', 'Blood Urea Nitrogen'), 'bun');
  assert.equal(canonicalAnalyteFor(null, 'Haemoglobin'), null);
  assert.deepEqual(bundlesForLoinc('2823-3'), ['renal']);
  assert.ok(LOINC_BUNDLES.renal.includes('2160-0'));
  assert.ok(LOINC_BUNDLES.cardiac.includes('33762-6'));
  assert.ok(LOINC_BUNDLES.hepatic.includes('6301-6'));
});

test('a renamed diagnosis cannot move the organ bundle: same failing organ both sides → SAME condition', () => {
  const lab = (id: string, side: 'index' | 'readmit', loinc: string, name: string) => item({
    id, source: 'lab', side, analyte: canonicalAnalyteFor(loinc, name), abnormal: true,
    labProvenance: 'structured', text: `${name} [LOINC ${loinc}]`,
  });
  const catalog: EvidenceCatalog = {
    items: [
      item({ id: 'S1', source: 'index_summary', side: 'index', text: 'Diagnosis: acute kidney injury.' }),
      item({ id: 'R1', source: 'readmit_summary', side: 'readmit', text: 'Diagnosis: metabolic encephalopathy.' }),
      lab('L1', 'index', '2160-0', 'Creatinine'),
      lab('M1', 'readmit', '3094-0', 'Urea Nitrogen'),     // different test, SAME renal bundle
    ],
  };
  const f = reconcileFinding({
    findingClass: 'even_even', catalog, labProfile: 'has_late_labs', labTier: 'tier1',
    indexDischargeAt: DISCH,
    passA: { sameCondition: { verdict: 'different', evidenceIds: ['S1', 'R1'] } },   // model fooled by the strings
    passB: { avoidable: { verdict: 'uncertain', evidenceIds: [] } },
  });
  assert.equal(f.sameCondition?.verdict, 'same');
  assert.equal(f.sameCondition?.basis, 'analyte_bundle');
  assert.deepEqual(f.sameCondition?.bundles, ['renal']);
});

// ── merge ───────────────────────────────────────────────────────────────────────

test('a derived omission and the model\'s version of the same one collapse to one row, derived winning', () => {
  const derived = deriveNumericOmissions({
    catalog: { items: [stableClaim, structuredK('L1', ago(12))] },
    tier: 'tier1', labProfile: 'has_late_labs', indexDischargeAt: DISCH,
  });
  const modelScored = scoreOmissions(
    [{ claim: 'stable vs K 2.9', claimEvidenceId: 'S1', contradictingEvidenceIds: ['L1'], danger: 'moderate' }],
    { items: [stableClaim, structuredK('L1', ago(12))] }, 'has_late_labs', DISCH, 'tier1',
  );
  const merged = mergeOmissions(derived, modelScored);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, 'derived');
  // A model omission on DIFFERENT evidence is kept alongside.
  const other = scoreOmissions(
    [{ claim: 'other', claimEvidenceId: 'S1', contradictingEvidenceIds: ['L2'], danger: 'low' }],
    { items: [stableClaim, structuredK('L1', ago(12)), structuredK('L2', ago(20))] }, 'has_late_labs', DISCH, 'tier1',
  );
  assert.equal(mergeOmissions(derived, other).length, 2);
});

test('the tier and its provenance ride the finding for the reviewer', () => {
  const provenance = {
    tier: 'tier1' as const, structuredLabCount: 7, window: { from: '2025-12-20', to: '2026-01-12' },
    caseLabCount: 0, indexCase: 'store' as const, readmitCase: 'fresh_extract' as const,
    extractionVersion: 'doc-extract/1', indexDocumentId: 'doc-index-1', readmitDocumentId: 'doc-readmit-1',
  };
  const f = reconcileFinding({
    findingClass: 'even_even', catalog: { items: [stableClaim, structuredK('L1', ago(12))] },
    labProfile: 'has_late_labs', labTier: 'tier1', labSourceProvenance: provenance,
    indexDischargeAt: DISCH, passA: null, passB: null,
  });
  assert.equal(f.labTier, 'tier1');
  assert.equal(f.labSourceProvenance?.structuredLabCount, 7);
  assert.equal(f.labSourceProvenance?.indexCase, 'store');
  assert.equal(f.labSourceProvenance?.extractionVersion, 'doc-extract/1');
});
