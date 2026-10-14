// lib/__tests__/lvc-value-no-normative-frame.test.ts — regression guard: the Value-Analysis judge
// (lib/lvc-value.ts) must NOT retrieve with useNormativeLeg — that would put the normative-source
// frame into the judge's prompt and reframe its independent judgment (CDMSS-WORKSPACE-FRAMING-
// PRINCIPLE §4/§6; R-11 measured ~90% low-value-signal loss). Source-scan (the retrieve() call is
// internal to defaultRetrieveHits and not otherwise inspectable without a DB).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync('lib/lvc-value.ts', 'utf8');

test('lvc-value defaultRetrieveHits does NOT set useNormativeLeg (no normative frame in the judge prompt)', () => {
  // the value pass retrieves; assert the leg is off on its retrieve() opts
  const call = src.match(/const r = await retrieve\(q,\s*\{[^}]*\}\)/);
  assert.ok(call, 'lvc-value must call retrieve(q, {...})');
  assert.ok(!/useNormativeLeg/.test(call![0]), 'the value-analysis retrieve() must NOT enable the normative leg');
  // ordinary corpus grounding stays intact
  for (const opt of ['topK: 8', 'useReranker: true', 'useSourceWeights: true', 'hybrid: true']) {
    assert.ok(call![0].includes(opt), `retrieve opts must keep ${opt}`);
  }
  // the framing-principle guard comment is present so it isn't "helpfully" re-added
  assert.ok(src.includes('WORKSPACE-FRAMING-PRINCIPLE'), 'the framing-principle citation comment must be present');
});
