/**
 * lib/__tests__/defect-map-delivery.test.ts — commit D, v10 requirements 1 to 5.
 *
 * ⚠️ WHY A SEPARATE FILE. `role-keyed-defects.test.ts` is scoped to what SETTLEMENT does with a map
 * it was given. This file is about how the map REACHES an owner in the first place: the callback
 * argument, the snapshots, the owner's selection order, and the end of `?? {}`. The two halves fail
 * for different reasons and a reader chasing one should not have to read the other.
 *
 * ⚠️ WHY MOST OF THIS IS A SOURCE PIN, AND WHAT THAT COSTS. Nothing in this repository drives
 * `auditOpdNote` end to end — it needs a metabase row, a live LLM leg, retrieval, embeddings and the
 * audit store — and `writeRetrievalTerminals`, where the two snapshots are taken, is not exported.
 * So the delivery half is pinned as SOURCE TEXT, which proves the wiring is written correctly and
 * does NOT prove it executes correctly. The settlement half, which is fully reachable, is proven
 * behaviourally in the other file. This asymmetry is reported as a gap rather than papered over.
 *
 * ⚠️ COMMENTS ARE STRIPPED BEFORE EVERY SCAN. Five times in this programme a text-level check has
 * matched the prose explaining the code instead of the code — including in this file's own subject
 * matter, where every expression below is also named in a comment beside it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { attachRetrievalTelemetry, readRetrievalTelemetry } from '../retrieval-telemetry-store';
import type { ManifestDefectsByRole } from '../retrieval-telemetry-store';

/** Source with comment LINES removed, so a pin can never be satisfied by prose about the pin. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

const AUDIT_FILE = 'lib/opd-note-audit.ts';

/** The five owners that READ the map. `lib/lab-batch.ts` and `scripts/metamorphic-llm-report.mjs`
 *  supply the callback and never read it, so they are deliberately absent. */
const OWNERS = [
  'app/api/opd-audit/run/route.ts',
  'app/api/opd-audit/worker/route.ts',
  'app/api/admin/opd-audit-mini-backfill/route.ts',
  'lib/mcp-tools.ts',
  'scripts/bedrock-opd-note-probe.mjs',
];

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Requirement 1 — the callback gains a trailing optional argument
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('r1 — the callback type carries the map, and it is TRAILING and OPTIONAL', () => {
  const src = code(AUDIT_FILE);
  assert.match(src, /onLifecycleHandleUpdated\?: \(handle: LifecycleHandle, manifestDefectsByRole\?: ManifestDefectsByRole\) => void;/);
  // Trailing and optional together are what make every existing caller still compile — the two
  // callback sites that read no map are unchanged, and `lib/lab-batch.ts` was not touched at all.
  assert.match(src, /publishHandle: \(h: LifecycleHandle, manifestDefectsByRole\?: ManifestDefectsByRole\) => void;/);
  assert.match(code('lib/lab-batch.ts'), /onLifecycleHandleUpdated: \(h: LifecycleHandle\) => \{ handle = h; published = true; \}/,
    'lab-batch supplies the callback and reads no map — it must be untouched');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Requirements 2 and 3 — declarations pass nothing, terminals pass SNAPSHOTS
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('r2 — the two DECLARATION publications pass no map', () => {
  const src = code(AUDIT_FILE);
  // A declaration knows no verdict yet. Passing `{}` there would be a claim, and under requirement 6
  // an empty PROVIDED map says "every declared role has no verdict" — the opposite of the truth.
  assert.match(src, /^\s*publishHandle\(handle\);$/m, 'the adopt branch publishes the handle alone');
  assert.match(src, /publishHandle\(await declareRetrievals\(tele\.ctx, runs, tele\.persistenceIntent \?\? 'will_persist'\)\);/);
  // Neither declaration site may acquire a second argument.
  assert.equal(/publishHandle\(handle, \{\}\)/.test(src), false, 'an empty map is not "no map"');
});

test('r3 — BOTH terminal publications pass a SHALLOW SNAPSHOT, never the live object', () => {
  const src = code(AUDIT_FILE);
  const snapshots = src.match(/publishHandle\(handle, \{ \.\.\.defectsByRole \}\)/g) || [];
  assert.equal(snapshots.length, 2, 'one after the primary terminal write, one after the normative');
  // ⚠️ THE BARE FORM IS THE DEFECT. `defectsByRole` is mutated after the primary publication — the
  // normative verdict is assigned to it before the normative write — so handing the object itself
  // would let an owner observe a later mutation of something it was told at an earlier moment.
  assert.equal(/publishHandle\(handle, defectsByRole\)/.test(src), false,
    'the live object must never be published');
  // And the mutation this guards against really does happen after the first publication.
  const firstPublish = src.indexOf('publishHandle(handle, { ...defectsByRole })');
  const normAssign = src.indexOf('defectsByRole.normative_channel = validateManifest(');
  assert.ok(firstPublish > 0 && normAssign > firstPublish,
    'the normative verdict lands AFTER the primary snapshot — which is why it must be a snapshot');
});

test('r3b — a shallow snapshot really is immune to the mutation that follows it', () => {
  // The mechanism itself, stated once. `writeRetrievalTerminals` is not exported and no harness
  // drives it, so this asserts the property of the expression the source pin above requires — not a
  // reconstruction of the function.
  const live: ManifestDefectsByRole = {};
  live.primary = ['a'];
  const snapshot = { ...live };
  live.normative_channel = ['b'];
  assert.deepEqual(snapshot, { primary: ['a'] }, 'the snapshot did not grow a key it was never told');
  assert.deepEqual(live, { primary: ['a'], normative_channel: ['b'] });
  assert.notEqual(snapshot, live, 'and it is a different object');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Requirements 4 and 5 — owner selection, and the end of `?? {}`
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('r5 — NO owner reads `?? {}` any more, anywhere in the repository', () => {
  // ⚠️ THE REQUIREMENT THAT MAKES THE RULE REAL. While `?? {}` stood, an owner never passed "no map";
  // it passed an empty map, which requirement 6 reads as a missing key for EVERY declared role. So
  // requirement 7 was unreachable and requirement 6 would have made every uninstrumented save
  // partial. Scanned across all five owners AND every other file, because a seventh site appearing
  // later is the same defect.
  for (const f of OWNERS) {
    const src = code(f);
    assert.equal(/manifestDefectsByRole \?\? \{\}/.test(src), false, `${f} still coalesces to an empty map`);
    // ⚠️ SCOPED TO THE DEFECT MAP, DELIBERATELY. A blanket ban on `?? {}` was tried and is wrong:
    // `lib/mcp-tools.ts` uses the idiom correctly for `extraHeaders ?? {}` and `rows[0] ?? {}`, and
    // a test that forbade those would be forbidding unrelated, correct code. What must not exist is
    // a defect map coalesced to `{}` — including through a renamed intermediate.
    for (const line of src.split('\n')) {
      if (!/defectsByRole/i.test(line)) continue;
      assert.equal(/\?\? \{\}/.test(line), false, `${f}: a defect map coalesced to an empty map: ${line.trim()}`);
    }
  }
});

test('r4 — every owner prefers the ATTACHED map, then the CALLBACK map, then undefined', () => {
  for (const f of OWNERS) {
    const src = code(f);
    assert.match(src, /const defectsByRole = readRetrievalTelemetry\((?:audit|au)\)\?\.manifestDefectsByRole \?\? publishedDefects;/,
      `${f} does not use the attached-then-published order`);
    // The capture keeps the last map it was GIVEN and is never overwritten with undefined by the
    // declaration publication that precedes it.
    //
    // ⚠️ EVERY SITE, NOT ONE OF THEM. A whole-file `assert.match` was tried and is too weak: the
    // worker route has TWO owning callback sites, and dropping the guard on the first left the
    // second still matching, so the mutation passed. Counted instead — every assignment of the
    // capture must carry the guard, so a second unguarded site cannot hide behind a correct one.
    const assignments = (src.match(/publishedDefects = d/g) || []).length;
    const guarded = (src.match(/if \(d\) publishedDefects = d/g) || []).length;
    assert.ok(assignments > 0, `${f} never captures the map from the callback`);
    assert.equal(guarded, assignments,
      `${f}: ${assignments - guarded} capture site(s) without \`if (d)\` — a declaration would wipe the map`);
    assert.match(src, /let publishedDefects/, `${f} never declares the capture`);
  }
  // The worker really does carry two owning sites, so the counting above is not theoretical.
  assert.equal((code('app/api/opd-audit/worker/route.ts').match(/publishedDefects = d/g) || []).length, 2,
    'the daily sweep and the re-audit are both owners');
});

test('r4b — the selection order, exercised against the REAL attach and read', () => {
  // The expression itself is pinned above; this is what it evaluates to, using the production
  // `attachRetrievalTelemetry` / `readRetrievalTelemetry` pair rather than a stand-in.
  const attachedMap: ManifestDefectsByRole = { primary: ['from-attach'] };
  const publishedMap: ManifestDefectsByRole = { primary: ['from-callback'] };

  const withAttached = attachRetrievalTelemetry({} as Record<string, unknown>, {
    handle: null, manifestDefectsByRole: attachedMap,
  });
  assert.deepEqual(
    readRetrievalTelemetry(withAttached)?.manifestDefectsByRole ?? publishedMap,
    attachedMap, '1. the attached map wins');

  const noAttachment = {} as Record<string, unknown>;
  assert.deepEqual(
    readRetrievalTelemetry(noAttachment)?.manifestDefectsByRole ?? publishedMap,
    publishedMap, '2. otherwise the last map the callback delivered');

  let nothingPublished: ManifestDefectsByRole | undefined;
  assert.equal(
    readRetrievalTelemetry(noAttachment)?.manifestDefectsByRole ?? nothingPublished,
    undefined, '3. otherwise UNDEFINED — which settles clean, not partial');

  // ⚠️ AND AN ATTACHED EMPTY MAP IS STILL "PROVIDED". `RetrievalTelemetryOutcome` declares the field
  // required (v10 §5 keeps it that way), so an attached outcome always carries a map, `{}` when no
  // terminal write ran. Requirement 9 is what makes that safe: no terminal write means every run is
  // still at revision 0, and a revision-0 run is never linked by the rule.
  const withEmpty = attachRetrievalTelemetry({} as Record<string, unknown>, {
    handle: null, manifestDefectsByRole: {},
  });
  assert.deepEqual(readRetrievalTelemetry(withEmpty)?.manifestDefectsByRole ?? publishedMap, {},
    'an empty attached map is a real answer and does not fall through to the callback map');
});

test('r4c — the two callback sites that read NO map were not changed', () => {
  // ⚠️ NOT EVERY `onLifecycleHandleUpdated` IN AN EDITED FILE HAS A MATCHING READ. These two sit
  // inside files this commit edits and own no persistence: the run route's POST arm settles
  // `no_persistence_intended`, and mcp-tools' first site is not a persistence owner. Changing them
  // would be scope this commit does not have.
  assert.match(code('app/api/opd-audit/run/route.ts'),
    /telemetry: \{ ctx, route: 'opd_audit_run', persistenceIntent: 'never_persists' \},\n\s*onLifecycleHandleUpdated: \(h\) => \{ handle = h; published = true; \},/);
  assert.equal(
    (code('lib/mcp-tools.ts').match(/onLifecycleHandleUpdated: \(h: LifecycleHandle\) => \{ handle = h; published = true; \},/g) || []).length,
    1, 'mcp-tools keeps exactly one unchanged, map-free callback site');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Requirement 11 — the deterministic fallback return is untouched
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('r11 — line 1723 is not wrapped, not rewritten, and still the only unattached return', () => {
  const src = code(AUDIT_FILE);
  // The exact statement the three committed pins assert, character for character.
  assert.match(src, /^\s*return \{ keys, scorecard, completeness, findings: finalize\(det\), suggestions: \[\], sources: \[\], engineVersion: engineVersion, traceId, complexity: await complexityFor\(\), quietingGen: quietCfg\.gen, llmLegFailed: true \};$/m);
  // ⚠️ RULING 1 OF REVIEW 21. The fallback is NOT wrapped with `withHandle`: the callback has
  // already given the owner the latest handle on every throwing path, and only the defect map was
  // lost — which requirement 1 fixes at the callback, not here.
  assert.equal(/withHandle\(\{ keys, scorecard, completeness, findings: finalize\(det\)/.test(src), false,
    'the fallback must not acquire an attachment');
  assert.equal((src.match(/withHandle\(/g) || []).length, 1, 'exactly one withHandle call site, as before');
});
