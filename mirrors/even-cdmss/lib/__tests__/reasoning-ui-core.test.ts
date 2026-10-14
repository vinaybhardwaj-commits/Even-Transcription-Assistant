/**
 * lib/__tests__/reasoning-ui-core.test.ts — Reasoning Observability Stage 2 (UI cores).
 * Pure coverage of the formatters the new admin surfaces render — no DB, no JSX:
 *
 *   1. registryTabRows maps generated + manifest correctly (count, maturity, rubric, sha12).
 *   2. groupPromptVersionCost sums the by-prompt-version breakdown correctly.
 *   3. fingerprintRows/stageRollupRows tolerate NULL columns (pre-Stage-1 rows) without throwing.
 *   4. PHI-safety: the new views' row objects carry registry/envelope fields only.
 *   5. shortVersion / shortPromptRef formatters.
 *   6. promptVersionChanges detects a rollout inside the watch window.
 *   7. GOVERNANCE_SNAPSHOT matches the LIVE scan — the coverage panel cannot silently rot
 *      (the deployed bundle can't scan source, so CI enforces snapshot currency here).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  registryTabRows, groupPromptVersionCost, fingerprintRows, stageRollupRows,
  shortVersion, shortPromptRef, promptVersionChanges, GOVERNANCE_SNAPSHOT,
  type EnvelopeEventRow,
} from '../reasoning/registry-core';

const ROOT = path.join(__dirname, '..', '..');
const GOV_SPECIFIER = ['..', '..', 'scripts', 'reasoning-governance-check.mjs'].join('/');

// Same forbidden pattern as the Stage-0 research-export test — the new admin views must
// surface registry/envelope fields only, never clinical/run content keys.
const FORBIDDEN = /(patient|phi\b|uhid|mrn|dob|diagnos|complaint|medication|symptom|answer|response|payload|run_id|member|episode|encounter)/i;

test('registryTabRows maps generated + manifest correctly', () => {
  const rows = registryTabRows();
  assert.equal(rows.length, 34, 'one row per registry prompt');   // +1 K1 (inquiry), +1 PR0 (verify-core/VERIFY_SYSTEM), +1 Concept Coder, +1 LVP L2 (lvp-operator-core/LVP_OPERATOR_SYSTEM), +2 Pre-op B5/B6 (extract + narrative rails, both flag-dark), +1 Stewardship S4 (physician-standing-core/STANDING_PROMPT_CLAUSE)
  const judge = rows.find((r) => r.id === 'lvc-core/JUDGE_SYSTEM')!;
  assert.ok(judge, 'known prompt present');
  assert.equal(judge.maturity, 'draft', 'manifest maturity merged');
  assert.equal(judge.rubricId, 'applicability discipline', 'manifest rubric merged');
  assert.equal(judge.shortId, 'lvc-core/judge');
  assert.match(judge.sha12, /^[0-9a-f]{12}$/);
  assert.ok(judge.text.length > 100, 'full prompt text available to the viewer');
  const unreg = rows.find((r) => r.id === 'expand/SYSTEM')!;
  assert.equal(unreg.maturity, 'unregistered', 'unlisted id renders unregistered, never throws');
});

test('groupPromptVersionCost sums the 4th breakdown correctly', () => {
  const price = (model: string, inTok: number, outTok: number, hi: boolean) =>
    (model === 'pro' ? 2 : 1) * (inTok + outTok) / 1000 * (hi ? 2 : 1);
  const groups = groupPromptVersionCost([
    { promptId: 'lvc-core/JUDGE_SYSTEM', promptVersion: 'unversioned (git-tracked)', model: 'pro', hi: false, inTok: 1000, outTok: 500, calls: 3 },
    { promptId: 'lvc-core/JUDGE_SYSTEM', promptVersion: 'unversioned (git-tracked)', model: 'flash', hi: false, inTok: 2000, outTok: 0, calls: 2 },
    { promptId: 'doc-audit-core/ANALYZE_SYSTEM', promptVersion: 'unversioned (git-tracked)', model: 'pro', hi: true, inTok: 500, outTok: 500, calls: 1 },
  ], price);
  assert.equal(groups.length, 2, 'grouped by prompt·version across models');
  const judge = groups.find((g) => g.key.startsWith('lvc-core/JUDGE_SYSTEM'))!;
  // pro: 2*(1500)/1000 = 3 ; flash: 1*(2000)/1000 = 2 → 5 across 5 calls
  assert.equal(judge.inr, 5);
  assert.equal(judge.calls, 5);
  assert.equal(judge.label, 'lvc-core/judge · unversioned');
  // sorted spend-first: analyze = 2*(1000)/1000*2 = 4 < 5
  assert.equal(groups[0].key, judge.key);
});

test('fingerprint + rollup tolerate NULL columns (pre-Stage-1 rows) without throwing', () => {
  const nullRow: EnvelopeEventRow = {
    seq: 1, stage: 'ask_draft', prompt_id: null, prompt_version: null, prompt_hash: null,
    rubric_versions: null, output_schema_version: null, call_model: 'qwen2.5:14b',
    call_provider: null, gen_params: null, tokens_in: null, tokens_out: null, latency_ms: 900,
  };
  assert.deepEqual(fingerprintRows([nullRow]), [], 'no prompt_id → no fingerprint row, no throw');
  assert.deepEqual(fingerprintRows([]), []);
  assert.deepEqual(stageRollupRows([nullRow]), [], 'no tokens → not a response row');
  assert.deepEqual(fingerprintRows(undefined as unknown as EnvelopeEventRow[]), [], 'undefined-tolerant');

  const full: EnvelopeEventRow[] = [
    { seq: 2, stage: 'lvc_judge', prompt_id: 'lvc-core/JUDGE_SYSTEM', prompt_version: 'unversioned (git-tracked)', prompt_hash: 'ab'.repeat(32), rubric_versions: { 'applicability discipline': 'x' }, output_schema_version: null, call_model: 'gemini-2.5-pro', call_provider: 'gemini', gen_params: { temperature: 0.1, max_tokens: 900 }, tokens_in: 100, tokens_out: 50, latency_ms: 2000 },
  ];
  const fps = fingerprintRows(full);
  assert.equal(fps.length, 1);
  assert.equal(fps[0].shortId, 'lvc-core/judge');
  assert.equal(fps[0].sha12, 'ab'.repeat(6));
  assert.deepEqual(fps[0].rubrics, ['applicability discipline']);
  assert.equal(fps[0].temperature, '0.1');
  const roll = stageRollupRows(full);
  assert.equal(roll.length, 1);
  assert.equal(roll[0].tokensIn, 100);
  assert.equal(roll[0].stage, 'lvc_judge');
});

test('PHI-safety: new views surface registry/envelope fields only', () => {
  for (const row of registryTabRows()) {
    for (const k of Object.keys(row)) assert.ok(!FORBIDDEN.test(k), `registry row key "${k}" is clean`);
  }
  const fp = fingerprintRows([{ prompt_id: 'lvc-core/JUDGE_SYSTEM', prompt_version: 'x', prompt_hash: 'y', call_model: 'm' }])[0];
  for (const k of Object.keys(fp)) assert.ok(!FORBIDDEN.test(k), `fingerprint key "${k}" is clean`);
});

test('shortVersion / shortPromptRef formatters', () => {
  assert.equal(shortVersion('unversioned (git-tracked)'), 'unversioned');
  assert.equal(shortVersion('OPD_ENGINE_VERSION=opd-note-audit/0.81.8'), 'opd-note-audit/0.81.8');
  assert.equal(shortVersion(''), '—');
  assert.equal(shortPromptRef('doc-audit-core/AUDIT_CRITIQUE_SYSTEM'), 'doc-audit-core/audit_critique');
  assert.equal(shortPromptRef('expand/SYSTEM'), 'expand/system');
  assert.equal(shortPromptRef('no-slash'), 'no-slash');
});

test('promptVersionChanges detects a rollout inside the watch window', () => {
  const now = 1_800_000_000_000;
  const changes = promptVersionChanges([
    { promptId: 'lvc-core/JUDGE_SYSTEM', promptVersion: 'v3', firstSeenMs: now - 10 * 86400_000 },
    { promptId: 'lvc-core/JUDGE_SYSTEM', promptVersion: 'v4', firstSeenMs: now - 3600_000 },
    { promptId: 'pathway-core/SKELETON_SYSTEM', promptVersion: 'v1', firstSeenMs: now - 30 * 86400_000 },  // single version → no change
  ], now - 48 * 3600_000);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].shortId, 'lvc-core/judge');
  assert.equal(changes[0].fromVersion, 'v3');
  assert.equal(changes[0].toVersion, 'v4');
  // Old rollout outside the window → not flagged.
  assert.deepEqual(promptVersionChanges([
    { promptId: 'a/B', promptVersion: 'v1', firstSeenMs: now - 90 * 86400_000 },
    { promptId: 'a/B', promptVersion: 'v2', firstSeenMs: now - 80 * 86400_000 },
  ], now - 48 * 3600_000), []);
});

test('GOVERNANCE_SNAPSHOT matches the live scan — the coverage panel cannot rot', async () => {
  const gov = await import(GOV_SPECIFIER);
  const { sites, stores } = gov.scanUngoverned();
  const files = [...new Set(sites.map((s: { file: string }) => s.file))].sort();
  assert.equal(sites.length, GOVERNANCE_SNAPSHOT.directSites, 'direct-site count — update GOVERNANCE_SNAPSHOT after migrating/adding a direct call');
  assert.equal(files.length, GOVERNANCE_SNAPSHOT.directFiles, 'direct-file count');
  assert.deepEqual(files, [...GOVERNANCE_SNAPSHOT.ungovernedFiles].sort(), 'ungoverned file list');
  assert.equal(stores.length, GOVERNANCE_SNAPSHOT.concordanceRefs, 'concordance reference count');

  // taggedPromptRefs: the Stage-1 wrapper tags, counted the same way the Stage-1 test does.
  const tagged = new Set<string>();
  for (const f of ['lib/lvc.ts', 'lib/pathway.ts', 'lib/doc-audit.ts']) {
    const text = readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of text.matchAll(/'([a-z0-9-]+\/[A-Z][A-Z0-9_]+)'/g)) tagged.add(m[1]);
  }
  assert.equal(tagged.size, GOVERNANCE_SNAPSHOT.taggedPromptRefs, 'tagged promptRef count');
});
