// Metamorphic relations over the OPD deterministic leg — CI hard gate (PRD
// CDMSS-METAMORPHIC-AND-SYNTHETIC-CONTROLS v1.0 §3, M1). ONE definition of every relation:
// this file only asserts what lib/metamorphic-core.ts `runRelations()` returns — the same call
// the engine-health panel renders live.
//
// KNOWN-DEFECT PINNING: two relations FAIL at opd-note-audit/0.81.17 — D-5 (no release-profile
// awareness, observed class Q2) and D-7 (antiplatelet-dose aspirin treated as an analgesic NSAID,
// observed class Q28, named unanimously). G-1 (finding_ref changed under medications[] reorder —
// surfaced BY this suite at f816f34) was RE-RATIFIED pinned-fail → pass on 1 Aug 2026 by the DDI
// pair-order canonicalisation build (orderPair in lib/ddi-tags.ts; regression-guarded by
// ddi-pair-order.test.ts). The PRD forbids fixing the engine in the suite's own build (§3.1, §6)
// and a permanently-red gate stops all work (M1's own rationale), so each
// relation is asserted to MATCH its measured, ratified status instead of asserted green. If the
// engine changes so a pinned failure starts passing (or a pass starts failing), this test fails
// LOUDLY and RATIFIED_RELATION_STATUS must be re-ratified with V.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRelations, RATIFIED_RELATION_STATUS } from '../metamorphic-core';

const results = runRelations();

test('every relation has a ratified status, and every ratified status has a relation', () => {
  const ids = results.map((r) => r.id).sort();
  assert.deepEqual(ids, Object.keys(RATIFIED_RELATION_STATUS).sort());
});

test('no relation THREW — a crash is never a legitimate relation outcome', () => {
  for (const r of results) assert.ok(!r.detail.startsWith('THREW:'), `${r.id} threw: ${r.detail}`);
});

for (const r of results) {
  const expected = RATIFIED_RELATION_STATUS[r.id];
  test(`${r.id} ${r.title} — ${expected === 'pass' ? 'holds' : 'reproduces the observed defect (pinned)'}`, () => {
    if (expected === 'pass') {
      assert.ok(r.pass, `${r.id} should pass but failed: ${r.detail}`);
    } else {
      assert.ok(!r.pass,
        `${r.id} is a PINNED KNOWN DEFECT at engine 0.81.17 and now PASSES — engine behaviour changed. `
        + `Re-ratify RATIFIED_RELATION_STATUS with V (do not silently accept). Detail: ${r.detail}`);
    }
  });
}
