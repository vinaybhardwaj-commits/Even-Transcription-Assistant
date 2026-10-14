/**
 * Pure-core tests for lib/opd-feedback-rollup-core.ts (PRD OPD-FEEDBACK-LOOP-MCP-PRD §8).
 * Run: node --experimental-strip-types --test lib/__tests__/opd-feedback-rollup-core.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ratio, pct, clampLimit, clusterKey, isEscalationComment,
  reduceRollup, buildRollupFindingSql, buildRollupFiredSql, buildRollupMissedSql,
  buildDetailSql, shapeDetailRow, parseAdjudicateArgs, buildAdjudicationInsert,
  buildAdjudicationListSql, reduceLedgerList,
  ESCALATION_MARKER, UNCLASSIFIED, UNJOINED, DECISIONS,
} from '../opd-feedback-rollup-core.ts';

// 1 — current-state dedup expression: latest created_at per (audit_id, finding_ref), tie-break id DESC
test('dedup expression selects latest per (audit_id, finding_ref), tie-break highest id', () => {
  const s = buildRollupFindingSql({ appSource: 'standalone' }).text;
  assert.match(s, /DISTINCT ON \(f\.audit_id, f\.finding_ref\)/);
  assert.match(s, /ORDER BY f\.audit_id, f\.finding_ref, f\.created_at DESC, f\.id DESC/);
  // the finding detail query uses the same current-state CTE
  assert.match(buildDetailSql({ appSource: 'standalone', scope: 'finding', history: false, limit: 50 }).text, /DISTINCT ON \(f\.audit_id, f\.finding_ref\)/);
});

// 2 — precision_strict excludes contested; zero-denominator → null (not NaN)
test('precision_strict excludes contested; zero denominator → null', () => {
  const r = reduceRollup({
    findingRows: [
      { engine_version: '0.81.2', signal_type: 'drug_interaction', verdict: 'true_positive', n: 3 },
      { engine_version: '0.81.2', signal_type: 'drug_interaction', verdict: 'nitpick', n: 1 },
      { engine_version: '0.81.2', signal_type: 'drug_interaction', verdict: 'false', n: 1 },
      { engine_version: '0.81.2', signal_type: 'drug_interaction', verdict: 'contested', n: 5 },
    ],
    firedRows: [], missedRows: [], auditRows: [], reviewerRows: [], ledgerRows: [],
  });
  const b = r.buckets[0];
  assert.equal(b.tp, 3); assert.equal(b.contested, 5); assert.equal(b.triaged, 10);
  assert.equal(b.precision_strict, 0.6);          // 3 / (3+1+1) — contested excluded
  assert.equal(b.contested_rate, 0.5);            // 5 / 10
  // contested-only bucket → strict denominator 0 → null, never NaN
  const only = reduceRollup({ findingRows: [{ engine_version: 'e', signal_type: 's', verdict: 'contested', n: 4 }], firedRows: [], missedRows: [], auditRows: [], reviewerRows: [], ledgerRows: [] });
  assert.equal(only.buckets[0].precision_strict, null);
  assert.ok(!Number.isNaN(only.buckets[0].precision_strict as unknown as number));
});

// 3 — coverage: fired=10, triaged=4 → 40.0
test('coverage_pct = triaged/fired as a one-decimal percentage', () => {
  const r = reduceRollup({
    findingRows: [
      { engine_version: '0.81.2', signal_type: 'nsaid', verdict: 'true_positive', n: 2 },
      { engine_version: '0.81.2', signal_type: 'nsaid', verdict: 'false', n: 2 },
    ],
    firedRows: [{ engine_version: '0.81.2', signal_type: 'nsaid', fired: 10 }],
    missedRows: [], auditRows: [], reviewerRows: [], ledgerRows: [],
  });
  const b = r.buckets[0];
  assert.equal(b.fired, 10); assert.equal(b.triaged, 4); assert.equal(b.coverage_pct, 40.0);
  assert.equal(r.totals.coverage_pct, 40.0);
});

// 4 — parseAdjudicateArgs
test('parseAdjudicateArgs: valid log accepted; bad decision/action/missing rationale rejected', () => {
  const ok = parseAdjudicateArgs({ action: 'log', cluster_key: 'nsaid@0.81.2', decision: 'monitor', rationale: 'watch it' });
  assert.equal(ok.ok, true);
  if (ok.ok && ok.action === 'log') { assert.equal(ok.decision, 'monitor'); assert.equal(ok.author, 'cowork-orchestrator'); assert.equal(ok.prd_ref, null); }
  assert.match((parseAdjudicateArgs({ action: 'log', cluster_key: 'c', decision: 'fix' }) as { error: string }).error, /rationale/);
  assert.match((parseAdjudicateArgs({ action: 'log', cluster_key: 'c', decision: 'nuke', rationale: 'x' }) as { error: string }).error, /decision must be/);
  assert.match((parseAdjudicateArgs({ action: 'log', decision: 'fix', rationale: 'x' }) as { error: string }).error, /cluster_key/);
  assert.match((parseAdjudicateArgs({ action: 'sideways' }) as { error: string }).error, /action must be/);
});

test('parseAdjudicateArgs: monitor and all five decisions accepted; list defaults + clamp', () => {
  for (const d of DECISIONS) assert.equal(parseAdjudicateArgs({ action: 'log', cluster_key: 'c', decision: d, rationale: 'r' }).ok, true);
  const l = parseAdjudicateArgs({ action: 'list' });
  assert.equal(l.ok, true);
  if (l.ok && l.action === 'list') { assert.equal(l.cluster_key, null); assert.equal(l.limit, 50); }
  const l2 = parseAdjudicateArgs({ action: 'list', cluster_key: 'x', limit: 9999 });
  if (l2.ok && l2.action === 'list') assert.equal(l2.limit, 200); // clamped to max
});

// 5 — missed rows: grouped by CATEGORY (F6 / A10.1), nulls as "(unclassified)"
test('missed rows: grouped by category; null category labelled (unclassified); unjoined engine preserved', () => {
  // F6 (addendum A10.1) — this previously grouped by `signal_type`, which NOTHING populates on a
  // missed row, so every bucket collapsed to one null key and recall had no denominator. Rewritten,
  // not deleted: the (unclassified) and UNJOINED assertions are preserved verbatim, now on category.
  const r = reduceRollup({
    findingRows: [], firedRows: [],
    missedRows: [
      { engine_version: '0.81.2', category: null, n: 2 },
      { engine_version: UNJOINED, category: 'coding', n: 1 },
    ],
    auditRows: [], reviewerRows: [], ledgerRows: [],
  });
  const unc = r.missed.find((m) => m.category === UNCLASSIFIED);
  assert.ok(unc && unc.n === 2);
  assert.ok(r.missed.some((m) => m.engine_version === UNJOINED));
  assert.equal(r.totals.missed, 3);
});

// 6 — SQL builders emit expected parameter slots; reject unknown scope/verdict filter values
test('buildDetailSql: whitelist rejects bad scope/verdict; param slots line up', () => {
  assert.throws(() => buildDetailSql({ appSource: 'standalone', scope: 'weird' as never, history: false, limit: 50 }), /unknown scope/);
  assert.throws(() => buildDetailSql({ appSource: 'standalone', scope: 'finding', verdict: 'agree', history: false, limit: 50 }), /unknown verdict filter for scope=finding/);
  // finding, no filters, current-only → params [appSource, study(null §8), limit]; uses inner JOIN cur
  const a = buildDetailSql({ appSource: 'standalone', scope: 'finding', history: false, limit: 50 });
  assert.equal(a.params.length, 3);
  assert.equal(a.params[1], null);          // §8: the always-present study slot, NULL by default
  assert.match(a.text, /\nJOIN cur ON cur\.cur_id = f\.id/);       // current-only = inner join
  // finding, history=true → LEFT JOIN + history flag; all filters present → 6 params
  const b = buildDetailSql({ appSource: 'standalone', scope: 'finding', verdict: 'false', signalType: 'nsaid', uid: 'u1', engineVersion: '0.81.2', history: true, limit: 300 });
  assert.match(b.text, /LEFT JOIN cur ON cur\.cur_id = f\.id/);
  assert.equal(b.params.length, 7);         // +1: the §8 study slot
  assert.equal(b.params[b.params.length - 1], 200);               // limit clamped 300 → 200
  // audit scope path parameterizes the scope value
  const c = buildDetailSql({ appSource: 'standalone', scope: 'audit', verdict: 'agree', history: false, limit: 50 });
  assert.ok(c.params.includes('audit') && c.params.includes('agree'));
});

test('rollup SQL builders parameterize every arg (no interpolation) and count slots', () => {
  // app($1) + study($2, §8 always present) + since($3) + until($4) + signalType($5) + engineVersion($6) = 6
  const f = buildRollupFindingSql({ appSource: 'standalone', engineVersion: '0.81.2', since: '2026-07-01', until: '2026-07-08', signalType: 'nsaid' });
  assert.equal(f.params.length, 6);
  assert.deepEqual(buildRollupFindingSql({ appSource: 's' }).params, ['s', null]); // app + the NULL study slot
  assert.deepEqual(buildRollupFiredSql({ appSource: 's' }).params, ['s']);         // fired is audit-side: no study slot
  assert.equal(buildRollupMissedSql({ appSource: 's', since: 'd1' }).params.length, 3);
  assert.match(buildRollupFiredSql({ appSource: 's' }).text, /jsonb_array_elements\(COALESCE\(a\.findings/);
});

// 7 — F4 escalation marker: counter matches the fixed prefix only
test('isEscalationComment + rollup n_escalations count only the marker prefix', () => {
  assert.equal(isEscalationComment(ESCALATION_MARKER), true);
  assert.equal(isEscalationComment(ESCALATION_MARKER + ' extra'), true);
  assert.equal(isEscalationComment('escalation package generated'), false); // missing the [ ] prefix
  assert.equal(isEscalationComment('note: [escalation package generated]'), false); // not a prefix
  assert.equal(isEscalationComment(null), false);
  const r = reduceRollup({
    findingRows: [], firedRows: [], missedRows: [], reviewerRows: [], ledgerRows: [],
    auditRows: [
      { verdict: null, comment: ESCALATION_MARKER },
      { verdict: null, comment: ESCALATION_MARKER },
      { verdict: 'agree', comment: 'looks fine' },
      { verdict: 'disagree', comment: null },
    ],
  });
  assert.equal(r.audit_scope.n_comments, 4);
  assert.equal(r.audit_scope.n_escalations, 2);
  assert.equal(r.audit_scope.verdict_counts.agree, 1);
  assert.equal(r.audit_scope.verdict_counts.disagree, 1);
  assert.equal(r.audit_scope.verdict_counts.none, 2);
});

// 8 — numeric guards
test('ratio/pct guard zero denominators to null and round', () => {
  assert.equal(ratio(1, 0), null);
  assert.equal(ratio(1, 3), 0.3333);
  assert.equal(pct(0, 0), null);
  assert.equal(pct(1, 3), 33.3);
  assert.equal(clampLimit(undefined), 50);
  assert.equal(clampLimit(0), 1);
  assert.equal(clampLimit(500), 200);
  assert.equal(clampLimit(75), 75);
});

// 10/11 — open-adjudication gate
test('open_adjudications: ≥3 false+nitpick opens; defer/absent open; fix|monitor close', () => {
  const findingRows = [
    { engine_version: '0.81.2', signal_type: 'nsaid', verdict: 'false', n: 2 },
    { engine_version: '0.81.2', signal_type: 'nsaid', verdict: 'nitpick', n: 2 },   // 4 ≥ 3 → candidate
    { engine_version: '0.81.2', signal_type: 'benzo', verdict: 'false', n: 1 },     // 1 < 3 → not
    { engine_version: '0.81.2', signal_type: 'muscle', verdict: 'false', n: 3 },    // 3 → candidate
    { engine_version: '0.81.2', signal_type: 'coding', verdict: 'nitpick', n: 5 },  // 5 → candidate
  ];
  const r = reduceRollup({
    findingRows, firedRows: [], missedRows: [], auditRows: [], reviewerRows: [],
    ledgerRows: [
      { cluster_key: clusterKey('muscle', '0.81.2'), decision: 'defer' },  // defer → still open
      { cluster_key: clusterKey('coding', '0.81.2'), decision: 'fix' },    // fix → closed
    ],
  });
  // LAB-MCP Phase 1 (normative detail 5): cluster_key is now the BARE signal_type — engine version is
  // metadata, not identity. This test previously asserted versioned keys; it is rewritten, not
  // deleted, and its LEDGER rows deliberately stay versioned, which additionally proves that a
  // historical '<signal>@<version>' decision still closes the cluster after read-time normalisation.
  assert.deepEqual(r.open_adjudications, ['muscle', 'nsaid']);   // sorted, bare signal types
  assert.equal(r.open_adjudications.includes('benzo'), false);   // below threshold
  assert.equal(r.open_adjudications.includes('coding'), false);  // closed by a versioned 'fix' row
  // monitor also closes (non-defer)
  const r2 = reduceRollup({ findingRows: findingRows.filter((x) => x.signal_type === 'muscle'), firedRows: [], missedRows: [], auditRows: [], reviewerRows: [], ledgerRows: [{ cluster_key: clusterKey('muscle', '0.81.2'), decision: 'monitor' }] });
  assert.deepEqual(r2.open_adjudications, []);
});

// 12 — ledger list current flag
test('reduceLedgerList marks the newest row per cluster_key as current', () => {
  const rows = [
    { id: 3, cluster_key: 'a', decision: 'fix', rationale: 'r3', prd_ref: null, author: null, created_at: '2026-07-08' },
    { id: 2, cluster_key: 'a', decision: 'defer', rationale: 'r2', prd_ref: null, author: null, created_at: '2026-07-07' },
    { id: 1, cluster_key: 'b', decision: 'monitor', rationale: 'r1', prd_ref: null, author: null, created_at: '2026-07-06' },
  ];
  const out = reduceLedgerList(rows);
  assert.deepEqual(out.map((r) => r.is_current), [true, false, true]);
});

// 13 — shapeDetailRow
test('shapeDetailRow resolves the finding from finding_raw; ref_resolved + history flags', () => {
  const withFinding = shapeDetailRow({
    feedback_id: 'fid', created_at: 't', scope: 'finding', verdict: 'false', comment: 'wrong', author: 'V', uid: 'u',
    audit_id: 'aid', finding_ref: 'abc123', signal_type: 'nsaid', engine_version: '0.81.2', note_date: 'd', doctor_uid: 'doc',
    finding_raw: { subject: 'NSAID x anticoagulant', verdict: 'low-value', domain: 'prescribing_safety', rationale: 'why' }, history: false,
  });
  assert.equal(withFinding.ref_resolved, true);
  assert.deepEqual(withFinding.finding, { subject: 'NSAID x anticoagulant', verdict: 'low-value', domain: 'prescribing_safety', rationale: 'why' });
  // finding scope but ref no longer resolves → finding null, ref_resolved false, verdict still present
  const unresolved = shapeDetailRow({
    feedback_id: 'f2', created_at: 't', scope: 'finding', verdict: 'true_positive', comment: null, author: null, uid: null,
    audit_id: 'aid', finding_ref: 'gone', signal_type: 's', engine_version: null, note_date: null, doctor_uid: null, finding_raw: null, history: true,
  });
  assert.equal(unresolved.ref_resolved, false);
  assert.equal(unresolved.finding, null);
  assert.equal(unresolved.verdict, 'true_positive');
  assert.equal(unresolved.history, true);
  assert.equal(unresolved.engine_version, null); // unjoined
  // missed scope → finding null, ref_resolved false
  const missed = shapeDetailRow({ feedback_id: 'f3', created_at: 't', scope: 'missed', verdict: 'missed', comment: 'BP not rechecked', author: null, uid: null, audit_id: 'aid', finding_ref: null, signal_type: null, engine_version: '0.81.2', note_date: null, doctor_uid: null, finding_raw: null, history: false });
  assert.equal(missed.ref_resolved, false);
  assert.equal(missed.finding, null);
});

// 15 — write SQL builders + clusterKey convention
test('adjudication insert/list builders parameterize; clusterKey convention', () => {
  assert.equal(clusterKey('nsaid', '0.81.2'), 'nsaid@0.81.2');
  const ins = buildAdjudicationInsert({ cluster_key: 'c', decision: 'fix', rationale: 'r', prd_ref: null, author: 'a' });
  assert.equal(ins.params.length, 5);
  assert.match(ins.text, /INSERT INTO opd_feedback_adjudications/);
  assert.match(ins.text, /VALUES \(\$1, \$2, \$3, \$4, \$5\)/);
  const list = buildAdjudicationListSql({ cluster_key: 'c', limit: 10 });
  assert.equal(list.params.length, 2); // cluster_key + limit
  assert.match(list.text, /ORDER BY created_at DESC, id DESC/);
  const listAll = buildAdjudicationListSql({ cluster_key: null, limit: 50 });
  assert.equal(listAll.params.length, 1); // limit only
});
