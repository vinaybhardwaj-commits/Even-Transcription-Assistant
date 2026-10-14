import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  branchForVerdict, floorFor, buildConcordancePrompt, parseConcordance,
  scoreCase, summarize, type CaseExpectation,
  initInterview, normalizeBelief, topBelief, isUnknownAnswer, shouldStop,
  recordTurn, toVerdictContext, parseSeed, parseNextQuestion, DEFAULT_INTERVIEW_OPTS,
  type NextQuestion, type InterviewState,
  extractDemographics, buildRunRecord, CONCORDANCE_ENGINE,
  populationLines, POPULATION_PRIORS,
  coarseBand, effectivePrior, STRATIFIED_PRIORS,
  inferUnit, resultHasUnit, unitAnnotations, unitContext,
} from '../concordance-core.ts';

test('branchForVerdict maps verdicts to branches', () => {
  assert.equal(branchForVerdict('discordant-likely-error'), 'A');
  assert.equal(branchForVerdict('discordant-likely-real'), 'B');
  assert.equal(branchForVerdict('concordant'), 'none');
  assert.equal(branchForVerdict('indeterminate'), 'none');
});

test('floorFor detects in-scope analytes and dedups', () => {
  const k = floorFor('Potassium 6.8 mmol/L (ref 3.5-5.1)');
  assert.ok(k.some((r) => r.analyte === 'potassium'));
  const ca = floorFor('Calcium 11.8 mg/dL');
  assert.ok(ca.some((r) => r.analyte === 'calcium'));
  const none = floorFor('Vitamin B12 300 pg/mL');
  assert.equal(none.length, 0);
});

test('prompt injects the cannot-miss floor for the analyte', () => {
  const { system, user } = buildConcordancePrompt('Potassium 6.8 mmol/L', '58F asymptomatic');
  assert.match(system, /BRANCH A/);
  assert.match(user, /CANNOT-MISS FLOOR/);
  assert.match(user, /hyperkalemia/i);
});

test('parser extracts a single committed verdict', () => {
  const raw = [
    'VERDICT: discordant-likely-error',
    'CONFIDENCE: moderate — capped by unknown hemolysis index',
    'BRANCH A (error): pseudohyperkalemia from tourniquet',
    'BRANCH B (real): true hyperkalemia — cannot-miss cardiac risk',
    'DECISIVE GAP: hemolysis index on the drawn sample',
    'VoI LEDGER: hemolysis index · lab · run on existing sample · high · yes',
    'NEXT STEP: hemolysis index, then plasma repeat',
    'GROUNDING: clinical-reasoning',
  ].join('\n');
  const p = parseConcordance(raw);
  assert.equal(p.verdict, 'discordant-likely-error');
  assert.equal(p.multipleVerdicts, false);
  assert.equal(p.branch, 'A');
  assert.equal(p.confidence, 'moderate');
  assert.equal(p.confidenceCapped, true);
  assert.match(p.decisiveGap, /hemolysis index/);
});

test('parser flags multiple verdicts (the A1 mini failure mode)', () => {
  const raw = 'VERDICT: discordant-likely-real | indeterminate\nCONFIDENCE: moderate';
  const p = parseConcordance(raw);
  assert.equal(p.multipleVerdicts, true);
});

test('scoreCase: correct branch-A verdict + gap hit + cannot-miss covered', () => {
  const exp: CaseExpectation = {
    id: 'A1', category: 'branchA', expectedVerdict: 'discordant-likely-error', expectedBranch: 'A',
    decisiveGapKeywords: ['hemolysis'], cannotMissKeywords: ['hyperkalemia'],
  };
  const p = parseConcordance([
    'VERDICT: discordant-likely-error',
    'BRANCH B (real): true hyperkalemia risk',
    'DECISIVE GAP: hemolysis index',
  ].join('\n'));
  const s = scoreCase(exp, p);
  assert.equal(s.verdictMatch, true);
  assert.equal(s.branchMatch, true);
  assert.equal(s.decisiveGapHit, true);
  assert.equal(s.cannotMissCovered, true);
  assert.equal(s.overFlagged, false);
});

test('scoreCase: control marked discordant is over-flagged', () => {
  const exp: CaseExpectation = {
    id: 'C1', category: 'control', expectedVerdict: 'concordant', expectedBranch: 'none',
    decisiveGapKeywords: ['fasting'],
  };
  const p = parseConcordance('VERDICT: discordant-likely-real\nDECISIVE GAP: none');
  const s = scoreCase(exp, p);
  assert.equal(s.overFlagged, true);
  assert.equal(s.verdictMatch, false);
});

// ── Unit inference ──

test('inferUnit picks the unit by magnitude and flags the ambiguous zone', () => {
  assert.equal(inferUnit('potassium', 6.8).unit, 'mmol/L');
  assert.equal(inferUnit('calcium', 11.8).unit, 'mg/dL');
  assert.equal(inferUnit('calcium', 2.4).unit, 'mmol/L');
  assert.equal(inferUnit('calcium', 4.0).ambiguous, true); // 4.0 fits both mg/dL and mmol/L
  assert.equal(inferUnit('hemoglobin', 11.5).unit, 'g/dL');
  assert.equal(inferUnit('hemoglobin', 115).unit, 'g/L');
});

test('resultHasUnit / unitAnnotations only annotate when no unit is typed', () => {
  assert.equal(resultHasUnit('Calcium 11.8 mg/dL'), true);
  assert.equal(resultHasUnit('Calcium 11.8'), false);
  assert.equal(unitAnnotations('Calcium 11.8 mg/dL').length, 0);
  const a = unitAnnotations('Calcium 11.8');
  assert.equal(a.length, 1);
  assert.equal(a[0].analyte, 'calcium');
  assert.match(a[0].inference.unit!, /mg\/dL/);
});

test('unitContext flags ambiguity for a clarifying question, assumes otherwise', () => {
  assert.equal(unitContext('Potassium 6.8').ambiguous, false);
  assert.match(unitContext('Potassium 6.8').line, /mmol\/L/);
  assert.equal(unitContext('Calcium 4.0').ambiguous, true);
  assert.equal(unitContext('Calcium 11.8 mg/dL').line, ''); // unit given → nothing to infer
});

// ── P3.2a population priors ──

test('populationLines flags an extreme value against real base rates', () => {
  const k = populationLines('Potassium 6.8 mmol/L (ref 3.5-5.1)');
  assert.equal(k.length, 1);
  assert.match(k[0], /potassium/);
  assert.match(k[0], /99th percentile/);
  assert.match(k[0], /markedly extreme/);
  assert.match(k[0], /\(6\.8\)/);
});

test('populationLines handles comma numbers and returns nothing off-scope', () => {
  const wbc = populationLines('WBC 15,000 x10^9/L');
  assert.equal(wbc.length, 1);
  assert.match(wbc[0], /\(15000\)/);
  assert.equal(populationLines('Glucose 240 mg/dL').length, 0);
});

test('POPULATION_PRIORS covers the tight analyte set', () => {
  for (const a of ['potassium', 'sodium', 'calcium', 'hemoglobin', 'platelets', 'wbc', 'ferritin', 'alt', 'ast', 'alp', 'tsh', 'ft4']) {
    assert.ok(POPULATION_PRIORS[a], `missing prior for ${a}`);
    assert.ok(POPULATION_PRIORS[a].p99 > POPULATION_PRIORS[a].p50);
  }
});

// ── P1 interview core ──

test('normalizeBelief sums to 1 and topBelief picks the leader', () => {
  const b = normalizeBelief([
    { cause: 'hemolysis', branch: 'A', weight: 1 },
    { cause: 'true hyperkalemia', branch: 'B', weight: 3 },
  ]);
  const sum = b.reduce((s, i) => s + i.weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.equal(topBelief(b)!.cause, 'true hyperkalemia');
});

test('isUnknownAnswer recognises "I don\'t have this" variants', () => {
  for (const a of ['I don\'t have this', 'I do not have this', 'Unknown', 'not measured', 'N/A', 'no data', 'Not documented']) assert.equal(isUnknownAnswer(a), true);
  for (const a of ['Albumin normal', '6.8']) assert.equal(isUnknownAnswer(a), false);
});

test('shouldStop fires on cap, confidence, unknown-streak, and belief threshold', () => {
  const base = initInterview('K 6.8', 'asx');
  assert.equal(shouldStop({ ...base, askedCount: 6 }, DEFAULT_INTERVIEW_OPTS), true);
  assert.equal(shouldStop({ ...base, leadConfidence: 0.75 }, DEFAULT_INTERVIEW_OPTS), true);
  assert.equal(shouldStop({ ...base, unknownStreak: 2 }, DEFAULT_INTERVIEW_OPTS), true);
  assert.equal(shouldStop({ ...base, belief: [{ cause: 'x', branch: 'B', weight: 0.8 }] }, DEFAULT_INTERVIEW_OPTS), true);
  assert.equal(shouldStop({ ...base, askedCount: 2, unknownStreak: 1, leadConfidence: 0.4, belief: [{ cause: 'x', branch: 'B', weight: 0.4 }] }, DEFAULT_INTERVIEW_OPTS), false);
});

test('recordTurn tracks unknown streak (resets on an answer) and lifts leadConfidence', () => {
  const nq: NextQuestion = { stop: false, question: 'q1', whoKnows: 'you', why: 'w', options: [], confidence: 0.3 };
  let s: InterviewState = { ...initInterview('Ca 11.8', 'asx'), status: 'asking' };
  s = recordTurn(s, nq, 'I don\'t have this');
  assert.equal(s.unknownStreak, 1);
  assert.equal(s.leadConfidence, 0.3);
  s = recordTurn(s, { ...nq, question: 'q2', confidence: 0.55 }, 'Albumin normal');
  assert.equal(s.unknownStreak, 0);
  assert.equal(s.leadConfidence, 0.55);
  s = recordTurn(s, { ...nq, question: 'q3' }, 'not measured');
  s = recordTurn(s, { ...nq, question: 'q4' }, 'unknown');
  assert.equal(s.unknownStreak, 2);
});

test('recordTurn logs an open gap on "I don\'t have this" and increments count', () => {
  const nq: NextQuestion = { stop: false, question: 'Albumin?', whoKnows: 'you', why: 'w', options: ['high', 'normal'] };
  const s0 = { ...initInterview('Ca 11.8', 'asx'), status: 'asking' as const };
  const s1 = recordTurn(s0, nq, 'Albumin normal');
  assert.equal(s1.askedCount, 1);
  assert.equal(s1.openGaps.length, 0);
  const s2 = recordTurn(s1, { ...nq, question: 'PTH?' }, 'I don\'t have this');
  assert.equal(s2.askedCount, 2);
  assert.equal(s2.openGaps.length, 1);
  assert.equal(s2.openGaps[0].gap, 'PTH?');
});

test('toVerdictContext folds transcript + open gaps into the context', () => {
  let s: InterviewState = { ...initInterview('Ca 11.8', '56F asymptomatic'), status: 'asking' };
  s = recordTurn(s, { stop: false, question: 'Albumin raised?', whoKnows: 'you', why: 'w', options: [] }, 'normal');
  s = recordTurn(s, { stop: false, question: 'PTH?', whoKnows: 'you', why: 'w', options: [] }, 'Unknown');
  const ctx = toVerdictContext(s);
  assert.match(ctx, /56F asymptomatic/);
  assert.match(ctx, /Albumin raised\? -> normal/);
  assert.match(ctx, /not available/i);
  assert.match(ctx, /PTH\?/);
});

test('parseSeed reads branch|weight|cause lines and normalises', () => {
  const b = parseSeed('A|0.5|hemolysis from difficult draw\nB|1.5|true hyperkalemia\ngarbage line');
  assert.equal(b.length, 2);
  assert.ok(Math.abs(b.reduce((s, i) => s + i.weight, 0) - 1) < 1e-9);
  assert.equal(topBelief(b)!.branch, 'B');
});

test('parseSeed tolerates a stray leading label (BRANCH|B|0.4|cause)', () => {
  const b = parseSeed('BRANCH|B|0.4|primary hyperparathyroidism\nBRANCH|A|0.15|EDTA contamination');
  assert.equal(b.length, 2);
  assert.equal(topBelief(b)!.cause, 'primary hyperparathyroidism');
});

test('parseNextQuestion parses a question and detects STOP', () => {
  const q = parseNextQuestion('QUESTION: Is the albumin raised?\nWHOKNOWS: you\nWHY: separates hemoconcentration\nOPTIONS: high | normal | unknown\nCONFIDENCE: 0.45');
  assert.equal(q.stop, false);
  assert.equal(q.whoKnows, 'you');
  assert.match(q.question, /albumin/);
  assert.equal(q.options.length, 3);
  assert.equal(q.confidence, 0.45);
  assert.equal(parseNextQuestion('QUESTION: STOP\nCONFIDENCE: 0.8').stop, true);
});

// ── P2 walled run record (de-id) ──

test('extractDemographics reads compact and worded forms, else null', () => {
  assert.deepEqual(extractDemographics('56F, ambulatory, asymptomatic'), { age: 56, ageBand: '50-59', sex: 'F' });
  assert.deepEqual(extractDemographics('44M routine'), { age: 44, ageBand: '40-49', sex: 'M' });
  assert.deepEqual(extractDemographics('a 72-year-old woman with a fall'), { age: 72, ageBand: '70-79', sex: 'F' });
  assert.deepEqual(extractDemographics('no demographics here'), { age: null, ageBand: null, sex: null });
});

test('coarseBand maps age to the mined bands', () => {
  assert.equal(coarseBand(30), '18-39');
  assert.equal(coarseBand(50), '40-59');
  assert.equal(coarseBand(72), '60+');
  assert.equal(coarseBand(null), null);
});

test('effectivePrior uses the sex cell (Hb F<M) and falls back when a cell is sparse/missing', () => {
  const f = effectivePrior('hemoglobin', 'F', '18-39')!;
  const m = effectivePrior('hemoglobin', 'M', '18-39')!;
  assert.equal(f.stratum, 'F 18-39');
  assert.ok(f.p50 < m.p50, 'female Hb median below male');           // real sex difference preserved
  assert.ok(Math.abs(f.p50 - 12.4) < 0.5 && Math.abs(m.p50 - 15.0) < 0.5);
  // ferritin M 60+ cell is not stored (too sparse) → parent fallback (stratum null)
  const fer = effectivePrior('ferritin', 'M', '60+')!;
  assert.equal(fer.stratum, null);
  assert.equal(fer.p50, POPULATION_PRIORS.ferritin.p50);
  // no demographics → unstratified parent
  const none = effectivePrior('potassium', null, null)!;
  assert.equal(none.stratum, null);
});

test('populationLines is sex-stratified when the context gives age/sex', () => {
  const f = populationLines('Hemoglobin 11.5 g/dL', '30F')[0];
  const m = populationLines('Hemoglobin 11.5 g/dL', '30M')[0];
  assert.match(f, /F 18-39/);
  assert.match(m, /M 18-39/);
  // 11.5 is within range for a young woman but low for a young man
  assert.match(m, /below the 2.5th percentile|low for this group/);
});

test('buildRunRecord is de-identified: analytes + verdict + counts, no raw text', () => {
  let s: InterviewState = { ...initInterview('Calcium 11.8 mg/dL', '56F asymptomatic'), status: 'asking' };
  s = recordTurn(s, { stop: false, question: 'Albumin raised?', whoKnows: 'report', why: 'w', options: [] }, 'normal');
  s = recordTurn(s, { stop: false, question: 'PTH?', whoKnows: 'lab', why: 'w', options: [] }, 'I do not have this');
  const rec = buildRunRecord('Calcium 11.8 mg/dL', '56F asymptomatic', { verdict: 'discordant-likely-real', confidence: 'moderate' }, 'interview', s);
  assert.deepEqual(rec.analytes, ['calcium']);
  assert.equal(rec.verdict, 'discordant-likely-real');
  assert.equal(rec.branch, 'B');
  assert.equal(rec.askedCount, 2);
  assert.equal(rec.unknownCount, 1);
  assert.equal(rec.whoReport, 1);
  assert.equal(rec.whoLab, 1);
  assert.equal(rec.ageBand, '50-59');
  assert.equal(rec.sex, 'F');
  assert.equal(rec.engine, CONCORDANCE_ENGINE);
  // no raw context / answers on the record
  assert.equal(Object.values(rec).some((v) => typeof v === 'string' && /asymptomatic|PTH/.test(v)), false);
});

test('summarize aggregates the bank', () => {
  const scores = [
    scoreCase({ id: 'A1', category: 'branchA', expectedVerdict: 'discordant-likely-error', expectedBranch: 'A', decisiveGapKeywords: ['x'] },
      parseConcordance('VERDICT: discordant-likely-error')),
    scoreCase({ id: 'C1', category: 'control', expectedVerdict: 'concordant', expectedBranch: 'none', decisiveGapKeywords: ['x'] },
      parseConcordance('VERDICT: concordant')),
  ];
  const sum = summarize(scores);
  assert.equal(sum.n, 2);
  assert.equal(sum.verdictAccuracy, 1);
  assert.equal(sum.controlOverFlagRate, 0);
});
