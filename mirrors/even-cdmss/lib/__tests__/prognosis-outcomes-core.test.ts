/**
 *   node --test --import tsx lib/__tests__/prognosis-outcomes-core.test.ts
 *
 * PX Phase 2 (outcome linkage) — PRD §7, every test that needs no database.
 *
 * The scenario these defend: lib/ipd-audit/store.ts upserts with
 * `ON CONFLICT (document_id, engine_version) DO UPDATE SET ... report = EXCLUDED.report`, so a
 * re-audit rewrites the complications array in place and an engine bump writes a whole new row.
 * A stored integer index therefore silently re-points; the hash does not. `unresolved` is a
 * first-class state — the block changed under a recorded outcome — never an error and never an
 * excuse to fall back to the index.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import { readFileSync } from 'node:fs';
import { guardReadOnlySql } from '../sql-guard-core';
import {
  OUTCOME_SOURCES, OUTCOME_CLASSIFICATIONS, isOutcomeSource, isOutcomeClassification,
  normalizeComplicationName, complicationHash, isComplicationHash,
  deriveClassification, resolveComplicationHash,
  currentRows, followUpBucket, inOverWarningDenominator,
} from '../prognosis-outcomes-core';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7.1 · Hash stability
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§7.1 hash stability: spacing and casing variants produce the SAME hash', () => {
  const h = complicationHash('Surgical site infection');
  for (const variant of [
    'surgical site infection',
    '  Surgical Site Infection  ',
    'SURGICAL   SITE\tINFECTION',
    'surgical\n site  infection',
  ]) {
    assert.equal(complicationHash(variant), h, `variant ${JSON.stringify(variant)}`);
  }
  // …and a genuinely different name produces a different hash.
  assert.notEqual(complicationHash('surgical site bleeding'), h);
});

test('the hash is EXACTLY sha256(normalized) hex first 16 — the stored contract, pinned', () => {
  // Pinned against an independent computation so a refactor cannot silently change stored
  // bindings: every previously stored hash would orphan.
  const name = '  Deep  Vein THROMBOSIS ';
  const expected = createHash('sha256').update('deep vein thrombosis', 'utf8').digest('hex').slice(0, 16);
  assert.equal(complicationHash(name), expected);
  assert.equal(expected.length, 16);
  assert.ok(isComplicationHash(expected));
  assert.ok(!isComplicationHash(expected + 'a'), '17 chars is not a stored hash');
  assert.ok(!isComplicationHash(expected.toUpperCase()), 'hex is lower-case');
});

test('ADDENDUM A §1.2 — the ten cross-engine vectors, pinned with their literal hashes', () => {
  // Computed from live Neon AND Node on 4 Aug 2026 (zero divergent under the fixed SQL). These are
  // THE regression suite for hash parity: this test pins the Node half; the orchestrator
  // re-validates the Postgres half against live Neon after any change to either normalization.
  // The shipped (trim-first) SQL diverged on lead_tab, trail_nl, crlf, nbsp_edge and vtab — the
  // silent-unresolved / inflated-over-warning class this pin exists to keep dead.
  const VECTORS: Array<[string, string, string]> = [
    // Written as escapes so the invisible characters are unambiguous in source: NBSP (JS \s and
    // Postgres \s both match U+00A0) and the vertical tab live below as \u escapes, never as
    // bare characters a reader cannot see.
    ['plain', 'Wound infection', '6739970f11b3130a'],
    ['pad_spaces', '  Wound infection  ', '6739970f11b3130a'],
    ['internal', 'Wound   infection', '6739970f11b3130a'],
    ['lead_tab', '\tWound infection', '6739970f11b3130a'],
    ['trail_nl', 'Wound infection\n', '6739970f11b3130a'],
    ['crlf', 'Wound infection\r\n', '6739970f11b3130a'],
    ['nbsp_edge', '\u00A0Wound infection\u00A0', '6739970f11b3130a'],
    ['nbsp_internal', 'Wound\u00A0infection', '6739970f11b3130a'],
    ['vtab', '\u000BWound infection', '6739970f11b3130a'],
    ['mixed', 'Surgical Site Infection (SSI)', '66dd35867e43e6fc'],
  ];
  for (const [name, input, expected] of VECTORS) {
    assert.equal(complicationHash(input), expected, `vector ${name}: ${JSON.stringify(input)}`);
  }
});

test('normalization is trim + lower-case + collapse internal whitespace, nothing more', () => {
  assert.equal(normalizeComplicationName('  A   B\t\nC '), 'a b c');
  // Deliberately NOT stripped: punctuation and diacritics. Adding a step later would orphan
  // every stored hash, so the contract is pinned narrow.
  assert.equal(normalizeComplicationName('Post-op ileus (paralytic)'), 'post-op ileus (paralytic)');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7.2 · Re-audit resilience — a reordered complications array still resolves by hash
// ═════════════════════════════════════════════════════════════════════════════════════════════

const BLOCK_AT_LINK_TIME = [
  { complication: 'Surgical site infection' },
  { complication: 'Deep vein thrombosis' },
  { complication: 'Anastomotic leak' },
];

test('§7.2 re-audit resilience: the array reorders, the hash still finds the right complication', () => {
  // Linked to DVT while it sat at index 1.
  const linkedHash = complicationHash('Deep vein thrombosis');
  // The re-audit rewrote the block; DVT now sits at index 0 and index 1 holds something else.
  const reordered = [
    { complication: 'Deep  Vein Thrombosis' },   // same name, different spacing — same hash
    { complication: 'Anastomotic leak' },
    { complication: 'Surgical site infection' },
  ];
  const r = resolveComplicationHash(linkedHash, reordered);
  assert.deepEqual(r, { status: 'matched', index: 0, complication: 'Deep  Vein Thrombosis' });
  // The advisory integer (1 at link time) now points at 'Anastomotic leak'. Resolution never
  // consulted it — resolveComplicationHash does not even accept an index parameter.
  assert.notEqual((reordered[1] as { complication: string }).complication.toLowerCase(), 'deep vein thrombosis');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7.3 · Engine bump — unchanged name resolves; changed name renders unresolved
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§7.3 engine bump: an outcome linked at engine A resolves against engine B when the name survived', () => {
  const linkedAtEngineA = complicationHash('Anastomotic leak');
  const blockAtEngineB = [
    { complication: 'Postoperative pneumonia' },
    { complication: 'anastomotic  LEAK' },       // reworded only in case/spacing ⇒ same binding
  ];
  const r = resolveComplicationHash(linkedAtEngineA, blockAtEngineB);
  assert.equal(r.status, 'matched');
});

test('§7.3 engine bump: a renamed complication renders UNRESOLVED — never re-pointed by index', () => {
  const linkedAtEngineA = complicationHash('Anastomotic leak');
  // Engine B rephrased the complication. The old index (2) is even in range — and must be ignored.
  const blockAtEngineB = [
    { complication: 'Surgical site infection' },
    { complication: 'Deep vein thrombosis' },
    { complication: 'Anastomotic dehiscence with leak' },
  ];
  const r = resolveComplicationHash(linkedAtEngineA, blockAtEngineB);
  assert.deepEqual(r, { status: 'unresolved' },
    'unresolved is the honest answer: the block changed under a recorded outcome');
});

test('a NULL hash reads as unpredicted, and junk shapes never throw', () => {
  assert.deepEqual(resolveComplicationHash(null, BLOCK_AT_LINK_TIME), { status: 'unpredicted' });
  assert.deepEqual(resolveComplicationHash(undefined, BLOCK_AT_LINK_TIME), { status: 'unpredicted' });
  assert.deepEqual(resolveComplicationHash('', BLOCK_AT_LINK_TIME), { status: 'unpredicted' });
  assert.deepEqual(resolveComplicationHash('deadbeefdeadbeef', []), { status: 'unresolved' });
  assert.deepEqual(
    resolveComplicationHash('deadbeefdeadbeef', [{ complication: 123 as unknown as string }]),
    { status: 'unresolved' }, 'a malformed block entry is skipped, not thrown on');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7.5 · Classification derivation — four values, from form state, never typed
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§7.5 each classification is produced by the correct form state', () => {
  const h = complicationHash('Surgical site infection');
  assert.deepEqual(
    deriveClassification({ noAdverseOutcome: false, benefitFailure: false, matchedComplicationHash: h }),
    { classification: 'predicted_occurred', matchedComplicationHash: h });
  assert.deepEqual(
    deriveClassification({ noAdverseOutcome: false, benefitFailure: false, matchedComplicationHash: null }),
    { classification: 'unpredicted_occurred', matchedComplicationHash: null });
  assert.deepEqual(
    deriveClassification({ noAdverseOutcome: false, benefitFailure: true, matchedComplicationHash: null }),
    { classification: 'benefit_failure', matchedComplicationHash: null });
  assert.deepEqual(
    deriveClassification({ noAdverseOutcome: true, benefitFailure: false, matchedComplicationHash: null }),
    { classification: 'no_adverse_outcome', matchedComplicationHash: null });
});

test('§7.5 no_adverse_outcome FORCES a null complication hash, whatever the form held', () => {
  const h = complicationHash('Deep vein thrombosis');
  const d = deriveClassification({ noAdverseOutcome: true, benefitFailure: true, matchedComplicationHash: h });
  assert.equal(d.classification, 'no_adverse_outcome', 'and it wins over the benefit-failure tick');
  assert.equal(d.matchedComplicationHash, null, 'the select was disabled; a stale value must not persist');
});

test('the vocabularies are exactly the PRD’s', () => {
  assert.deepEqual([...OUTCOME_SOURCES], ['complaint', 'readmission', 'revisit', 'reoperation', 'call', 'other']);
  assert.deepEqual([...OUTCOME_CLASSIFICATIONS], ['predicted_occurred', 'unpredicted_occurred', 'benefit_failure', 'no_adverse_outcome']);
  assert.ok(isOutcomeSource('readmission'));
  assert.ok(!isOutcomeSource('slack'));
  assert.ok(isOutcomeClassification('no_adverse_outcome'));
  assert.ok(!isOutcomeClassification('resolved'));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7.4 (pure half) · Supersede reading rules — the DB write is pinned in the store tests
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§7.4 currentRows: the default view shows only non-superseded rows; history shows all', () => {
  const rows = [
    { id: 1, superseded: true, classification: 'predicted_occurred' },
    { id: 2, superseded: false, classification: 'predicted_occurred' },
  ];
  assert.deepEqual(currentRows(rows).map((r) => r.id), [2], 'exactly one non-superseded row after a correction');
  assert.equal(rows.length, 2, 'the history toggle has both to show — nothing is deleted');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7.6 (pure mirror) · The denominator rule the metrics view must implement
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§7.6 a document with no rows is not_followed_up and OUTSIDE the over-warning denominator', () => {
  assert.equal(followUpBucket([]), 'not_followed_up');
  assert.equal(inOverWarningDenominator([]), false);
});

test('§7.6 an event row alone follows the document up but does NOT admit it to the over-warning denominator', () => {
  const rows = [{ classification: 'predicted_occurred' as const, superseded: false }];
  assert.equal(followUpBucket(rows), 'followed_up');
  assert.equal(inOverWarningDenominator(rows), false,
    'one recorded event proves someone looked at ONE outcome, not that the rest never occurred');
});

test('§7.6 a no_adverse_outcome row admits the document; a superseded one does not', () => {
  assert.equal(inOverWarningDenominator([{ classification: 'no_adverse_outcome', superseded: false }]), true);
  assert.equal(inOverWarningDenominator([{ classification: 'no_adverse_outcome', superseded: true }]), false);
  assert.equal(followUpBucket([{ classification: 'no_adverse_outcome', superseded: true }]), 'not_followed_up',
    'a fully superseded history means nobody currently vouches for follow-up');
});

test('§7.6 no_adverse alongside an event row: followed up, in the denominator, both persist', () => {
  const rows = [
    { classification: 'predicted_occurred' as const, superseded: false },
    { classification: 'no_adverse_outcome' as const, superseded: false },
  ];
  assert.equal(followUpBucket(rows), 'followed_up');
  assert.equal(inOverWarningDenominator(rows), true);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Commit 2 · §7.7 the migration is idempotent, and the store keeps the P-7 write discipline
// ═════════════════════════════════════════════════════════════════════════════════════════════

const MIGRATION = readFileSync('migrations/0033_prognosis_outcomes.sql', 'utf8');
const STORE = readFileSync('lib/prognosis-outcomes-store.ts', 'utf8');
const sqlOf = (s: string) => s.replace(/--[^\n]*/g, '');

test('§7.7 idempotent migration: every statement is IF NOT EXISTS — running it twice is a no-op', () => {
  assert.ok(MIGRATION.includes('CREATE TABLE IF NOT EXISTS prognosis_outcomes ('));
  assert.ok(MIGRATION.includes('CREATE INDEX IF NOT EXISTS prognosis_outcomes_source_idx'));
  const stmts = sqlOf(MIGRATION).split(';').map((s) => s.trim()).filter(Boolean);
  for (const st of stmts) {
    assert.ok(/^CREATE (TABLE|INDEX) IF NOT EXISTS/.test(st), `non-idempotent statement: ${st.slice(0, 60)}…`);
  }
  // The §5.1 DDL, structurally: every column the PRD names, and the partial-index predicate.
  for (const col of ['source_table', 'source_id', 'source_engine', 'app_source', 'source ',
    'observed_outcome', 'observed_at', 'horizon_days', 'matched_complication ',
    'matched_complication_hash', 'classification', 'reviewed_by_name', 'notes',
    'supersedes_id', 'superseded', 'created_at']) {
    assert.ok(MIGRATION.includes(col), `column missing from DDL: ${col.trim()}`);
  }
  assert.ok(MIGRATION.includes('WHERE superseded = FALSE'), 'the partial index serves current-rows reads');
  assert.ok(MIGRATION.includes('REFERENCES prognosis_outcomes(id)'), 'supersedes_id is a self-reference');
});

test('P-7 in the store: supersede is ONE atomic statement — flag-flip CTE + insert, no content UPDATE, no DELETE', () => {
  // The Neon HTTP driver has no multi-statement transaction on this path, so atomicity comes from
  // a single data-modifying-CTE statement. Both halves must live in the SAME template literal.
  assert.ok(STORE.includes('WITH marked AS ('), 'the CTE exists');
  const stmt = STORE.slice(STORE.indexOf('WITH marked AS ('), STORE.indexOf('RETURNING id`', STORE.indexOf('WITH marked AS (')));
  assert.ok(stmt.includes('SET superseded = TRUE'), 'the old row is flagged…');
  assert.ok(stmt.includes('AND superseded = FALSE'), '…only if still live (a raced double-correct refuses)');
  assert.ok(stmt.includes('AND source_table = $1 AND source_id = $2'), '…and only within the same source document');
  assert.ok(stmt.includes('INSERT INTO prognosis_outcomes'), 'the correction is an INSERT in the same statement');
  assert.ok(stmt.includes('supersedes_id'), 'carrying the chain');
  // Append-only: the ONLY UPDATE in the whole store is the superseded flag-flip. Checked on
  // comment-stripped source — the docblocks legitimately SAY "No DELETE".
  const storeCode = STORE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/[^\n']*$/gm, '');
  const updates = storeCode.match(/UPDATE prognosis_outcomes/g) ?? [];
  assert.equal(updates.length, 1, 'exactly one UPDATE, the flag-flip');
  assert.ok(!/\bDELETE\b/.test(storeCode), 'nothing is ever deleted');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Commit 4 · §7.6 the calibration view's denominator, and P-8 readability — pinned in source
// (the SQL itself is INFERRED; the orchestrator validates it against live Neon)
// ═════════════════════════════════════════════════════════════════════════════════════════════

const MIGRATE_ROUTE = readFileSync('app/api/admin/migrate-lab-views/route.ts', 'utf8');
const CAL_VIEW = MIGRATE_ROUTE.slice(MIGRATE_ROUTE.indexOf('CREATE VIEW v_prognosis_calibration'));

test('§7.6 the view emits the not_followed_up bucket, and the over-warning columns go NULL outside it', () => {
  assert.ok(CAL_VIEW.includes("THEN 'followed_up' ELSE 'not_followed_up' END AS follow_up_bucket"),
    'the bucket is a visible column — the honest denominator statement');
  // Over-warning is computable ONLY where a no_adverse_outcome row exists; otherwise NULL, so a
  // not-followed-up document can never silently inflate the rate.
  assert.equal((CAL_VIEW.match(/WHEN COALESCE\(o\.n_no_adverse_outcome, 0\) > 0/g) ?? []).length, 2,
    'both over-warning columns are gated on the no_adverse_outcome row');
  assert.ok(CAL_VIEW.includes('ELSE NULL END AS n_anticipated_never_occurred'));
  assert.ok(CAL_VIEW.includes('ELSE NULL END AS over_warning_rate'));
  assert.ok(CAL_VIEW.includes('AS n_unresolved'), 'the §5.2 unresolved count is emitted');
});

test('the view reads only non-superseded rows and resolves by the SAME hash as the core', () => {
  assert.equal((CAL_VIEW.match(/superseded = FALSE/g) ?? []).length, 4,
    'every prognosis_outcomes read in the view filters superseded rows (incl. the engine_drift probe)');
  // ⚠️ ADDENDUM A §1 — COLLAPSE FIRST, THEN TRIM. The first cut trimmed first, and btrim with no
  // second argument strips ASCII spaces only, so a leading tab / trailing newline survived and
  // hashed differently from Node (5 of 10 vectors diverged, MEASURED on live Neon 4 Aug). The
  // fixed order turns every \s run into a plain space, then trims exactly what JS .trim() trims.
  assert.ok(CAL_VIEW.includes("btrim(regexp_replace(lower(c.value->>'complication'), '\\\\s+', ' ', 'g'), ' ')"),
    'normalization: lower → collapse whitespace → trim ASCII space (hash parity with Node)');
  assert.ok(!CAL_VIEW.includes("lower(btrim("), 'the trim-first order is the defect — it must not come back');
  assert.ok(CAL_VIEW.includes("substr(encode(sha256(convert_to("), 'sha256 → hex');
  assert.ok(CAL_VIEW.includes("'hex'), 1, 16)"), 'first 16 chars');
  // P-2: the advisory integer never appears in the view's logic.
  assert.ok(!CAL_VIEW.includes('matched_complication '), 'resolution is by hash — the integer index is never consulted');
  // A-3: the '%-mini' guard matched ZERO rows in this table (the mini path writes to
  // lab_analyses) — an inert guard reads as a rule someone verified, so it is gone.
  assert.ok(!CAL_VIEW.includes('-mini'), 'no inert mini filter');
  // A-1: canonical = greatest audited_at with a NON-EMPTY complications array…
  assert.ok(CAL_VIEW.includes("jsonb_array_length(report->'prognosis'->'complications') > 0"));
  // …and the engine mixture is legible, never silent: TRUE on any current outcome linked at a
  // different engine, NULL when the document has no outcome rows — never FALSE by default.
  assert.ok(CAL_VIEW.includes('ELSE NULL END AS engine_drift'), 'engine_drift is NULL without outcome rows');
  assert.ok(CAL_VIEW.includes('po.source_engine IS DISTINCT FROM b.engine_version'),
    'drift compares against the canonical row, treating an unknown link engine as visible, not equal');
});

test('the migrate route creates the table BEFORE the view, mirroring migrations/0033 exactly', () => {
  const tableAt = MIGRATE_ROUTE.indexOf('CREATE TABLE IF NOT EXISTS prognosis_outcomes (');
  const viewAt = MIGRATE_ROUTE.indexOf('CREATE VIEW v_prognosis_calibration');
  assert.ok(tableAt > -1 && viewAt > tableAt, 'table first — the view reads it');
  assert.ok(MIGRATE_ROUTE.includes('CREATE INDEX IF NOT EXISTS prognosis_outcomes_source_idx'));
  assert.ok(MIGRATE_ROUTE.includes('DROP VIEW IF EXISTS v_prognosis_calibration'),
    'DROP + CREATE: idempotent as a pair, and survives column-shape changes on re-run');
  // Idempotency of the whole route addition: rerunnable statements only.
  for (const frag of ['CREATE TABLE IF NOT EXISTS prognosis_outcomes (', 'CREATE INDEX IF NOT EXISTS prognosis_outcomes_source_idx', 'DROP VIEW IF EXISTS v_prognosis_calibration']) {
    assert.ok(MIGRATE_ROUTE.includes(frag), frag);
  }
});

test('P-8: the table and the view pass the SQL guard, and lib/sql-guard-core.ts is untouched', () => {
  const outcomes = guardReadOnlySql('SELECT source, classification, observed_at FROM prognosis_outcomes WHERE superseded = FALSE LIMIT 50');
  assert.equal(outcomes.ok, true, (outcomes as { error?: string }).error);
  const view = guardReadOnlySql('SELECT document_id, follow_up_bucket, over_warning_rate FROM v_prognosis_calibration LIMIT 50');
  assert.equal(view.ok, true, (view as { error?: string }).error);
  const guard = readFileSync('lib/sql-guard-core.ts', 'utf8');
  assert.ok(guard.includes('const BLOCKED_RELATIONS = /\\b(traces|trace_events|appropriateness_runs|ccb_briefs|care_track_assignments|opd_audit_feedback)\\b/i;'),
    'the block list is byte-identical — P-8 ruled the table readable; the revisit trigger is in the PRD');
  assert.ok(!/prognosis/.test(guard), 'the guard does not need to know the feature exists');
});

test('A-2: horizon_days is DERIVED in SQL against the canonical discharged_at — never typed, never audited_at', () => {
  // Both write statements carry the same derivation: observed_at minus the canonical document's
  // discharged_at in whole days, NULL when either is absent (67 of 423 documents have no
  // discharged_at — NULL is normal, not an error).
  assert.equal((STORE.match(/HORIZON_DERIVATION/g) ?? []).length, 3, 'defined once, used by insert AND supersede');
  assert.ok(STORE.includes("SELECT ($7::date - d.discharged_at::date)"), 'whole days from discharged_at');
  assert.ok(STORE.includes('ORDER BY d.audited_at DESC'), 'the canonical row is A-1\'s: greatest audited_at…');
  assert.ok(STORE.includes("jsonb_array_length(d.report->'prognosis'->'complications') > 0"), '…with a non-empty complications array');
  // audited_at appears ONLY as the canonical-row sort key — never as a date substituted into the
  // subtraction (that would silently answer a different question).
  assert.ok(!STORE.includes('audited_at::date'), 'never a fallback to the audit date');
  assert.ok(!STORE.includes('COALESCE(d.discharged_at'), 'no substitute for an absent discharge date');
  // …and the reviewer never types it: the input field is dead, no form/route value reaches SQL.
  assert.ok(STORE.includes('IGNORED since Addendum A (A-2)'), 'the input field is documented dead');
  assert.ok(!STORE.includes('i.horizonDays'), 'the store never reads it');
});

test('SQL honesty: reads degrade to unavailable and writes to a refusal — never a throw (no DB in this sandbox)', async () => {
  // No DATABASE_URL in the test process, so every query path fails — which is exactly the
  // condition §6 requires to be survivable. `unavailable: true` (not an empty "no outcomes")
  // is the investigations-lookup discipline: null means unknown.
  assert.equal(process.env.DATABASE_URL, undefined, 'precondition: no live DB in tests');
  const { outcomesForSource, insertOutcome, supersedeOutcome } = await import('../prognosis-outcomes-store');
  const read = await outcomesForSource('ipd_discharge_audits', 'doc-1');
  assert.deepEqual(read, { rows: [], unavailable: true });
  const ins = await insertOutcome({
    sourceTable: 'ipd_discharge_audits', sourceId: 'doc-1', sourceEngine: 'ipd-discharge-audit/0.2',
    source: 'complaint', observedOutcome: 'x', observedAt: null, horizonDays: null,
    matchedComplication: null, matchedComplicationHash: null, classification: 'unpredicted_occurred',
    reviewedByName: 'Dr X', notes: null,
  });
  assert.equal(ins.ok, false, 'a failed insert is a refusal, not a throw');
  const sup = await supersedeOutcome({
    sourceTable: 'ipd_discharge_audits', sourceId: 'doc-1', sourceEngine: null,
    source: 'call', observedOutcome: 'y', observedAt: null, horizonDays: null,
    matchedComplication: null, matchedComplicationHash: null, classification: 'no_adverse_outcome',
    reviewedByName: 'Dr X', notes: null,
  }, 0);
  assert.equal(sup.ok, false, 'a bad supersedesId refuses before touching the DB');
});
