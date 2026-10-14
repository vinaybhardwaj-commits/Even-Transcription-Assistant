/**
 * Pure-core tests for lib/pathway-core.ts.
 * Run in the Linux sandbox WITHOUT tsx (macOS binaries) via:
 *   node --experimental-strip-types --test lib/__tests__/pathway-core.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normStageKind,
  normStageFlag,
  orderAndIdStages,
  parseSkeleton,
  parseEnrichment,
  mergeStages,
  STAGE_ORDER,
  type SkeletonStage,
} from '../pathway-core.ts';

// De-anchoring guard (from Dr. Zaki's Widal/enteric-fever feedback): a low-certainty
// or anchored diagnosis must force the DDx hand-off even if the model says needs_ddx=false.
test('parseSkeleton forces DDx hand-off on a low-certainty / anchored diagnosis', () => {
  const stages = '[{"kind":"diagnosis","title":"Confirm","action":"blood culture","flag":"high-value"}]';
  const low = parseSkeleton(`{"detected_stage":"diagnosis","working_diagnosis":"Suspected enteric fever","diagnosis_certainty":"low","needs_ddx":false,"anchor_note":"Widal-anchored; roommate cluster favours gastroenteritis","summary":"x","stages":${stages}}`);
  assert.ok(low);
  assert.equal(low!.needsDdx, true, 'low certainty must force needsDdx');
  assert.equal(low!.anchorNote, 'Widal-anchored; roommate cluster favours gastroenteritis');

  // anchor_note present but model said moderate certainty + needs_ddx false → still force it
  const anchored = parseSkeleton(`{"detected_stage":"diagnosis","working_diagnosis":"Typhoid","diagnosis_certainty":"moderate","needs_ddx":false,"anchor_note":"anchored on outside Widal","summary":"x","stages":${stages}}`);
  assert.ok(anchored);
  assert.equal(anchored!.needsDdx, true, 'anchor_note must force needsDdx');

  // established, high-certainty dx with no anchoring → does NOT over-trigger the hand-off
  const high = parseSkeleton(`{"detected_stage":"diagnosis","working_diagnosis":"STEMI","diagnosis_certainty":"high","needs_ddx":false,"anchor_note":null,"summary":"x","stages":${stages}}`);
  assert.ok(high);
  assert.equal(high!.needsDdx, false, 'high certainty + no anchor should not force handoff');
});

test('normStageKind maps synonyms + defaults to assessment', () => {
  assert.equal(normStageKind('workup'), 'assessment');
  assert.equal(normStageKind('Management'), 'treatment');
  assert.equal(normStageKind('safety-net'), 'followup');
  assert.equal(normStageKind('stabilisation'), 'triage');
  assert.equal(normStageKind('gibberish'), 'assessment');
});

test('normStageFlag maps synonyms + defaults to routine', () => {
  assert.equal(normStageFlag('question this'), 'low-value');
  assert.equal(normStageFlag('high_value'), 'high-value');
  assert.equal(normStageFlag('warning'), 'caution');
  assert.equal(normStageFlag('context'), 'context-dependent');
  assert.equal(normStageFlag('nonsense'), 'routine');
});

test('orderAndIdStages enforces canonical order, stable within kind, sequential ids', () => {
  const raw = [
    { kind: 'treatment' as const, title: 'Tx', action: 'a', flag: 'high-value' as const },
    { kind: 'triage' as const, title: 'Triage', action: 'a', flag: 'essential' as const },
    { kind: 'treatment' as const, title: 'Tx2', action: 'a', flag: 'routine' as const },
    { kind: 'assessment' as const, title: 'Hx', action: 'a', flag: 'routine' as const },
  ];
  const out = orderAndIdStages(raw);
  assert.deepEqual(out.map((s) => s.kind), ['triage', 'assessment', 'treatment', 'treatment']);
  // stable within the two treatment stages: Tx before Tx2
  assert.deepEqual(out.filter((s) => s.kind === 'treatment').map((s) => s.title), ['Tx', 'Tx2']);
  assert.deepEqual(out.map((s) => s.id), ['s1', 's2', 's3', 's4']);
});

test('orderAndIdStages caps the spine', () => {
  const raw = Array.from({ length: 12 }, (_, i) => ({ kind: 'treatment' as const, title: `t${i}`, action: 'a', flag: 'routine' as const }));
  assert.equal(orderAndIdStages(raw).length, 8);
});

test('STAGE_ORDER is strictly increasing along the canonical path', () => {
  assert.ok(STAGE_ORDER.triage < STAGE_ORDER.assessment);
  assert.ok(STAGE_ORDER.assessment < STAGE_ORDER.diagnosis);
  assert.ok(STAGE_ORDER.diagnosis < STAGE_ORDER.treatment);
  assert.ok(STAGE_ORDER.treatment < STAGE_ORDER.disposition);
  assert.ok(STAGE_ORDER.disposition < STAGE_ORDER.followup);
});

test('parseSkeleton parses a fenced JSON skeleton', () => {
  const txt = '```json\n' + JSON.stringify({
    detected_stage: 'order',
    working_diagnosis: 'mechanical low back pain',
    diagnosis_certainty: 'high',
    needs_ddx: false,
    summary: 'conservative path',
    stages: [
      { kind: 'assessment', title: 'Exam', action: 'history + neuro exam', flag: 'routine' },
      { kind: 'triage', title: 'Red-flag screen', action: 'rule out cauda equina', flag: 'essential' },
      { kind: 'treatment', title: 'Conservative care', action: 'NSAID + stay active', flag: 'high-value' },
    ],
  }) + '\n```';
  const sk = parseSkeleton(txt);
  assert.ok(sk);
  assert.equal(sk!.detectedStage, 'order');
  assert.equal(sk!.workingDiagnosis, 'mechanical low back pain');
  assert.equal(sk!.needsDdx, false);
  // re-ordered: triage first despite being listed 2nd
  assert.equal(sk!.stages[0].kind, 'triage');
  assert.deepEqual(sk!.stages.map((s) => s.id), ['s1', 's2', 's3']);
});

test('parseSkeleton forces needsDdx for undifferentiated low-certainty presentation', () => {
  const sk = parseSkeleton(JSON.stringify({
    detected_stage: 'presentation',
    working_diagnosis: null,
    diagnosis_certainty: 'low',
    needs_ddx: false, // model said false; heuristic should override
    summary: 's',
    stages: [{ kind: 'assessment', title: 'Workup', action: 'broad', flag: 'routine' }],
  }));
  assert.ok(sk);
  assert.equal(sk!.needsDdx, true);
});

test('parseSkeleton returns null on garbage / empty stages', () => {
  assert.equal(parseSkeleton('not json'), null);
  assert.equal(parseSkeleton(JSON.stringify({ detected_stage: 'order', stages: [] })), null);
});

test('parseEnrichment parses, filters unknown ids, dedups, separates evidence/estimates', () => {
  const txt = JSON.stringify({
    nodes: [
      { id: 's1', flag: 'essential', detail: 'screen', decision_criteria: 'if red flags escalate', evidence: ['NICE NG59'], estimates: [], citation_ids: [1, 4, 0] },
      { id: 's1', flag: 'routine', detail: 'dup', evidence: [], estimates: [] }, // duplicate id → dropped
      { id: 's9', flag: 'routine', detail: 'unknown id', evidence: [], estimates: [] }, // not in validIds → dropped
      { id: 's2', flag: 'low-value', detail: 'MRI not indicated', order: 'MRI lumbar spine', evidence: ['Choosing Wisely'], estimates: ['est. ~₹X (not validated)'], citation_ids: [2] },
    ],
  });
  const enr = parseEnrichment(txt, ['s1', 's2', 's3'], 3);
  assert.ok(enr);
  assert.deepEqual(enr!.nodes.map((n) => n.id), ['s1', 's2']);
  assert.equal(enr!.nodes[1].order, 'MRI lumbar spine');
  assert.equal(enr!.nodes[1].evidence.length, 1);
  assert.equal(enr!.nodes[1].estimates.length, 1);
  // citation_ids clamped to [1..3]: 4 and 0 dropped from s1
  assert.deepEqual(enr!.nodes[0].citation_ids, [1]);
  assert.deepEqual(enr!.nodes[1].citation_ids, [2]);
  assert.ok(enr!.disclaimer.length > 0);
});

test('parseEnrichment returns null on garbage', () => {
  assert.equal(parseEnrichment('nope'), null);
  assert.equal(parseEnrichment(JSON.stringify({ nodes: [] })), null);
});

test('mergeStages overlays enrichment by id and marks enriched', () => {
  const stages: SkeletonStage[] = [
    { id: 's1', kind: 'triage', title: 'Triage', action: 'screen', flag: 'essential' },
    { id: 's2', kind: 'assessment', title: 'Workup', action: 'exam', flag: 'routine' },
  ];
  const enr = parseEnrichment(JSON.stringify({
    nodes: [{ id: 's2', flag: 'low-value', detail: 'no imaging', decision_criteria: null, evidence: ['x'], estimates: [] }],
  }), ['s1', 's2']);
  const merged = mergeStages(stages, enr);
  assert.equal(merged[0].enriched, false);
  assert.equal(merged[1].enriched, true);
  assert.equal(merged[1].flag, 'low-value'); // enrichment revised the chip
  assert.equal(merged[1].detail, 'no imaging');
});
