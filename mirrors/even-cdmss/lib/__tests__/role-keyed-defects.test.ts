/**
 * lib/__tests__/role-keyed-defects.test.ts — pass 0b, the cross-role contamination.
 *
 * ⚠️ THE DEFECT. `RetrievalTelemetryOutcome.manifestDefects` was one flat `string[]`, described by
 * the store's own comment as "whichever role was dirtiest", and `outcomeForOwnedSave` then marked
 * the WHOLE save dirty if it was non-empty. Two rows, one verdict, belonging to neither: a
 * `normative_channel` defect made the `primary` row `persisted_partial`, and the reverse held.
 *
 * The acceptance property, stated as the kickoff states it:
 *   a primary-role defect must not make a normative row dirty,
 *   a normative-role defect must not make a primary row dirty.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDbStub, type DbStub } from './telemetry-db-stub';
import {
  settleRetrievalTelemetry, settleOwned, outcomeForOwnedSave, upgradeForDefects,
  verdictForRun, MISSING_ROLE_VERDICT,
} from '../retrieval-settlement';
import type { LifecycleHandle, ManifestDefectsByRole } from '../retrieval-telemetry-store';

const AT = '2026-08-15T00:00:00.000Z';
const AUDIT = '11111111-1111-1111-1111-111111111111';
const SELECT_ROW = /SELECT persistence_state, row_revision, audit_id/;
const UPDATE_SETTLE = /SET persistence_state = \$3, audit_id = \$4/;

/** Both roles declared, both terminal-written, both linkable — the two-role handle production builds. */
const twoRoleHandle = (): LifecycleHandle => ({
  invocationId: 'inv-1',
  runs: [
    { role: 'primary', runId: 'r-prim', expectedRevision: 1 },
    { role: 'normative_channel', runId: 'r-norm', expectedRevision: 1 },
  ],
  persistenceIntent: 'will_persist',
});

/** Every role reached `retrieval_complete`, so the outcome applies directly and nothing reconciles. */
function readyStub(): DbStub {
  const db = installDbStub();
  db.on(SELECT_ROW, [{ persistence_state: 'retrieval_complete', row_revision: 1, audit_id: null }]);
  db.on(UPDATE_SETTLE, (c) => [{ row_revision: Number(c.params[1]) + 1 }]);
  return db;
}

/** The state each run was actually settled to, keyed by run id. $1 runId, $3 state, $4 auditId. */
function settledStates(db: DbStub): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of db.matching(UPDATE_SETTLE)) out[String(c.params[0])] = String(c.params[2]);
  return out;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 1–4. Cross-role isolation, the four corners
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('1 — a PRIMARY defect leaves the NORMATIVE run clean', async () => {
  // ⚠️ EVERY DECLARED ROLE NOW CARRIES AN EXPLICIT ENTRY (v10 requirement 6), which is what
  // production does: `defectsByRole.primary` is assigned at opd-note-audit.ts:787 and
  // `.normative_channel` at :807, each BEFORE its own terminal write. The isolation property under
  // test is unchanged — a defect in one role must leave the other role's verdict alone. What
  // changed is that a declared role with NO verdict no longer counts as clean, so omitting the
  // normative key here would now be testing the missing-key rule instead of isolation.
  const db = readyStub();
  await settleRetrievalTelemetry(twoRoleHandle(), {
    outcome: 'persisted_clean', auditId: AUDIT, settledAt: AT,
    manifestDefectsByRole: { primary: ['scorer_context_hmac_absent'], normative_channel: [] },
  });
  const states = settledStates(db);
  assert.equal(states['r-prim'], 'persisted_partial', 'the role that HAS the defect is partial');
  assert.equal(states['r-norm'], 'persisted_complete', 'and the role that does not is NOT dragged with it');
});

test('2 — a NORMATIVE defect leaves the PRIMARY run clean', async () => {
  // This is the direction that actually bit: the normative channel is the more permissive manifest,
  // so its defects were the likelier ones to exist — and they were marking the primary row partial.
  const db = readyStub();
  await settleRetrievalTelemetry(twoRoleHandle(), {
    outcome: 'persisted_clean', auditId: AUDIT, settledAt: AT,
    manifestDefectsByRole: { normative_channel: ['expansion_served_route_class_absent'], primary: [] },
  });
  const states = settledStates(db);
  assert.equal(states['r-norm'], 'persisted_partial');
  assert.equal(states['r-prim'], 'persisted_complete', 'THE acceptance property');
});

test('3 — both roles dirty: both settle dirty', async () => {
  const db = readyStub();
  await settleRetrievalTelemetry(twoRoleHandle(), {
    outcome: 'persisted_clean', auditId: AUDIT, settledAt: AT,
    manifestDefectsByRole: { primary: ['a'], normative_channel: ['b'] },
  });
  const states = settledStates(db);
  assert.equal(states['r-prim'], 'persisted_partial');
  assert.equal(states['r-norm'], 'persisted_partial');
});

test('4 — neither dirty: both settle clean', async () => {
  const db = readyStub();
  await settleRetrievalTelemetry(twoRoleHandle(), {
    outcome: 'persisted_clean', auditId: AUDIT, settledAt: AT,
    manifestDefectsByRole: { primary: [], normative_channel: [] },
  });
  const states = settledStates(db);
  assert.equal(states['r-prim'], 'persisted_complete');
  assert.equal(states['r-norm'], 'persisted_complete');
});

test('4b — an EMPTY array is clean; an ABSENT key on a linkable run is NOT', async () => {
  // ⚠️ REWRITTEN (v10 requirement 6). This used to assert that an empty array and an absent key
  // "both settle clean", which was the defect: on a map that was PROVIDED at all, a missing key
  // means nobody validated the manifest that row claims to describe. Silence from an instrument
  // that was running is not evidence of cleanliness.
  //
  // The two are still different statements — that part was always right. What changed is which way
  // the second one settles.
  const db = readyStub();
  await settleRetrievalTelemetry(twoRoleHandle(), {
    outcome: 'persisted_clean', auditId: AUDIT, settledAt: AT,
    manifestDefectsByRole: { primary: [] },     // normative_channel absent entirely
  });
  const states = settledStates(db);
  assert.equal(states['r-prim'], 'persisted_complete', 'an explicit [] is a real verdict of clean');
  assert.equal(states['r-norm'], 'persisted_partial', 'and an absent key is no verdict at all');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 5. The map absent entirely — today's behaviour for a single-role save
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('5 — no map at all: a single-role save behaves exactly as before', async () => {
  const db = readyStub();
  const single: LifecycleHandle = {
    invocationId: 'inv-2',
    runs: [{ role: 'primary', runId: 'r-only', expectedRevision: 1 }],
    persistenceIntent: 'will_persist',
  };
  await settleRetrievalTelemetry(single, { outcome: 'persisted_clean', auditId: AUDIT, settledAt: AT });
  assert.equal(settledStates(db)['r-only'], 'persisted_complete');

  // …and through `settleOwned`, which is the shape every owner actually calls.
  const db2 = readyStub();
  await settleOwned(single, 'persisted_clean', AUDIT);
  assert.equal(settledStates(db2)['r-only'], 'persisted_complete');
});

test('5b — only the CLEAN branch is upgraded; a losing race or a skip is never made partial', () => {
  // Unchanged from before the rekeying, and stated directly because it is the one rule the upgrade
  // has: neither `exists` nor `skipped` persisted anything to be partial about.
  assert.equal(upgradeForDefects('persisted_clean', ['x']), 'persisted_dirty');
  assert.equal(upgradeForDefects('persisted_clean', []), 'persisted_clean');
  assert.equal(upgradeForDefects('losing_conflict', ['x']), 'losing_conflict');
  assert.equal(upgradeForDefects('persistence_skipped', ['x']), 'persistence_skipped');
  assert.equal(upgradeForDefects('audit_persistence_failed', ['x']), 'audit_persistence_failed');
  assert.equal(upgradeForDefects('no_persistence_intended', ['x']), 'no_persistence_intended');

  // NO DEFECT CODE CHANGED MEANING. `outcomeForOwnedSave` now returns the BASE outcome only — the
  // same four mappings it always had — and the upgrade moved to the run, where the manifest is.
  assert.equal(outcomeForOwnedSave('inserted'), 'persisted_clean');
  assert.equal(outcomeForOwnedSave('updated'), 'persisted_clean');
  assert.equal(outcomeForOwnedSave('exists'), 'losing_conflict');
  assert.equal(outcomeForOwnedSave('skipped'), 'persistence_skipped');
});

test('5c — a revision-0 role is still not linked, and the per-run upgrade did not disturb that', async () => {
  // The upgrade happens before the linkable check, so a role that never wrote its terminal manifest
  // is still unlinked and still settled from the failure evidence.
  const db = installDbStub();
  db.on(SELECT_ROW, (c) => (String(c.params[0]) === 'r-norm'
    ? [{ persistence_state: 'started', row_revision: 0, audit_id: null }]
    : [{ persistence_state: 'retrieval_complete', row_revision: 1, audit_id: null }]));
  db.on(UPDATE_SETTLE, (c) => [{ row_revision: Number(c.params[1]) + 1 }]);
  db.on(/SELECT failed_phase/, []);

  const handle: LifecycleHandle = {
    invocationId: 'inv-3',
    runs: [
      { role: 'primary', runId: 'r-prim', expectedRevision: 1 },
      { role: 'normative_channel', runId: 'r-norm', expectedRevision: 0 },
    ],
    persistenceIntent: 'will_persist',
  };
  await settleRetrievalTelemetry(handle, {
    outcome: 'persisted_clean', auditId: AUDIT, settledAt: AT,
    manifestDefectsByRole: { primary: ['x'] },
  });
  const updates = db.matching(UPDATE_SETTLE);
  const norm = updates.find((c) => String(c.params[0]) === 'r-norm');
  assert.equal(norm?.params[3], null, 'the unwritten role is still not linked to the audit');
  assert.equal(norm?.params[2], 'aborted', 'and is still settled from the failure evidence');
  const prim = updates.find((c) => String(c.params[0]) === 'r-prim');
  assert.equal(prim?.params[2], 'persisted_partial', 'while the primary carries its OWN defect');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 6. Every persistence owner reaches the same derivation
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('6 — every persistence owner passes the role map, and none passes an empty one where it holds defects', () => {
  // ⚠️ SOURCE-CHECKED ACROSS ALL SIX OWNERS, because the failure mode is an owner that silently
  // keeps the old behaviour. The field RENAME is what makes that structurally impossible — a stale
  // `.manifestDefects` no longer typechecks — and this pins the positive form as well.
  const owners = [
    'app/api/opd-audit/run/route.ts',
    'app/api/opd-audit/worker/route.ts',
    'app/api/admin/opd-audit-mini-backfill/route.ts',
    'lib/mcp-tools.ts',
    'scripts/bedrock-opd-note-probe.mjs',
  ];
  for (const f of owners) {
    const src = readFileSync(f, 'utf8');
    assert.equal(/\.manifestDefects\b/.test(src), false, `${f} still reads the flat list`);
    assert.match(src, /manifestDefectsByRole/, `${f} does not read the role map`);
    // Every settle that carries a save result must also carry the map.
    for (const m of src.matchAll(/settleOwned\([^)]*outcomeForOwnedSave\([^)]*\)[^)]*\)/g)) {
      assert.match(m[0], /defectsByRole/, `${f}: a save-result settle without the map: ${m[0]}`);
    }
  }
  // The producer keys by role rather than merging.
  const audit = readFileSync('lib/opd-note-audit.ts', 'utf8');
  assert.match(audit, /defectsByRole\.primary = validateManifest\(/);
  assert.match(audit, /defectsByRole\.normative_channel = validateManifest\(/);
  assert.equal(/defects\.push\(\.\.\.validateManifest/.test(audit), false, 'the flat merge is gone');
});

test('6b — the upgrade is applied in settlement, not by the owners', () => {
  // The design: one base outcome per handle, one settlement call, the upgrade per run inside
  // `settleRetrievalTelemetry`. An owner computing `persisted_dirty` itself would be the old shape.
  const settlement = readFileSync('lib/retrieval-settlement.ts', 'utf8');
  // ⚠️ RE-PINNED (v10 requirement 6). The `?? []` form could not distinguish an absent key from an
  // explicit empty one, which is the whole distinction the rule turns on. It is now a call to
  // `verdictForRun`, which takes linkability because the rule applies only to a linkable run.
  assert.match(settlement, /const roleDefects = verdictForRun\(input\.manifestDefectsByRole, run\.role, linkable\);/);
  assert.match(settlement, /const runOutcome = upgradeForDefects\(input\.outcome, roleDefects\);/);
  // …and the old form is gone, not merely shadowed.
  assert.equal(/manifestDefectsByRole\?\.\[run\.role\] \?\? \[\]/.test(settlement), false,
    'the `?? []` read cannot survive anywhere in this file');
  // The linkability test is HOISTED, not duplicated: exactly one definition of it exists.
  //
  // ⚠️ COMMENTS STRIPPED FIRST. This is the fifth time in this programme that a text-level check
  // counted the prose ABOVE the code it was checking — the comment at retrieval-settlement.ts:143
  // names the expression while explaining why there must be only one of it, and an unstripped
  // count reads 2 and fails on a correct file.
  const settlementCode = settlement.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.equal((settlementCode.match(/run\.expectedRevision > 0/g) || []).length, 1,
    'a second copy of the linkability definition is how the two drift apart later');
  // …and the strip is not vacuous: the code it kept still contains the definition it counted.
  assert.match(settlementCode, /const linkable = run\.expectedRevision > 0;/);
  for (const f of [
    'app/api/opd-audit/run/route.ts', 'app/api/opd-audit/worker/route.ts',
    'app/api/admin/opd-audit-mini-backfill/route.ts', 'lib/mcp-tools.ts',
    'scripts/bedrock-opd-note-probe.mjs',
  ]) {
    assert.equal(
      /persisted_dirty/.test(readFileSync(f, 'utf8')), false,
      `${f} computes the dirty upgrade itself — that belongs to the run, not the owner`,
    );
  }
});

test('6c — settleOwned still takes ONE base outcome and makes ONE settlement call', async () => {
  // The design constraint, asserted rather than assumed: the map is a trailing optional argument,
  // so no positional argument moved, and one call still settles the whole handle.
  const db = readyStub();
  // Explicit entry per declared role (v10 requirement 6) — see test 1.
  await settleOwned(twoRoleHandle(), 'persisted_clean', AUDIT, { primary: ['x'], normative_channel: [] });
  const updates = db.matching(UPDATE_SETTLE);
  assert.equal(updates.length, 2, 'one call, one UPDATE per declared run — not one call per role');
  const states = settledStates(db);
  assert.equal(states['r-prim'], 'persisted_partial');
  assert.equal(states['r-norm'], 'persisted_complete');
});

test('6d — settlement is fail-safe: a role map on a handle with no runs settles nothing and throws nothing', async () => {
  const db = readyStub();
  await settleOwned(null, 'persisted_clean', AUDIT, { primary: ['x'] });
  await settleOwned({ invocationId: 'i', runs: [], persistenceIntent: 'will_persist' }, 'persisted_clean', AUDIT, { primary: ['x'] });
  assert.equal(db.matching(UPDATE_SETTLE).length, 0, 'the uninstrumented path still costs nothing');
});


// ════════════════════════════════════════════════════════════════════════════════════════════════
// 7. v10 requirement 6 — a provided map missing the run's own key
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('7 — the three cases of `verdictForRun`, stated directly', () => {
  // 1. NO MAP AT ALL (requirement 7): clean, whatever the run is. Backward compatible.
  assert.deepEqual(verdictForRun(undefined, 'primary', true), []);
  assert.deepEqual(verdictForRun(undefined, 'primary', false), []);
  // 2. OWN-ROLE KEY PRESENT (requirement 8): that entry decides, and `[]` is a real clean verdict.
  assert.deepEqual(verdictForRun({ primary: [] }, 'primary', true), []);
  assert.deepEqual(verdictForRun({ primary: ['x'] }, 'primary', true), ['x']);
  // 3. OWN-ROLE KEY ABSENT on a provided map (requirement 6): no verdict, and a LINKABLE run
  //    carries the synthetic defect that makes it partial.
  assert.deepEqual(verdictForRun({ primary: [] }, 'normative_channel', true), [MISSING_ROLE_VERDICT]);
  //    …and a revision-zero run does not (requirement 9).
  assert.deepEqual(verdictForRun({ primary: [] }, 'normative_channel', false), []);
  // An EMPTY provided map is a provided map: it says "verdicts exist, none is about you".
  assert.deepEqual(verdictForRun({}, 'primary', true), [MISSING_ROLE_VERDICT]);
  assert.deepEqual(verdictForRun({}, 'primary', false), []);
});

test('7b — requirement 10: an INHERITED key is not a verdict', () => {
  // ⚠️ WHY THIS IS NOT PARANOIA. `in` and truthiness both walk the prototype chain, and
  // `Object.prototype` already carries names — `constructor`, `toString`, `valueOf` — that a future
  // role could collide with. An inherited value would then be read as a verdict nobody recorded.
  const inherited = Object.create({ normative_channel: [] as readonly string[] }) as Record<string, readonly string[]>;
  inherited.primary = [];
  assert.equal(Object.prototype.hasOwnProperty.call(inherited, 'normative_channel'), false, 'it really is inherited');
  assert.equal('normative_channel' in inherited, true, '…and `in` really would have found it');
  // The own key decides; the inherited one is no verdict at all.
  assert.deepEqual(verdictForRun(inherited, 'primary', true), []);
  assert.deepEqual(verdictForRun(inherited, 'normative_channel', true), [MISSING_ROLE_VERDICT]);

  // And the same through real settlement, end to end.
  const src = readFileSync('lib/retrieval-settlement.ts', 'utf8');
  assert.match(src, /Object\.prototype\.hasOwnProperty\.call\(map, role\)/);
});

test('7c — an inherited key does not rescue a run from partial, through settlement', async () => {
  const db = readyStub();
  const inherited = Object.create({ normative_channel: [] as readonly string[] }) as Record<string, readonly string[]>;
  inherited.primary = [];
  await settleRetrievalTelemetry(twoRoleHandle(), {
    outcome: 'persisted_clean', auditId: AUDIT, settledAt: AT,
    manifestDefectsByRole: inherited,
  });
  const states = settledStates(db);
  assert.equal(states['r-prim'], 'persisted_complete', 'the OWN key is honoured');
  assert.equal(states['r-norm'], 'persisted_partial', 'the INHERITED one is not a verdict');
});

test('7d — THE PLACEMENT TEST: the rule reaches a linkable run and stops at a revision-zero one', async () => {
  // ⚠️ NOTHING IN THE SUITE PINNED THIS. An earlier draft claimed test 5c would catch the rule
  // being applied in the wrong place. That claim was traced and is FALSE: `ALLOWED_TRANSITIONS.started`
  // contains neither `persisted_complete` nor `persisted_partial`, so 5c's revision-zero run settles
  // `aborted` under BOTH placements and passes either way.
  //
  // This is the test that distinguishes them. One handle, one provided map holding NEITHER key:
  //   · the LINKABLE run must settle partial          — the rule fired
  //   · the REVISION-ZERO run must still go through `stateForUnwrittenRun`, unlinked
  //
  // If the rule were applied after the linkability branch, the linkable run would settle
  // `persisted_complete` and this fails on the first assertion.
  const db = installDbStub();
  db.on(SELECT_ROW, (c) => (String(c.params[0]) === 'r-zero'
    ? [{ persistence_state: 'started', row_revision: 0, audit_id: null }]
    : [{ persistence_state: 'retrieval_complete', row_revision: 1, audit_id: null }]));
  db.on(UPDATE_SETTLE, (c) => [{ row_revision: Number(c.params[1]) + 1 }]);
  db.on(/SELECT failed_phase/, []);

  await settleRetrievalTelemetry({
    invocationId: 'inv-placement',
    runs: [
      { role: 'primary', runId: 'r-link', expectedRevision: 1 },
      { role: 'normative_channel', runId: 'r-zero', expectedRevision: 0 },
    ],
    persistenceIntent: 'will_persist',
  }, {
    outcome: 'persisted_clean', auditId: AUDIT, settledAt: AT,
    manifestDefectsByRole: {},          // PROVIDED, and holding neither key
  });

  const updates = db.matching(UPDATE_SETTLE);
  const link = updates.find((c) => String(c.params[0]) === 'r-link');
  const zero = updates.find((c) => String(c.params[0]) === 'r-zero');
  assert.equal(link?.params[2], 'persisted_partial', 'the linkable run has no verdict, so it is partial');
  assert.equal(link?.params[3], AUDIT, '…and is still linked, because it did write its manifest');
  assert.equal(zero?.params[2], 'aborted', 'the revision-zero run still settles from the failure evidence');
  assert.equal(zero?.params[3], null, '…and is still not linked to the audit');

  // ⚠️ WHAT THIS TEST CANNOT PROVE, STATED RATHER THAN IMPLIED. The revision-zero assertions above
  // hold under BOTH the correct rule and a rule that ignored linkability. Traced by mutation: with
  // `linkable` replaced by `true` at the call site, the zero run's outcome becomes `persisted_dirty`,
  // its outcomeState `persisted_partial`, and `isAllowedTransition('started', …)` rejects
  // `persisted_complete` and `persisted_partial` alike — so both fall through to `reconcilerStateFor`
  // and settle `aborted`, unlinked, identically. There is no base outcome for which they differ,
  // because `upgradeForDefects` only ever moves the clean branch.
  //
  // So requirement 9 is held at the CALL SITE by the source pin in test 6b and by the unit contract
  // in test 7, not by the settled row. That is a real limit of this test, not a gap in the rule.
});

test('7e — requirement 3 in the only place it is observable: settlement never mutates the map', async () => {
  // The producer hands over a snapshot; settlement must not write back into whatever it was given,
  // or two owners sharing a map would see each other's runs.
  const db = readyStub();
  const map = Object.freeze({ primary: Object.freeze(['x']) }) as ManifestDefectsByRole;
  await settleRetrievalTelemetry(twoRoleHandle(), {
    outcome: 'persisted_clean', auditId: AUDIT, settledAt: AT, manifestDefectsByRole: map,
  });
  assert.deepEqual(map, { primary: ['x'] }, 'the map is unchanged — a frozen one would have thrown');
  assert.equal(settledStates(db)['r-norm'], 'persisted_partial');
});

test('7f — the base outcome still decides: only a CLEAN run is made partial by a missing key', async () => {
  // ⚠️ THE RULE RIDES ON `upgradeForDefects`, DELIBERATELY. A losing race, a skip or a failed save
  // persisted nothing to be partial about, and a missing verdict must not restate any of them.
  // This is 5b's property, held across the new rule rather than around it.
  for (const base of ['losing_conflict', 'persistence_skipped', 'no_persistence_intended'] as const) {
    assert.equal(upgradeForDefects(base, [MISSING_ROLE_VERDICT]), base, `${base} is not made partial`);
  }
  assert.equal(upgradeForDefects('persisted_clean', [MISSING_ROLE_VERDICT]), 'persisted_dirty');
});

test('7g — no new settlement outcome value was added, and nothing writes the synthetic code', () => {
  // v9 §5.4 considered a real "no verdict" outcome and did not propose one; this pass authorises no
  // migration, so the vocabulary must be untouched. The synthetic defect exists only to reach
  // `upgradeForDefects`, whose output is one of the EXISTING outcomes.
  const core = readFileSync('lib/retrieval-telemetry-core.ts', 'utf8');
  assert.equal(core.includes(MISSING_ROLE_VERDICT), false,
    'the synthetic code must not appear in the vocabulary file — it is not an outcome or a state');
  const sqlFile = readFileSync('migrations/0035_opd_audit_retrieval_telemetry.sql', 'utf8');
  assert.equal(sqlFile.includes(MISSING_ROLE_VERDICT), false, 'and it reaches no CHECK constraint');
  // It is read by exactly one function, and that function returns an existing outcome.
  assert.equal(upgradeForDefects('persisted_clean', [MISSING_ROLE_VERDICT]), 'persisted_dirty');
});
