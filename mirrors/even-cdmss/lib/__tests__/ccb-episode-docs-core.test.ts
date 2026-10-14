/**
 *   node --experimental-strip-types --test lib/__tests__/ccb-episode-docs-core.test.ts
 *
 * CCB v2 P2: EpisodeBundle → the split-screen document pane's list.
 * Prescription-first ordering, label derivation, null-url filtering, empty/hostile bundles.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { docsFromBundle } from '../ccb-episode-docs-core.ts';
import type { EpisodeBundle } from '../ccb-fetch-core.ts';

const RX = 'https://storage.googleapis.com/even-prod-rx/presc.pdf';
const USG = 'https://storage.googleapis.com/even-prod-rad/usg.pdf';
const LAB = 'https://storage.googleapis.com/even-prod-dx/cbc.pdf';

/** Minimal bundle — only the fields docsFromBundle reads. */
function bundle(partial: Record<string, unknown>): EpisodeBundle {
  return { prescription: { url: null }, reports: [], ...partial } as unknown as EpisodeBundle;
}

test('prescription comes first and is labelled "Encounter note"', () => {
  const docs = docsFromBundle(bundle({
    prescription: { url: RX },
    reports: [{ kind: 'radiology', url: USG, date: '2026-05-19' }],
  }));
  assert.equal(docs.length, 2);
  assert.equal(docs[0].kind, 'prescription');
  assert.equal(docs[0].label, 'Encounter note');
  assert.equal(docs[0].url, RX);
});

test('reports keep bundle order after the prescription', () => {
  const docs = docsFromBundle(bundle({
    prescription: { url: RX },
    reports: [
      { kind: 'diagnostic', url: LAB, date: '2026-05-01' },
      { kind: 'radiology', url: USG, date: '2026-05-19' },
    ],
  }));
  assert.deepEqual(docs.map((d) => d.url), [RX, LAB, USG]);
});

test('labels derive from kind + IST day', () => {
  const docs = docsFromBundle(bundle({
    reports: [
      { kind: 'radiology', url: USG, date: '2026-05-19T08:00:00Z' },
      { kind: 'diagnostic', url: LAB, date: '2026-05-01' },
      { kind: 'hcu', url: 'u3', date: null },
    ],
  }));
  assert.equal(docs[0].label, 'Radiology report · 2026-05-19');
  assert.equal(docs[1].label, 'Lab report · 2026-05-01');
  assert.equal(docs[2].label, 'Health checkup report'); // no date → no suffix
});

test('an unknown report kind falls back to a generic label, never blank', () => {
  const docs = docsFromBundle(bundle({ reports: [{ kind: 'mystery', url: USG, date: '2026-05-19' }] }));
  assert.equal(docs[0].label, 'Report · 2026-05-19');
  assert.ok(docs[0].label.trim().length > 0);
});

test('an unparseable date yields no date suffix rather than a broken label', () => {
  const docs = docsFromBundle(bundle({ reports: [{ kind: 'radiology', url: USG, date: 'not-a-date' }] }));
  assert.equal(docs[0].label, 'Radiology report');
});

test('documents with no url are dropped — there is nothing to frame', () => {
  const docs = docsFromBundle(bundle({
    prescription: { url: null },
    reports: [
      { kind: 'radiology', url: '', date: '2026-05-19' },
      { kind: 'diagnostic', url: '   ', date: '2026-05-19' },
      { kind: 'hcu', url: null, date: '2026-05-19' },
      { kind: 'diagnostic', url: LAB, date: '2026-05-19' },
    ],
  }));
  assert.deepEqual(docs.map((d) => d.url), [LAB]);
});

test('an order-only episode (no prescription pdf, no reports) yields an empty list', () => {
  assert.deepEqual(docsFromBundle(bundle({ prescription: { url: null }, reports: [] })), []);
});

test('duplicate urls collapse to the first occurrence', () => {
  const docs = docsFromBundle(bundle({
    prescription: { url: RX },
    reports: [
      { kind: 'radiology', url: USG, date: '2026-05-19' },
      { kind: 'radiology', url: USG, date: '2026-05-19' },
      { kind: 'diagnostic', url: RX, date: '2026-05-19' }, // same url as the prescription
    ],
  }));
  assert.deepEqual(docs.map((d) => d.url), [RX, USG]);
  assert.equal(docs[0].kind, 'prescription'); // first occurrence wins
});

test('processedUrl is present in the shape and null today (ReportDoc carries no such column)', () => {
  const docs = docsFromBundle(bundle({ prescription: { url: RX } }));
  assert.equal(docs[0].processedUrl, null);
  assert.ok('processedUrl' in docs[0]);
});

test('a null / undefined / malformed bundle yields [] and never throws', () => {
  assert.deepEqual(docsFromBundle(null), []);
  assert.deepEqual(docsFromBundle(undefined), []);
  for (const bad of [{}, { reports: null }, { prescription: null, reports: undefined }, { reports: [null, 3, 'x'] }]) {
    assert.doesNotThrow(() => docsFromBundle(bad as unknown as EpisodeBundle));
    assert.deepEqual(docsFromBundle(bad as unknown as EpisodeBundle), []);
  }
});
