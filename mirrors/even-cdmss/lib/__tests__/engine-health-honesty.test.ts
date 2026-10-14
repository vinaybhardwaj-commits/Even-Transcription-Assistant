/**
 *   node --test --import tsx lib/__tests__/engine-health-honesty.test.ts
 *
 * ENGINE-HEALTH-HONESTY PRD v1.0 (2 Aug 2026) — the panel must not report green on a silent engine.
 *
 * Defect 1: L-3's verdict is a disjunction (`!praiseStillPresent || safetyFired`), so on 1 Aug it
 * reported HOLDS while amoxicillin against a documented penicillin allergy went unflagged — base
 * praise never appeared, `!praiseStillPresent` was true, and the safety matcher was never consulted.
 * Defect 2: the panel's "Ratified @ 0.81.17" header was a hard-coded string that drifts silently.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PART_C_RELATIONS, partCVerdict, RATIFIED_AT_ENGINE, ratificationDriftWarning,
  RATIFIED_RELATION_STATUS,
} from '../metamorphic-core.ts';
import { OPD_ENGINE_VERSION } from '../opd-note-audit-core.ts';

const rel = (id: string) => PART_C_RELATIONS.find((r) => r.id === id)!;
const silent = { baseFired: false, basePraise: false, transformedFired: false, transformedPraise: false };

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Gate test 1 — a failing precondition returns VACUOUS, never HOLDS, never FAILS
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the 1-Aug regression shape: L-3 with no base praise is VACUOUS, not HOLDS', () => {
  // Exactly the measured state that hid the missed contraindication: base praise absent, engine
  // silent on the transformed arm. The old disjunction returned true (HOLDS).
  const out = partCVerdict(rel('L-3'), silent);
  assert.equal(out.verdict, 'VACUOUS');
  assert.notEqual(out.verdict, 'HOLDS');
  assert.equal(out.reason, 'could not be tested — the base arm produced no praise');
});

test('every Part C relation is VACUOUS in the state that makes IT untestable', () => {
  // GENERALISED 2 Aug 2026 (LLM-LEG-RELATION-REPAIR, DEC-5): which base state is untestable now
  // depends on the relation's direction. 'removes' is untestable on a SILENT base (nothing to
  // remove) — the original rule. 'adds' is untestable on a FIRING base (the engine already flags
  // the untransformed note, so the transformed arm proves nothing). Both are VACUOUS, never HOLDS.
  for (const r of PART_C_RELATIONS) {
    const untestable = r.direction === 'adds'
      ? { ...silent, baseFired: true, basePraise: true }
      : silent;
    const out = partCVerdict(r, untestable);
    assert.equal(out.verdict, 'VACUOUS', `${r.id} (${r.direction}) must be VACUOUS in its untestable state`);
    assert.equal(out.reason, r.direction === 'adds'
      ? 'could not be tested — the base arm already fired, so the engine flags this even before the transformation'
      : `could not be tested — the base arm produced no ${r.precondition}`);
    // …even when the transformed arm looks like a pass — the precondition is checked FIRST.
    const transformedLooksGood = partCVerdict(r, { ...untestable, transformedFired: r.id !== 'L-2' });
    assert.equal(transformedLooksGood.verdict, 'VACUOUS', `${r.id}: precondition precedes the verdict fn`);
  }
});

test('L-1/L-2 precondition is base fires; L-3 precondition is base praise, not base fires', () => {
  assert.equal(rel('L-1').precondition, 'fires');
  assert.equal(rel('L-2').precondition, 'fires');
  assert.equal(rel('L-3').precondition, 'praise');
  // L-3's base arm never trips its own safety matcher (the fixture plants the allergy only in the
  // transformed arm), so gating L-3 on baseFired would make it permanently vacuous. Base PRAISE
  // present + baseFired false must therefore still be testable:
  const testable = partCVerdict(rel('L-3'), { ...silent, basePraise: true });
  assert.notEqual(testable.verdict, 'VACUOUS');
});

test('with the precondition met, the verdicts are the relation\'s own — HOLDS and FAILS both reachable', () => {
  // L-2 ('removes'): fired on base, gone on transformed → HOLDS; still firing → FAILS.
  // (This was L-1 until 2 Aug 2026; L-1 was flipped to 'adds' by DEC-1, so the removes example
  // moved to L-2, which still carries those semantics. The property under test is unchanged.)
  assert.equal(partCVerdict(rel('L-2'), { ...silent, baseFired: true }).verdict, 'HOLDS');
  assert.equal(partCVerdict(rel('L-2'), { ...silent, baseFired: true, transformedFired: true }).verdict, 'FAILS');
  // L-1 ('adds'): silent base, finding appears on transformed → HOLDS; nothing appears → FAILS.
  assert.equal(partCVerdict(rel('L-1'), { ...silent, transformedFired: true }).verdict, 'HOLDS');
  assert.equal(partCVerdict(rel('L-1'), silent).verdict, 'FAILS');
  // L-3: praise present on base; transformed praise persists with NO safety finding → FAILS (the
  // blind-praise defect); praise persists but safety fired → HOLDS; praise withdrawn → HOLDS.
  assert.equal(partCVerdict(rel('L-3'), { ...silent, basePraise: true, transformedPraise: true }).verdict, 'FAILS');
  assert.equal(partCVerdict(rel('L-3'), { ...silent, basePraise: true, transformedPraise: true, transformedFired: true }).verdict, 'HOLDS');
  assert.equal(partCVerdict(rel('L-3'), { ...silent, basePraise: true, transformedPraise: false }).verdict, 'HOLDS');
  // A tested relation never reports VACUOUS's reason.
  assert.equal(partCVerdict(rel('L-2'), { ...silent, baseFired: true }).reason, undefined);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Gate test 2 — the ratified-at label and the drift warning
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('RATIFIED_AT_ENGINE is pinned to the version the map was measured at — now 0.81.21', () => {
  // RE-RATIFIED 8 Aug 2026 at 0.81.21 (DETERMINISM-TRIO PRD v1.0 §2.4). The deterministic relations
  // are CODE-LEVEL and CI-measured — lib/__tests__/metamorphic-deterministic.test.ts calls the same
  // runRelations() the panel loads — so this build's green suite IS the re-measurement, which is
  // what the PRD authorises for Part A (and would NOT authorise for the LLM-leg Part C relations).
  // Previously RE-RATIFIED 2 Aug 2026 at 0.81.20 on production after 6cff240 and 97e2f36, 14/14
  // matching (CDMSS-RERATIFICATION-EVIDENCE-2-AUG-2026.md). It goes stale again on the next engine
  // bump, and must move only with a fresh measurement.
  assert.equal(RATIFIED_AT_ENGINE, 'opd-note-audit/0.81.21');
  assert.equal(RATIFIED_AT_ENGINE, OPD_ENGINE_VERSION,
    'the map is ratified AT the deployed engine — if a bump made these differ, re-measure and move it');
});

test('the drift warning is null at the deployed engine, and exact when a version differs', () => {
  assert.equal(ratificationDriftWarning(OPD_ENGINE_VERSION), null,
    'the map is current, so the panel shows no stale-ratification banner');
  assert.equal(ratificationDriftWarning(RATIFIED_AT_ENGINE), null);
  // …and the wording is unchanged for the next time it DOES drift.
  assert.equal(ratificationDriftWarning('opd-note-audit/0.81.22'),
    `Ratified at ${RATIFIED_AT_ENGINE}. The deployed engine is opd-note-audit/0.81.22. These statuses have not been re-measured against the deployed engine.`);
});

test('the panel renders the constant, not a hard-coded version string', () => {
  const page = readFileSync('app/admin/observability/engine-health/page.tsx', 'utf8');
  assert.ok(page.includes('Ratified @ {RATIFIED_AT_ENGINE}'), 'the header reads the exported constant');
  assert.ok(!/Ratified @ 0\.81\.\d+/.test(page), 'no hard-coded version in the header — the constant is the only source');
  assert.ok(page.includes('ratificationDriftWarning(OPD_ENGINE_VERSION)'), 'the drift warning is wired to the deployed engine');
  assert.ok(page.includes('partCVerdict(rel, {'), 'the panel verdict goes through the shared partCVerdict — including L-3\'s (praise, safety) wiring');
});

test('RATIFIED_RELATION_STATUS: D-5 stays a pinned failure; D-7 was FIXED and re-ratified', () => {
  assert.equal(RATIFIED_RELATION_STATUS['D-5'], 'fail',
    'a coarse dosage form is still not a release profile — the defect is real and still pinned');
  // D-7 flipped fail → pass at 0.81.21 (DETERMINISM-TRIO PRD v1.0 §2, V ruled D-1/D-2, 8 Aug 2026).
  // It was FIXED, not silenced: ddiFindings now computes the total daily aspirin mg and de-classes
  // only a line at ≤ 100 mg/day, and the relation itself was strengthened to assert the POSITIVE
  // arm too (650 mg TDS still fires), so it cannot be satisfied by an engine that has merely
  // stopped flagging aspirin. Threshold behaviour is guarded by aspirin-dose-class.test.ts.
  assert.equal(RATIFIED_RELATION_STATUS['D-7'], 'pass');
  assert.equal(Object.keys(RATIFIED_RELATION_STATUS).length, 14);
});
