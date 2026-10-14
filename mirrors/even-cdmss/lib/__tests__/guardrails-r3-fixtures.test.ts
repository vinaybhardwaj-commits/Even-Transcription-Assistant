/**
 * lib/__tests__/guardrails-r3-fixtures.test.ts — the fixtures are synthetic, TEXT-FREE and
 * deterministic, each proven by execution.
 *
 * PRD §6.4 requires that the manifest carry no field which could hold clinical text, that the
 * assertion FAIL when such a field is added, and that it NOT be able to pass on an empty slice.
 * Both halves are honoured below: the walk counts the strings it examined and asserts a non-zero
 * count before judging any of them, and a deliberately poisoned fixture is run through the same
 * walk to show the check can fail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIXTURE_ENUMS, FIXTURE_HMAC, FIXTURE_INSTANT, FIXTURE_SHAPES, P95_MIN_N, P99_MIN_N, SEEDS,
  manifestFixture, mulberry32, seededUuid, summariseSamples, summarisePaired,
} from '../guardrails-r3-fixtures';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ENUMS = new Set<string>(FIXTURE_ENUMS);

/** Every string value anywhere in a value, with the path that reached it. */
function stringsIn(v: unknown, path = '$', out: Array<[string, string]> = []): Array<[string, string]> {
  if (typeof v === 'string') out.push([path, v]);
  else if (Array.isArray(v)) v.forEach((x, i) => stringsIn(x, `${path}[${i}]`, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.push([`${path}.${k}(key)`, k]);   // keys are text too, and a `note` key is the warning
      stringsIn(x, `${path}.${k}`, out);
    }
  }
  return out;
}

/** One of the four declared shapes: an enum member, a UUID, an ISO instant, a hex digest. */
const isDeclaredShape = (s: string) =>
  ENUMS.has(s) || UUID.test(s) || ISO.test(s) || HEX64.test(s)
  // Bare snake_case identifiers are the field KEYS. Free text cannot match: no spaces, no
  // punctuation, and a hard length ceiling well under any clinical phrase.
  || (/^[a-z][a-z0-9_]{0,40}$/.test(s) && !s.includes(' '));

test('R3.16 — every string in every fixture matches a declared shape: NO free text, anywhere', () => {
  let examined = 0;
  for (const shape of FIXTURE_SHAPES) {
    const rnd = mulberry32(SEEDS.manifestShape);
    const fixture = manifestFixture(shape, rnd);
    for (const [path, s] of stringsIn(fixture)) {
      examined++;
      assert.ok(isDeclaredShape(s), `${shape} ${path}: ${JSON.stringify(s)} is not a declared shape`);
    }
  }
  // ⚠️ AND IT CANNOT PASS ON AN EMPTY SLICE (PRD §6.4). A walk that found nothing would satisfy
  // every assertion above vacuously — the same defect the vacuous `every()` was in proof 14.
  assert.ok(examined > 100, `the walk must actually examine strings, examined ${examined}`);
});

test('R3.17 — the text-free check CAN FAIL: a poisoned fixture is rejected', () => {
  // PRD §6.4: "The assertion must fail when such a field is added." Demonstrated rather than
  // asserted, because a check nobody has seen fail is a check nobody has tested.
  const rnd = mulberry32(SEEDS.manifestShape);
  const poisoned = {
    ...manifestFixture('single_batch', rnd),
    clinical_note: 'Patient reports chest pain radiating to the left arm since this morning.',
  };
  const offending = stringsIn(poisoned).filter(([, s]) => !isDeclaredShape(s));
  assert.equal(offending.length, 1, 'exactly the poisoned value is caught');
  assert.match(offending[0][0], /clinical_note$/);
  // …and the KEY that carried it is itself a declared identifier, which is the subtle half: the
  // key alone would not have given it away. The VALUE is what fails.
  assert.ok(isDeclaredShape('clinical_note'));
});

test('R3.18 — the fixtures are DETERMINISTIC: the same seed gives byte-identical output', () => {
  for (const shape of FIXTURE_SHAPES) {
    const a = JSON.stringify(manifestFixture(shape, mulberry32(SEEDS.manifestShape)));
    const b = JSON.stringify(manifestFixture(shape, mulberry32(SEEDS.manifestShape)));
    assert.equal(a, b, `${shape}: same seed must give the same bytes`);
  }
  // …and a DIFFERENT seed gives different ids, so the determinism above is the seed's doing and not
  // a fixture that simply has no randomness in it.
  const s1 = manifestFixture('single_batch', mulberry32(SEEDS.manifestShape));
  const s2 = manifestFixture('single_batch', mulberry32(SEEDS.manifestShape + 1));
  assert.notEqual(s1.invocation_id, s2.invocation_id);
  assert.match(s1.invocation_id, UUID);
  assert.match(seededUuid(mulberry32(1)), UUID);
});

test('R3.19 — the three shapes really do bracket a size range, which is what guardrail 3 measures', () => {
  const size = (s: typeof FIXTURE_SHAPES[number]) =>
    Buffer.byteLength(JSON.stringify(manifestFixture(s, mulberry32(SEEDS.manifestShape))), 'utf8');
  const single = size('single_batch');
  const multi = size('multi_batch');
  const throttled = size('throttled');
  assert.ok(single < multi, 'more batches must be a larger manifest');
  assert.ok(multi < throttled, 'attempt-heavy rows must be larger still — that is the point of the shape');
  // A guardrail whose fixtures all produced the same size would report one number and call it a
  // range, so the spread is asserted rather than hoped for.
  assert.ok(throttled > single * 3, `throttled ${throttled} vs single ${single}: the spread is real`);
});

test('R3.20 — the fixture HMAC is a digest SHAPE, not a hash of anything', () => {
  // The real field is keyed over the assembled scorer context, and that context is clinical text.
  // The fixture carries a constant of the right LENGTH — all guardrail 3 needs — and it is not a
  // hash of a document, which is the property that keeps a fixture from becoming a carrier.
  assert.match(FIXTURE_HMAC, HEX64);
  assert.equal(new Set(FIXTURE_HMAC).size, 1, 'a constant, visibly not a digest of anything');
  assert.equal(FIXTURE_INSTANT, '2026-09-01T00:00:00.000Z');
  assert.match(FIXTURE_INSTANT, ISO);
});

test('R3.21 — percentiles are WITHHELD below their minimum n, with the reason stated', () => {
  const few = summariseSamples(Array.from({ length: 12 }, (_, i) => i + 1));
  assert.equal(few.n, 12);
  assert.equal(few.median, 6.5);
  // ⚠️ A p95 OVER TWELVE SAMPLES IS THE MAXIMUM WEARING A PERCENTILE'S NAME. Null, plus a sibling
  // field saying why, so a report cannot quote a number that was never a percentile.
  assert.equal(few.p95, null);
  assert.match(String(few.p95_withheld), /needs n >= 20, have 12/);
  assert.equal(few.p99, null);
  assert.match(String(few.p99_withheld), /needs n >= 100, have 12/);

  const enough = summariseSamples(Array.from({ length: P95_MIN_N }, (_, i) => i + 1));
  assert.equal(enough.p95, 19);
  assert.equal(enough.p95_withheld, null);
  assert.equal(enough.p99, null, 'still short of the p99 minimum');

  const plenty = summariseSamples(Array.from({ length: P99_MIN_N }, (_, i) => i + 1));
  assert.equal(plenty.p99, 99);
  assert.equal(plenty.p99_withheld, null);

  // An empty sample is null everywhere and never 0 — a zero would read as a measurement.
  const none = summariseSamples([]);
  assert.deepEqual([none.n, none.min, none.median, none.max], [0, null, null, null]);
});

test('R3.22 — guardrail 4 reports PAIRED differences, including how often instrumentation lost', () => {
  // Deltas in milliseconds: instrumented minus uninstrumented. Two of five are negative, which is
  // exactly the situation a two-median comparison would hide.
  const p = summarisePaired([3, -1, 5, -2, 4]);
  assert.equal(p.pairs, 5);
  assert.equal(p.meanDelta, 1.8);
  assert.equal(p.median, 3);
  assert.equal(p.instrumentedSlower, 3, 'a count, not a rate — n is small by design');
  assert.equal(p.min, -2);
  assert.equal(p.max, 5);
  // The paired summary is still a summary, so the withholding rule applies to it too.
  assert.equal(p.p95, null);
  assert.match(String(p.p95_withheld), /needs n >= 20/);
});
