/**
 * LAB-MCP-V2 §17.6 — coverage, drift, retrieval_compare, and the generated versions file.
 *
 * ⚠️ EVERY STATEMENT IS EXERCISED ON SEEDED ROWS, NOT ON PRODUCTION. The four coverage statements
 * and the three drift ones were validated live through `audit_query` before they were written (the
 * build report lists each verbatim); what is testable HERE is the arithmetic on top of them, which
 * is where the mistakes that matter live — a denominator that includes a skip it should not, a
 * percentage of zero reported as 100, a week-over-week delta taken against a different engine
 * version. The reads themselves are injected.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  IPD_AUDITED_SQL, IPD_SELECTION_SKIPS, IPD_SKIPS_SQL, OPD_COVERAGE_SQL, OPD_EXCLUSIONS_SQL,
  QUALIFYING_DEFINITION, coveragePct, coverageReport,
} from '../tools/coverage';
import {
  DRIFT_CAVEAT, IPD_DRIFT_SQL, IPD_RETRIEVAL_DRIFT_SQL, OPD_DRIFT_SQL, delta, driftReport,
} from '../tools/drift';
import {
  SNAPSHOT_CAVEAT, bm25LegSql, fuse, rankCorrelation, retrievalCompare, vectorLegSql,
} from '../tools/retrieval-compare';
import { GENERATED_ROUTE_VERSIONS, bakedEngineVersion } from '../engine-versions.generated';
import { liveOrBakedVersion, versionSourceFor } from '../service';

// ── every inferred statement, and what may not be in one ─────────────────────────────────────

test('§17.6: every inferred statement is a single SELECT over the three named tables', () => {
  const statements: [string, string][] = [
    ['ipd_episode_audits', IPD_AUDITED_SQL(30, null)],
    ['ipd_episode_skips', IPD_SKIPS_SQL(30, 'ipd-episode-audit/0.2')],
    ['opd_note_audits', OPD_COVERAGE_SQL(30, null)],
    ['opd_note_audits', OPD_EXCLUSIONS_SQL(30, 'opd-note-audit/0.81.21')],
    ['ipd_episode_audits', IPD_DRIFT_SQL(8, null)],
    ['ipd_episode_checkpoints', IPD_RETRIEVAL_DRIFT_SQL(8, null)],
    ['opd_note_audits', OPD_DRIFT_SQL(8, null)],
  ];
  for (const [table, sql] of statements) {
    assert.match(sql, /^SELECT/, 'read only');
    assert.ok(sql.includes(`FROM ${table}`) || sql.includes(`JOIN ${table}`), `${table} is the source`);
    // Case-SENSITIVE, as §17.4's source test narrowed it: a lower-case `update` inside an
    // identifier is not a write and the check must not fire on one.
    assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|GRANT|TRUNCATE)\b/.test(sql), `a write token in: ${sql.slice(0, 60)}`);
    assert.equal((sql.match(/;/g) ?? []).length, 0, 'a single statement');
    assert.ok(!/SELECT\s+\*/.test(sql), 'never SELECT * — a new production column must be named to arrive');
    assert.ok(/LIMIT \d+/.test(sql), 'every statement is bounded');
  }
  // §17.6's SQL honesty rule names exactly three tables for coverage and drift. This is where a
  // fourth would be noticed.
  const all = statements.map(([, s]) => s).join('\n');
  const tables = [...all.matchAll(/(?:FROM|JOIN)\s+([a-z_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tables)].sort(),
    ['ipd_episode_audits', 'ipd_episode_checkpoints', 'ipd_episode_skips', 'opd_note_audits']);
});

test('§17.6: a version filter is refused rather than escaped, and the window is bounded', () => {
  for (const bad of ["0.2'; DROP TABLE x --", 'a b', "x' OR 1=1"]) {
    assert.throws(() => IPD_AUDITED_SQL(30, bad), (e: { code?: string }) => e.code === 'INVALID_INPUT');
    assert.throws(() => OPD_DRIFT_SQL(8, bad), (e: { code?: string }) => e.code === 'INVALID_INPUT');
  }
  assert.throws(() => IPD_AUDITED_SQL(0, null), (e: { code?: string }) => e.code === 'INVALID_INPUT');
  assert.throws(() => IPD_AUDITED_SQL(91, null), (e: { code?: string }) => e.code === 'INVALID_INPUT');
  assert.throws(() => IPD_DRIFT_SQL(1, null), (e: { code?: string }) => e.code === 'INVALID_INPUT');
  assert.throws(() => IPD_DRIFT_SQL(27, null), (e: { code?: string }) => e.code === 'INVALID_INPUT');
});

// ── coverage_report: the denominator ─────────────────────────────────────────────────────────

test('§17.6: coverage states its qualifying definition, in the output, in words', async () => {
  const out = await coverageReport({ engine: 'ipd_episode', days: 7 }, { read: async () => [] });
  assert.equal(out.qualifying_definition, QUALIFYING_DEFINITION.ipd_episode);
  assert.match(out.qualifying_definition, /invisible to this report/,
    'the definition must say what it CANNOT see, not only what it counts');
  const opd = await coverageReport({ engine: 'opd_note_audit', days: 7 }, { read: async () => [] });
  assert.notEqual(opd.qualifying_definition, out.qualifying_definition, 'the two engines count different things');
});

test('§17.6: only the three SELECTION skips leave the denominator', async () => {
  const read = async (source: string) => (source === 'ipd_episode_audits'
    ? [{ day: '2026-09-05', engine_version: 'ipd-episode-audit/0.2', audited: 6 }]
    : [
      { day: '2026-09-05', engine_version: 'ipd-episode-audit/0.2', reason: 'no_extraction', n: 3 },
      { day: '2026-09-05', engine_version: 'ipd-episode-audit/0.2', reason: 'no_notes', n: 1 },
      // ⚠️ NOT a selection skip. This episode QUALIFIED and the engine could not finish it, which
      // is the single most important thing a coverage report has to show.
      { day: '2026-09-05', engine_version: 'ipd-episode-audit/0.2', reason: 'diff_failed', n: 2 },
    ]);
  const out = await coverageReport({ engine: 'ipd_episode', days: 7 }, { read });
  const [d] = out.by_day;
  assert.equal(d.examined, 12, '6 audited + 6 skipped');
  assert.equal(d.qualifying, 8, 'only no_extraction (3) and no_notes (1) leave the denominator');
  assert.equal(d.audited, 6);
  assert.equal(d.coverage_pct, 75, '6 of 8');
  assert.deepEqual(d.skips_by_reason, { no_extraction: 3, no_notes: 1, diff_failed: 2 });
  assert.deepEqual([...IPD_SELECTION_SKIPS], ['no_discharge_summary', 'no_notes', 'no_extraction']);
  assert.equal(out.totals.qualifying, 8);
});

test('§17.6: nothing qualifying is a null coverage, never 100 and never 0', () => {
  assert.equal(coveragePct(0, 0), null, 'a fraction with no denominator is not a number');
  assert.equal(coveragePct(3, 0), null);
  assert.equal(coveragePct(0, 4), 0, 'but nothing audited out of four really is zero');
  assert.equal(coveragePct(2, 4), 50);
});

test('§17.6: OPD counts an excluded row as examined, because it IS a row', async () => {
  // ⚠️ Discriminated on the PROJECTION, not on the WHERE: both statements mention
  // `excluded_reason IS NOT NULL`, one as a filter and one as a predicate, and keying on that
  // string made both reads return the same shape.
  const read = async (_s: string, sql: string) => (sql.includes('AS reason')
    ? [{ day: '2026-09-05', engine_version: 'v1', reason: 'llm_leg_failed', n: 4 }]
    : [{ day: '2026-09-05', engine_version: 'v1', examined: 100, audited: 96, excluded: 4 }]);
  const out = await coverageReport({ engine: 'opd_note_audit', days: 7 }, { read });
  const [d] = out.by_day;
  assert.equal(d.examined, 100);
  assert.equal(d.qualifying, 100, 'there is no skips table: a failed note is still a stored row');
  assert.equal(d.audited, 96);
  assert.equal(d.coverage_pct, 96);
  assert.deepEqual(d.skips_by_reason, { llm_leg_failed: 4 });
});

test('§17.6: days are newest first, and two engine versions on one day stay separate rows', async () => {
  const read = async (source: string) => (source === 'ipd_episode_audits'
    ? [
      { day: '2026-09-04', engine_version: 'v2', audited: 1 },
      { day: '2026-09-05', engine_version: 'v1', audited: 2 },
      { day: '2026-09-05', engine_version: 'v2', audited: 3 },
    ]
    : []);
  const out = await coverageReport({ engine: 'ipd_episode', days: 7 }, { read });
  assert.deepEqual(out.by_day.map((d) => `${d.day}/${d.engine_version}`), ['2026-09-05/v1', '2026-09-05/v2', '2026-09-04/v2']);
  assert.equal(out.totals.audited, 6);
});

// ── drift_report: the caveat, the denominators, and the delta ────────────────────────────────

test('§17.6: drift carries its caveat and names its denominators', async () => {
  const out = await driftReport({ engine: 'ipd_episode', weeks: 4 }, { read: async () => [] });
  assert.equal(out.caveat, DRIFT_CAVEAT);
  assert.match(out.caveat, /never as a result/);
  assert.match(out.denominators.retrieval, /checkpoints, NOT episodes/,
    'the fan-out that produced 82 episodes for a week that had 25 is named where a reader will see it');
  assert.match(out.denominators.score, /divergence_index/);
});

test('§17.6: the retrieval rate is counted on checkpoints and the episode count is not inflated by it', async () => {
  const read = async (source: string) => (source === 'ipd_episode_checkpoints'
    ? [{ week: '2026-W36', engine_version: 'v2', checkpoints: 184, checkpoints_offtopic: 164 }]
    : [{ week: '2026-W36', engine_version: 'v2', n: 60, avg_n_findings: 65.63, p50_n_findings: 63, p90_n_findings: 84, n_scored: 58, avg_score: 97.24, p50_score: 97, band_none: 2, band_no_divergence: 50, band_divergence_found: 8 }]);
  const out = await driftReport({ engine: 'ipd_episode', weeks: 4 }, { read });
  const [w] = out.by_week;
  // ⚠️ THE BUG THIS SHAPE EXISTS TO PREVENT. Joining the two tables made `n` the checkpoint count.
  assert.equal(w.n, 60, 'episodes, not checkpoints');
  assert.equal(w.retrieval!.checkpoints, 184);
  assert.equal(w.retrieval!.offtopic_pct, 89);
  assert.equal(w.score.n_scored, 58, 'two episodes had no score and are out of that denominator');
  assert.deepEqual(w.bands, { none: 2, 'no divergence found': 50, 'divergence found': 8 });
});

test('§17.6: the delta is against the previous week OF THE SAME engine version', async () => {
  const read = async (source: string) => (source === 'ipd_episode_checkpoints' ? [] : [
    { week: '2026-W36', engine_version: 'v2', n: 60, avg_n_findings: 65, n_scored: 60, avg_score: 97 },
    // A different version in between must not become v2's comparator.
    { week: '2026-W36', engine_version: 'v1', n: 25, avg_n_findings: 70, n_scored: 25, avg_score: 98 },
    { week: '2026-W35', engine_version: 'v2', n: 40, avg_n_findings: 60, n_scored: 40, avg_score: 95 },
  ]);
  const out = await driftReport({ engine: 'ipd_episode', weeks: 4 }, { read });
  const w36v2 = out.by_week.find((w) => w.week === '2026-W36' && w.engine_version === 'v2')!;
  assert.equal(w36v2.delta.n, 20, '60 against v2’s own 40, not against v1’s 25');
  assert.equal(w36v2.delta.n_findings_avg, 5);
  assert.equal(w36v2.delta.score_avg, 2);
  const w35 = out.by_week.find((w) => w.week === '2026-W35')!;
  assert.equal(w35.delta.n, null, 'the oldest week of a version has nothing to compare against');
  const w36v1 = out.by_week.find((w) => w.engine_version === 'v1')!;
  assert.equal(w36v1.delta.n, null, 'and neither does a version seen in only one week');
});

test('§17.6: a delta of two averages is rounded, and a missing side is null', () => {
  assert.equal(delta(97.24, 95.11), 2.13);
  assert.equal(delta(null, 5), null);
  assert.equal(delta(5, null), null);
  assert.equal(delta(0.1 + 0.2, 0.3), 0, 'and float noise does not become a reported change');
});

test('§17.6: OPD drift reports NQI and the five bands', async () => {
  const read = async () => [{
    week: '2026-W36', engine_version: 'opd-note-audit/0.81.21', n: 2530,
    avg_n_findings: 1.94, p50_n_findings: 1, p90_n_findings: 4,
    n_scored: 2530, avg_score: 81.17, p50_score: 82,
    band_a: 991, band_b: 1234, band_c: 280, band_d: 25, band_e: 0,
  }];
  const out = await driftReport({ engine: 'opd_note_audit', weeks: 4 }, { read });
  const [w] = out.by_week;
  assert.equal(w.score_field, 'note_quality_index');
  assert.equal(w.score.avg, 81.17);
  assert.deepEqual(w.bands, { A: 991, B: 1234, C: 280, D: 25, E: 0 });
  assert.equal(w.retrieval, null, 'the off-topic rate is an IPD checkpoint property and OPD has none');
  assert.equal(out.denominators.retrieval, 'not reported for this engine');
});

// ── retrieval_compare: no model, one embedding, production's own SQL ─────────────────────────

test('§17.6: the candidate legs are production’s own builders, plus a snapshot clause', () => {
  const vec = vectorLegSql(50);
  const bm = bm25LegSql(50);
  for (const { sql } of [vec, bm]) {
    // `defaultBm25Sql` is a template literal that opens with a newline — trimmed, not matched
    // loosely, so the assertion still means "this statement begins with a SELECT".
    assert.match(sql.trimStart(), /^SELECT/, 'read only');
    assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/.test(sql));
    // Production's quarantine guards, from production's own clause builder.
    assert.ok(sql.includes("source NOT LIKE 'labq:%'"), 'the quarantine guard cannot be dropped here');
    assert.ok(sql.includes('visible IS NOT FALSE'));
  }
  assert.ok(vec.sql.includes('embedding <=> $1::vector'));
  // The snapshot is an integer ceiling on the serial id, and it appears only when asked for.
  assert.ok(!vec.sql.includes('id <= '));
  assert.ok(vectorLegSql(50, 12345).sql.includes('AND id <= 12345'));
  assert.ok(bm25LegSql(50, 12345).sql.includes('AND id <= 12345'));
  assert.throws(() => vectorLegSql(50, -1), (e: { code?: string }) => e.code === 'INVALID_INPUT');
  assert.throws(() => vectorLegSql(50, 1.5), (e: { code?: string }) => e.code === 'INVALID_INPUT');
});

test('§17.6: RRF fusion is production’s, and ties break on id so a comparison is stable', () => {
  const a = [{ id: 7, rank: 1 }, { id: 9, rank: 2 }];
  const b = [{ id: 9, rank: 1 }, { id: 7, rank: 2 }];
  // Symmetric input: both ids score identically, so the order must come from the id, not from
  // whichever leg happened to be walked first.
  assert.deepEqual(fuse([a, b], 5), [7, 9]);
  assert.deepEqual(fuse([b, a], 5), [7, 9]);
  assert.deepEqual(fuse([a], 1), [7]);
  assert.deepEqual(fuse([], 5), []);
});

test('§17.6: rank correlation refuses to report a correlation of one or two points', () => {
  assert.equal(rankCorrelation([1, 2], [1, 2]), null, 'two shared ids is not a correlation');
  assert.equal(rankCorrelation([1, 2, 3], [1, 2, 3]), 1);
  assert.equal(rankCorrelation([1, 2, 3], [3, 2, 1]), -1);
  assert.equal(rankCorrelation([1, 2, 3], [9, 8, 7]), null, 'nothing shared, nothing to correlate');
});

test('§17.6: retrieval_compare makes zero model calls and embeds ONCE per query', async () => {
  let embeds = 0;
  const embed = async () => { embeds += 1; return [0.1, 0.2, 0.3]; };
  const read = async (_s: string, sql: string) => (sql.includes('vector')
    ? [{ id: 1, rank: 1 }, { id: 2, rank: 2 }, { id: 3, rank: 3 }]
    : [{ id: 3, rank: 1 }, { id: 4, rank: 2 }]);
  const out = await retrievalCompare({
    queries: ['acute appendicitis management', 'community acquired pneumonia'],
    k: 3,
    a: { bm25: true, embedding: true },
    b: { bm25: false, embedding: true },
  }, { embed, read });
  assert.equal(out.model_calls, 0);
  assert.equal(out.embeddings, 2, 'one per query, shared by both configurations');
  assert.equal(embeds, 2, 'and the same vector really was reused, not embedded twice');
  assert.equal(out.per_query.length, 2);
  assert.equal(out.totals.queries, 2);
  assert.match(out.snapshot_caveat, /the corpus at that size/);
  // The query TEXT is never echoed back — only its hash.
  const body = JSON.stringify(out);
  assert.ok(!body.includes('appendicitis'), 'a clinical query is not echoed into the result');
  assert.ok(String((out.per_query[0] as { query_hash: string }).query_hash)
    === createHash('sha256').update('acute appendicitis management').digest('hex'));
});

test('§17.6: a configuration with neither leg retrieves nothing and is refused', async () => {
  await assert.rejects(
    () => retrievalCompare({ queries: ['x y z'], a: { bm25: false, embedding: false }, b: { bm25: true, embedding: true } },
      { embed: async () => [0], read: async () => [] }),
    (e: { code?: string }) => e.code === 'INVALID_INPUT',
  );
});

test('§17.6: with no vector leg on either side, nothing is embedded at all', async () => {
  let embeds = 0;
  const out = await retrievalCompare({
    queries: ['a b c'], k: 2,
    a: { bm25: true, embedding: false },
    b: { bm25: true, embedding: false, max_chunk_id: 100 },
  }, { embed: async () => { embeds += 1; return [0]; }, read: async () => [{ id: 1, rank: 1 }] });
  assert.equal(embeds, 0);
  assert.equal(out.embeddings, 0);
  assert.equal(out.per_query[0].overlap_at_k, 1);
  assert.equal(out.per_query[0].overlap_pct, 100);
});

// ── item 8: the generated versions file ──────────────────────────────────────────────────────

test('§17.6 item 8: the committed engine-versions file is FRESH against the route sources', () => {
  /**
   * ⚠️ THIS IS THE TEST THAT MAKES THE BAKED VERSION HONEST. The file is written at build time and
   * committed; if a route were edited and it were not regenerated, production would report a hash
   * for source that no longer exists — a version that is precise and wrong, which is worse than
   * `unavailable`. Regenerate with `npm run lab:versions`.
   */
  const blob = (file: string) => {
    const data = readFileSync(join(process.cwd(), file));
    return createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
  };
  const engines = Object.keys(GENERATED_ROUTE_VERSIONS).sort();
  assert.deepEqual(engines, ['appropriateness', 'ask', 'ddx', 'doc_audit', 'pathway'],
    'the five engines that have no version constant of their own');
  for (const [engine, entry] of Object.entries(GENERATED_ROUTE_VERSIONS)) {
    const actual = blob(entry.file);
    assert.equal(entry.blob, actual,
      `lib/lab-v2/engine-versions.generated.ts is STALE for ${engine} (${entry.file}) — run: npm run lab:versions`);
    assert.equal(entry.version, `${engine}/route@${actual.slice(0, 12)}`, 'the version is the hash, shortened');
    assert.equal(bakedEngineVersion(engine), entry.version);
  }
  assert.equal(bakedEngineVersion('opd_note_audit'), null, 'an engine with its own constant bakes nothing');
});

test('§17.6 item 8: the baked hash replaces `unavailable` and can never override a live one', () => {
  // The whole point: a stale generated file must not be able to mask a route that moved.
  assert.equal(liveOrBakedVersion('ask', 'ask/route@abcdef123456'), 'ask/route@abcdef123456');
  assert.equal(liveOrBakedVersion('ask', 'ask/route@unavailable'), GENERATED_ROUTE_VERSIONS.ask.version);
  assert.equal(liveOrBakedVersion('opd_note_audit', 'opd-note-audit/0.81.21'), 'opd-note-audit/0.81.21');
  // and a reader is told which one answered
  assert.equal(versionSourceFor('ask', 'ask/route@abcdef123456'), 'source');
  assert.equal(versionSourceFor('ask', 'ask/route@unavailable'), 'generated');
  assert.equal(versionSourceFor('opd_note_audit', 'opd-note-audit/0.81.21'), 'constant');
});

test('§17.6 item 8: the build runs the generator, and it takes no dependency to do it', () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    scripts: Record<string, string>; dependencies: Record<string, string>; devDependencies: Record<string, string>;
  };
  assert.equal(pkg.scripts['lab:versions'], 'node scripts/lab-versions-gen.mjs');
  assert.match(pkg.scripts.build, /^npm run lab:versions && next build$/,
    'the generated file is baked before the bundle that will ship without the sources');
  // §17.6's file contract: package.json, SCRIPTS ONLY. The generator is plain node — no new
  // dependency, which is what makes that promise checkable rather than a claim.
  const gen = readFileSync(join(process.cwd(), 'scripts/lab-versions-gen.mjs'), 'utf8');
  for (const imp of [...gen.matchAll(/from '([^']+)'/g)].map((m) => m[1])) {
    assert.ok(imp.startsWith('node:'), `the generator may import only node builtins, found ${imp}`);
  }
});
