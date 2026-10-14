import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deterministicExtract, normalizeWithLlm, mergeLlmFindings, COMPLAINT_FIELD_NAMES, type ExtractInput,
} from '../clinical-state/extract';
import { buildDdxClinicalState, applyParsedInvestigations, floorRulesFor, priorFor } from '../clinical-state/from-primitives';
import { validateClinicalState, emptyClinicalState } from '../clinical-state/schema';
import type { ParsedInvestigations } from '../investigations';

const INPUT: ExtractInput = {
  surface: 'ddx',
  age: 62,
  sex: 'M',
  fields: {
    complaint: 'epigastric discomfort for 2 hours',
    history: 'diabetic, smoker. No fever. Denies vomiting. Pain is worsening.',
    exam: 'soft non-tender abdomen',
    vitals: 'BP 82/50, HR 134, SpO2 90%',
  },
};

// ── Stage 1 — deterministic ──

test('demographics: structured input wins; band derived', () => {
  const s = deterministicExtract(INPUT);
  assert.equal(s.demographics.age, 62);
  assert.equal(s.demographics.sex, 'M');
  assert.equal(s.demographics.ageBand, '60-69');
  assert.deepEqual(validateClinicalState(s), s);
});

test('"No fever" → absent; "fever not mentioned" → unknown (the two are DIFFERENT)', () => {
  const s = deterministicExtract(INPUT);
  const fever = s.negatives.find((f) => f.concept === 'fever');
  assert.ok(fever, 'explicit negation lands in negatives');
  assert.equal(fever!.status, 'absent');
  assert.equal(fever!.provenance.rawText, 'No fever');
  assert.ok(!s.unknowns.some((f) => f.concept === 'fever'), 'a negated concept is NOT unknown');

  // Same input minus the negation: fever silent → unknown + missingCriticalData.
  const silent = deterministicExtract({ ...INPUT, fields: { ...INPUT.fields, history: 'diabetic, smoker.' } });
  const unknownFever = silent.unknowns.find((f) => f.concept === 'fever');
  assert.ok(unknownFever, 'unmentioned checklist concept lands in unknowns');
  assert.equal(unknownFever!.status, 'unknown');
  assert.ok(silent.missingCriticalData.includes('fever'));
});

test('"Denies vomiting" is a negation too; complaint carries its duration', () => {
  const s = deterministicExtract(INPUT);
  assert.ok(s.negatives.some((f) => f.concept === 'vomiting'));
  const complaint = s.positives.find((f) => f.provenance.sourceField === 'complaint');
  assert.ok(complaint);
  assert.equal(complaint!.temporality?.duration, 'for 2 hours');
});

test('accepted complaint field names are pinned — a rename at a call site is a silent positives:0', () => {
  // 31 Jul 2026: patient-summary.ts passed `presentingComplaint`, the extractor matched only
  // `complaint`/`cc`, and the rich baseline reported positives:0. This pins the contract.
  assert.deepEqual([...COMPLAINT_FIELD_NAMES].sort(), ['cc', 'complaint', 'presentingComplaint']);
  for (const name of COMPLAINT_FIELD_NAMES) {
    const s = deterministicExtract({ surface: 'ddx', fields: { [name]: 'crushing chest pain for 2 hours' } });
    const complaint = s.positives.find((f) => f.provenance.sourceField === name);
    assert.ok(complaint, `field name '${name}' must yield a complaint finding`);
    assert.equal(complaint!.status, 'present');
    assert.equal(complaint!.temporality?.duration, 'for 2 hours');
  }
  // An unrecognised field name yields NO complaint finding — the trap this test documents.
  const miss = deterministicExtract({ surface: 'ddx', fields: { chiefComplaint: 'crushing chest pain' } });
  assert.ok(!miss.positives.some((f) => f.provenance.sourceField === 'chiefComplaint'));
});

test('vitals: parsed reads + instability from adult thresholds', () => {
  const s = deterministicExtract(INPUT);
  const sbp = s.positives.find((f) => f.concept === 'systolic bp');
  assert.equal(sbp?.value, '82');
  assert.equal(s.instability.unstable, true);
  assert.ok(s.instability.reasons.some((r) => r.includes('SBP 82')));
  assert.ok(s.instability.reasons.some((r) => r.includes('HR 134')));
  assert.ok(s.instability.reasons.some((r) => r.includes('SpO2 90')));

  const calm = deterministicExtract({ ...INPUT, fields: { ...INPUT.fields, vitals: 'BP 118/76, HR 72, SpO2 99%' } });
  assert.equal(calm.instability.unstable, false);
});

// ── Three-state instability (UI-integrity fix): assessment + assessed/missing channels ──

test('instability three-state: no vitals → not_assessable, all 5 channels missing', () => {
  const s = deterministicExtract({ ...INPUT, fields: { ...INPUT.fields, vitals: '' } });
  assert.equal(s.instability.assessment, 'not_assessable');
  assert.equal(s.instability.unstable, false);
  assert.deepEqual(s.instability.assessedInputs, []);
  assert.deepEqual(s.instability.missingInputs, ['BP', 'HR', 'SpO₂', 'RR', 'T']);
});

test('instability three-state: full normal vitals → no_instability_detected, all 5 assessed', () => {
  const s = deterministicExtract({ ...INPUT, fields: { ...INPUT.fields, vitals: 'BP 120/80 HR 80 SpO2 98 RR 16 Temp 37' } });
  assert.equal(s.instability.assessment, 'no_instability_detected');
  assert.equal(s.instability.unstable, false);
  assert.deepEqual(s.instability.reasons, []);
  assert.deepEqual(s.instability.assessedInputs, ['BP', 'HR', 'SpO₂', 'RR', 'T']);
  assert.deepEqual(s.instability.missingInputs, []);
});

test('instability three-state: partial vitals (temperature only) → assessed [T], rest missing', () => {
  // "Temp 37" (not bare "T 37") is the token parseVitals actually reads — parser LOGIC unchanged;
  // the display label for the temperature channel is 'T' per spec.
  const s = deterministicExtract({ ...INPUT, fields: { ...INPUT.fields, vitals: 'Temp 37' } });
  assert.equal(s.instability.assessment, 'no_instability_detected');
  assert.deepEqual(s.instability.assessedInputs, ['T']);
  assert.deepEqual(s.instability.missingInputs, ['BP', 'HR', 'SpO₂', 'RR']);
});

test('instability three-state: breach → unstable, reasons byte-identical to unchanged logic', () => {
  const s = deterministicExtract({ ...INPUT, fields: { ...INPUT.fields, vitals: 'BP 82/50' } });
  assert.equal(s.instability.assessment, 'unstable');
  assert.equal(s.instability.unstable, true);
  assert.deepEqual(s.instability.reasons, ['SBP 82 < 90']);          // instabilityReasons unchanged
  assert.deepEqual(s.instability.assessedInputs, ['BP']);
  // the original full-INPUT breach still yields exactly today's reason set
  const full = deterministicExtract(INPUT);                          // vitals 'BP 82/50, HR 134, SpO2 90%'
  assert.deepEqual(full.instability.reasons, ['SBP 82 < 90', 'HR 134 outside 40-130', 'SpO2 90% < 92%']);
});

test('instability invariant: unstable === (assessment === "unstable"); emptyClinicalState passes updated zod', () => {
  for (const vitals of ['', 'Temp 37', 'BP 120/80 HR 80 SpO2 98 RR 16 Temp 37', 'BP 82/50', 'BP 82/50, HR 134, SpO2 90%']) {
    const s = deterministicExtract({ ...INPUT, fields: { ...INPUT.fields, vitals } });
    assert.equal(s.instability.unstable, s.instability.assessment === 'unstable', `vitals="${vitals}"`);
  }
  // emptyClinicalState default satisfies the updated .strict() validator (new required fields present)
  assert.doesNotThrow(() => validateClinicalState(emptyClinicalState('ddx')));
  const def = emptyClinicalState('ddx').instability;
  assert.equal(def.assessment, 'not_assessable');
  assert.deepEqual(def.missingInputs, ['BP', 'HR', 'SpO₂', 'RR', 'T']);
});

// ── Stage 2 — LLM normalisation with span verification (fake chat, no network) ──

test('normalizeWithLlm: verified spans accepted with offsets; unverifiable spans REJECTED', async () => {
  const fake = async () => JSON.stringify({
    findings: [
      { concept: 'diabetes', status: 'historical', field: 'history', rawText: 'diabetic' },
      { concept: 'jaundice', status: 'present', field: 'exam', rawText: 'icteric sclera' }, // NOT in the exam text
    ],
  });
  const { accepted, rejected } = await normalizeWithLlm(INPUT, fake);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].concept, 'diabetes');
  assert.equal(accepted[0].status, 'historical');
  assert.equal(accepted[0].provenance.extractionMethod, 'llm');
  assert.equal(accepted[0].provenance.startOffset, INPUT.fields.history!.indexOf('diabetic'));
  assert.deepEqual(rejected, [{ concept: 'jaundice', rawText: 'icteric sclera', field: 'exam' }]);
});

test('mergeLlmFindings: resolves checklist unknowns, dedupes, sorts absent into negatives', async () => {
  const silent = deterministicExtract({ ...INPUT, fields: { ...INPUT.fields, history: 'diabetic. no chills' } });
  assert.ok(silent.unknowns.some((f) => f.concept === 'fever'));
  const fake = async () => JSON.stringify({
    findings: [
      { concept: 'fever', status: 'absent', field: 'history', rawText: 'diabetic' }, // span exists; concept resolves the unknown
    ],
  });
  const llm = await normalizeWithLlm({ ...INPUT, fields: { ...INPUT.fields, history: 'diabetic. no chills' } }, fake);
  const merged = mergeLlmFindings(silent, llm);
  assert.ok(!merged.unknowns.some((f) => f.concept === 'fever'), 'LLM-resolved concept leaves unknowns');
  assert.ok(!merged.missingCriticalData.includes('fever'));
  assert.ok(merged.negatives.some((f) => f.concept === 'fever' && f.provenance.extractionMethod === 'llm'));
  assert.deepEqual(validateClinicalState(merged), merged);
});

// ── Stage 2 — polarity MARKER (31 Jul 2026): annotate, never remove ──

test('polarity MARKER: a negation-headed span labelled present is MARKED and KEPT — the live case', async () => {
  const input: ExtractInput = {
    surface: 'ddx',
    fields: { reportImpressions: 'Normal LV systolic function; No obvious regional wall motion abnormalities; no PAH' },
  };
  const fake = async () => JSON.stringify({
    findings: [
      { concept: 'No obvious regional wall motion abnormalities', status: 'present', field: 'reportImpressions', rawText: 'No obvious regional wall motion abnormalities' },
      { concept: 'No PAH', status: 'present', field: 'reportImpressions', rawText: 'no PAH' },
      { concept: 'Normal LV systolic function', status: 'present', field: 'reportImpressions', rawText: 'Normal LV systolic function' },
    ],
  });
  const { accepted, rejected, polarityMarked } = await normalizeWithLlm(input, fake);
  // ALL THREE SURVIVE — nothing is dropped. That is the whole change.
  assert.equal(accepted.length, 3, 'marking is behaviourally inert: no finding is removed');
  const marked = accepted.filter((f) => f.polaritySuspect === true).map((f) => f.concept);
  assert.deepEqual(marked, ['No obvious regional wall motion abnormalities', 'No PAH']);
  assert.equal(accepted.find((f) => f.concept === 'Normal LV systolic function')!.polaritySuspect, undefined);
  assert.deepEqual(polarityMarked.map((p) => p.concept), ['No obvious regional wall motion abnormalities', 'No PAH']);
  assert.deepEqual(rejected, [], 'a mark is NOT a rejection — the two meters never merge');
});

test('polarity MARKER: the bank cases that killed the FILTER are kept, and merely annotated', async () => {
  // These are the three red-flag DDx signs the reject-version deleted. Under the marker they are
  // PRESENT — annotated at worst. This test is the reason the design changed.
  const cases: Array<[string, string]> = [
    ['absent distal pulses', 'Cool, mottled leg; absent distal pulses; reduced sensation.'],
    ['absent bowel sounds', 'Rigid, board-like abdomen with rebound; absent bowel sounds.'],
    ['not using contraception', 'Last menstrual period ~7 weeks ago; not using contraception.'],
  ];
  for (const [span, exam] of cases) {
    const r = await normalizeWithLlm(
      { surface: 'ddx', fields: { exam } },
      async () => JSON.stringify({ findings: [{ concept: span, status: 'present', field: 'exam', rawText: span }] }),
    );
    assert.equal(r.accepted.length, 1, `"${span}" must SURVIVE — deleting it lost a cannot-miss sign`);
    assert.equal(r.accepted[0].concept, span);
    assert.equal(r.rejected.length, 0);
  }
});

test('polarity MARKER: cue immediately LEFT of the span marks too', async () => {
  const input: ExtractInput = { surface: 'ddx', fields: { history: 'headache. no evidence of focal deficit today' } };
  const fake = async () => JSON.stringify({
    findings: [{ concept: 'focal deficit', status: 'present', field: 'history', rawText: 'focal deficit' }],
  });
  const r = await normalizeWithLlm(input, fake);
  assert.equal(r.accepted.length, 1, 'kept');
  assert.equal(r.accepted[0].polaritySuspect, true, 'and marked');
});

test('polarity MARKER: head-governed ONLY — a mid-span cue is a modifier, and absent/historical are untouched', async () => {
  const input: ExtractInput = {
    surface: 'ddx',
    fields: { history: 'epigastric pain not relieved by antacids. non-productive cough. No fever.' },
  };
  const fake = async () => JSON.stringify({
    findings: [
      { concept: 'pain not relieved by antacids', status: 'present', field: 'history', rawText: 'pain not relieved by antacids' },
      { concept: 'non-productive cough', status: 'present', field: 'history', rawText: 'non-productive cough' },
      { concept: 'fever', status: 'absent', field: 'history', rawText: 'No fever' },
    ],
  });
  const r = await normalizeWithLlm(input, fake);
  assert.equal(r.accepted.length, 3);
  assert.equal(r.polarityMarked.length, 0, 'no mark: mid-span cue, non-, and a correctly-absent status');
  assert.ok(r.accepted.every((f) => f.polaritySuspect === undefined));
});

test('polarity MARKER: a marked finding still validates against the .strict() schema', async () => {
  const s0 = deterministicExtract({ surface: 'ddx', fields: { history: 'headache' } });
  const r = await normalizeWithLlm(
    { surface: 'ddx', fields: { exam: 'no murmur' } },
    async () => JSON.stringify({ findings: [{ concept: 'murmur', status: 'present', field: 'exam', rawText: 'no murmur' }] }),
  );
  const merged = mergeLlmFindings(s0, r);
  assert.ok(merged.positives.some((f) => f.polaritySuspect === true));
  assert.deepEqual(validateClinicalState(merged), merged, 'zod .strict() accepts the new field');
});

// ── from-primitives wiring ──

const PARSED: ParsedInvestigations = {
  raw: 'K 6.8, Hb 13.9',
  findings: [
    { test: 'Potassium', value: '6.8', unit: 'mmol/L', flag: 'critical', category: 'lab', note: 'hyperkalemia' },
    { test: 'Hb', value: '13.9', unit: 'g/dL', flag: 'normal', category: 'lab', note: null },
  ],
  summary: 'hyperkalemia',
  abnormalTerms: ['hyperkalemia'],
  promptBlock: '(unused here)',
  structured: true,
};

test('applyParsedInvestigations: rows land verbatim; only abnormals become positive findings', () => {
  const s = applyParsedInvestigations(deterministicExtract(INPUT), PARSED);
  assert.equal(s.investigations.length, 2);
  const k = s.positives.find((f) => f.concept === 'hyperkalemia');
  assert.ok(k, 'abnormal investigation is a stated positive finding');
  assert.equal(k!.provenance.sourceField, 'investigations');
  assert.ok(!s.positives.some((f) => f.concept === 'Hb'), 'normal rows never become findings');
  assert.deepEqual(validateClinicalState(s), s);
});

test('buildDdxClinicalState composes stage 1 + investigations; floor + priors wire through', () => {
  const s = buildDdxClinicalState(
    { age: 62, sex: 'M', cc: INPUT.fields.complaint, history: INPUT.fields.history, exam: INPUT.fields.exam, vitals: INPUT.fields.vitals },
    PARSED,
  );
  assert.equal(s.surface, 'ddx');
  assert.equal(s.investigations.length, 2);
  const rules = floorRulesFor(s);
  assert.ok(rules.some((r) => r.analyte === 'potassium'), 'cannot-miss floor sees the potassium row');
  const prior = priorFor(s, 'potassium');
  assert.ok(prior && prior.stratum === 'M 60+', 'stratified prior resolves from demographics');
  assert.deepEqual(validateClinicalState(s), s);
});
