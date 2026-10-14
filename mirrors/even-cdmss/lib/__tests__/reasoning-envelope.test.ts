/**
 * lib/__tests__/reasoning-envelope.test.ts — Reasoning Observability Stage 1
 * (Invocation Envelope). Pure/unit coverage — no DB, no network:
 *
 *   1. promptFingerprint resolves version+hash from the committed registry; unknown → null.
 *   2. buildEnvelope stamps the fingerprint columns when promptRef is set, and ONLY the
 *      call facts when unset (the "unset ⇒ model/tokens only" contract).
 *   3. ENVELOPE_UPDATE_SQL names exactly the ten normative 0012 columns.
 *   4. withTrace finalizes exactly once, in finally, on success AND on throw.
 *   5. The 0012 migration is idempotent (IF NOT EXISTS on every statement) and covers
 *      every normative column + the index.
 *   6. The governance check flags a known direct call and the concordance parallel store.
 *   7. Every Right Care promptRef tag resolves to a REAL registry id.
 *   8. countNonEnumVerdicts (A04, DA04=a) counts exactly the out-of-enum verdicts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { promptFingerprint } from '../reasoning/registry-core';
import { buildEnvelope, withTrace, ENVELOPE_UPDATE_SQL } from '../trace';
import { countNonEnumVerdicts } from '../doc-audit-core';
import GENERATED from '../../data/reasoning-registry/prompts.generated.json';

const ROOT = path.join(__dirname, '..', '..');
// Joined at runtime so tsc never tries to resolve the .mjs module graph (Stage-0 idiom).
const GOV_SPECIFIER = ['..', '..', 'scripts', 'reasoning-governance-check.mjs'].join('/');

interface GenPrompt { id: string; sha256: string; version_hint: string }
const genPrompts = (GENERATED as unknown as { prompts: GenPrompt[] }).prompts;

const NORMATIVE_EVENT_COLUMNS = [
  'prompt_id', 'prompt_version', 'prompt_hash', 'rubric_versions', 'output_schema_version',
  'call_model', 'call_provider', 'gen_params', 'tokens_in', 'tokens_out',
];

// The Stage-1 Right Care tag set (PRD §Stage-1 item 5 + the extract stamp).
const EXPECTED_TAGS = [
  'lvc-core/CANDIDATE_SYSTEM',
  'lvc-core/JUDGE_SYSTEM',
  'pathway-core/SKELETON_SYSTEM',
  'pathway-core/ENRICH_SYSTEM',
  'pathway-core/ENRICH_CRITIQUE_SYSTEM',
  'pathway-core/ENRICH_REVISE_SYSTEM',
  'doc-audit-core/EXTRACT_SYSTEM',
  'doc-audit-core/ANALYZE_SYSTEM',
  'doc-audit-core/AUDIT_CRITIQUE_SYSTEM',
  'doc-audit-core/AUDIT_REVISE_SYSTEM',
];

test('promptFingerprint resolves from the committed registry; unknown id → null, never a throw', () => {
  const judge = genPrompts.find((p) => p.id === 'lvc-core/JUDGE_SYSTEM')!;
  const fp = promptFingerprint('lvc-core/JUDGE_SYSTEM');
  assert.ok(fp, 'known id resolves');
  assert.equal(fp!.id, 'lvc-core/JUDGE_SYSTEM');
  assert.equal(fp!.hash, judge.sha256);
  assert.equal(fp!.version, judge.version_hint);
  // Manifest-linked rubric surfaces with its registry version string.
  assert.deepEqual(fp!.rubricIds, ['applicability discipline']);
  assert.ok(fp!.rubricVersions['applicability discipline']);
  // Unregistered-but-generated prompt still fingerprints (maturity lives in the manifest).
  assert.ok(promptFingerprint('pathway-core/SKELETON_SYSTEM'));
  // Unknown id → null (an untagged/mistagged call degrades, never throws).
  assert.equal(promptFingerprint('no-such-file/NO_SUCH_CONST'), null);
});

test('buildEnvelope: promptRef set → fingerprint columns; unset → call facts only', () => {
  const withRef = buildEnvelope('doc-audit-core/ANALYZE_SYSTEM', {
    model: 'gemini-2.5-pro', provider: 'gemini', genParams: { temperature: 0.2 }, tokensIn: 100, tokensOut: 50,
  });
  const analyze = genPrompts.find((p) => p.id === 'doc-audit-core/ANALYZE_SYSTEM')!;
  assert.equal(withRef.prompt_id, 'doc-audit-core/ANALYZE_SYSTEM');
  assert.equal(withRef.prompt_hash, analyze.sha256);
  assert.equal(withRef.prompt_version, analyze.version_hint);
  assert.equal(withRef.call_model, 'gemini-2.5-pro');
  assert.equal(withRef.tokens_in, 100);
  assert.equal(withRef.tokens_out, 50);

  const noRef = buildEnvelope(undefined, { model: 'qwen2.5:14b', provider: 'ollama', tokensIn: 10, tokensOut: 5 });
  assert.equal(noRef.prompt_id, null);
  assert.equal(noRef.prompt_hash, null);
  assert.equal(noRef.rubric_versions, null);
  assert.equal(noRef.call_model, 'qwen2.5:14b');
  assert.equal(noRef.tokens_out, 5);
});

test('ENVELOPE_UPDATE_SQL writes exactly the ten normative columns', () => {
  for (const col of NORMATIVE_EVENT_COLUMNS) {
    assert.ok(ENVELOPE_UPDATE_SQL.includes(`${col} = $`), `updates ${col}`);
  }
});

test('withTrace finalizes exactly once — on success AND on throw', async () => {
  const finishes: Array<{ status: string; err?: string }> = [];
  const deps = {
    start: async () => 'trace-test-id',
    finish: async (_id: string, status: 'success' | 'error', err?: string) => { finishes.push({ status, err }); },
  };

  const out = await withTrace('test_feature', { a: 1 }, async (tid) => {
    assert.equal(tid, 'trace-test-id');
    return 'ok';
  }, deps);
  assert.equal(out, 'ok');
  assert.equal(finishes.length, 1, 'exactly one finalize on success');
  assert.equal(finishes[0].status, 'success');

  await assert.rejects(
    withTrace('test_feature', {}, async () => { throw new Error('boom'); }, deps),
    /boom/,
  );
  assert.equal(finishes.length, 2, 'exactly one finalize on throw (rethrown unchanged)');
  assert.equal(finishes[1].status, 'error');
  assert.match(finishes[1].err ?? '', /boom/);
});

test('migration 0012 is additive + idempotent and covers every normative column', () => {
  const sqlText = readFileSync(path.join(ROOT, 'migrations', '0012_reasoning_fingerprint.sql'), 'utf8');
  const statements = sqlText.split('\n').filter((l) => /^\s*(ALTER|CREATE)\b/i.test(l));
  assert.ok(statements.length >= 12, 'all 11 column adds + the index are present');
  for (const s of statements) {
    assert.match(s, /IF NOT EXISTS/i, `idempotent: ${s.trim()}`);
    assert.doesNotMatch(s, /\b(DROP|RENAME)\b/i, `additive only: ${s.trim()}`);
  }
  for (const col of NORMATIVE_EVENT_COLUMNS) assert.ok(sqlText.includes(col), `migration adds ${col}`);
  assert.ok(sqlText.includes('prompt_ids'), 'traces.prompt_ids');
  assert.match(sqlText, /CREATE INDEX IF NOT EXISTS .* ON trace_events \(prompt_id, prompt_version\)/, 'the (prompt_id, prompt_version) index');
});

test('governance gate (Stage 4): the repo scan is CLEAN; synthetic direct calls are flagged', async () => {
  const gov = await import(GOV_SPECIFIER);
  const { sites, stores, foldViolations } = gov.scanUngoverned();
  assert.equal(sites.length, 0, 'ZERO ungoverned model calls (Stage 4 migrated every direct site)');
  assert.deepEqual(foldViolations, [], 'the concordance→traces fold holds');
  assert.ok(stores.some((s: { file: string; pattern: string }) => s.pattern === 'concordance_runs'), 'concordance refs still listed (info — its own surface remains)');
  // A synthetic offender is caught per pattern; the governed layer itself is exempt.
  const synth = gov.scanSource('lib/synthetic.ts', [
    'const a = await chatWithFallback(params, gemini);',
    'const b = await llm.chat.completions.create(params);',
    'const c = await getGeminiChatClient();',
  ].join('\n'));
  assert.equal(synth.sites.length, 3, 'each direct-call pattern flags');
  assert.equal(gov.scanSource('lib/trace.ts', 'chatWithFallback(params)').sites.length, 0, 'governed layer exempt');
});

test('every Right Care promptRef tag resolves to a REAL registry id', () => {
  const wrapperFiles = ['lib/lvc.ts', 'lib/pathway.ts', 'lib/doc-audit.ts'];
  const tagged = new Set<string>();
  for (const f of wrapperFiles) {
    const text = readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of text.matchAll(/'([a-z0-9-]+\/[A-Z][A-Z0-9_]+)'/g)) tagged.add(m[1]);
  }
  const registryIds = new Set(genPrompts.map((p) => p.id));
  for (const id of tagged) assert.ok(registryIds.has(id), `tag "${id}" exists in the registry`);
  for (const id of EXPECTED_TAGS) assert.ok(tagged.has(id), `expected tag "${id}" is present in the wrappers`);
});

test('countNonEnumVerdicts (A04) counts exactly the out-of-enum verdicts', () => {
  const raw = JSON.stringify({
    findings: [
      { subject: 'CBC', verdict: 'high-value' },
      { subject: 'Widal', verdict: 'caveat' },              // non-enum (the A04 roll)
      { subject: 'MRI', verdict: 'Low Value' },              // normalises to low-value → enum
      { subject: 'PT/INR', verdict: 'informational' },       // non-enum
      { verdict: 'safety' },                                 // subject-less → skipped (mirrors parseAnalysis)
    ],
    idealised_summary: 'x', diff: [], suggestions: [],
  });
  assert.equal(countNonEnumVerdicts(raw), 2);
  assert.equal(countNonEnumVerdicts('not json at all'), 0);
  assert.equal(countNonEnumVerdicts(JSON.stringify({ findings: [] })), 0);
});
