import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDomainSignals, type GovDomainKey } from '../opd-governance-core.ts';

const doc = (uid: string, key: GovDomainKey, value: number, n = 5, name?: string) =>
  ({ uid, name, values: { [key]: { value, n } } });

test('lower_worse severity: completeness 74 act_now, 88 watch, 96 healthy', () => {
  const r = computeDomainSignals({
    domains: [
      { key: 'documentation_completeness', value: 74, n: 100 },
    ],
  });
  assert.equal(r.signals[0].severity, 'act_now');
  const r2 = computeDomainSignals({ domains: [{ key: 'documentation_completeness', value: 88, n: 100 }] });
  assert.equal(r2.signals[0].severity, 'watch');
  const r3 = computeDomainSignals({ domains: [{ key: 'documentation_completeness', value: 96, n: 100 }] });
  assert.equal(r3.signals.length, 0);
  assert.equal(r3.healthy[0].metric, 'documentation_completeness');
});

test('higher_worse severity: interactions 25/100 act_now, 12 watch, 8 healthy', () => {
  const act = computeDomainSignals({ domains: [{ key: 'interaction_alerts', value: 25, n: 494 }] });
  assert.equal(act.signals[0].severity, 'act_now');
  const watch = computeDomainSignals({ domains: [{ key: 'interaction_alerts', value: 12, n: 494 }] });
  assert.equal(watch.signals[0].severity, 'watch');
  const ok = computeDomainSignals({ domains: [{ key: 'interaction_alerts', value: 8, n: 494 }] });
  assert.equal(ok.signals.length, 0);
});

test('direction-aware trend: rising interactions = worsening, rising completeness = improving', () => {
  const up = computeDomainSignals({
    domains: [{ key: 'interaction_alerts', value: 20, n: 100 }],
    prior: { interaction_alerts: 12 },
  });
  assert.equal(up.signals[0].trend, 'worsening');
  assert.equal(up.signals[0].delta, 8);
  const better = computeDomainSignals({
    domains: [{ key: 'documentation_completeness', value: 88, n: 100 }],
    prior: { documentation_completeness: 82 },
  });
  assert.equal(better.signals[0].trend, 'improving');
});

test('scope: systemic when most doctors low; concentrated names them worst-first (higher_worse)', () => {
  const doctors = [
    doc('d1', 'interaction_alerts', 60, 5, 'Dr A'), doc('d2', 'interaction_alerts', 40, 5, 'Dr B'),
    doc('d3', 'interaction_alerts', 5, 5), doc('d4', 'interaction_alerts', 8, 5),
    doc('d5', 'interaction_alerts', 3, 5), doc('d6', 'interaction_alerts', 6, 5),
  ];
  const r = computeDomainSignals({ domains: [{ key: 'interaction_alerts', value: 15, n: 200 }], doctors });
  const s = r.signals[0];
  assert.equal(s.scope, 'concentrated');
  assert.equal(s.affected[0].name, 'Dr A'); // highest rate first for higher_worse
  assert.match(s.action, /Dr A \(60, 5 notes\)/);
});

test('placeholders substituted; fallbacks when absent', () => {
  const doctors = Array.from({ length: 5 }, (_, i) => doc(`d${i}`, 'documentation_completeness', 70, 5));
  const r = computeDomainSignals({
    domains: [{ key: 'documentation_completeness', value: 80, n: 100 }],
    doctors,
    placeholders: { top_gap_documentation: 'No advice / plan recorded' },
  });
  assert.match(r.signals[0].action, /No advice \/ plan recorded/);
  const r2 = computeDomainSignals({
    domains: [{ key: 'interaction_alerts', value: 30, n: 100 }],
    doctors: Array.from({ length: 5 }, (_, i) => doc(`d${i}`, 'interaction_alerts', 30, 5)),
  });
  assert.match(r2.signals[0].action, /most frequent flagged pairs in this window/);
  assert.doesNotMatch(r2.signals[0].action, /\{top_pairs\}/);
});

test('low_value_rate is HELD by default; included with includeHeld + confidence estimate', () => {
  const domains = [{ key: 'low_value_rate' as GovDomainKey, value: 69, n: 494 }];
  const off = computeDomainSignals({ domains });
  assert.equal(off.signals.length, 0);
  assert.equal(off.healthy.length, 0); // held metrics don't leak into healthy either
  const on = computeDomainSignals({ domains, includeHeld: true });
  assert.equal(on.signals[0].metric, 'low_value_rate');
  assert.equal(on.signals[0].severity, 'watch'); // 69 < 75 actNow, ≥50 signal
  assert.equal(on.signals[0].confidence, 'estimate');
});

test('kind discriminator and unit present on every domain signal', () => {
  const r = computeDomainSignals({ domains: [{ key: 'prescribing_safety', value: 50, n: 100 }] });
  assert.equal(r.signals[0].kind, 'domain');
  assert.equal(r.signals[0].unit, 'score');
});

test('mixed scope appends most-affected list to systemic action', () => {
  // 40% affected, 6 doctors (> concentratedMax) ⇒ mixed
  const doctors = Array.from({ length: 15 }, (_, i) =>
    doc(`d${i}`, 'prescribing_safety', i < 6 ? 40 : 90, 5, `Dr ${i}`));
  const r = computeDomainSignals({ domains: [{ key: 'prescribing_safety', value: 65, n: 150 }], doctors });
  assert.equal(r.signals[0].scope, 'mixed');
  assert.match(r.signals[0].action, /Start with the most affected doctors/);
});
