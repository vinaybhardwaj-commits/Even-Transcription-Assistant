import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runGuards, parseJudgeResponse, summarizePath, headToHead, proposePromotionThreshold,
  scoreExtractorVsGold, calibrateJudge, buildJudgeUser, judgeStateView, adaptGoldSeed,
  CHECKLIST_SENTINEL, EXTRACTION_BANK,
  type SourceFields, type JudgeResult, type GoldSeed, type JudgeDimensionScores,
} from '../clinical-state/extraction-eval-core.ts';
import { emptyClinicalState, mkFindingId, type ClinicalState, type FindingStatus } from '../clinical-state/schema.ts';

function mk(concept: string, status: FindingStatus, field: string, rawText: string, method: 'deterministic' | 'llm' = 'deterministic', offsets?: [number, number]) {
  return {
    id: mkFindingId(concept, field, status), concept, status,
    provenance: {
      sourceField: field, rawText, extractionMethod: method, confidence: 0.9,
      ...(offsets ? { startOffset: offsets[0], endOffset: offsets[1] } : {}),
    },
  };
}

const FIELDS: SourceFields = {
  complaint: 'Central crushing chest pain for 40 minutes',
  history: 'No fever, no cough. Hypertension.',
  exam: 'Diaphoretic',
  vitals: 'HR 98, BP 150/92',
};

function detState(): ClinicalState {
  const s = emptyClinicalState('ddx');
  s.positives.push(mk('Central crushing chest pain for 40 minutes', 'present', 'complaint', 'Central crushing chest pain for 40 minutes'));
  s.positives.push(mk('heart rate', 'present', 'vitals', 'HR 98'));
  s.negatives.push(mk('fever', 'absent', 'history', 'No fever'));
  s.unknowns.push(mk('syncope', 'unknown', 'checklist', CHECKLIST_SENTINEL));
  return s;
}

// ── H2 guards ──────────────────────────────────────────────────────────────────

test('runGuards: clean deterministic state — every asserted rawText verbatim, sentinel exempt', () => {
  const g = runGuards('D01', 'deterministic', FIELDS, detState(), 0);
  assert.equal(g.nFindings, 4);
  assert.equal(g.nAsserted, 3);         // 2 positives + 1 negative; the unknown is excluded
  assert.equal(g.nUnknowns, 1);
  assert.equal(g.nVerbatim, 3);
  assert.equal(g.fabricated.length, 0);
  assert.equal(g.noFabRate, 1);
  assert.equal(g.nStatusInvalid, 0);
});

test('runGuards: a finding whose rawText is NOT in its field is caught as fabricated', () => {
  const s = detState();
  s.positives.push(mk('pneumonia', 'present', 'exam', 'bibasal crackles')); // not in exam text
  const g = runGuards('D01', 'llm', FIELDS, s, 2);
  assert.equal(g.fabricated.length, 1);
  assert.equal(g.fabricated[0].concept, 'pneumonia');
  assert.equal(g.rejectedSpans, 2);
  assert.equal(g.nAsserted, 4);
  assert.equal(g.nVerbatim, 3);
  assert.ok(Math.abs(g.noFabRate - 0.75) < 1e-9);
});

test('runGuards: sentinel unknown is never a fabrication even though "(not mentioned)" is not in the text', () => {
  const s = emptyClinicalState('ddx');
  s.unknowns.push(mk('bleeding', 'unknown', 'checklist', CHECKLIST_SENTINEL));
  const g = runGuards('DX', 'deterministic', FIELDS, s, 0);
  assert.equal(g.fabricated.length, 0);
  assert.equal(g.noFabRate, 1);   // no asserted findings ⇒ vacuously clean
});

test('runGuards: offset validation flags a wrong span; correct offsets pass', () => {
  const s = emptyClinicalState('ddx');
  // "HR 98" occurs at index 0 of vitals → correct offsets
  s.positives.push(mk('heart rate', 'present', 'vitals', 'HR 98', 'llm', [0, 5]));
  // wrong offsets (point elsewhere) → invalid
  s.positives.push(mk('bp', 'present', 'vitals', 'BP 150/92', 'llm', [0, 5]));
  const g = runGuards('DX', 'llm', FIELDS, s, 0);
  assert.equal(g.nOffsetInvalid, 1);
  assert.ok(g.provenanceValidRate < 1);
});

// ── H3 judge parse ───────────────────────────────────────────────────────────────

test('parseJudgeResponse: fenced JSON, clamps out-of-range, defaults bad verdict, keeps missed[]', () => {
  const raw = '```json\n{"dimensions":{"recall":1.4,"statusAccuracy":0.8,"noFabrication":-0.2,"provenanceAccuracy":0.9},"findings":[{"concept":"x","status":"present","verdict":"bogus"},{"bad":true}],"missed":["appendicitis",""]}\n```';
  const j = parseJudgeResponse(raw);
  assert.equal(j.dimensions.recall, 1);        // clamped from 1.4
  assert.equal(j.dimensions.noFabrication, 0); // clamped from -0.2
  assert.equal(j.dimensions.statusAccuracy, 0.8);
  assert.equal(j.findings.length, 2);
  assert.equal(j.findings[0].verdict, 'ok');   // 'bogus' → default 'ok'
  assert.deepEqual(j.missed, ['appendicitis']); // empty string dropped
});

// ── H5 aggregation ───────────────────────────────────────────────────────────────

function judgeFixture(recall: number): JudgeResult {
  return { dimensions: { recall, statusAccuracy: 0.9, noFabrication: 1, provenanceAccuracy: 0.95 }, findings: [], missed: [] };
}

test('summarizePath: guard means aggregate; judge is ALWAYS calibrated:false', () => {
  const guards = [runGuards('A', 'llm', FIELDS, detState()), runGuards('B', 'llm', FIELDS, detState())];
  const sc = summarizePath('llm', guards, [judgeFixture(0.8), judgeFixture(0.9)]);
  assert.equal(sc.n, 2);
  assert.equal(sc.guard.noFabRate, 1);
  assert.equal(sc.guard.totalFabricated, 0);
  assert.ok(sc.judge);
  assert.equal(sc.judge!.calibrated, false);   // the trust rule: never trusted pre-H4
  assert.ok(Math.abs(sc.judge!.recall - 0.85) < 1e-9);
});

test('headToHead: llm − det deltas; judge deltas null when a path lacks judge', () => {
  const det = summarizePath('deterministic', [runGuards('A', 'deterministic', FIELDS, detState())], [judgeFixture(0.7)]);
  const llm = summarizePath('llm', [runGuards('A', 'llm', FIELDS, detState())], [judgeFixture(0.85)]);
  const h = headToHead(det, llm);
  assert.ok(Math.abs(h.deltaJudgeRecall! - 0.15) < 1e-9);
  const detNoJudge = summarizePath('deterministic', [runGuards('A', 'deterministic', FIELDS, detState())]);
  assert.equal(headToHead(detNoJudge, llm).deltaJudgeRecall, null);
});

test('proposePromotionThreshold: never armed; floor = det baseline + noise margin', () => {
  const det = summarizePath('deterministic', [runGuards('A', 'deterministic', FIELDS, detState())], [judgeFixture(0.80)]);
  const llm = summarizePath('llm', [runGuards('A', 'llm', FIELDS, detState())], [judgeFixture(0.90)]);
  const p = proposePromotionThreshold(det, llm, 0.03);
  assert.equal(p.armed, false);
  assert.equal(p.proposedFloor, 0.83);
  assert.match(p.rationale, /NOT ENFORCED/);
});

// ── H4 calibration ───────────────────────────────────────────────────────────────

const GOLD: GoldSeed = {
  version: 'ddx-extraction-gold-seed-v1', signedBy: 'V',
  cases: [{
    caseId: 'D01',
    findings: [
      { concept: 'chest pain', status: 'present' },
      { concept: 'fever', status: 'absent' },
      { concept: 'appendicitis', status: 'present' }, // deliberately NOT extracted → recall miss
    ],
  }],
};

test('scoreExtractorVsGold: recall/status matched; word-boundary match avoids ces⊂abscess', () => {
  const states = new Map<string, ClinicalState>([['D01', detState()]]);
  const r = scoreExtractorVsGold('deterministic', states, GOLD);
  assert.equal(r.nGold, 3);
  assert.equal(r.nMatched, 2);                 // chest pain + fever; appendicitis missed
  assert.ok(Math.abs(r.recall - 2 / 3) < 1e-9);
  assert.equal(r.statusAccuracy, 1);           // both matched with correct status
  // word-boundary guard: 'ces' must NOT match 'abscess'
  const s2 = emptyClinicalState('ddx');
  s2.positives.push(mk('spinal epidural abscess', 'present', 'complaint', 'Central crushing chest pain for 40 minutes'));
  const g2: GoldSeed = { version: 'v', cases: [{ caseId: 'D01', findings: [{ concept: 'ces', status: 'present' }] }] };
  assert.equal(scoreExtractorVsGold('llm', new Map([['D01', s2]]), g2).nMatched, 0);
});

test('scoreExtractorVsGold: vitals granularity fold — HR/BP names+split match gold abbrev+value', () => {
  // Gold labels vitals by abbreviation+value with BP combined; the extractor uses canonical
  // names and splits BP into systolic/diastolic. eval/2 folds them to a canonical key so each
  // gold vital is credited. Without the fold, only concepts sharing a token (spo2) would match.
  const s = emptyClinicalState('ddx');
  s.positives.push(mk('heart rate', 'present', 'vitals', 'HR 98'));
  s.positives.push(mk('systolic bp', 'present', 'vitals', 'BP 150/92'));
  s.positives.push(mk('diastolic bp', 'present', 'vitals', 'BP 150/92'));
  s.positives.push(mk('spo2', 'present', 'vitals', 'SpO2 96%'));
  const gold: GoldSeed = { version: 'v', cases: [{ caseId: 'D01', findings: [
    { concept: 'HR 98', status: 'present' },
    { concept: 'BP 150/92', status: 'present' },
    { concept: 'SpO2 96%', status: 'present' },
  ] }] };
  const r = scoreExtractorVsGold('deterministic', new Map([['D01', s]]), gold);
  assert.equal(r.nGold, 3);
  assert.equal(r.nMatched, 3);          // all three vitals credited (HR, BP, SpO2)
  assert.equal(r.recall, 1);
  // fold is conservative: a qualitative-augmented vital is NOT force-matched to a bare value
  const s2 = emptyClinicalState('ddx');
  s2.positives.push(mk('heart rate', 'present', 'vitals', 'HR 128'));
  const g2: GoldSeed = { version: 'v', cases: [{ caseId: 'D01', findings: [
    { concept: 'irregularly irregular pulse', status: 'present' }, // rhythm descriptor, not a bare vital
  ] }] };
  assert.equal(scoreExtractorVsGold('llm', new Map([['D01', s2]]), g2).nMatched, 0);
});

test('calibrateJudge: low MAE ⇒ trustworthy; high MAE ⇒ retune', () => {
  const truth = new Map<string, JudgeDimensionScores>([['D01', { recall: 0.67, statusAccuracy: 1, noFabrication: 1, provenanceAccuracy: 0.95 }]]);
  const close = new Map<string, JudgeResult>([['D01', judgeFixture(0.65)]]); // judgeFixture status .9 noFab 1 prov .95
  const cclose = calibrateJudge(close, truth, 0.85);
  assert.equal(cclose.nSeedCases, 1);
  assert.equal(cclose.verdict, 'trustworthy');
  const far = new Map<string, JudgeResult>([['D01', judgeFixture(0.1)]]);
  const cfar = calibrateJudge(far, new Map([['D01', { recall: 0.9, statusAccuracy: 0.2, noFabrication: 0.3, provenanceAccuracy: 0.2 }]]), 0.85);
  assert.equal(cfar.verdict, 'retune-judge');
});

// ── misc ─────────────────────────────────────────────────────────────────────────

test('buildJudgeUser / judgeStateView: present the state without ids or offsets', () => {
  const view = judgeStateView(detState());
  assert.equal(view.length, 4);
  assert.ok(view.every((v) => 'concept' in v && 'status' in v && 'rawText' in v && !('id' in v)));
  const user = buildJudgeUser(FIELDS, detState());
  assert.match(user, /PRESENTATION:/);
  assert.match(user, /EXTRACTED FINDINGS:/);
  assert.match(user, /chest pain/);
});

test('adaptGoldSeed: flattens present/absent/unknown lanes; excludes riskFactors/investigations', () => {
  const delivered = {
    meta: { id: 'ddx-extraction-gold-seed/1.0', labelled_by: 'Cowork proposed, V signed off' },
    cases: [{
      id: 'D01',
      present: [{ concept: 'chest pain', provenance: 'complaint' }, { concept: 'diaphoretic', provenance: 'exam' }],
      absent: [{ concept: 'fever', provenance: 'afebrile' }],
      unknown: ['breathlessness', 'syncope'],
      riskFactors: ['hypertension'],       // separate lane — must NOT become a finding
      investigations: [],
    }],
  };
  const gold = adaptGoldSeed(delivered);
  assert.equal(gold.version, 'ddx-extraction-gold-seed/1.0');
  assert.match(gold.signedBy!, /V signed off/);
  assert.equal(gold.cases.length, 1);
  const f = gold.cases[0].findings;
  assert.equal(f.length, 5); // 2 present + 1 absent + 2 unknown; hypertension excluded
  assert.equal(f.filter((x) => x.status === 'present').length, 2);
  assert.equal(f.filter((x) => x.status === 'absent').length, 1);
  assert.equal(f.filter((x) => x.status === 'unknown').length, 2);
  assert.ok(!f.some((x) => x.concept === 'hypertension'));
  assert.equal(f.find((x) => x.concept === 'chest pain')!.sourceField, 'complaint');
});

test('EXTRACTION_BANK is pinned to the frozen bank', () => {
  assert.equal(EXTRACTION_BANK, 'ddx-case-bank/1.0');
});
