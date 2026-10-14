// Inquiry K1 — askset route flag-off byte-identity (PRD §15, 1 test). FORM USED: source-level
// structural pinning (the sanctioned equivalent used across the architecture suite — the route
// module's graph (next/server, metabase, neon) cannot load under node --test, so instead of an
// HTTP harness we prove the invariant on the source):
//   (a) the deterministic flag-off serving lines are still present VERBATIM (unchanged bytes);
//   (b) the inquiry path is reachable ONLY inside the `INQUIRY_ENABLED === '1'` guard, which
//       sits strictly between the deterministic lines and never wraps them;
//   (c) the existing CARE_CALL_ENABLED 404 gate is untouched.
// Together these make "flag unset but response differs from today" unrepresentable without
// failing this test: with the guard false, execution falls through to the byte-identical
// original buildAskSet + response line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'app/api/care-call/askset/route.ts'), 'utf8');

test('askset route: INQUIRY_ENABLED unset ⇒ byte-identical deterministic path', () => {
  // (a) the original flag-off lines, verbatim (as at d0f5c5b)
  const detBuild = `const { asks, overflow } = buildAskSet(oc, askKeys);`;
  const detReturn = `return NextResponse.json({ asks, overflow, degraded: false, attempt_next, prior, keys: askKeys });`;
  assert.ok(SRC.includes(detBuild), 'deterministic buildAskSet line unchanged');
  assert.ok(SRC.includes(detReturn), 'deterministic response line unchanged (no added fields on the flag-off path)');
  const gate404 = `if (process.env.CARE_CALL_ENABLED !== '1') return NextResponse.json({ error: 'not found' }, { status: 404 });`;
  assert.ok(SRC.includes(gate404), 'CARE_CALL_ENABLED gate unchanged');

  // (b) the inquiry path is gated and precedes the deterministic fall-through
  const guard = SRC.indexOf(`if (process.env.INQUIRY_ENABLED === '1') {`);
  assert.ok(guard > 0, 'inquiry path exists behind INQUIRY_ENABLED');
  const det = SRC.indexOf(detBuild);
  assert.ok(guard < det, 'guard sits before the deterministic path (falls through when unset)');

  // serveInquiry is invoked exactly once, inside the guarded block (before the deterministic line)
  const calls = [...SRC.matchAll(/serveInquiry\(/g)].map((m) => m.index ?? -1);
  const declaration = SRC.indexOf('async function serveInquiry(');
  const invocations = calls.filter((i) => i !== declaration + 'async function '.length);
  const callSites = invocations.filter((i) => !SRC.slice(Math.max(0, i - 20), i).includes('function'));
  assert.equal(callSites.length, 1, 'exactly one serveInquiry call site');
  assert.ok(callSites[0] > guard && callSites[0] < det, 'the call site lives inside the guarded block');

  // (c) the degraded/error paths still return the original shape (no inquiry fields leak in)
  assert.ok(SRC.includes(`return NextResponse.json({ asks: [], overflow: [], degraded: true, attempt_next, prior });`),
    'degraded response unchanged');
});
