import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBundle } from '../sepsis-bundle';

function isoMinutesAgo(min: number): string {
  return new Date(Date.now() - min * 60000).toISOString();
}

// PRD §11 vignettes

test('SepsisBundle V1: just recognized (5 min), nothing done', () => {
  const r = computeBundle({
    recognition_time: isoMinutesAgo(5),
    lactate_done: false, cultures_done: false, abx_given: false,
    hypotension_or_lactate_high: false, fluids_done: false, vasopressors_started: false,
  });
  assert.equal(r.elapsed_min, 5);
  assert.equal(r.required_count, 3);   // lactate + cultures + abx only (no hypotension gate)
  assert.equal(r.complete_required_count, 0);
  assert.equal(r.compliance_pct, 0);
  // At 5 min (<30), required-incomplete elements should be amber, not red
  for (const e of r.elements.filter((x) => x.required)) assert.equal(e.status, 'amber');
  assert.equal(r.banner, null);   // <30 min so no banner
});

test('SepsisBundle V2: at 35 min, lactate + cultures done, abx + fluids missing (hypotensive)', () => {
  const r = computeBundle({
    recognition_time: isoMinutesAgo(35),
    lactate_done: true, lactate_value: 3.2,
    cultures_done: true, abx_given: false,
    hypotension_or_lactate_high: true, fluids_done: false, vasopressors_started: false,
  });
  assert.equal(r.elapsed_min, 35);
  // 4 required (lactate, cultures, abx, fluids); 2 complete → 50%
  assert.equal(r.required_count, 4);
  assert.equal(r.complete_required_count, 2);
  assert.equal(r.compliance_pct, 50);
  // abx + fluids should be RED (≥30 min)
  assert.equal(r.elements.find((e) => e.key === 'abx')!.status, 'red');
  assert.equal(r.elements.find((e) => e.key === 'fluids')!.status, 'red');
  // No banner — 50% is the threshold (banner only if <50%)
  assert.equal(r.banner, null);
});

test('SepsisBundle V2b: at 35 min, only lactate done (25% compliance) → amber banner', () => {
  const r = computeBundle({
    recognition_time: isoMinutesAgo(35),
    lactate_done: true, cultures_done: false, abx_given: false,
    hypotension_or_lactate_high: true, fluids_done: false, vasopressors_started: false,
  });
  assert.equal(r.compliance_pct, 25);
  assert.ok(r.banner);
  assert.equal(r.banner!.tone, 'amber');
});

test('SepsisBundle V3: 55 min, vasopressors required after fluids in hypotension', () => {
  const r = computeBundle({
    recognition_time: isoMinutesAgo(55),
    lactate_done: true, cultures_done: true, abx_given: true,
    hypotension_or_lactate_high: true, fluids_done: true, vasopressors_started: false,
  });
  // hypotension=true + fluids_done=true → vasopressors required
  assert.equal(r.required_count, 5);
  assert.equal(r.complete_required_count, 4);
  assert.equal(r.compliance_pct, 80);
  assert.equal(r.bundle_complete, false);
});

test('SepsisBundle V4: 75 min, abx never given → overdue + red banner', () => {
  const r = computeBundle({
    recognition_time: isoMinutesAgo(75),
    lactate_done: true, cultures_done: true, abx_given: false,
    hypotension_or_lactate_high: false, fluids_done: false, vasopressors_started: false,
  });
  assert.equal(r.elapsed_min, 75);
  assert.equal(r.remaining_min, 0);
  assert.equal(r.elements.find((e) => e.key === 'abx')!.status, 'overdue');
  assert.ok(r.banner);
  assert.equal(r.banner!.tone, 'red');
});

test('SepsisBundle: not-hypotensive patient does not require fluids/vasopressors', () => {
  const r = computeBundle({
    recognition_time: isoMinutesAgo(20),
    lactate_done: true, cultures_done: true, abx_given: true,
    hypotension_or_lactate_high: false, fluids_done: false, vasopressors_started: false,
  });
  assert.equal(r.required_count, 3);   // lactate + cultures + abx only
  assert.equal(r.compliance_pct, 100);
  assert.equal(r.bundle_complete, true);
});

test('SepsisBundle: elapsed_min defaults to 0 for future recognition_time (clamps)', () => {
  const r = computeBundle({
    recognition_time: new Date(Date.now() + 5 * 60000).toISOString(),
    lactate_done: false, cultures_done: false, abx_given: false,
    hypotension_or_lactate_high: false, fluids_done: false, vasopressors_started: false,
  });
  assert.equal(r.elapsed_min, 0);
  assert.equal(r.remaining_min, 60);
});
