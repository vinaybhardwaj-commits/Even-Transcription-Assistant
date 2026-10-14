// lib/__tests__/architecture-map-gen.test.ts — System Map Stage 1 generator tests:
// determinism / committed-map currency / coverage partition / version-registry rule.
// Run: npm test (flat-named to match the existing test glob).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MODULE_MANIFESTS, UNREGISTERED } from '../architecture/manifests';
import { MAP_MODULES, MAP_EDGES, VERSION_REGISTRY, COVERAGE } from '../architecture/map.generated';
import type { ChangeEntry } from '../architecture/changelog-types';
import { OPD_AUDIT_CHANGELOG } from '../opd-audit-changelog';
import { OPD_ENGINE_VERSION } from '../opd-note-audit-core';

// The generator is an untyped .mjs script; resolve it at runtime (tsx) so tsc doesn't chase it.
const GEN_SPECIFIER = ['..', '..', 'scripts', 'architecture-map-gen.mjs'].join('/');

test('map generation is deterministic and the committed map is current', async () => {
  const { buildMapSource } = await import(GEN_SPECIFIER);
  const first = buildMapSource();
  const second = buildMapSource();
  assert.equal(first, second, 'two runs must be byte-identical (the CI staleness gate depends on this)');
  // npm test runs from the repo root
  const committed = readFileSync('lib/architecture/map.generated.ts', 'utf8');
  assert.equal(first, committed, 'committed map.generated.ts is stale — run `npm run architecture:map`');
});

test('coverage is a true partition and matches the UNREGISTERED allowlist', () => {
  assert.equal(COVERAGE.registered + COVERAGE.unregistered, COVERAGE.total);
  assert.equal(COVERAGE.unregisteredIds.length, COVERAGE.unregistered);
  assert.deepEqual([...COVERAGE.unregisteredIds].sort(), [...UNREGISTERED].sort(),
    'the generated gap list and the manifests.ts allowlist must be the same list');
  const manifestIds = new Set(MODULE_MANIFESTS.map((m) => m.id));
  for (const id of COVERAGE.unregisteredIds) {
    assert.ok(!manifestIds.has(id), `${id} is both unregistered and a manifest id`);
  }
});

test('the governed modules appear on the map with their INVENTORY planes', () => {
  const planeOf = new Map(MAP_MODULES.map((m) => [m.id, m.plane]));
  assert.equal(planeOf.get('clinical-state'), 'pure-core');
  assert.equal(planeOf.get('member-state'), 'spine');
  assert.equal(planeOf.get('opd-note-score-core'), 'score-arithmetic');
  assert.equal(planeOf.get('opd-longitudinal'), 'advisory');
  assert.equal(planeOf.get('opd-triage-core'), 'advisory');
  assert.equal(planeOf.get('as-of-core'), 'pure-core');
});

test('version registry: declared *_VERSION constants only, live value round-trips', () => {
  assert.ok(VERSION_REGISTRY.length >= 27, `expected ≥27 declared version constants, got ${VERSION_REGISTRY.length}`);
  for (const row of VERSION_REGISTRY) {
    assert.match(row.constName, /_VERSIONS?(_|$)/, `${row.constName} does not carry the _VERSION token`);
    assert.ok(row.file.startsWith('lib/'), `${row.constName} collected outside lib/: ${row.file}`);
  }
  const engineRow = VERSION_REGISTRY.find((r) => r.constName === 'OPD_ENGINE_VERSION');
  assert.ok(engineRow, 'OPD_ENGINE_VERSION missing from the registry');
  assert.equal(engineRow!.derived, false);
  assert.equal(engineRow!.value, OPD_ENGINE_VERSION, 'generated value must equal the live constant');
});

test('edges: no self-loops, and the map shows the Slice-1 boundaries clean', () => {
  for (const e of MAP_EDGES) {
    assert.notEqual(e.from, e.to, `self-edge on ${e.from}`);
    assert.ok(e.kind === 'value' || e.kind === 'type');
  }
  // the relocation Slice 1 Part A made: the spine takes the temporal cut from the pure leaf …
  assert.ok(MAP_EDGES.some((e) => e.from === 'member-state' && e.to === 'as-of-core' && e.kind === 'value'),
    'expected the member-state → as-of-core value edge');
  // … and runs NO value import of score/audit/advisory logic (rule 3, visible on the map)
  for (const from of ['member-state', 'clinical-state']) {
    for (const to of ['opd-note-score-core', 'opd-longitudinal']) {
      assert.ok(!MAP_EDGES.some((e) => e.from === from && e.to === to && e.kind === 'value'),
        `forbidden value edge ${from} → ${to} appears on the map`);
    }
  }
});

test('ChangeEntry is a true superset: the audit changelog conforms with no data change', () => {
  const conforms: ChangeEntry[] = OPD_AUDIT_CHANGELOG;   // type-level conformance assertion
  assert.ok(conforms.length > 0);
  for (const entry of conforms) {
    assert.equal(typeof entry.date, 'string');
    assert.equal(typeof entry.scoring, 'boolean');
  }
});
