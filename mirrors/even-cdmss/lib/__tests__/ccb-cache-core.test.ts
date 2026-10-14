/**
 *   node --experimental-strip-types --test lib/__tests__/ccb-cache-core.test.ts
 *
 * CCB v2 P1 cache cores: snapshot freshness arithmetic + TTL parsing + the row mapper (a corrupt
 * row must read as a MISS, never as a servable hit), and the document-extract cache key.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSnapshotFresh, snapshotTtlHours, mapSnapshotRow, toEpochMs,
  SNAPSHOT_TTL_H_DEFAULT, SNAPSHOT_SCHEMA_VERSION,
} from '../ccb-dossier-cache-core.ts';
import { docSha } from '../ccb-extract-cache-core.ts';

const H = 3_600_000;
const NOW = 1_752_000_000_000; // fixed epoch ms — no wall-clock dependence

// ── isSnapshotFresh: boundaries ────────────────────────────────────────────────
test('isSnapshotFresh: just inside the TTL is fresh', () => {
  assert.equal(isSnapshotFresh(NOW - (24 * H - 1), 24, NOW), true);
});

test('isSnapshotFresh: exactly at the TTL is NOT fresh (strict <)', () => {
  assert.equal(isSnapshotFresh(NOW - 24 * H, 24, NOW), false);
});

test('isSnapshotFresh: just outside the TTL is stale', () => {
  assert.equal(isSnapshotFresh(NOW - (24 * H + 1), 24, NOW), false);
});

test('isSnapshotFresh: zero age is fresh', () => {
  assert.equal(isSnapshotFresh(NOW, 24, NOW), true);
});

test('isSnapshotFresh: negative age (clock skew, refreshed in the future) is fresh', () => {
  // Safe direction: serve now, refresh once the TTL genuinely lapses.
  assert.equal(isSnapshotFresh(NOW + 5 * H, 24, NOW), true);
});

test('isSnapshotFresh: a non-positive TTL means never fresh, not unbounded', () => {
  assert.equal(isSnapshotFresh(NOW, 0, NOW), false);
  assert.equal(isSnapshotFresh(NOW, -1, NOW), false);
});

test('isSnapshotFresh: non-finite inputs are never fresh', () => {
  assert.equal(isSnapshotFresh(NaN, 24, NOW), false);
  assert.equal(isSnapshotFresh(NOW, NaN, NOW), false);
  assert.equal(isSnapshotFresh(NOW, 24, NaN), false);
  assert.equal(isSnapshotFresh(Infinity, 24, NOW), false);
});

test('isSnapshotFresh: a sub-hour TTL still works', () => {
  assert.equal(isSnapshotFresh(NOW - 20 * 60_000, 0.5, NOW), true);   // 20 min old, 30 min TTL
  assert.equal(isSnapshotFresh(NOW - 40 * 60_000, 0.5, NOW), false);  // 40 min old
});

// ── snapshotTtlHours: env read ────────────────────────────────────────────────
test('snapshotTtlHours: parses a valid value', () => {
  assert.equal(snapshotTtlHours('6'), 6);
  assert.equal(snapshotTtlHours('0.5'), 0.5);
});

test('snapshotTtlHours: unset / junk / non-positive fall back to the default', () => {
  for (const bad of [undefined, '', '   ', 'abc', '0', '-3', 'NaN', 'Infinity']) {
    assert.equal(snapshotTtlHours(bad), SNAPSHOT_TTL_H_DEFAULT, `expected default for ${JSON.stringify(bad)}`);
  }
});

test('snapshotTtlHours default is 24', () => {
  assert.equal(SNAPSHOT_TTL_H_DEFAULT, 24);
});

// ── toEpochMs ─────────────────────────────────────────────────────────────────
test('toEpochMs accepts Date, ISO string, and epoch number', () => {
  assert.equal(toEpochMs(new Date(NOW)), NOW);
  assert.equal(toEpochMs(new Date(NOW).toISOString()), NOW);
  assert.equal(toEpochMs(NOW), NOW);
});

test('toEpochMs rejects everything else', () => {
  for (const bad of [null, undefined, '', 'not-a-date', {}, [], NaN, new Date('nope')]) {
    assert.equal(toEpochMs(bad), null, `expected null for ${String(bad)}`);
  }
});

// ── mapSnapshotRow: a corrupt row is a MISS, never a stale-wrong serve ────────
// v2 Build B: a servable bundle must carry the current _schemaVersion stamp.
const bundle = { member: { uid: 'm1' }, snapshot: {}, timeline: [], latestEpisodeUid: 'e1', _schemaVersion: SNAPSHOT_SCHEMA_VERSION };

test('mapSnapshotRow maps a jsonb object row', () => {
  const got = mapSnapshotRow({ snapshot: bundle, refreshed_at: new Date(NOW) });
  assert.ok(got);
  assert.equal(got.refreshedAt, NOW);
  assert.deepEqual(got.bundle, bundle);
});

test('mapSnapshotRow maps a row whose snapshot arrived as a JSON string', () => {
  const got = mapSnapshotRow({ snapshot: JSON.stringify(bundle), refreshed_at: new Date(NOW).toISOString() });
  assert.ok(got);
  assert.deepEqual(got.bundle, bundle);
  assert.equal(got.refreshedAt, NOW);
});

test('mapSnapshotRow returns null for a missing row (cache miss)', () => {
  assert.equal(mapSnapshotRow(undefined), null);
  assert.equal(mapSnapshotRow(null), null);
});

test('mapSnapshotRow returns null for an unparseable or non-object snapshot', () => {
  for (const bad of ['{not json', 'null', '[]', 42, null, undefined, true]) {
    assert.equal(mapSnapshotRow({ snapshot: bad, refreshed_at: new Date(NOW) }), null, `expected miss for ${String(bad)}`);
  }
  // A JSON array is valid JSON but not a DossierBundle.
  assert.equal(mapSnapshotRow({ snapshot: [1, 2], refreshed_at: new Date(NOW) }), null);
});

test('mapSnapshotRow returns null when refreshed_at is unreadable', () => {
  for (const bad of [null, undefined, 'garbage', {}]) {
    assert.equal(mapSnapshotRow({ snapshot: bundle, refreshed_at: bad }), null);
  }
});

test('mapSnapshotRow never throws on hostile input', () => {
  assert.doesNotThrow(() => mapSnapshotRow({ snapshot: '{"a":', refreshed_at: 'x' }));
});

// ── schema-version guard (v2 Build B) ────────────────────────────────────────
test('SNAPSHOT_SCHEMA_VERSION is 2 (v1 = P1 rows, unstamped)', () => {
  assert.equal(SNAPSHOT_SCHEMA_VERSION, 2);
});

test('a P1 bundle (no _schemaVersion) is a MISS, so the enriched timeline appears without waiting out the TTL', () => {
  const v1 = { member: { uid: 'm1' }, snapshot: {}, timeline: [], latestEpisodeUid: 'e1' };
  assert.equal(mapSnapshotRow({ snapshot: v1, refreshed_at: new Date(NOW) }), null);
});

test('a bundle stamped with any other version is a MISS (older or newer)', () => {
  for (const v of [1, 3, '2', null, undefined, 2.0001, NaN]) {
    const b = { ...bundle, _schemaVersion: v };
    assert.equal(mapSnapshotRow({ snapshot: b, refreshed_at: new Date(NOW) }), null, `version ${String(v)} should miss`);
  }
});

test('a correctly stamped bundle is servable, and the stamp rides along harmlessly', () => {
  const got = mapSnapshotRow({ snapshot: bundle, refreshed_at: new Date(NOW) });
  assert.ok(got);
  assert.equal((got.bundle as unknown as { _schemaVersion: number })._schemaVersion, SNAPSHOT_SCHEMA_VERSION);
  assert.equal(got.refreshedAt, NOW);
});

test('the version guard also applies to a snapshot that arrived as a JSON string', () => {
  const v1 = JSON.stringify({ member: {}, timeline: [] });
  assert.equal(mapSnapshotRow({ snapshot: v1, refreshed_at: new Date(NOW) }), null);
  const v2 = JSON.stringify(bundle);
  assert.ok(mapSnapshotRow({ snapshot: v2, refreshed_at: new Date(NOW) }));
});

// ── docSha ────────────────────────────────────────────────────────────────────
const URL_A = 'https://storage.googleapis.com/even-prod-reports/abc123.pdf';
const URL_B = 'https://storage.googleapis.com/even-prod-reports/abc124.pdf';

test('docSha is deterministic', () => {
  assert.equal(docSha(URL_A), docSha(URL_A));
});

test('docSha diverges for different URLs', () => {
  assert.notEqual(docSha(URL_A), docSha(URL_B));
});

test('docSha is 64 lowercase hex chars', () => {
  const s = docSha(URL_A);
  assert.equal(s.length, 64);
  assert.match(s, /^[0-9a-f]{64}$/);
});

test('docSha matches the known SHA-256 of a fixed string', () => {
  // Pins the algorithm + encoding: sha256("abc") is a published constant.
  assert.equal(docSha('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('docSha does NOT normalise — a byte of difference is a different document', () => {
  assert.notEqual(docSha(URL_A), docSha(`${URL_A} `));          // trailing space
  assert.notEqual(docSha(URL_A), docSha(URL_A.toUpperCase()));  // case
  assert.notEqual(docSha(URL_A), docSha(`${URL_A}?sig=x`));     // query string
});

test('docSha handles the empty string and unicode without throwing', () => {
  assert.match(docSha(''), /^[0-9a-f]{64}$/);
  assert.match(docSha('https://x/…é.pdf'), /^[0-9a-f]{64}$/);
});
