/**
 *   node --experimental-strip-types --test lib/__tests__/readmission-reconcile-core.test.ts
 * Pure core: Stage-2 provenance reconciliation (PRD §5/§5a/§11, decisions 13/14)
 * + the tolerant parser in readmission-prompts (no runtime cross-imports beyond cores).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileFinding, labTimingProfile, canonicalAnalyte, abnormalBundles, labAbnormal,
  parseRefRange, twoPassAvoidable, enforcePlanned,
  type EvidenceCatalog, type EvidenceItem, type PassClaims,
} from '../readmission-reconcile-core.ts';
import { parsePassClaims, extractJsonObject } from '../readmission-prompts.ts';

const item = (o: Partial<EvidenceItem> & { id: string }): EvidenceItem => ({
  source: 'index_summary', text: 'text', ...o,
});

const DISCH = '2026-01-10T10:00:00Z';
const H = 3_600_000;

const baseCatalog = (extra: EvidenceItem[] = []): EvidenceCatalog => ({
  items: [
    item({ id: 'S1', source: 'index_summary', side: 'index', text: 'Patient stable at discharge.' }),
    item({ id: 'S2', source: 'index_summary', side: 'index', text: 'Plan: readmit in 3 weeks for stage-2 procedure.' }),
    item({ id: 'R1', source: 'readmit_summary', side: 'readmit', text: 'Presented with worsening symptoms.' }),
    item({ id: 'L1', source: 'lab', side: 'index', at: new Date(Date.parse(DISCH) - 24 * H).toISOString(), analyte: 'potassium', abnormal: true, text: 'Potassium 2.9 (ref 3.5-5.1)' }),
    ...extra,
  ],
});

const fullInput = (over: Record<string, unknown> = {}) => ({
  findingClass: 'even_even' as const,
  catalog: baseCatalog(),
  labProfile: 'has_late_labs' as const,
  indexDischargeAt: DISCH,
  passA: null as PassClaims | null,
  passB: null as PassClaims | null,
  ...over,
});

// ── planned: temporal provenance ────────────────────────────────────────────────

test('planned counts only when foreshadowed in the INDEX summary', () => {
  const f = reconcileFinding(fullInput({
    passA: { planned: { verdict: 'planned', evidenceIds: ['S2'] }, avoidable: { verdict: 'justified', evidenceIds: ['R1'] } },
    passB: { avoidable: { verdict: 'justified', evidenceIds: ['R1'] } },
  }));
  assert.equal(f.planned?.verdict, 'planned');
});

test('planned asserted ONLY in the readmit summary does NOT make it planned', () => {
  const f = reconcileFinding(fullInput({
    passA: { planned: { verdict: 'planned', evidenceIds: ['R1'] } },
    passB: { avoidable: { verdict: 'uncertain', evidenceIds: [] } },
  }));
  assert.notEqual(f.planned?.verdict, 'planned');
  assert.equal(f.planned?.verdict, 'unplanned');
  assert.match(f.planned?.enforcement ?? '', /not foreshadowed/);
});

// ── omission audit: confidence scales with lab timing ───────────────────────────

const omissionPass = (): PassClaims => ({
  omissions: [{ claim: 'note says stable, potassium 2.9', claimEvidenceId: 'S1', contradictingEvidenceIds: ['L1'], danger: 'high' }],
});

test('near-discharge abnormal → high-confidence omission', () => {
  const f = reconcileFinding(fullInput({ passA: omissionPass(), passB: { avoidable: { verdict: 'uncertain', evidenceIds: [] } } }));
  assert.equal(f.omissions.length, 1);
  assert.equal(f.omissions[0].confidence, 'high');
  assert.equal(f.stabilityAssessment, 'contradicted');
});

test('admission-only labs → lower-confidence, clearly-labelled — never a hard "discharged unstable"', () => {
  const catalog: EvidenceCatalog = {
    items: [
      item({ id: 'S1', side: 'index', text: 'Stable at discharge.' }),
      // abnormal value from the admission workup, 6 days before discharge
      item({ id: 'L1', source: 'lab', side: 'index', at: new Date(Date.parse(DISCH) - 6 * 24 * H).toISOString(), analyte: 'potassium', abnormal: true, text: 'K 2.9' }),
    ],
  };
  const f = reconcileFinding(fullInput({ catalog, labProfile: 'admission_only', passA: omissionPass(), passB: { avoidable: { verdict: 'uncertain', evidenceIds: [] } } }));
  assert.equal(f.omissions[0].confidence, 'low');
  assert.match(f.omissions[0].caveat ?? '', /admission-only|may have corrected/);
  assert.match(f.omissions[0].caveat ?? '', /not a "discharged unstable" claim/);
});

test('missing labs → prose-only track; "no contradicting lab" is NEVER "confirmed stable"', () => {
  const catalog: EvidenceCatalog = { items: [item({ id: 'S1', side: 'index', text: 'Stable at discharge.' })] };
  const f = reconcileFinding(fullInput({
    catalog, labProfile: 'no_labs',
    passA: { planned: { verdict: 'unplanned', evidenceIds: [] } },
    passB: { avoidable: { verdict: 'uncertain', evidenceIds: [] } },
  }));
  assert.equal(f.corroborationTrack, 'prose_only');
  assert.notEqual(f.stabilityAssessment, 'corroborated');
  assert.equal(f.stabilityAssessment, 'unverifiable');
  assert.ok(f.refusalRecord.some((r) => /lab/i.test(r.lookedFor) && r.found === false));
});

test('labTimingProfile: short_stay / has_late_labs / admission_only / no_labs', () => {
  const admit = '2026-01-01T00:00:00Z';
  assert.equal(labTimingProfile([], admit, DISCH), 'no_labs');
  assert.equal(labTimingProfile([{ at: '2026-01-01T06:00:00Z' }], admit, '2026-01-02T12:00:00Z'), 'short_stay');
  assert.equal(labTimingProfile([{ at: '2026-01-03T00:00:00Z' }], admit, DISCH), 'has_late_labs');
  assert.equal(labTimingProfile([{ at: '2026-01-01T06:00:00Z' }], admit, DISCH), 'admission_only');
});

// ── exculpatory needs corroboration ─────────────────────────────────────────────

test('an uncorroborated exculpatory claim does NOT clear a flagged case', () => {
  const f = reconcileFinding(fullInput({
    passA: {
      ...omissionPass(),
      exculpatory: [{ claim: 'patient was non-adherent', claimEvidenceId: 'S1', corroboratingEvidenceIds: [] }],
      avoidable: { verdict: 'justified', evidenceIds: ['S1'] },
    },
    passB: { avoidable: { verdict: 'justified', evidenceIds: ['S1'] } },
  }));
  assert.equal(f.exculpatory[0].corroborated, false);
  assert.equal(f.avoidable?.verdict, 'needs_adjudication');   // stays flagged, not cleared
});

test('a disinterested corroborator makes the exculpatory claim count', () => {
  const f = reconcileFinding(fullInput({
    passA: {
      ...omissionPass(),
      exculpatory: [{ claim: 'patient stopped meds', claimEvidenceId: 'S1', corroboratingEvidenceIds: ['R1'] }],
      avoidable: { verdict: 'justified', evidenceIds: ['R1'] },
    },
    passB: { avoidable: { verdict: 'justified', evidenceIds: ['R1'] } },
  }));
  assert.equal(f.exculpatory[0].corroborated, true);
  assert.equal(f.avoidable?.verdict, 'justified');
});

// ── same condition by analyte bundle, not diagnosis string ──────────────────────

test('same-condition decided on the analyte bundle even when the model followed the renamed diagnosis string', () => {
  const catalog: EvidenceCatalog = {
    items: [
      item({ id: 'S1', side: 'index', text: 'Diagnosis: acute kidney injury.' }),
      item({ id: 'R1', source: 'readmit_summary', side: 'readmit', text: 'Diagnosis: metabolic derangement.' }),
      item({ id: 'L1', source: 'lab', side: 'index', analyte: 'creatinine', abnormal: true, text: 'Creatinine 3.1' }),
      item({ id: 'M1', source: 'lab', side: 'readmit', analyte: 'creatinine', abnormal: true, text: 'Creatinine 4.0' }),
    ],
  };
  const f = reconcileFinding(fullInput({
    catalog,
    // the model was fooled by the renamed string:
    passA: { sameCondition: { verdict: 'different', evidenceIds: ['S1', 'R1'] } },
    passB: { avoidable: { verdict: 'uncertain', evidenceIds: [] } },
  }));
  assert.equal(f.sameCondition?.verdict, 'same');
  assert.equal(f.sameCondition?.basis, 'analyte_bundle');
  assert.deepEqual(f.sameCondition?.bundles, ['renal']);
});

test('analyte helpers: canonicalisation, ranges, bundles', () => {
  assert.equal(canonicalAnalyte('Serum Creatinine'), 'creatinine');
  assert.equal(canonicalAnalyte('NT-proBNP'), 'bnp');
  assert.equal(canonicalAnalyte('Haemoglobin'), null);
  assert.deepEqual(parseRefRange('3.5-5.1'), { lo: 3.5, hi: 5.1 });
  assert.equal(labAbnormal(2.9, null, '3.5-5.1'), true);
  assert.equal(labAbnormal(4.0, null, '3.5-5.1'), false);
  assert.equal(labAbnormal(null, 'H', null), true);
  const bundles = abnormalBundles([
    item({ id: 'L1', source: 'lab', analyte: 'bilirubin', abnormal: true }),
    item({ id: 'L2', source: 'lab', analyte: 'inr', abnormal: false }),
  ]);
  assert.deepEqual(bundles, ['hepatic']);
});

// ── two-pass money verdict ──────────────────────────────────────────────────────

test('two-pass: same verdict + overlapping evidence ids → avoidable emitted', () => {
  const v = twoPassAvoidable(
    { verdict: 'avoidable', evidenceIds: ['L1', 'S1'] },
    { verdict: 'avoidable', evidenceIds: ['L1', 'R1'] },
    baseCatalog(), [], [],
  );
  assert.equal(v.verdict, 'avoidable');
  assert.deepEqual(v.evidenceIds, ['L1']);
});

test('two-pass: same verdict + DISJOINT evidence → needs_adjudication', () => {
  const v = twoPassAvoidable(
    { verdict: 'avoidable', evidenceIds: ['S1'] },
    { verdict: 'avoidable', evidenceIds: ['R1'] },
    baseCatalog(), [], [],
  );
  assert.equal(v.verdict, 'needs_adjudication');
  assert.match(v.reason ?? '', /disjoint/);
});

test('two-pass: disagreeing verdicts → needs_adjudication; avoidable on interested evidence alone → needs_adjudication', () => {
  const disagree = twoPassAvoidable(
    { verdict: 'avoidable', evidenceIds: ['L1'] },
    { verdict: 'justified', evidenceIds: ['L1'] },
    baseCatalog(), [], [],
  );
  assert.equal(disagree.verdict, 'needs_adjudication');
  const interestedOnly = twoPassAvoidable(
    { verdict: 'avoidable', evidenceIds: ['S1'] },
    { verdict: 'avoidable', evidenceIds: ['S1'] },
    baseCatalog(), [], [],
  );
  assert.equal(interestedOnly.verdict, 'needs_adjudication');
  assert.match(interestedOnly.reason ?? '', /interested|prose/);
});

test('hallucinated evidence ids are dropped before the overlap test', () => {
  const v = twoPassAvoidable(
    { verdict: 'avoidable', evidenceIds: ['L1', 'GHOST-1'] },
    { verdict: 'avoidable', evidenceIds: ['GHOST-1'] },
    baseCatalog(), [], [],
  );
  assert.equal(v.verdict, 'needs_adjudication');   // GHOST-1 cannot carry the overlap
});

// ── provenance-weighted confidence ──────────────────────────────────────────────

test('a verdict resting only on treating-team prose auto-routes to human review', () => {
  const f = reconcileFinding(fullInput({
    passA: { planned: { verdict: 'unplanned', evidenceIds: ['S1'] } },
    passB: { avoidable: { verdict: 'uncertain', evidenceIds: [] } },
  }));
  assert.equal(f.provenance.needsHumanReview, true);
  assert.equal(f.provenance.disinterested, 0);
});

// ── lane D condition-only + promotion (decisions 9/14) ──────────────────────────

test('lane-D condition pass: SAME condition sets promoteToFull; different does not', () => {
  const same = reconcileFinding(fullInput({
    conditionOnly: true,
    passA: { sameCondition: { verdict: 'same', evidenceIds: ['R1'] } },
  }));
  assert.equal(same.promoteToFull, true);
  assert.equal(same.avoidable, null);            // the condition pass never carries the money verdict
  const diff = reconcileFinding(fullInput({
    conditionOnly: true,
    passA: { sameCondition: { verdict: 'different', evidenceIds: ['R1'] } },
  }));
  assert.equal(diff.promoteToFull, false);
});

// ── out-of-network class (decision 13) ──────────────────────────────────────────

test('out-of-network: index-side only, NO avoidable verdict, identity always resolved, patient-reported stated', () => {
  const catalog: EvidenceCatalog = {
    items: [
      item({ id: 'S1', side: 'index', text: 'Stable at discharge.' }),
      item({ id: 'L1', source: 'lab', side: 'index', at: new Date(Date.parse(DISCH) - 12 * H).toISOString(), analyte: 'creatinine', abnormal: true, text: 'Creatinine 2.8' }),
      item({ id: 'F1', source: 'cm_form', text: 'Patient reports readmission at another hospital for the same kidney problem.' }),
    ],
  };
  const f = reconcileFinding({
    findingClass: 'out_of_network', catalog, labProfile: 'has_late_labs', indexDischargeAt: DISCH,
    passA: {
      planned: { verdict: 'unplanned', evidenceIds: ['F1'] },
      omissions: [{ claim: 'stable claim vs creatinine 2.8', claimEvidenceId: 'S1', contradictingEvidenceIds: ['L1'], danger: 'high' }],
      // even if the model volunteers a money verdict, it must not survive:
      avoidable: { verdict: 'avoidable', evidenceIds: ['L1'] },
    },
    passB: null,
    formFlags: { isPlanned: null, sameCondition: true },
  });
  assert.equal(f.avoidable, null);
  assert.equal(f.verdictScope, 'index_side_only');
  assert.equal(f.readmitFactsPatientReported, true);
  assert.equal(f.identityResolved, true);
  assert.equal(f.omissions.length, 1);           // the index-side omission audit DID run
  assert.equal(f.sameCondition?.verdict, 'same');
  assert.ok(f.refusalRecord.some((r) => /readmit discharge summary/i.test(r.lookedFor)));
});

test('out-of-network planned may come from the CM form flag', () => {
  const p = enforcePlanned(null, { items: [] }, 'out_of_network', { isPlanned: true, sameCondition: null });
  assert.equal(p?.verdict, 'planned');
  const q = enforcePlanned(null, { items: [] }, 'even_even', { isPlanned: true, sameCondition: null });
  assert.equal(q, null);   // Even→Even ignores the form flag: index foreshadowing only
});

// ── tolerant parser (readmission-prompts) ───────────────────────────────────────

test('parsePassClaims: fenced JSON with prose around it parses; junk returns null (fail-safe)', () => {
  const reply = 'Here is my analysis:\n```json\n{"planned":{"verdict":"unplanned","evidence_ids":["S1"]},"avoidable":{"verdict":"avoidable","evidence_ids":["L1"],"rationale":"x"},"weakest_step":"lab timing"}\n```\nDone.';
  const c = parsePassClaims(reply);
  assert.equal(c?.planned?.verdict, 'unplanned');
  assert.equal(c?.avoidable?.verdict, 'avoidable');
  assert.deepEqual(c?.avoidable?.evidenceIds, ['L1']);
  assert.equal(c?.weakestStep, 'lab timing');
  assert.equal(parsePassClaims('the model refused to answer'), null);
  assert.equal(parsePassClaims(''), null);
  assert.equal(parsePassClaims('{"unrelated": true}'), null);   // parsed but asserts nothing usable
});

test('extractJsonObject survives nested braces and invalid verdict values are dropped, not guessed', () => {
  const j = extractJsonObject('x {"a": {"b": 1}} y');
  assert.deepEqual(j, { a: { b: 1 } });
  const c = parsePassClaims('{"avoidable":{"verdict":"definitely-bill-them","evidence_ids":["L1"]},"planned":{"verdict":"unplanned","evidence_ids":[]}}');
  assert.equal(c?.avoidable, undefined);         // invalid enum → dropped
  assert.equal(c?.planned?.verdict, 'unplanned');
});
