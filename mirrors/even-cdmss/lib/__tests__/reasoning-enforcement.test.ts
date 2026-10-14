/**
 * lib/__tests__/reasoning-enforcement.test.ts — Reasoning Observability Stage 4
 * (enforcement + breadth). Pure coverage:
 *
 *   1. Every promptRef literal across ALL tagged files resolves to a REAL registry id,
 *      and the Stage-4 breadth tags (DDx graph, ClinicalState extraction, OPD audit,
 *      retrieval helpers, concordance, value pass) are present.
 *   2. governedChat is exact delegation — the transport-equivalence pin: traced calls go
 *      to tracedChat verbatim, traceless calls to chatWithFallback with the same params,
 *      so routing a call through the governed layer cannot change its output.
 *   3. The governance script exits 1 semantics: config sanity (patterns + governed set).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import GENERATED from '../../data/reasoning-registry/prompts.generated.json';

const ROOT = path.join(__dirname, '..', '..');
const genIds = new Set((GENERATED as unknown as { prompts: Array<{ id: string }> }).prompts.map((p) => p.id));

// Every file that carries promptRef tags after Stage 4.
const TAGGED_FILES = [
  'lib/lvc.ts', 'lib/pathway.ts', 'lib/doc-audit.ts',                      // Stage 1 (Right Care)
  'lib/lvc-value.ts', 'lib/expand.ts', 'lib/rerank.ts', 'lib/learning.ts', // Stage 4
  'lib/investigations.ts', 'lib/mcp-tools.ts', 'lib/concordance.ts',
  'lib/ddx-hypothesis.ts', 'lib/opd-note-audit.ts',
  'app/api/appropriateness/route.ts', 'app/api/pathway/skeleton/route.ts', 'app/api/ddx/route.ts',
];

// The Stage-4 breadth tags that must exist (beyond Stage 1's ten).
const EXPECTED_NEW_TAGS = [
  'lvc-value-core/VALUE_SYSTEM',
  'lvc-value-core/VALUE_CRITIQUE_SYSTEM',
  'lvc-value-core/VALUE_REVISE_SYSTEM',
  'expand/SYSTEM',
  'rerank/JUDGE_SYSTEM',
  'learning-core/CANONICALIZE_SYSTEM',
  'investigations/PARSE_SYSTEM',
  'concordance-core/SYSTEM',
  'ddx-hypothesis/HYPO_SYSTEM',
  'extract/NORMALISE_SYSTEM',
  'opd-note-audit-core/OPD_AUDIT_SYSTEM',
];

test('every promptRef tag across all tagged files resolves to a real registry id', () => {
  const tagged = new Set<string>();
  for (const f of TAGGED_FILES) {
    const text = readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of text.matchAll(/'([a-z0-9-]+\/[A-Z][A-Z0-9_]+)'/g)) tagged.add(m[1]);
  }
  for (const id of tagged) assert.ok(genIds.has(id), `tag "${id}" exists in the registry`);
  for (const id of EXPECTED_NEW_TAGS) assert.ok(tagged.has(id), `Stage-4 tag "${id}" is present`);
});

test('governedChat is exact delegation (transport-equivalence pin)', () => {
  const traceText = readFileSync(path.join(ROOT, 'lib', 'trace.ts'), 'utf8');
  const body = traceText.slice(traceText.indexOf('export async function governedChat'));
  assert.ok(body.includes('return tracedChat(traceId, label, params, opts);'), 'traced branch delegates verbatim');
  // D-1 (31 Jul): the traceless branch forwards the per-request ceiling too — equivalence holds.
  // Unit D (3 Aug): and the transport try count, on BOTH arms. Equivalence is the point of this
  // pin, so a bound that reached one arm and not the other would break exactly what it protects.
  // Unit V-a2 (4 Aug): and noLocalFallback, for the same reason — a flag that reached only the
  // traced arm would leave the lab's traceless runs silently falling back to the local model.
  assert.ok(body.includes('return chatWithFallback(params, opts?.gemini, opts?.openrouter, opts?.timeoutMs, opts?.maxTries, opts?.noLocalFallback);'), 'traceless branch is the plain hybrid fallback with the same params (+ openrouter route + D-1 ceiling + Unit D try count + V-a2 flag)');
});

test('governance config sanity: four call patterns, three governed files, fold declared', async () => {
  const gov = await import(['..', '..', 'scripts', 'reasoning-governance-check.mjs'].join('/'));
  // 3 → 4 and 2 → 3 on 7 Aug 2026 (Bedrock S1): lib/bedrock.ts owns the AWS transport the way
  // lib/llm.ts owns the two OpenAI-SDK ones, and bedrockConverse/bedrockGenerate join the banned
  // direct calls so the S2 backfill runner cannot reach Bedrock except through governedChat.
  assert.equal(gov.DIRECT_CALL_PATTERNS.length, 4);
  assert.deepEqual([...gov.GOVERNED_FILES].sort(), ['lib/bedrock.ts', 'lib/llm.ts', 'lib/trace.ts']);
  assert.ok(gov.PARALLEL_STORE_PATTERNS.some((p: { id: string; foldedBy?: string }) => p.id === 'concordance_runs' && p.foldedBy === 'lib/concordance.ts'));
});
