/**
 *   node --test --import tsx lib/__tests__/opd-rescore-direction.test.ts
 *
 * The `direction` dead-path fix (PRD 29 Jul 2026).
 *
 * MEASURED defect: `concept_id` is written by the concept tick AFTER the audit row lands, so on
 * the fresh-LLM path `finalize()` always sees an empty conceptId and `stampDirection` can never
 * fire — 52 prefixed findings across 0.81.16/0.81.17, zero directions. On the REUSE path the
 * stored findings DO carry `concept_id`, so the stamp works. The fix is a separate watermarked
 * re-score pass that drives the reuse path (D-1/D-2); the race with the concept tick is closed by
 * keying the watermark on the coded_at the re-score OBSERVED (D-3), not on when it ran.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stampDirection, opdSignalType } from '../opd-note-audit-core.ts';
import { computeOpdScore, hysteresisBand } from '../opd-note-score-core.ts';
import {
  rescoreCandidateSql, clampRescoreLimit, RESCORE_WATERMARK_UPSERT_SQL, buildWatermarkParams,
  pdqi9ObjFromStoredRows, directionGained, underuseCount, reduceRescoreReport, emptyRescoreReport,
  resolveEngineFilter, RESCORE_LOCK_KEY, RESCORE_LOCK_TTL_MS, rescoreLockHeld,
} from '../opd-rescore-direction-core.ts';
import { OPD_ENGINE_VERSIONS_CURRENT } from '../opd-note-audit-core.ts';
import type { OpdFinding } from '../opd-note-audit-core.ts';
import type { DeidOpdCase } from '../opd-ingest-core.ts';
import type { RescoreOutcome } from '../opd-rescore-direction-core.ts';

const AUDIT = readFileSync('lib/opd-note-audit.ts', 'utf8');
const ROUTE = readFileSync('app/api/admin/opd-rescore-direction/route.ts', 'utf8');
const MIGRATION = readFileSync('migrations/0030_opd_rescore_state.sql', 'utf8');
const STORE = readFileSync('lib/opd-audit-store.ts', 'utf8');

function mkFinding(p: Partial<OpdFinding> & { concept_id?: string }): OpdFinding {
  return {
    subject: 'Vitamin D supplementation not offered', verdict: 'low-value', confidence: 0.9,
    domain: 'appropriateness', rationale: 'guideline-indicated therapy absent from the plan',
    evidence: [], estimates: [], citation_ids: [], source: 'llm', ...p,
  } as OpdFinding;
}
// No medications on the case — irrelevant to the underuse tests (check 1 keys on OVERUSE + the
// antibiotic text regex), minimal by construction.
const CASE = { medications: [] } as unknown as DeidOpdCase;

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · Acceptance §4.1 — the reuse path stamps; the fresh path (no concept_id) does not
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§4.1: concept_id "underuse:…" + source llm ⇒ direction underuse', () => {
  const [f] = stampDirection([mkFinding({ concept_id: 'underuse:rx:vitamin d' })], CASE);
  assert.equal(f.direction, 'underuse');
});

test('§4.1: an underuse finding contributes ZERO penalty', () => {
  const base = { completenessCoverage: 1, pdqi9: null, patientCentred: { present: 2, total: 2 } };
  const [f] = stampDirection([mkFinding({ concept_id: 'underuse:rx:vitamin d' })], CASE);
  const withUnderuse = computeOpdScore({ ...base, findings: [{ verdict: f.verdict, confidence: f.confidence, domain: f.domain, direction: f.direction }] });
  const withNothing = computeOpdScore({ ...base, findings: [] });
  assert.equal(withUnderuse.headline, withNothing.headline, 'zero penalty ⇒ identical headline');
});

test('§4.1 pinned DELIBERATELY: the same finding with NO concept_id emerges with NO direction — the fresh-path behaviour, so a future change to it is visible', () => {
  const [f] = stampDirection([mkFinding({})], CASE);
  assert.equal(f.direction, undefined);
});

test('overuse: prefix stamps overuse (the four measured 0.81.17 exhibits — non-antibiotic subjects)', () => {
  const [f] = stampDirection([mkFinding({ concept_id: 'overuse:investigation:cbc', subject: 'CBC without indication', rationale: 'no indication documented' })], CASE);
  assert.equal(f.direction, 'overuse');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · Acceptance §4.2 — D-6: documentation/process prefixes set NOTHING
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§4.2 (D-6): documentation: and process: prefixes set no direction — absent stays the honest default', () => {
  const out = stampDirection([
    mkFinding({ concept_id: 'documentation:note:follow-up interval' }),
    mkFinding({ concept_id: 'process:referral:pathway' }),
  ], CASE);
  for (const f of out) assert.equal(f.direction, undefined);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · Acceptance §4.3 — D-3: the watermark stores the OBSERVED coded_at, by identity
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§4.3 (D-3): the value written as based_on_coded_at IS the value read — identity, not recency', () => {
  const observed = '2026-07-29T04:11:22.000Z';
  const params = buildWatermarkParams({
    uid: 'u1', engineVersion: 'opd-note-audit/0.81.17', observedCodedAt: observed,
    indexBefore: 61, indexAfter: 74, bandBefore: 'C', bandAfter: 'B',
  });
  assert.equal(params[2], observed, 'written ($3) === read, verbatim');
  assert.deepEqual(params, ['u1', 'opd-note-audit/0.81.17', observed, 61, 74, 'C', 'B']);
});

test('the watermark SQL binds based_on_coded_at as $3 and reserves now() for rescored_at only', () => {
  assert.ok(RESCORE_WATERMARK_UPSERT_SQL.includes('(uid, engine_version, based_on_coded_at, rescored_at, index_before, index_after, band_before, band_after)'));
  assert.ok(RESCORE_WATERMARK_UPSERT_SQL.includes('VALUES ($1, $2, $3, now(), $4, $5, $6, $7)'),
    'based_on_coded_at = $3 (the observed value); now() feeds rescored_at ONLY');
  assert.ok(RESCORE_WATERMARK_UPSERT_SQL.includes('ON CONFLICT (uid, engine_version) DO UPDATE'));
});

test('the route passes the coded_at from the CANDIDATE SELECT and never re-reads it after the update', () => {
  assert.ok(ROUTE.includes('observedCodedAt: stored.coded_at'), 'the selected value, verbatim');
  // The only SQL the route runs is the core's candidate query and the core's watermark upsert —
  // no inline SQL string exists that could re-read coded_at after the update.
  assert.ok(!/`\s*SELECT/i.test(ROUTE), 'no inline SELECT anywhere in the route');
  assert.ok(!ROUTE.includes('even_concept_state'), 'the route holds no SQL of its own against the concept watermark');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · The candidate query — bound params only, fail safe
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('candidate SQL: engine versions are a BOUND array param — unknown version ⇒ zero rows, never a throw', () => {
  const q = rescoreCandidateSql(true);
  assert.ok(q.includes('a.engine_version = ANY($2::text[])'));
  assert.ok(q.includes('a.app_source = $1'));
  assert.ok(q.includes('LIMIT $3'));
  assert.ok(!q.includes('0.81'), 'no version string is ever interpolated into the SQL text');
});

test('candidate SQL: candidacy = the coder touched the note more recently than the last re-score observed', () => {
  const q = rescoreCandidateSql(true);
  assert.ok(q.includes("(r.uid IS NULL OR date_trunc('milliseconds', s.coded_at) > r.based_on_coded_at)"));   // A-4: ms-truncated, or the pass never drains
  assert.ok(q.includes('JOIN even_concept_state s'));
  assert.ok(q.includes('LEFT JOIN opd_rescore_state r'));
  assert.ok(q.includes('a.excluded_reason IS NULL'));
});

test('candidate SQL tolerates migration 0029 not having run (displayed_band variant)', () => {
  assert.ok(rescoreCandidateSql(true).includes('a.displayed_band'));
  assert.ok(!rescoreCandidateSql(false).includes('displayed_band'));
});

test('?limit= — default 800, clamped 1..3000, junk lands on the default', () => {
  assert.equal(clampRescoreLimit(null), 800);
  assert.equal(clampRescoreLimit('nonsense'), 800);
  assert.equal(clampRescoreLimit(-5), 800);
  assert.equal(clampRescoreLimit(0), 800);
  assert.equal(clampRescoreLimit(1), 1);
  assert.equal(clampRescoreLimit(99999), 3000);
  assert.equal(clampRescoreLimit('50'), 50);
});

// A-1 (D-8) — the ?engine= single-stratum filter. WHITELIST, not passthrough: only an exact member
// of the family narrows the list; anything else selects zero rows. The value is a bound parameter
// either way; these pin that it never reaches the query as a live term.
test('A-1 §1: resolveEngineFilter(null) returns the whole family', () => {
  assert.deepEqual(resolveEngineFilter(null, OPD_ENGINE_VERSIONS_CURRENT), [...OPD_ENGINE_VERSIONS_CURRENT]);
  assert.deepEqual(resolveEngineFilter('  ', OPD_ENGINE_VERSIONS_CURRENT), [...OPD_ENGINE_VERSIONS_CURRENT], 'blank is absent');
});

test('A-1 §2: an exact family member narrows to exactly that one version', () => {
  assert.deepEqual(resolveEngineFilter('opd-note-audit/0.81.17', OPD_ENGINE_VERSIONS_CURRENT), ['opd-note-audit/0.81.17']);
});

test('A-1 §3: an unknown version yields [] — the fail-safe, never a widened scope', () => {
  assert.deepEqual(resolveEngineFilter('opd-note-audit/9.9.9', OPD_ENGINE_VERSIONS_CURRENT), []);
  assert.deepEqual(resolveEngineFilter('0.81.17', OPD_ENGINE_VERSIONS_CURRENT), [],
    'a short form is NOT accepted and NOT helpfully prefixed — exact match is the safety property');
});

test("A-1 §4: an injection-shaped value yields [] and never reaches the query as a live term", () => {
  assert.deepEqual(resolveEngineFilter("'; DROP TABLE", OPD_ENGINE_VERSIONS_CURRENT), []);
});

test("A-1 §5: the report's engine_versions reflects the FILTERED list, not the family", () => {
  assert.ok(ROUTE.includes("const engines = resolveEngineFilter(p.get('engine'), OPD_ENGINE_VERSIONS_CURRENT);"));
  assert.ok(ROUTE.includes('engine_versions: engines.length,'), 'the report describes what actually ran');
  assert.ok(ROUTE.includes('[APP, engines, limit]'), 'and the same resolved list is the $2 bound parameter');
  assert.ok(!ROUTE.includes('[APP, [...OPD_ENGINE_VERSIONS_CURRENT], limit]'), 'the unfiltered family no longer feeds $2 directly');
});

test('a candidate-query error degrades to an EMPTY report — never a 500', () => {
  // A-2 §5: every counter zero, including the new apply diagnostics; first_apply_error null.
  assert.deepEqual(emptyRescoreReport(), { considered: 0, not_fetched: 0, direction_stamped: 0, index_changed: 0, band_changed: 0, applied: 0, apply_skipped: 0, apply_error: 0, first_apply_error: null, missing_audit_uid: 0, sample: [] });
  assert.ok(ROUTE.includes('...emptyRescoreReport(),'), 'the catch path returns the empty report');
  assert.ok(ROUTE.includes('candidate_query_error'), 'with the error surfaced for diagnosis, not swallowed');
  const catchIdx = ROUTE.indexOf('candidate_query_error');
  assert.ok(!ROUTE.slice(catchIdx - 400, catchIdx).includes('status: 500'), 'the degrade path is a 200');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5 · The route — reuse path, in-place update, apply gate, no scheduler
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('finalize() runs stampDirection on the reuse path — the moment that already works', () => {
  assert.ok(AUDIT.includes('out = stampDirection(out, oc);'), 'inside finalize');
  assert.ok(AUDIT.includes('const findings: OpdFinding[] = finalize([...det, ...opts.reuse.llmFindings]);'),
    'and the reuse path routes stored findings — which carry concept_id — through it');
});

test('the route threads each row\'s OWN engine_version into auditOpdNote, so the UPDATE is in place', () => {
  assert.ok(ROUTE.includes('auditOpdNote(note, { trace: false, reuse, engineVersion })'));
  assert.ok(ROUTE.includes("const engineVersion = String(stored.engine_version || '')"));
});

test('?apply=1 is the ONLY write switch — read-only without it', () => {
  assert.ok(ROUTE.includes("const apply = p.get('apply') === '1';"));
  const applyIdx = ROUTE.indexOf("const apply = p.get('apply') === '1';");
  const updIdx = ROUTE.indexOf('await updateOpdAudit', applyIdx);
  assert.ok(updIdx > applyIdx, 'the write happens after the switch is read');
  assert.ok(/if \(apply\)/.test(ROUTE), 'and is gated on it');
  const wmIdx = ROUTE.indexOf('RESCORE_WATERMARK_UPSERT_SQL', updIdx);
  assert.ok(wmIdx > updIdx, "the watermark write follows updateOpdAudit's 'updated' inside the same gate");
});

test('§2.7: no cron, no ?auto=1, no scheduler — cadence is V\'s decision, later', () => {
  assert.ok(!ROUTE.includes("get('auto')"), 'no drain switch is read');
  const vercelJson = readFileSync('vercel.json', 'utf8');
  assert.ok(!vercelJson.includes('opd-rescore-direction'), 'no cron entry was added');
});

test('hysteresis is NOT this build\'s code — the band rides updateOpdAudit (D-4), the report only mirrors it', () => {
  assert.ok(ROUTE.includes('hysteresisBand(indexAfter, storedDisplayed)'), 'the REPORT prediction uses the same pure rule');
  assert.ok(!ROUTE.includes('hysteresisCaseSql'), 'no SQL hysteresis of its own');
  assert.ok(!ROUTE.includes('UPDATE opd_note_audits'), 'the audit-row write is updateOpdAudit\'s alone');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 6 · The report — index/band movement counted DIRECTLY (rows_changed is not acceptable here)
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('reduceRescoreReport counts direction/index/band movement directly and samples ≤ 20 movers', () => {
  const moved: RescoreOutcome = { uid: 'a', fetched: true, directionGained: 2, indexBefore: 61, indexAfter: 74, bandBefore: 'C', bandAfter: 'B', nUnderuse: 2, applied: true };
  const still: RescoreOutcome = { uid: 'b', fetched: true, directionGained: 0, indexBefore: 80, indexAfter: 80, bandBefore: 'B', bandAfter: 'B', nUnderuse: 0, applied: true };
  const missing: RescoreOutcome = { uid: 'c', fetched: false, directionGained: 0, indexBefore: null, indexAfter: null, bandBefore: null, bandAfter: null, nUnderuse: 0, applied: false };
  const r = reduceRescoreReport([moved, still, missing]);
  assert.equal(r.considered, 2, 'not_fetched rows are NOT considered');
  assert.equal(r.not_fetched, 1);
  assert.equal(r.direction_stamped, 2);
  assert.equal(r.index_changed, 1);
  assert.equal(r.band_changed, 1);
  assert.equal(r.applied, 2, 'a zero-change note is still applied AND watermarked, so it is not rescanned');
  assert.deepEqual(r.sample.map((s) => s.uid), ['a'], 'only movers enter the sample');
});

// A-2 — the apply path must say why it failed. 'skipped' and a discarded throw were measured
// indistinguishable on prod (applied 0 at HTTP 200 with no error output); these diagnostics are
// purely additive — the fail-safe catch still continues.
test('A-2 §1: one skipped + one error outcome count into apply_skipped 1 / apply_error 1', () => {
  const base = { fetched: true, directionGained: 0, indexBefore: 70, indexAfter: 70, bandBefore: 'B', bandAfter: 'B', nUnderuse: 0, applied: false };
  const r = reduceRescoreReport([
    { ...base, uid: 'a', applyOutcome: 'skipped', auditUid: 'a' },
    { ...base, uid: 'b', applyOutcome: 'error', applyError: 'column "x" does not exist', auditUid: 'b' },
    { ...base, uid: 'c', applyOutcome: 'updated', applied: true, auditUid: 'c' },
  ]);
  assert.equal(r.apply_skipped, 1);
  assert.equal(r.apply_error, 1);
  assert.equal(r.applied, 1);
});

test('A-2 §2: first_apply_error is the FIRST non-empty error message, null when none occurred', () => {
  const base = { fetched: true, directionGained: 0, indexBefore: 70, indexAfter: 70, bandBefore: 'B', bandAfter: 'B', nUnderuse: 0, applied: false };
  const r = reduceRescoreReport([
    { ...base, uid: 'a', applyOutcome: 'error', applyError: 'first message' },
    { ...base, uid: 'b', applyOutcome: 'error', applyError: 'second message' },
  ]);
  assert.equal(r.first_apply_error, 'first message');
  assert.equal(reduceRescoreReport([{ ...base, uid: 'c', applyOutcome: 'updated', applied: true }]).first_apply_error, null);
});

test('A-2 §3: an applyError longer than 300 characters is truncated to 300', () => {
  const base = { fetched: true, directionGained: 0, indexBefore: 70, indexAfter: 70, bandBefore: 'B', bandAfter: 'B', nUnderuse: 0, applied: false };
  const r = reduceRescoreReport([{ ...base, uid: 'a', applyOutcome: 'error', applyError: 'x'.repeat(500) }]);
  assert.equal(r.first_apply_error?.length, 300);
});

test('A-2 §4: missing_audit_uid counts apply-path outcomes whose auditUid is null or empty', () => {
  const base = { fetched: true, directionGained: 0, indexBefore: 70, indexAfter: 70, bandBefore: 'B', bandAfter: 'B', nUnderuse: 0, applied: false };
  const r = reduceRescoreReport([
    { ...base, uid: 'a', applyOutcome: 'skipped', auditUid: null },
    { ...base, uid: 'b', applyOutcome: 'skipped', auditUid: '' },
    { ...base, uid: 'c', applyOutcome: 'updated', applied: true, auditUid: 'c' },
    { ...base, uid: 'd' },   // dry run — no apply outcome, never counted
  ]);
  assert.equal(r.missing_audit_uid, 2, "separates `if (!k.uid) return 'skipped'` from the-UPDATE-matched-no-row");
});

test("A-2: the route records updateOpdAudit's outcome and never console-logs the driver message", () => {
  assert.ok(ROUTE.includes('const res = await updateOpdAudit(audit);'));
  assert.ok(ROUTE.includes('applyOutcome = res;'), "'skipped' is no longer collapsed into silence");
  assert.ok(ROUTE.includes("applyOutcome = 'error';"));
  assert.ok(ROUTE.includes('applyError = String((e as Error)?.message ?? e).slice(0, 300);'));
  assert.ok(ROUTE.includes('auditUid: audit.keys?.uid ?? null,'));
  assert.ok(!ROUTE.includes('console.'), 'the driver message reaches the report only — never the console');
});

test('directionGained counts findings that GAINED a direction; underuseCount feeds the sample', () => {
  const before = [mkFinding({ concept_id: 'underuse:rx:vitamin d' })];
  const after = stampDirection(before, CASE);
  assert.equal(directionGained(before, after), 1);
  assert.equal(directionGained(after, after), 0, 'idempotent re-stamp gains nothing');
  assert.equal(underuseCount(after), 1);
  assert.equal(directionGained(null, []), 0, 'junk stored findings degrade to zero, never a throw');
});

test('pdqi9 stored rows-array reconstructs to the computeOpdScore object form', () => {
  assert.deepEqual(pdqi9ObjFromStoredRows([{ attr: 'accurate', value: 4 }, { attr: 'thorough', value: '3' }]), { accurate: 4, thorough: 3 });
  assert.equal(pdqi9ObjFromStoredRows([]), null);
  assert.equal(pdqi9ObjFromStoredRows(null), null);
  assert.equal(pdqi9ObjFromStoredRows([{ attr: '', value: 4 }]), null, 'nameless rows do not fabricate an assessment');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 7 · A-3 — $2 must deduce ONE type in updateOpdAudit's statement
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// MEASURED on prod: apply_error 14/14, "inconsistent types deduced for parameter $2". $2 is
// sc.headline — deduced integer by `note_quality_index = $2` and numeric by the hysteresis CASE's
// literal comparisons. Live since 0029 ran (28 Jul, when withBand became true); the insert path
// never broke because saveOpdAudit's CASE reads EXCLUDED.note_quality_index, a column reference.
// The fix is a cast at the CASE's use site ONLY — same value, same thresholds, same g.

// hysteresisCaseSql is deliberately unexported; the statement cannot run in tests. Extract the
// real function from source and evaluate it, so the assertion is on the GENERATED SQL, not a copy.
function extractHysteresisCaseSql(): (priorCol: string, newBand: string, newIndex: string) => string {
  const start = STORE.indexOf('function hysteresisCaseSql');
  const end = STORE.indexOf('\n}', start) + 2;
  assert.ok(start > 0 && end > start, 'hysteresisCaseSql is locatable in the store source');
  const HYSTERESIS_G = 3.87;   // pinned: the calibration everything is measured against
  const js = STORE.slice(start, end).replace(/: string/g, '');   // the source is TS; strip the annotations
  return new Function('HYSTERESIS_G', `${js}; return hysteresisCaseSql;`)(HYSTERESIS_G);
}

test("A-3 §1: hysteresisCaseSql('displayed_band','$3','$2::int') emits $2::int in every comparison, $3 as every result", () => {
  const gen = extractHysteresisCaseSql()('displayed_band', '$3', '$2::int');
  assert.equal((gen.match(/\$2::int/g) || []).length, 8, 'all eight band-boundary comparisons carry the cast');
  assert.equal((gen.match(/\$2(?!::int)/g) || []).length, 0, 'no bare $2 survives anywhere in the CASE');
  assert.equal((gen.match(/THEN \$3/g) || []).length, 2, 'both THEN arms (no-prior + decisive crossing) yield $3');
  assert.ok(gen.includes('ELSE displayed_band'), 'the hold arm is the prior column, untouched');
});

test('A-3 §2: the UPDATE statement deduces $2 from the SET clause and casts it in the CASE', () => {
  assert.ok(STORE.includes('note_quality_index = $2,'), 'the SET clause — integer deduction');
  assert.ok(STORE.includes("hysteresisCaseSql('displayed_band', '$3', '$2::int')"), 'the CASE site — cast form');
  assert.ok(!STORE.includes("hysteresisCaseSql('displayed_band', '$3', '$2')"), 'the bare form is gone');
});

test("A-3 §3: saveOpdAudit's conflict clause still reads EXCLUDED.note_quality_index — the two call sites must never be \"unified\" back into this bug", () => {
  assert.ok(STORE.includes("hysteresisCaseSql('opd_note_audits.displayed_band', 'EXCLUDED.displayed_band', 'EXCLUDED.note_quality_index')"),
    'a column reference needs no cast; adding one would be noise at best');
});

test('A-3 §4: the pure twin hysteresisBand is untouched — same thresholds, same g', () => {
  assert.equal(hysteresisBand(82, 'B'), 'B', 'inside the guard: holds');
  assert.equal(hysteresisBand(90, 'B'), 'A', 'decisive crossing: moves to the band the index implies');
  assert.equal(hysteresisBand(90, null), 'A', 'no prior: raw band');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 8 · A-4 — convergence, the lvc_category strip, and the pass lock
// ═════════════════════════════════════════════════════════════════════════════════════════════

test("A-4 §1 (defect 1): the candidate comparison truncates the DB side to the watermark's precision", () => {
  const q = rescoreCandidateSql(true);
  assert.ok(q.includes("(r.uid IS NULL OR date_trunc('milliseconds', s.coded_at) > r.based_on_coded_at)"),
    'a JS Date holds milliseconds; timestamptz holds microseconds — untruncated, every watermark sits ~900µs behind what it observed and the pass can never drain');
  assert.ok(!q.includes('s.coded_at > r.based_on_coded_at)') || !/\bOR s\.coded_at >/.test(q),
    'no bare microsecond-vs-millisecond comparison survives');
  // The SELECT list still carries the FULL-precision s.coded_at — the watermark stores what was
  // observed; only the COMPARISON is truncated. (D-3 unchanged.)
  assert.ok(q.includes('s.coded_at,'), 'selection still reads the observed value verbatim');
});

// Defect 2 — the taxonomy gate. The map is a closure inside finalize(); extract the REAL shipped
// source and evaluate it with the real opdSignalType, so the assertion is on what runs, not a copy.
function extractTaxonomyGate(): (out: OpdFinding[], stamped: OpdFinding[]) => OpdFinding[] {
  const anchor = AUDIT.indexOf('const stamped = stampLvcMetadata(out, lvcRules);');
  const start = AUDIT.indexOf('out = out.map((f, i) => {', anchor);
  const end = AUDIT.indexOf('});', start) + 3;
  assert.ok(anchor > 0 && start > anchor && end > start, 'the gate is locatable in the audit source');
  const js = AUDIT.slice(start, end).replace(' as typeof f & { lvc_category?: string }', '');
  return new Function('out', 'stamped', 'opdSignalType', `${js} return out;`).bind(null) as never;
}
const runGate = (out: OpdFinding[], stamped: OpdFinding[]): OpdFinding[] =>
  (extractTaxonomyGate() as unknown as (o: OpdFinding[], s: OpdFinding[], sig: typeof opdSignalType) => OpdFinding[])(out, stamped, opdSignalType);

test('A-4 §2 (defect 2): an underuse finding carrying lvc_category on input emerges WITHOUT it — every other key survives', () => {
  const f = mkFinding({ concept_id: 'underuse:rx:vitamin d', direction: 'underuse', lvc_category: 'antibiotic', signal_type: 'missed_therapy' } as never);
  const [got] = runGate([f], [{ ...f, lvc_category: 'antibiotic' }]);
  assert.ok(!('lvc_category' in got), 'the stored stamp from the original audit is REMOVED, not merely not-re-added');
  for (const k of Object.keys(f).filter((k) => k !== 'lvc_category')) {
    assert.deepEqual((got as never)[k], (f as never)[k], `key survives verbatim: ${k}`);
  }
});

test('A-4 §3 (defect 2): a non-underuse finding is unchanged — it still receives stamped[i] with its lvc_category', () => {
  const f = mkFinding({ concept_id: 'overuse:investigation:cbc', direction: 'overuse' } as never);
  const stampedIn = { ...f, lvc_category: 'other', rule_ref: 'r1' } as OpdFinding;
  const [got] = runGate([f], [stampedIn]);
  assert.deepEqual(got, stampedIn, 'the gate only ever intervenes on underuse');
});

test('A-4 §4 (defect 2): underuse + signal_type low_value_care — specific type restored AND lvc_category dropped, both on one finding', () => {
  const f = mkFinding({ concept_id: 'underuse:rx:vitamin d', direction: 'underuse', lvc_category: 'supplement_polypharmacy', signal_type: 'low_value_care' } as never);
  const [got] = runGate([f], [{ ...f }]);
  assert.ok(!('lvc_category' in got));
  assert.equal(got.signal_type, opdSignalType(f.subject, f.domain, { verdict: f.verdict }),
    'recomputed with the same pure opdSignalType the stamper used — never invented');
  assert.notEqual(got.signal_type, 'low_value_care');
});

test('A-4 §5 (defect 3): the pass lock — lab_batch semantics, TTL pinned, held ⇒ empty report, never a 500', () => {
  // Pure lock predicate, byte-for-byte labLockHeld semantics.
  const now = new Date('2026-07-29T10:00:00Z');
  assert.equal(rescoreLockHeld(null, now), false, 'absent ⇒ free');
  assert.equal(rescoreLockHeld('', now), false, 'empty ⇒ free');
  assert.equal(rescoreLockHeld('garbage', now), false, 'unparseable ⇒ free, never a wedge');
  assert.equal(rescoreLockHeld(new Date(now.getTime() - 60_000).toISOString(), now), true, 'fresh ⇒ held');
  assert.equal(rescoreLockHeld(new Date(now.getTime() - RESCORE_LOCK_TTL_MS - 1).toISOString(), now), false, 'expired ⇒ free — a crashed run self-heals');
  assert.equal(RESCORE_LOCK_TTL_MS, 600_000, "the TTL is present and pinned — its absence was the 28 Jul lab-batch defect");
  assert.equal(RESCORE_LOCK_KEY, 'opd_rescore_direction_lock');
  // Route wiring: held ⇒ HTTP 200 empty report with skipped:'locked'; acquire ISO now; release on
  // EVERY exit path via finally, best-effort.
  assert.ok(ROUTE.includes("skipped: 'locked', ...emptyRescoreReport()"));
  assert.ok(ROUTE.includes('await setSetting(RESCORE_LOCK_KEY, new Date().toISOString());'));
  assert.ok(ROUTE.includes("if (lockAcquired) await setSetting(RESCORE_LOCK_KEY, '').catch(() => {});"));
  assert.ok(/\} finally \{/.test(ROUTE), 'the release lives in a finally');
  const lockIdx = ROUTE.indexOf("skipped: 'locked'");
  assert.ok(!ROUTE.slice(lockIdx - 300, lockIdx + 100).includes('status: 5'), 'the locked path is a 200');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 9 · Migration 0030 — additive, idempotent, the composite key the race guard needs
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('migration 0030: CREATE TABLE IF NOT EXISTS opd_rescore_state, keyed (uid, engine_version)', () => {
  assert.ok(MIGRATION.includes('CREATE TABLE IF NOT EXISTS opd_rescore_state'));
  assert.ok(MIGRATION.includes('PRIMARY KEY (uid, engine_version)'));
  assert.ok(MIGRATION.includes('based_on_coded_at  TIMESTAMPTZ NOT NULL'));
  assert.ok(!/DROP|ALTER TABLE opd_note_audits/i.test(MIGRATION), 'additive only — nothing existing is touched');
});
