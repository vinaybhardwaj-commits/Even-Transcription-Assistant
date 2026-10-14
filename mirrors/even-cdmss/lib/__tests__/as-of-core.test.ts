// lib/__tests__/as-of-core.test.ts — the D2 knowability-cut cases, MOVED (not duplicated) from
// opd-longitudinal-core.test.ts with the function (Architecture Governance Slice 1, Part A).
// Pure — no DB, no LLM, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAsOfCut } from '../as-of-core';

// ── D2 cut ──────────────────────────────────────────────────────────────────────────────────────
test('D2 cut: strict prior-day — same-day and future excluded, prior included', () => {
  const enc = [
    { encounterRef: 'a', date: '2026-07-09', kind: 'opd' },
    { encounterRef: 'b', date: '2026-07-10', kind: 'opd' },   // same day — excluded
    { encounterRef: 'c', date: '2026-07-11', kind: 'lab' },   // future — excluded
  ];
  const out = applyAsOfCut(enc, '2026-07-10');
  assert.deepEqual(out.map((e) => e.encounterRef), ['a']);
});

test('D2 cut: the audited encounterRef is always dropped even if prior-dated', () => {
  const enc = [{ encounterRef: 'presc-c', date: '2026-07-01', kind: 'opd' }, { encounterRef: 'other', date: '2026-07-01', kind: 'opd' }];
  const out = applyAsOfCut(enc, '2026-07-10', 'presc-c');
  assert.deepEqual(out.map((e) => e.encounterRef), ['other']);
});

test('D2 cut: applies identically to care_call / PROM-fold kinds', () => {
  const enc = [
    { encounterRef: 'cc', date: '2026-06-01', kind: 'care_call' },
    { encounterRef: 'pr', date: '2026-07-10', kind: 'care_call' },   // same-day fold — excluded
  ];
  const out = applyAsOfCut(enc, '2026-07-10');
  assert.deepEqual(out.map((e) => e.encounterRef), ['cc']);
});

test('D2 cut: empty when nothing survives (no-prior-history honesty)', () => {
  const enc = [{ encounterRef: 'a', date: '2026-07-10', kind: 'opd' }, { encounterRef: 'b', date: '2026-08-01', kind: 'opd' }];
  assert.equal(applyAsOfCut(enc, '2026-07-10').length, 0);
});

test('D2 cut: ISO timestamps are compared at day precision', () => {
  const enc = [{ encounterRef: 'a', date: '2026-07-09T23:59:00Z', kind: 'opd' }];
  assert.equal(applyAsOfCut(enc, '2026-07-10T08:00:00Z').length, 1);
});

test('D2 cut: does not mutate the input array', () => {
  const enc = [{ encounterRef: 'a', date: '2026-07-09' }, { encounterRef: 'b', date: '2026-07-10' }];
  const before = enc.length;
  applyAsOfCut(enc, '2026-07-10');
  assert.equal(enc.length, before);
});
