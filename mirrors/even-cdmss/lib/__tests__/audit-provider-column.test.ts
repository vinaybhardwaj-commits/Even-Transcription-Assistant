/**
 *   node --test --import tsx lib/__tests__/audit-provider-column.test.ts
 *
 * PROVIDER-SWITCH Unit B (PRD §5, 2 Aug 2026) — the provider column.
 *
 * WHY. `model` cannot answer "who graded this". `google/gemini-2.5-pro` is Gemini via the
 * OpenRouter bridge; `gemini-2.5-pro` is Gemini via Vertex; a future `bedrock:anthropic.claude-x`
 * is a third route. When Vertex was disabled on 26 July, and again when the bridge's 110 s ceiling
 * silently degraded every median-or-slower audit to the local model from 30 July, the stored rows
 * could not say which path had been taken — the column that should have shouted "served somewhere
 * else" was carrying a model name that looked perfectly normal. That ambiguity is a large part of
 * why a three-day outage went unnoticed.
 *
 * These tests assert the SQL contract and the wiring, not a live database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MIGRATION = readFileSync('migrations/0032_audit_provider_column.sql', 'utf8');
const OPD_STORE = readFileSync('lib/opd-audit-store.ts', 'utf8');
const IPD_STORE = readFileSync('lib/ipd-audit/store.ts', 'utf8');
const IPD_RUN = readFileSync('lib/ipd-audit/run.ts', 'utf8');
const OPD_WORKER = readFileSync('app/api/opd-audit/worker/route.ts', 'utf8');
/** Statements only — comments carry example SQL that must not be mistaken for the migration. */
const MIGRATION_SQL = MIGRATION.replace(/^\s*--.*$/gm, '').trim();

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · The migration
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the migration adds provider to BOTH audit tables', () => {
  assert.ok(MIGRATION_SQL.includes('ALTER TABLE opd_note_audits      ADD COLUMN IF NOT EXISTS provider text;'));
  assert.ok(MIGRATION_SQL.includes('ALTER TABLE ipd_discharge_audits ADD COLUMN IF NOT EXISTS provider text;'));
});

test('IT IS IDEMPOTENT — running it twice is a no-op', () => {
  const stmts = MIGRATION_SQL.split(';').map((s) => s.trim()).filter(Boolean);
  assert.equal(stmts.length, 2, 'exactly two statements, nothing else');
  for (const s of stmts) {
    assert.match(s, /^ALTER TABLE \w+\s+ADD COLUMN IF NOT EXISTS provider text$/,
      `every statement must be ADD COLUMN IF NOT EXISTS: ${s}`);
  }
});

test('NO index, NO default, NO backfill — a null provider must stay distinguishable', () => {
  assert.ok(!/CREATE INDEX/i.test(MIGRATION_SQL), 'nothing filters on it yet — Unit C decides');
  assert.ok(!/DEFAULT/i.test(MIGRATION_SQL),
    "a default would make 'recorded before attribution existed' indistinguishable from a real value");
  assert.ok(!/^\s*UPDATE\s/im.test(MIGRATION_SQL), 'no backfill: historical rows keep provider IS NULL');
  assert.ok(!/DROP|DELETE|TRUNCATE|NOT NULL/i.test(MIGRATION_SQL), 'additive only');
});

test('the migration records WHY the column exists', () => {
  assert.ok(/google\/gemini-2\.5-pro/.test(MIGRATION) && /gemini-2\.5-pro/.test(MIGRATION),
    'the two model ids that are the same model by different routes');
  assert.ok(/three-day outage/i.test(MIGRATION));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · The OPD store persists it beside model
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('a saved OPD row carries BOTH provider and model', () => {
  assert.ok(OPD_STORE.includes('provider?: string | null;'), 'SaveOpdAuditMeta accepts it');
  assert.ok(/complexity_band, complexity_inputs, scorecard, excluded_reason.*\$\{withProvider \? ', provider' : ''\}\)/.test(OPD_STORE),
    'the column list includes it when the column exists');
  assert.ok(OPD_STORE.includes("...(withProvider ? [meta.provider ?? null] : []),"), 'and the param is bound');
  // model is untouched beside it
  assert.ok(OPD_STORE.includes('audit.engineVersion, meta.model ?? null, audit.traceId ?? null, meta.latencyMs ?? null,'),
    'the existing model param is unchanged');
});

test('OPD: a re-audit RE-ATTRIBUTES — provider is in the conflict SET, like model', () => {
  assert.ok(OPD_STORE.includes("${withProvider ? 'provider = EXCLUDED.provider, ' : ''}"),
    'a note re-graded on a different provider must not keep the old attribution');
  assert.ok(OPD_STORE.includes('model = EXCLUDED.model,'), 'model already did this');
});

test('OPD: the column is PROBED, so the deploy is safe before the migration runs', () => {
  assert.ok(OPD_STORE.includes("async function providerColumnExists(): Promise<boolean> { return opdColumnExists('provider'); }"));
  assert.ok(OPD_STORE.includes('const withProvider = await providerColumnExists();'));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · The IPD store persists it beside model
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('a saved IPD row carries BOTH provider and model', () => {
  assert.ok(IPD_STORE.includes('provider?: string | null;'), 'IpdAuditRow accepts it');
  assert.ok(IPD_STORE.includes("engine_version, model, trace_id${withProvider ? ', provider' : ''})"),
    'the column list includes it when the column exists');
  assert.ok(IPD_STORE.includes("$23,$24,$25,$26${withProvider ? ', $27' : ''})"), 'and $27 is bound');
  assert.ok(IPD_STORE.includes('...(withProvider ? [row.provider ?? null] : []),'));
  assert.ok(IPD_STORE.includes("${withProvider ? ' provider = EXCLUDED.provider,' : ''}"), 're-attributes on conflict');
});

test('IPD: the column is PROBED too, against its OWN table', () => {
  assert.ok(IPD_STORE.includes("WHERE table_name = 'ipd_discharge_audits' AND column_name = $1"),
    'probing opd_note_audits here would report the wrong table');
  assert.ok(IPD_STORE.includes("const withProvider = await ipdColumnExists('provider');"));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · The value comes from what SERVED — never a constant
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('both workers read model AND provider from ONE row of ONE query', () => {
  const sel = "SELECT payload->>'model' AS model, payload->>'provider' AS provider FROM trace_events";
  assert.ok(OPD_WORKER.includes(sel), 'OPD');
  assert.ok(IPD_RUN.includes(sel), 'IPD');
  // one query, so a model can never be paired with another event's provider
  assert.equal((OPD_WORKER.match(/FROM trace_events/g) || []).length, 1);
  assert.equal((IPD_RUN.match(/FROM trace_events/g) || []).length, 1);
  // …and each reads its OWN analyze stage
  assert.ok(OPD_WORKER.includes("AND stage = 'opd_audit_analyze'"));
  assert.ok(IPD_RUN.includes("AND stage = 'doc_audit_analyze'"));
});

test('THE MINI PATH RECORDS ollama', () => {
  assert.ok(IPD_RUN.includes("? { model: MINI_MODEL, provider: 'ollama' as string | null }"),
    "a local run has no fallback to discover — 'ollama' is the truth, not a guess");
  assert.ok(IPD_RUN.includes('row.provider = served.provider;'), 'and it reaches the row');
});

test('NEVER FROM A CONSTANT — the D-D defect that bit twice', () => {
  // No hardcoded provider literal on either cloud path.
  assert.ok(!/provider: 'vertex'|provider: 'openrouter'|provider: 'bedrock'/.test(IPD_RUN));
  assert.ok(!/provider: 'vertex'|provider: 'openrouter'|provider: 'bedrock'|provider: 'ollama'/.test(OPD_WORKER));
  assert.ok(!/GEMINI_MODEL/.test(IPD_RUN), 'the model constant is gone too');
});

test('a NULL provider is accepted and stored as null, not the string "null"', () => {
  // The helpers return a typed null, and the binders use ?? null rather than String(...).
  for (const [name, src] of [['OPD worker', OPD_WORKER], ['IPD run', IPD_RUN]] as const) {
    assert.ok(src.includes('const none = { model: null, provider: null };'), `${name}: typed null on no trace`);
    assert.ok(src.includes("provider: typeof r?.provider === 'string' && r.provider ? r.provider : null,"),
      `${name}: an absent or empty provider becomes null, never a coerced string`);
  }
  assert.ok(OPD_STORE.includes('[meta.provider ?? null]'), 'OPD binds null, not String(undefined)');
  assert.ok(IPD_STORE.includes('[row.provider ?? null]'), 'IPD binds null');
  // and the soft-fail path returns the same typed null rather than throwing
  for (const src of [OPD_WORKER, IPD_RUN]) assert.ok(/catch \{ return none; \}/.test(src));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5 · Unit C's dependency, and what must not have moved
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('lib/audit-canonical.ts is UNTOUCHED — the grader tier is Unit C', () => {
  const canonical = readFileSync('lib/audit-canonical.ts', 'utf8');
  assert.ok(!/\bprovider\b/.test(canonical.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')),
    'the ranking must not read the new column until Unit C says so');
  // the tier as shipped in 4f055c3 still keys on model/engine_version only
  assert.ok(canonical.includes("CASE WHEN model LIKE 'qwen%' OR engine_version LIKE '%-mini' THEN 1 ELSE 0 END"));
});
