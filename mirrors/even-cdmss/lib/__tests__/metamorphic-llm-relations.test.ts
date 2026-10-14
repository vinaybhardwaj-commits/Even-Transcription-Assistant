// Part C — the LLM-leg relations and the two-direction verdict (PRD
// CDMSS-LLM-LEG-RELATION-REPAIR v1.0, 2 Aug 2026; DEC-1 … DEC-5).
//
// WHY THIS FILE EXISTS: all three LLM-leg relations read VACUOUS, so the LLM leg had no working
// test at all. Two MEASURED facts drove the repair. (1) The engine emits NO finding type meaning
// "a condition was documented and not managed" — all 17 of its live types are about a drug, a test
// or a code — so L-1's old assertion was unfalsifiable and it is now FLIPPED to 'adds'. (2) Praise
// is rare (8 findings corpus-wide) and lands on named drugs and named tests, so L-2's referral-based
// base and L-3's one-antihistamine base could never meet their preconditions.
//
// Part C runs in the lab, never in CI (the relations drive a real LLM audit), so this file asserts
// the PURE machinery and the fixture INVARIANTS only — never a verdict from a live run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PART_C_RELATIONS, partCVerdict, type PartCRelation } from '../metamorphic-core';

const rel = (id: string): PartCRelation => {
  const r = PART_C_RELATIONS.find((x) => x.id === id);
  assert.ok(r, `${id} must exist`);
  return r!;
};
/** The four arm-majorities partCVerdict reads; every case below varies only what it names. */
const arms = (o: Partial<Parameters<typeof partCVerdict>[1]> = {}) => ({
  baseFired: false, basePraise: false, transformedFired: false, transformedPraise: false, ...o,
});
const REMOVES_REASON = (p: string) => `could not be tested — the base arm produced no ${p}`;
const ADDS_REASON = 'could not be tested — the base arm already fired, so the engine flags this even before the transformation';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · partCVerdict — 'removes'
// ═════════════════════════════════════════════════════════════════════════════════════════════

test("removes: base HAS the state, transformed does NOT → HOLDS", () => {
  const out = partCVerdict(rel('L-2'), arms({ baseFired: true, basePraise: true, transformedFired: false }));
  assert.equal(out.verdict, 'HOLDS');
  assert.equal(out.reason, undefined, 'a tested relation carries no VACUOUS reason');
});

test("removes: base HAS the state, transformed STILL has it → FAILS", () => {
  const out = partCVerdict(rel('L-2'), arms({ baseFired: true, basePraise: true, transformedFired: true }));
  assert.equal(out.verdict, 'FAILS');
});

test("removes: base LACKS the state → VACUOUS, with today's exact reason string", () => {
  const out = partCVerdict(rel('L-2'), arms({ baseFired: false }));
  assert.equal(out.verdict, 'VACUOUS');
  assert.equal(out.reason, REMOVES_REASON('fires'), 'the ENGINE-HEALTH-HONESTY wording must stay byte-identical');
  // …and the praise-precondition relation names 'praise' in its reason.
  const l3 = partCVerdict(rel('L-3'), arms({ basePraise: false }));
  assert.equal(l3.verdict, 'VACUOUS');
  assert.equal(l3.reason, REMOVES_REASON('praise'));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · partCVerdict — 'adds' (the new direction)
// ═════════════════════════════════════════════════════════════════════════════════════════════

test("adds: base LACKS the state, transformed HAS it → HOLDS", () => {
  const out = partCVerdict(rel('L-1'), arms({ baseFired: false, transformedFired: true }));
  assert.equal(out.verdict, 'HOLDS');
  assert.equal(out.reason, undefined);
});

test("adds: base LACKS the state, transformed ALSO lacks it → FAILS", () => {
  const out = partCVerdict(rel('L-1'), arms({ baseFired: false, transformedFired: false }));
  assert.equal(out.verdict, 'FAILS', 'the engine did not respond to the transformation — a real failure, not vacuity');
});

test("adds: base ALREADY fires → VACUOUS with the new reason, and NEVER HOLDS", () => {
  // The engine flags the untransformed note, so the transformed arm proves nothing.
  for (const transformedFired of [true, false]) {
    const out = partCVerdict(rel('L-1'), arms({ baseFired: true, transformedFired }));
    assert.equal(out.verdict, 'VACUOUS', `transformedFired=${transformedFired}`);
    assert.notEqual(out.verdict, 'HOLDS', 'an over-flagging base must never be read as a pass');
    assert.equal(out.reason, ADDS_REASON);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · L-1's matcher — the antibiotic, never the condition
// ═════════════════════════════════════════════════════════════════════════════════════════════

const finding = (o: Record<string, unknown>) => ({
  subject: '', rationale: '', verdict: 'low-value', domain: 'appropriateness',
  confidence: 0.9, evidence: [], estimates: [], citation_ids: [], source: 'llm', ...o,
} as never);

test('L-1 fires on a finding naming the antibiotic', () => {
  const f = rel('L-1').fires;
  assert.equal(f([finding({ subject: 'Amoxicillin + Clavulanic acid continued without an active indication' })]), true);
  assert.equal(f([finding({ subject: 'Unindicated antibiotic', rationale: 'The clavulanate combination has no documented indication.' })]), true);
  assert.equal(f([finding({ subject: 'Antibiotic continued after resolution', verdict: 'context-dependent' })]), true,
    'context-dependent counts, exactly as low-value does');
});

test('L-1 does NOT fire on a finding whose only match is the word cellulitis — the original defect', () => {
  const f = rel('L-1').fires;
  assert.equal(f([finding({ subject: 'Documentation of cellulitis extent', rationale: 'The note does not record the margin of the cellulitis.' })]), false,
    'matching the CONDITION is what made this relation unfalsifiable');
});

test('L-1 ignores informational findings and praise', () => {
  const f = rel('L-1').fires;
  assert.equal(f([finding({ subject: 'Amoxicillin', informational: true })]), false, 'informational never counts');
  assert.equal(f([finding({ subject: 'Amoxicillin appropriately chosen', verdict: 'high-value' })]), false, 'praise is not a fire');
  assert.equal(f([]), false);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · Fixture invariants — what must be identical across the two arms
// ═════════════════════════════════════════════════════════════════════════════════════════════

const complaintsOf = (r: Record<string, unknown>) =>
  (r['general_practitioner_prescription__presenting_complaints'] as { symptoms: string; diagnoses: unknown }[])[0];
const planOf = (r: Record<string, unknown>) =>
  (r['general_practitioner_prescription__plan_of_management'] as { management_plan: string }[])[0].management_plan;

test('L-1: ONLY the symptom line and the diagnosis text change between the arms', () => {
  const r = rel('L-1');
  const base = r.baseRow;
  const t = r.transform(structuredClone(base));
  assert.equal(planOf(t), planOf(base), 'the plan must be byte-identical');
  assert.equal(t['general_practitioner_prescription__examination'], base['general_practitioner_prescription__examination'],
    'the examination must be byte-identical');
  assert.deepEqual(t.medications, base.medications, 'the antibiotic must be byte-identical — it is the constant under test');
  assert.notEqual(complaintsOf(t).symptoms, complaintsOf(base).symptoms, 'the symptom line is what moves');
  assert.notDeepEqual(complaintsOf(t).diagnoses, complaintsOf(base).diagnoses, 'the diagnosis text is what moves');
  // the drug is the same molecule the matcher looks for
  assert.match(JSON.stringify(base.medications), /Amoxicillin \+ Clavulanic acid/);
});

test('L-2: the DRUGS stay and the REASON goes', () => {
  const r = rel('L-2');
  const base = r.baseRow;
  const t = r.transform(structuredClone(base));
  assert.deepEqual(t.medications, base.medications, 'medications byte-identical — the whole point of the relation');
  assert.notEqual(planOf(t), planOf(base));
  assert.notEqual(complaintsOf(t).symptoms, complaintsOf(base).symptoms);
  assert.match(JSON.stringify(base.medications), /Ferrous Ascorbate \+ Folic Acid/, 'the praise-earning drug (measured shape)');
});

test('L-2: the referral the old fixture rested on is GONE from both arms', () => {
  const r = rel('L-2');
  const t = r.transform(structuredClone(r.baseRow));
  for (const [label, row] of [['base', r.baseRow], ['transformed', t]] as const) {
    assert.equal('refer_to' in row, false, `${label}: refer_to must not exist`);
    assert.equal('num_referrals' in row, false, `${label}: num_referrals must not exist`);
  }
});

test('L-3: the base earns praise through a named drug, and the transformation is untouched', () => {
  const r = rel('L-3');
  const base = r.baseRow;
  assert.match(JSON.stringify(base.medications), /Calamine Lotion/, 'the praise shape observed in production');
  // the transformation itself: allergy text added, amoxicillin appended, nothing else disturbed
  const t = r.transform(structuredClone(base));
  assert.equal(t.patient_details__allergies, 'Penicillin allergy — rash and facial swelling with amoxicillin in 2023');
  assert.equal((t.medications as unknown[]).length, (base.medications as unknown[]).length + 1);
  assert.match(JSON.stringify(t.medications), /Amoxicillin/);
  assert.equal(planOf(t), planOf(base), 'the transform touches only allergies + medications');
  assert.equal(complaintsOf(t).symptoms, complaintsOf(base).symptoms);
  assert.equal(r.precondition, 'praise', 'unchanged');
  assert.equal(r.verdict(false, false), true, 'unchanged: praise gone ⇒ holds');
  assert.equal(r.verdict(true, false), false, 'unchanged: praise stayed and nothing fired ⇒ fails');
  assert.equal(r.verdict(true, true), true, 'unchanged: praise stayed but the safety finding appeared ⇒ holds');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5 · Every relation is well-formed
// ═════════════════════════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 6 · Retirement (V, 2 Aug 2026) — retired is NOT deleted
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('every relation carries an active flag, and it is a boolean', () => {
  for (const r of PART_C_RELATIONS) {
    assert.equal(typeof r.active, 'boolean', `${r.id} must declare active`);
  }
});

test('EXACTLY ONE relation is active — L-1; L-2 and L-3 are retired', () => {
  const active = PART_C_RELATIONS.filter((r) => r.active);
  assert.equal(active.length, 1);
  assert.equal(active[0].id, 'L-1');
  assert.equal(rel('L-2').active, false, 'retired: rests on praise, which is too rare to test on');
  assert.equal(rel('L-3').active, false, 'retired: same praise problem');
});

test('RETIRED IS NOT DELETED — both objects stay complete and usable as fixtures', () => {
  // Deleting L-3 would delete the 1 August regression guard in engine-health-honesty.test.ts,
  // which pins a real production defect. Every member must still be present and callable.
  for (const id of ['L-2', 'L-3']) {
    const r = rel(id);
    assert.ok(r.baseRow && typeof r.transform === 'function', `${id} keeps its fixture and transform`);
    assert.ok(typeof r.fires === 'function' && typeof r.verdict === 'function', `${id} keeps its matchers`);
    assert.ok(r.precondition && r.direction && r.experiment && r.title, `${id} keeps its metadata`);
    assert.doesNotThrow(() => r.transform(structuredClone(r.baseRow)), `${id}'s transform still runs`);
  }
  // and the verdict machinery still works on a retired relation — that is what the guard uses
  assert.equal(partCVerdict(rel('L-3'), arms()).verdict, 'VACUOUS');
});

test('the runner and the panel both filter on active — retired relations are skipped, not shown', () => {
  const runner = readFileSync('scripts/metamorphic-llm-report.mjs', 'utf8');
  const panel = readFileSync('app/admin/observability/engine-health/page.tsx', 'utf8');
  assert.ok(/PART_C_RELATIONS\.filter\(\(r\) => r\.active\)/.test(runner), 'the runner skips retired relations');
  assert.ok(/for \(const rel of ACTIVE\)/.test(runner), 'and iterates only the active set');
  assert.ok(/PART_C_RELATIONS\.filter\(\(rel\) => rel\.active\)/.test(panel), 'the panel hides retired relations');
});

test('the panel states the leg\'s scope and the retirement, without overclaiming', () => {
  const panel = readFileSync('app/admin/observability/engine-health/page.tsx', 'utf8');
  assert.ok(/run on the <b[^>]*>local model<\/b>|local model/.test(panel), 'says it runs on the local model');
  assert.ok(/do not test the engine that scores doctors/.test(panel), 'says what it does NOT test');
  assert.ok(/L-2 and L-3 are retired/.test(panel));
  assert.ok(/praise proved too rare to build a test on/.test(panel), 'says WHY they were retired');
  assert.ok(/L-1 is retained/.test(panel));
  // the word "coverage" must not appear in the LLM-leg statement — it is a claim this leg cannot support
  const section = panel.slice(panel.indexOf('LLM-leg relations'), panel.indexOf('lab_analyses could not be read'));
  assert.ok(!/coverage/i.test(section), 'the leg must not claim coverage');
});

test('every relation in PART_C_RELATIONS carries a direction, and it is one of the two', () => {
  assert.equal(PART_C_RELATIONS.length, 3);
  for (const r of PART_C_RELATIONS) {
    assert.ok(['removes', 'adds'].includes(r.direction), `${r.id} direction=${r.direction}`);
  }
  assert.equal(rel('L-1').direction, 'adds', 'L-1 is the flipped one (DEC-1)');
  assert.equal(rel('L-2').direction, 'removes');
  assert.equal(rel('L-3').direction, 'removes');
});

test('ids, experiment names and titles are preserved — the lab history must stay joinable', () => {
  assert.deepEqual(PART_C_RELATIONS.map((r) => r.id), ['L-1', 'L-2', 'L-3']);
  assert.deepEqual(PART_C_RELATIONS.map((r) => r.experiment), ['mm-llm-l1', 'mm-llm-l2', 'mm-llm-l3']);
  assert.equal(rel('L-1').title, 'Status qualifier is read');
  assert.equal(rel('L-2').title, 'Praise requires evidence');
  assert.equal(rel('L-3').title, 'Praise is not blind');
});

test('the generalising tests still cover ALL THREE relations, active or retired', () => {
  // Retirement must not shrink the test surface: a retired relation is still a fixture, and these
  // loops must keep walking it. If PART_C_RELATIONS ever drops to the active set, this fails.
  assert.equal(PART_C_RELATIONS.length, 3);
  assert.deepEqual(PART_C_RELATIONS.map((r) => r.id), ['L-1', 'L-2', 'L-3']);
  assert.equal(PART_C_RELATIONS.filter((r) => !r.active).length, 2, 'two retired fixtures still present');
});

test('every fixture is synthetic — no db13 uid may reach the lab runner (§9.3)', () => {
  for (const r of PART_C_RELATIONS) {
    assert.equal(r.baseRow.uid, null, `${r.id} base`);
    assert.equal(r.transform(structuredClone(r.baseRow)).uid, null, `${r.id} transformed`);
  }
});

test('no relation throws on its own transform, and both arms stay well-formed rows', () => {
  for (const r of PART_C_RELATIONS) {
    const t = r.transform(structuredClone(r.baseRow));
    assert.ok(complaintsOf(t).symptoms.length > 0, `${r.id} transformed symptoms`);
    assert.ok(typeof planOf(t) === 'string', `${r.id} transformed plan`);
    assert.ok(Array.isArray(t.medications), `${r.id} transformed medications`);
  }
});
