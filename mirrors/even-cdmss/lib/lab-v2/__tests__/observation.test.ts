/**
 * LAB-MCP-V2 §17.2 — the nine observation tools.
 *
 * THE SPLIT, AND WHY. These tools read PRODUCTION Neon and db13, which a test has neither of.
 * So the suite tests two things separately and honestly:
 *
 *  · the generated SQL, executed against a real Postgres (PGlite) with seeded rows. This is
 *    where §17.2's "audit_aggregate against the embedded store" lives, and it is the half that
 *    can actually be wrong in a way that matters — the grain of the lvc_category grouping, the
 *    projection that must never carry note text, the filter translation.
 *  · the handler contract — scope denial, schema refusal, and the fail-safe — driven through the
 *    real dispatcher, where a missing DATABASE_URL is exactly the source error §17.2 asks about.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshDb } from './helpers';
import { callTool } from '../service';
import { REGISTRY } from '../registry';
import { OBSERVATION_HANDLERS, REPORT_CAVEAT } from '../tools/observation';
import {
  buildAggregateSql, buildFindingsSql, buildOneAuditSql, buildSearchSql, BANDS, VERDICTS,
} from '../sources/audits';
import {
  buildChunksByIdSql, buildCorpusFilterSql, buildCorpusSearchSql, corpusSearch, quarantinePrefix, ACTIVE_PREDICATE,
} from '../sources/corpus';
import { searchAudits } from '../sources/audits';
import { setSourceExecutor, setSourceTimeoutMs } from '../sources/read';
import {
  DB13_FRESHNESS_SQL, IPD_EPISODE_FRESHNESS_SQL, MKSAP_FRESHNESS_SQL, OPD_AUDITS_FRESHNESS_SQL,
  sourceFreshness,
} from '../sources/freshness';
import { servedUsage } from '../transport';
import type { Db } from '../db';

/** The sentence that must never appear in any tool's output. */
const NOTE_SENTENCE = 'PATIENT COMPLAINS OF CRUSHING CENTRAL CHEST PAIN RADIATING TO THE JAW';

const deps = (db: Db, principal: 'research' | 'operator' | 'reviewer' | 'release' = 'research') =>
  ({ db, principal, protocolVersion: 'test', sdkVersion: 'test' }) as never;

// ── the embedded fixture: a real opd_note_audits and mksap_chunks ────────────────────
async function seed(db: Db): Promise<void> {
  await db.exec(`
    CREATE TABLE opd_note_audits (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      audited_at timestamptz NOT NULL DEFAULT now(),
      uid text, doctor_uid text, note_date timestamptz, band text,
      note_quality_index int, completeness_pct int, n_findings int, n_low_value int,
      findings jsonb, sources jsonb, engine_version text, note_body text
    );
    CREATE TABLE mksap_chunks (
      id bigint PRIMARY KEY, book text, chapter text, source text, text text,
      visible boolean DEFAULT true, created_at timestamptz DEFAULT now(),
      -- decision 31: corpus_search now runs on the lexical index, so the fixture needs the
      -- column that index is built on. Production's mksap_chunks_tsv_idx is GIN over text_tsv.
      text_tsv tsvector
    );
  `);
  // Two audits. `note_body` exists ONLY so the projection test can prove the column is never
  // selected — production's opd_note_audits has no such column and no note text at all.
  await db.query(
    `INSERT INTO opd_note_audits (uid, doctor_uid, note_date, band, note_quality_index, completeness_pct, n_findings, n_low_value, findings, sources, engine_version, note_body)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12)`,
    ['uid-a', 'doc-1', '2026-08-10', 'B', 80, 90, 2, 1,
      JSON.stringify([
        { subject: 'Vitamin D without indication', verdict: 'low-value', lvc_category: 'imaging', citation_ids: [1] },
        { subject: 'Antibiotic for viral URTI', verdict: 'low-value', lvc_category: 'antibiotic', citation_ids: [] },
      ]),
      JSON.stringify([{ n: 1, id: '101' }]), 'opd-note-audit/0.81.21', NOTE_SENTENCE]);
  await db.query(
    `INSERT INTO opd_note_audits (uid, doctor_uid, note_date, band, note_quality_index, completeness_pct, n_findings, n_low_value, findings, sources, engine_version, note_body)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12)`,
    ['uid-b', 'doc-2', '2026-09-02', 'A', 90, 100, 1, 0,
      JSON.stringify([{ subject: 'Imaging without indication', verdict: 'context-dependent', lvc_category: 'imaging', citation_ids: [] }]),
      JSON.stringify([]), 'opd-note-audit/0.81.21', NOTE_SENTENCE]);
  await db.query(
    `INSERT INTO mksap_chunks (id, book, chapter, source, text, visible) VALUES
      (101, 'Tintinalli', 'Acute Bronchitis', 'textbook', 'Antibiotics are not indicated for the common cold.', true),
      (102, 'LabStaged', 'Staged chapter', 'labq:trial-22jul', 'Quarantined material awaiting activation.', false)`);
  await db.query(`UPDATE mksap_chunks SET text_tsv = to_tsvector('english', text)`);
}

// ── the SQL, against real Postgres ───────────────────────────────────────────────────
test('§17.2: the audit projection never selects note text, and returns the named fields', async () => {
  const db = await freshDb();
  await seed(db);
  const rows = await db.query<Record<string, unknown>>(buildSearchSql({}, 50, 0));
  assert.equal(rows.length, 2);
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    'band', 'completeness_pct', 'engine_version', 'finding_subjects', 'n_findings',
    'n_low_value', 'note_date', 'note_quality_index', 'uid',
  ]);
  assert.ok(!JSON.stringify(rows).includes(NOTE_SENTENCE), 'no note text may reach a caller');
  await db.close();
});

test('§17.2: every filter translates, including the two that live inside the findings jsonb', async () => {
  const db = await freshDb();
  await seed(db);
  const only = async (f: Parameters<typeof buildSearchSql>[0]) =>
    (await db.query<{ uid: string }>(buildSearchSql(f, 50, 0))).map((r) => r.uid);

  assert.deepEqual(await only({ doctor_uid: 'doc-1' }), ['uid-a']);
  assert.deepEqual(await only({ band: 'A' }), ['uid-b']);
  assert.deepEqual(await only({ engine_version: 'opd-note-audit/0.81.21' }), ['uid-b', 'uid-a']);
  assert.deepEqual(await only({ note_date_from: '2026-09-01' }), ['uid-b']);
  assert.deepEqual(await only({ note_date_to: '2026-08-31' }), ['uid-a']);
  assert.deepEqual(await only({ min_findings: 2 }), ['uid-a']);
  // Inside the jsonb: an audit matches when ANY of its findings does.
  assert.deepEqual(await only({ lvc_category: 'antibiotic' }), ['uid-a']);
  assert.deepEqual((await only({ lvc_category: 'imaging' })).sort(), ['uid-a', 'uid-b']);
  assert.deepEqual(await only({ verdict: 'context-dependent' }), ['uid-b']);
  await db.close();
});

test('§17.2: audit_aggregate counts AUDITS, not findings, when grouping by lvc_category', async () => {
  const db = await freshDb();
  await seed(db);
  const byCat = await db.query<{ group_key: string; value: string; n_audits: string }>(
    buildAggregateSql({}, 'lvc_category', 'count', 500));
  const m = Object.fromEntries(byCat.map((r) => [r.group_key, Number(r.n_audits)]));
  // uid-a carries imaging AND antibiotic; uid-b carries imaging. If the CTE did not reduce to
  // DISTINCT (audit, category) first, the unnest would double-count and every average with it.
  assert.equal(m.imaging, 2);
  assert.equal(m.antibiotic, 1);

  const avg = await db.query<{ group_key: string; value: string }>(
    buildAggregateSql({}, 'engine_version', 'avg_note_quality_index', 500));
  assert.equal(Number(avg[0].value), 85);   // (80 + 90) / 2, over audits
  await db.close();
});

test('§17.2: every group_by and every metric produces a runnable statement', async () => {
  const db = await freshDb();
  await seed(db);
  for (const g of ['engine_version', 'doctor_uid', 'band', 'lvc_category', 'note_month'] as const) {
    for (const met of ['count', 'avg_note_quality_index', 'avg_completeness_pct', 'sum_findings', 'sum_low_value'] as const) {
      const rows = await db.query(buildAggregateSql({}, g, met, 500));
      assert.ok(Array.isArray(rows), `${g}/${met} must run`);
    }
  }
  await db.close();
});

test('§17.2: the corpus reads resolve ids, honour the active predicate, and bound the preview', async () => {
  const db = await freshDb();
  await seed(db);
  const byId = await db.query<{ id: string; active: boolean; preview: string }>(buildChunksByIdSql([101, 102, 999]));
  assert.equal(byId.length, 2, '999 does not exist and is simply absent — the caller reports it unresolved');
  const active = Object.fromEntries(byId.map((r) => [String(r.id), r.active]));
  assert.equal(active['101'], true);
  assert.equal(active['102'], false, 'labq: + visible false is not active');

  // decision 31 — the search is the retrieval BM25 predicate, with $1 bound, not an ILIKE scan.
  const hits = await db.query<{ id: string }>(buildCorpusSearchSql({ text: 'antibiotics', limit: 25 }), ['antibiotics']);
  assert.deepEqual(hits.map((h) => String(h.id)), ['101']);
  const inactive = await db.query<{ id: string }>(
    buildCorpusSearchSql({ text: 'quarantined', active: false, limit: 25 }), ['quarantined']);
  assert.deepEqual(inactive.map((h) => String(h.id)), ['102']);
  await db.close();
});

test("§17.2: the corpus 'active' flag is production's own predicate, not a column", () => {
  // mksap_chunks has no `active` column — measured live on 05 Sep 2026. The predicate below is
  // the clause list lib/retrieve.ts:167 uses, and a drift here would make the lab describe a
  // corpus the audits were not run against.
  const retrieveSrc = readFileSync('lib/retrieve.ts', 'utf8');
  assert.ok(retrieveSrc.includes(`'visible IS NOT FALSE'`) || retrieveSrc.includes('visible IS NOT FALSE'));
  assert.ok(retrieveSrc.includes(`source NOT LIKE 'labq:%'`));
  assert.ok(ACTIVE_PREDICATE.includes('visible IS NOT FALSE'));
  assert.ok(ACTIVE_PREDICATE.includes(`source NOT LIKE 'labq:%'`));
  assert.equal(quarantinePrefix('labq:trial-22jul'), 'labq:');
  assert.equal(quarantinePrefix('textbook'), null);
});

test('§17.2: the one-audit and findings statements run and carry no note text', async () => {
  const db = await freshDb();
  await seed(db);
  const one = await db.query<Record<string, unknown>>(buildOneAuditSql('uid-a'));
  assert.equal(one.length, 1);
  const f = await db.query<Record<string, unknown>>(buildFindingsSql('uid-a'));
  assert.equal(f.length, 1);
  assert.ok(!JSON.stringify([one, f]).includes(NOTE_SENTENCE));
  await db.close();
});

test('§17.2: the live enums are the measured ones, not plausible-looking guesses', () => {
  assert.deepEqual([...BANDS], ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual([...VERDICTS], ['high-value', 'low-value', 'context-dependent', 'uncertain']);
});

// ── scope, schema, fail-safe, through the real dispatcher ────────────────────────────
test('§17.2: every observation tool denies a principal without its scope', async () => {
  const db = await freshDb();
  // `release` holds only `release` + `production_read`, so the eight research_read tools are
  // invisible to it; `source_freshness` (production_read) is not, and is excluded here.
  const researchOnly = REGISTRY.filter((t) => t.slice === 'A-2' && !t.scopes.includes('production_read'));
  assert.equal(researchOnly.length, 8);
  for (const spec of researchOnly) {
    await assert.rejects(
      () => callTool(deps(db, 'release'), spec.name, {}),
      (e: { code?: string }) => e.code === 'SCOPE_DENIED',
      `${spec.name} must be denied to the release key`,
    );
  }
  await db.close();
});

test('§17.2: a bad filter is refused by the schema before any statement is built', async () => {
  const db = await freshDb();
  const bad: [string, Record<string, unknown>][] = [
    ['audit_search', { band: 'excellent' }],                       // not a live band
    ['audit_search', { verdict: 'appropriate' }],                  // not a live verdict
    ['audit_search', { limit: 500 }],                              // over the 200 ceiling
    ['audit_aggregate', { group_by: 'doctor', metric: 'count' }],  // not a group_by
    ['audit_aggregate', { group_by: 'band', metric: 'median' }],   // not a metric
    ['retrieval_inspect', { query: 'x', k: 99 }],                  // over the 30 ceiling
    ['corpus_search', { text: '' }],                               // empty search text
    ['audit_explain', { uid: 'x', finding_index: -1 }],            // negative index
    ['report_export', { run_id: 'not-a-uuid' }],
  ];
  for (const [name, args] of bad) {
    await assert.rejects(
      () => callTool(deps(db), name, args),
      (e: { code?: string }) => e.code === 'INVALID_INPUT',
      `${name} ${JSON.stringify(args)} must be refused`,
    );
  }
  await db.close();
});

test('§17.2: audit_search defaults limit to 50 and accepts the 200 ceiling', async () => {
  const db = await freshDb();
  // The schema's default is what the dispatcher hands the handler; with no production database
  // the read then fails SOURCE_UNAVAILABLE, which is the point of the next test.
  await assert.rejects(
    () => callTool(deps(db), 'audit_search', { limit: 200 }),
    (e: { code?: string }) => e.code === 'SOURCE_UNAVAILABLE',
  );
  await db.close();
});

test('§17.2: a source error is SOURCE_UNAVAILABLE, never a crash and never a wrong answer', async () => {
  const db = await freshDb();
  for (const [name, args] of [
    ['audit_search', {}],
    ['audit_aggregate', { group_by: 'band', metric: 'count' }],
    ['corpus_search', { text: 'cough' }],
    ['case_snapshot', { uid: 'uid-a' }],
    ['audit_explain', { uid: 'uid-a', finding_index: 0 }],
  ] as [string, Record<string, unknown>][]) {
    await assert.rejects(
      () => callTool(deps(db), name, args),
      (e: { code?: string }) => e.code === 'SOURCE_UNAVAILABLE',
      `${name} must degrade to SOURCE_UNAVAILABLE`,
    );
  }
  await db.close();
});

test('§17.2: source_freshness reports each source independently and never fails as a whole', async () => {
  const db = await freshDb();
  const out = await callTool(deps(db, 'operator'), 'source_freshness', {}) as {
    sources: { source: string; ok: boolean; error: string | null }[];
  };
  assert.equal(out.sources.length, 5);
  assert.deepEqual(out.sources.map((s) => s.source), [
    'db13:individuals-prescriptions', 'neon:opd_note_audits', 'neon:ipd_episode_audits',
    'neon:mksap_chunks', 'lab_v2:calls',
  ]);
  // The four production sources are unreachable here; the v2 store is not. That asymmetry IS
  // the behaviour §17.2 asks for — one dead mirror must not take the answer down with it.
  const labV2 = out.sources.find((s) => s.source === 'lab_v2:calls')!;
  assert.equal(labV2.ok, true);
  assert.equal(labV2.error, null);
  for (const s of out.sources.filter((x) => x.source !== 'lab_v2:calls')) {
    assert.equal(s.ok, false);
    assert.match(s.error ?? '', /^SOURCE_UNAVAILABLE/);
  }
  await db.close();
});

test('§17.2: the freshness statements are the ones the report lists', () => {
  assert.ok(DB13_FRESHNESS_SQL.includes('"individuals-prescriptions"'), 'the db13 table needs its quotes');
  assert.ok(OPD_AUDITS_FRESHNESS_SQL.includes('audited_at'));
  assert.ok(IPD_EPISODE_FRESHNESS_SQL.includes('audited_at'));
  assert.ok(MKSAP_FRESHNESS_SQL.includes(`source NOT LIKE 'labq:%'`), 'freshness counts ACTIVE chunks');
});

// ── citation_check, report_export ────────────────────────────────────────────────────
test('§17.2: citation_check resolves one id and reports the other as unresolved', async () => {
  const db = await freshDb();
  await seed(db);
  // Drive the source layer against the embedded store: the handler's production reads are
  // covered by the fail-safe test above; what matters here is the resolvable/unresolvable split.
  const rows = await db.query<{ id: string; active: boolean }>(buildChunksByIdSql([101, 999]));
  const found = new Set(rows.map((r) => String(r.id)));
  const results = [101, 999].map((id) => ({ citation_id: id, exists: found.has(String(id)) }));
  assert.deepEqual(results, [{ citation_id: 101, exists: true }, { citation_id: 999, exists: false }]);
  await db.close();
});

test('§17.2: report_export writes one artifact carrying the caveat sentence verbatim', async () => {
  const db = await freshDb();
  const { ensureBudget, submitRun, getObject } = await import('../store');
  const budget = await ensureBudget(db, 'research', 'default', 1_000_000);
  const { run } = await submitRun(db, 'research', 'experiment_run', null, budget.id, 'rep-1', 'h', 86_400_000, [
    { case_key: 'uid-a', arm_hash: 'h', repetition: 1, payload: {} },
  ]);
  const out = await callTool(deps(db), 'report_export', { run_id: run.id }) as {
    artifact_id: string; caveat: string; summary: { items: number };
  };
  assert.equal(out.caveat, REPORT_CAVEAT);
  assert.equal(out.summary.items, 1);
  const artifact = await getObject(db, out.artifact_id);
  assert.ok(artifact, 'the artifact is stored in lab_v2');
  assert.equal(artifact!.kind, 'report');
  const body = JSON.stringify(artifact!.body);
  assert.ok(body.includes('One run is one sample. Judged findings at temperature 0 recur at about 0.58 across same-config pairs.'));
  assert.ok(!body.includes(NOTE_SENTENCE), 'a report carries dataset METADATA, never frozen note text');
  await db.close();
});

test('§17.2: report_export is idempotent per run', async () => {
  const db = await freshDb();
  const { ensureBudget, submitRun } = await import('../store');
  const budget = await ensureBudget(db, 'research', 'default', 1_000_000);
  const { run } = await submitRun(db, 'research', 'experiment_run', null, budget.id, 'rep-2', 'h', 86_400_000, [
    { case_key: 'uid-a', arm_hash: 'h', repetition: 1, payload: {} },
  ]);
  const a = await callTool(deps(db), 'report_export', { run_id: run.id }) as { artifact_id: string };
  const b = await callTool(deps(db), 'report_export', { run_id: run.id }) as { artifact_id: string };
  assert.equal(a.artifact_id, b.artifact_id, 'one report per run, not one per call');
  await db.close();
});

// ── fix 26a ──────────────────────────────────────────────────────────────────────────
test('fix 26a: a completion with usage yields the §17.2 shape', () => {
  const u = servedUsage({ usage: { prompt_tokens: 1200, completion_tokens: 340, completion_tokens_details: { reasoning_tokens: 128 } } });
  assert.deepEqual(u, { prompt_tokens: 1200, completion_tokens: 340, reasoning_tokens: 128 });
  assert.equal('usage_missing' in u, false);
});

test('fix 26a: a completion WITHOUT usage says so, rather than reporting zero', () => {
  const u = servedUsage({ choices: [] });
  assert.equal(u.usage_missing, true);
  assert.equal(u.prompt_tokens, null);
  assert.equal(u.completion_tokens, null);
  // Reporting 0/0 would be a lie the cost ledger could not later distinguish from a free call.
  assert.notEqual(u.prompt_tokens, 0);
});

test('fix 26a: a settled call stores usage on the served receipt', async () => {
  const db = await freshDb();
  const { ensureBudget, submitRun, itemsOf } = await import('../store');
  const { Gateway } = await import('../gateway');
  const { fixtureTransport } = await import('../transport');
  const budget = await ensureBudget(db, 'research', 'default', 10_000_000);
  const { run } = await submitRun(db, 'research', 'experiment_run', null, budget.id, 'usage-1', 'h', 86_400_000, [
    { case_key: 'c', arm_hash: 'h', repetition: 1, payload: {} },
  ]);
  const item = (await itemsOf(db, run.id))[0];
  await new Gateway({
    db, itemId: item.id, leaseToken: 0, budgetId: budget.id,
    transport: fixtureTransport({ inputTokens: 900, outputTokens: 120 }),
    stages: { analysis: { provider: 'ollama', model: 'local-model', max_cost_microusd: 5_000 } },
  }).call('analysis', { messages: [] });

  const [call] = await db.query<{ served: { usage?: Record<string, unknown> } }>(
    `SELECT served FROM lab_v2.calls WHERE item_id = $1`, [item.id]);
  assert.equal(call.served.usage?.prompt_tokens, 900);
  assert.equal(call.served.usage?.completion_tokens, 120);
  await db.close();
});

// ── fix 26b ──────────────────────────────────────────────────────────────────────────
test('fix 26b: the summary reads the field the engine actually sets', () => {
  // OpdScorecard's index field is `headline` (lib/opd-note-score-core.ts:93). Round 1 read
  // `noteQualityIndex`, which the type does not have, so the value was null on every audit.
  const scoreCore = readFileSync('lib/opd-note-score-core.ts', 'utf8');
  assert.ok(/headline:\s*number/.test(scoreCore), 'the engine field is `headline`');
  assert.ok(!/noteQualityIndex/.test(scoreCore), 'and there is no `noteQualityIndex` on the scorecard');
  const adapter = readFileSync('lib/lab-v2/adapters/opd.ts', 'utf8');
  assert.ok(adapter.includes('scorecard?.headline'), 'the adapter now reads headline');
  // The READ expression, not the word: the comment above the fix names the old key on purpose,
  // so a bare substring check would fail on the very documentation that explains the bug.
  assert.ok(!adapter.includes('scorecard?.noteQualityIndex'), 'and no longer reads the key that never existed');
});

// ── decision 27 ──────────────────────────────────────────────────────────────────────
test('decision 27: retrieval_inspect asks for the candidate stage only', () => {
  const src = readFileSync('lib/lab-v2/tools/observation.ts', 'utf8');
  assert.ok(/skipExpand:\s*true/.test(src), 'query expansion is a governedChat call and must be off');
  assert.ok(/useReranker:\s*false/.test(src), 'the rerank judge is a governedChat call and must be off');

  // And the two facts those flags rest on, read from lib/retrieve.ts itself, so a change to
  // either default fails here rather than silently putting a model call outside the ledger.
  const retrieveSrc = readFileSync('lib/retrieve.ts', 'utf8');
  assert.ok(retrieveSrc.includes('const useReranker = opts.useReranker === true;'), 'reranking is opt-IN');
  assert.ok(retrieveSrc.includes('opts.skipExpand ? query : await expandQuery(query)'), 'expansion is opt-OUT');
  const expandSrc = readFileSync('lib/expand.ts', 'utf8');
  assert.ok(expandSrc.includes('governedChat('), 'expandQuery really is a model call');
});

test('decision 27: retrieval_inspect makes zero CHAT calls on the path it takes', async () => {
  const db = await freshDb();
  // The chat tripwire: any chat completion request would be recorded here. Retrieval fails at
  // the vector read (no DATABASE_URL) long before it could reach one — and the assertion is that
  // it never tried, not merely that it failed.
  let chatCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    if (String((input as { url?: string })?.url ?? input).includes('/chat/completions')) chatCalls += 1;
    throw new Error('network disabled in test');
  }) as typeof globalThis.fetch;
  try {
    await assert.rejects(
      () => callTool(deps(db), 'retrieval_inspect', { query: 'acute cough in an adult', k: 5 }),
      (e: { code?: string }) => e.code === 'SOURCE_UNAVAILABLE',
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(chatCalls, 0, 'a chat call here would be a model call outside the gateway ledger');
  await db.close();
});

// ── the note-text sweep ──────────────────────────────────────────────────────────────
test('§17.2: no observation tool output carries note text or a patient field', async () => {
  const db = await freshDb();
  await seed(db);
  const outputs: unknown[] = [];
  outputs.push(await callTool(deps(db, 'operator'), 'source_freshness', {}));
  const { ensureBudget, submitRun } = await import('../store');
  const budget = await ensureBudget(db, 'research', 'default', 1_000_000);
  const { run } = await submitRun(db, 'research', 'experiment_run', null, budget.id, 'sweep', 'h', 86_400_000, [
    { case_key: 'uid-a', arm_hash: 'h', repetition: 1, payload: {} },
  ]);
  outputs.push(await callTool(deps(db), 'report_export', { run_id: run.id }));
  outputs.push(await callTool(deps(db), 'case_snapshot', { uid: 'uid-a' }).catch((e) => ({ error: String(e) })));
  // Plus the raw SQL results, which is where note text would actually have to leak from.
  outputs.push(await db.query(buildSearchSql({}, 50, 0)));
  outputs.push(await db.query(buildFindingsSql('uid-a')));
  outputs.push(await db.query(buildCorpusSearchSql({ text: 'antibiotics', limit: 25 }), ['antibiotics']));

  const blob = JSON.stringify(outputs);
  assert.ok(!blob.includes(NOTE_SENTENCE), 'a note sentence reached an output');
  assert.ok(!blob.includes('note_body'), 'the note column is never even named in a projection');
  await db.close();
});

test('§17.2: the nine handlers are all registered and all dispatchable', () => {
  const a2 = REGISTRY.filter((t) => t.slice === 'A-2').map((t) => t.name).sort();
  assert.deepEqual(Object.keys(OBSERVATION_HANDLERS).sort(), a2);
  assert.equal(a2.length, 9);
});

// ── decision 31 ──────────────────────────────────────────────────────────────────────
test('decision 31: corpus_search runs on the lexical index, never ILIKE over text', () => {
  const sqlText = buildCorpusSearchSql({ text: 'therapeutic duplication antihistamine', limit: 5 });
  // The indexed predicate — this is what reaches mksap_chunks_tsv_idx (GIN over text_tsv),
  // confirmed live on 05 Sep 2026. The ILIKE it replaces was a full corpus scan and 504'd twice.
  assert.ok(sqlText.includes(`text_tsv @@ plainto_tsquery('english', $1)`), 'the indexed predicate');
  assert.ok(!/ILIKE/i.test(sqlText), 'no substring scan may return');
  assert.ok(sqlText.includes('ts_rank_cd'), 'ranked the way retrieval ranks');

  // And it is production's own builder, imported rather than copied, so the two cannot drift.
  const src = readFileSync('lib/lab-v2/sources/corpus.ts', 'utf8');
  assert.ok(src.includes("import { defaultBm25Sql } from '../../retrieve'"), 'the BM25 template is imported');
  const retrieveSrc = readFileSync('lib/retrieve.ts', 'utf8');
  assert.ok(retrieveSrc.includes('export function defaultBm25Sql('), 'and lib/retrieve.ts still exports it');
});

test('decision 31: the query text is a bind parameter, never interpolated', () => {
  const sqlText = buildCorpusSearchSql({ text: "o'brien; DROP TABLE x", limit: 5 });
  assert.ok(!sqlText.includes('DROP TABLE'), 'the search text never reaches the statement text');
  assert.ok(sqlText.includes('$1'), 'it travels as a bind');
  // Filters bind too, starting at $2 exactly as lib/retrieve.ts orders them.
  const withBook = buildCorpusSearchSql({ text: 'x', book: 'StatPearls', limit: 5 });
  assert.ok(withBook.includes('book = $2'));
  assert.deepEqual(buildCorpusFilterSql({ text: 'x', book: 'StatPearls', limit: 5 }).params, ['StatPearls']);
});

test('decision 31: audits.ts returns SOURCE_UNAVAILABLE when the read exceeds its deadline', async () => {
  const restoreT = setSourceTimeoutMs(30);
  const restoreE = setSourceExecutor(() => new Promise(() => {}));   // never settles
  try {
    await assert.rejects(
      () => searchAudits({}, 10, 0),
      (e: { code?: string; message?: string }) => e.code === 'SOURCE_UNAVAILABLE' && /read deadline/.test(e.message ?? ''),
    );
  } finally { setSourceExecutor(restoreE); setSourceTimeoutMs(restoreT); }
});

test('decision 31: corpus.ts returns SOURCE_UNAVAILABLE when the read exceeds its deadline', async () => {
  const restoreT = setSourceTimeoutMs(30);
  const restoreE = setSourceExecutor(() => new Promise(() => {}));
  try {
    await assert.rejects(
      () => corpusSearch({ text: 'therapeutic duplication antihistamine', limit: 5 }),
      (e: { code?: string; message?: string }) => e.code === 'SOURCE_UNAVAILABLE' && /read deadline/.test(e.message ?? ''),
    );
  } finally { setSourceExecutor(restoreE); setSourceTimeoutMs(restoreT); }
});

test('decision 31: freshness.ts reports a per-source deadline without failing the tool', async () => {
  const db = await freshDb();
  const restoreT = setSourceTimeoutMs(30);
  const restoreE = setSourceExecutor(() => new Promise(() => {}));
  try {
    const out = await sourceFreshness(db);
    // Every Neon source times out; the tool still answers, and lab_v2 (its own store) still works.
    for (const name of ['neon:opd_note_audits', 'neon:ipd_episode_audits', 'neon:mksap_chunks']) {
      const row = out.find((s) => s.source === name)!;
      assert.equal(row.ok, false, `${name} must report its own failure`);
      assert.match(row.error ?? '', /SOURCE_UNAVAILABLE/);
    }
    assert.equal(out.find((s) => s.source === 'lab_v2:calls')!.ok, true, 'one dead source must not take the answer down');
  } finally { setSourceExecutor(restoreE); setSourceTimeoutMs(restoreT); await db.close(); }
});

test('decision 31: a non-timeout read error is also SOURCE_UNAVAILABLE, with a short reason', async () => {
  const restoreE = setSourceExecutor(async () => { throw new Error('connection reset by peer'); });
  try {
    await assert.rejects(
      () => searchAudits({}, 10, 0),
      (e: { code?: string; message?: string }) => e.code === 'SOURCE_UNAVAILABLE' && /connection reset/.test(e.message ?? ''),
    );
  } finally { setSourceExecutor(restoreE); }
});

test('decision 31: the deadline lives in the v2 wrapper, and the v1 guard is untouched', () => {
  const guard = readFileSync('lib/sql-guard-core.ts', 'utf8');
  assert.ok(!/timeout/i.test(guard), 'the v1 guard gained no timeout parameter');
  const read = readFileSync('lib/lab-v2/sources/read.ts', 'utf8');
  assert.ok(read.includes('SOURCE_TIMEOUT_MS = 15_000'), 'decision 31 asks for 15 s');
  assert.ok(read.includes('guardReadOnlySql'), 'and the guard still decides what may run');
});
