// lib/__tests__/right-care-ground.test.ts — Right Care × ClinicalState Slice 2.
// The gate's unit-provable checks: FLAG-OFF BYTE-IDENTICAL prompts in every grounded builder
// (the neutrality contract this slice ships under), the picture block's rules, the double
// flag gate, the frozen bank's shape, and the A/B referee (pair-judge parser, deterministic
// check diff, scorecard gates). Run: npm test.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildJudgeUser, type LvcRecommendation } from '../lvc-core';
import { buildSkeletonUser, buildEnrichUser, type SkeletonStage } from '../pathway-core';
import { buildAnalyzeUser, type ExtractedCase } from '../doc-audit-core';
import { rightCareGroundingEnabled, patientPictureBlock, buildRightCareState, rightCareExtractInput } from '../right-care-state';
import { formatClinicalState } from '../clinical-state/format';
import {
  GROUND_BANK, RIGHT_CARE_EVAL_BANK,
  checkView, diffCheckFlags, parsePairJudgeResponse, summarizeMode, buildPairJudgeUser,
  type CasePair,
} from '../right-care-ground-eval-core';

beforeEach(() => {
  delete process.env.RIGHT_CARE_CLINICAL_STATE;
  delete process.env.RIGHT_CARE_CLINICAL_STATE_GROUND;
});

const REC: LvcRecommendation = {
  id: 'IN-001', region: 'IN', society: 'Soc', specialty: null,
  statement: 'Do not image low back pain within 6 weeks without red flags.',
  precondition: 'No red flags', action_type: null, consider_instead: null, rationale: null,
  keywords: [], citation_doi: null, citation_pmid: null, citation_url: null,
  source_release_year: null,
};
const STAGES: SkeletonStage[] = [{ id: 's1', kind: 'assessment', title: 'Assess', action: 'Focused exam', flag: 'essential' }];
const EC: ExtractedCase = {
  docType: 'opd_rx', detectedDocType: 'opd_rx', confidence: 0.8,
  patient: { age: 24, sex: 'male' },
  diagnosis: 'Viral pharyngitis', indication: null, procedure: null,
  investigations: ['CBC'], treatments: [], medications: ['Azithromycin'],
  courseSummary: 'Sore throat 2 days.', disposition: null, followUp: null, rawNotes: '',
};
const PICTURE = 'PATIENT PICTURE (test):\nPatient: 34y M\nExplicitly negative: fever';

test('flag-off byte-identical: every grounded builder without the param equals Slice 1 exactly', () => {
  const ctx = { scenario: 'low back pain, no red flags', patient: { age: 34, sex: 'M' } };
  // omitted === undefined === Slice-1 template, and no picture text anywhere
  const judgeOff = buildJudgeUser(ctx, [REC]);
  assert.equal(judgeOff, buildJudgeUser(ctx, [REC], undefined));
  assert.equal(judgeOff, buildJudgeUser(ctx, [REC], ''));
  assert.equal(judgeOff,
    `Patient: 34y, M\nClinical scenario / proposed plan:\nlow back pain, no red flags\n\nCandidate recommendations to judge:\n` +
    `1. id=IN-001 [IN/Soc]\n   STATEMENT: Do not image low back pain within 6 weeks without red flags.\n   PRECONDITION: No red flags`);
  // Fix-3 ordered-action param (RIGHT_CARE_JUDGE_SEES_ACTION): absent / empty / whitespace-only
  // renders NOTHING → byte-identical to Slice 1 (the flag-off neutrality contract).
  assert.equal(judgeOff, buildJudgeUser(ctx, [REC], undefined, undefined));
  assert.equal(judgeOff, buildJudgeUser(ctx, [REC], undefined, []));
  assert.equal(judgeOff, buildJudgeUser(ctx, [REC], undefined, ['   ', '']));

  const skelOff = buildSkeletonUser({ scenario: 'sc', patient: { age: 34 } });
  assert.equal(skelOff, buildSkeletonUser({ scenario: 'sc', patient: { age: 34 }, clinicalStateText: undefined }));
  assert.equal(skelOff, 'Patient: 34y\nClinical scenario:\nsc');

  const enrichOff = buildEnrichUser({ scenario: 'sc' }, STAGES, 'ctx');
  assert.equal(enrichOff, buildEnrichUser({ scenario: 'sc', clinicalStateText: '' }, STAGES, 'ctx'));
  assert.ok(!enrichOff.includes('PATIENT PICTURE'));

  const analyzeOff = buildAnalyzeUser(EC, 'ctx', 'OPD');
  assert.equal(analyzeOff, buildAnalyzeUser(EC, 'ctx', 'OPD', undefined));
  assert.ok(!analyzeOff.includes('PATIENT PICTURE'));
});

test('grounded: the picture lands between the input and the downstream sections, verbatim', () => {
  const ctx = { scenario: 'low back pain', patient: { age: 34, sex: 'M' } };
  const judgeOn = buildJudgeUser(ctx, [REC], PICTURE);
  assert.ok(judgeOn.includes(PICTURE));
  assert.ok(judgeOn.indexOf(PICTURE) > judgeOn.indexOf('Clinical scenario / proposed plan:'));
  assert.ok(judgeOn.indexOf(PICTURE) < judgeOn.indexOf('Candidate recommendations to judge:'));

  // Fix-3: the ORDERED ACTION(S) section lands between the input/picture and the candidate list,
  // carries each action verbatim, and drops whitespace-only entries.
  const judgeAct = buildJudgeUser(ctx, [REC], PICTURE, ['CT coronary calcium score', '  ']);
  assert.ok(judgeAct.includes('ORDERED ACTION(S) UNDER REVIEW'));
  assert.ok(judgeAct.includes('- CT coronary calcium score'));
  assert.ok(!judgeAct.includes('-   \n'), 'whitespace-only action dropped');
  assert.ok(judgeAct.indexOf('ORDERED ACTION(S) UNDER REVIEW') > judgeAct.indexOf(PICTURE));
  assert.ok(judgeAct.indexOf('ORDERED ACTION(S) UNDER REVIEW') < judgeAct.indexOf('Candidate recommendations to judge:'));

  const skelOn = buildSkeletonUser({ scenario: 'sc', clinicalStateText: PICTURE });
  assert.ok(skelOn.endsWith(PICTURE));

  const enrichOn = buildEnrichUser({ scenario: 'sc', clinicalStateText: PICTURE }, STAGES, 'evidence');
  assert.ok(enrichOn.indexOf(PICTURE) < enrichOn.indexOf('STAGES TO ENRICH'));

  const analyzeOn = buildAnalyzeUser(EC, 'evidence', 'OPD', PICTURE);
  assert.ok(analyzeOn.indexOf(PICTURE) > analyzeOn.indexOf('EXTRACTED CASE:'));
  assert.ok(analyzeOn.indexOf(PICTURE) < analyzeOn.indexOf('NUMBERED EVIDENCE EXCERPTS:'));
});

test('patientPictureBlock: formatClinicalState content + the two prompt rules', async () => {
  const built = await buildRightCareState(rightCareExtractInput('check', {
    scenario: 'chest pain, no fever', age: 60, sex: 'F',
  }));
  const block = patientPictureBlock(built!.state);
  assert.ok(block.startsWith('PATIENT PICTURE'));
  assert.ok(block.includes(formatClinicalState(built!.state)));
  assert.match(block, /never assume/i);
  assert.match(block, /do not introduce any finding/i);
});

test('grounding flag is double-gated on the master flag', () => {
  assert.equal(rightCareGroundingEnabled(), false);
  process.env.RIGHT_CARE_CLINICAL_STATE_GROUND = '1';
  assert.equal(rightCareGroundingEnabled(), false, 'GROUND alone must not enable');
  process.env.RIGHT_CARE_CLINICAL_STATE = '1';
  assert.equal(rightCareGroundingEnabled(), true);
  delete process.env.RIGHT_CARE_CLINICAL_STATE_GROUND;
  assert.equal(rightCareGroundingEnabled(), false);
});

test('frozen bank right-care-eval/1.0: pinned, unique ids, per-mode shape', () => {
  assert.equal(RIGHT_CARE_EVAL_BANK, 'right-care-eval/1.0');
  const ids = GROUND_BANK.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique');
  const byMode = { check: 0, pathway: 0, audit: 0 };
  for (const c of GROUND_BANK) {
    byMode[c.mode]++;
    if (c.mode === 'audit') assert.ok(c.extracted, `${c.id} needs extracted`);
    else assert.ok(c.scenario && c.scenario.length > 10, `${c.id} needs a scenario`);
    assert.ok(c.note, `${c.id} needs a bank note`);
  }
  assert.deepEqual(byMode, { check: 8, pathway: 6, audit: 4 });
  // the bank note is report-only — it must never reach the judge prompt
  for (const c of GROUND_BANK) {
    assert.ok(!buildPairJudgeUser(c, {}, {}).includes(c.note), `${c.id} note leaked to the judge`);
  }
});

test('pair-judge parser: defensive on directions, safety classes, fences', () => {
  const v = parsePairJudgeResponse('```json\n{"overall":"improvement","changes":[{"item":"x","direction":"weird"},{"item":"","direction":"regression"}],"safety":[{"class":"catch_suppressed","item":"MRI flag"},{"class":"made_up","item":"y"}],"note":"n"}\n```');
  assert.equal(v.overall, 'improvement');
  assert.equal(v.changes.length, 1);
  assert.equal(v.changes[0].direction, 'neutral', 'unknown direction folds to neutral');
  assert.equal(v.safety.length, 1, 'unknown safety class dropped, never invented');
  assert.equal(v.safety[0].class, 'catch_suppressed');
  assert.equal(parsePairJudgeResponse('{"overall":"nonsense"}').overall, 'neutral');
  assert.throws(() => parsePairJudgeResponse('no json at all'));
});

test('deterministic check diff: added / removed / kept by rec id', () => {
  const off = checkView({ flags: [{ id: 'A', statement: '', why_it_applies: '', confidence: 0.8 } as never], considered: 3 });
  const on = checkView({ flags: [{ id: 'A', statement: '', why_it_applies: '', confidence: 0.9 } as never, { id: 'B', statement: '', why_it_applies: '', confidence: 0.7 } as never], considered: 3 });
  assert.deepEqual(diffCheckFlags(off, on), { added: ['B'], removed: [], kept: ['A'] });
  assert.deepEqual(diffCheckFlags(on, off), { added: [], removed: ['B'], kept: ['A'] });
});

test('scorecard gates: FAIL_SAFETY dominates; PASS needs net improvement clearing noise', () => {
  const ok = (overall: 'improvement' | 'neutral' | 'regression'): CasePair => ({
    caseId: 'X', verdict: { overall, changes: [], safety: [], note: '' },
  });
  const unsafe: CasePair = {
    caseId: 'C02', verdict: { overall: 'improvement', changes: [], note: '',
      safety: [{ class: 'appropriate_flipped_low_value', item: 'MRI lumbar spine' }] },
  };
  assert.equal(summarizeMode('check', [ok('improvement'), unsafe], null).gate, 'FAIL_SAFETY');
  // net improvement, quiet noise floor → PASS
  const noisy = summarizeMode('check',
    [ok('improvement'), ok('improvement'), ok('neutral')],
    [ok('neutral'), ok('neutral')]);
  assert.equal(noisy.gate, 'PASS');
  assert.equal(noisy.clearsNoise, true);
  // all-neutral → NO_SIGNAL (the expected Record-audit outcome)
  assert.equal(summarizeMode('audit', [ok('neutral'), ok('neutral')], [ok('neutral')]).gate, 'NO_SIGNAL');
  // delta that does NOT clear a noisy floor → NO_SIGNAL even with an improvement
  const drowned = summarizeMode('check', [ok('improvement'), ok('neutral')], [ok('improvement'), ok('improvement')]);
  assert.equal(drowned.clearsNoise, false);
  assert.equal(drowned.gate, 'NO_SIGNAL');
});
