/**
 *   node --test --import tsx lib/__tests__/citation-support.test.ts
 *
 * Phase 3b — the citation support check (register bug 9a, P0).
 *
 * A HIGH-VALUE finding praised cholecalciferol after cranioplasty, citing Rae et al.'s wound-healing
 * protocol — vitamin A, ascorbic acid, zinc sulfate. NO vitamin D, and no weekly high-dose regimen
 * of anything. The retrieved excerpt said "vitamin and mineral supplementation" without naming
 * which; the model saw cholecalciferol on the prescription and concluded the study endorsed it.
 * The provenance surface then reported it as grounded.
 *
 * ⚠️ GENERATION TIME, NOT POST-HOC (superseding PRD §6.3). MEASURED: the model reads 700 chars per
 * excerpt; only 600 are stored. A check against the stored preview would strip citations whose
 * supporting sentence sits in chars 601–700 — text the model legitimately read. Stripping a GOOD
 * citation is worse than leaving a bad one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripUnsupportedCitations } from '../opd-note-audit.ts';
import { computeOpdScore } from '../opd-note-score-core.ts';
import type { OpdFinding } from '../opd-note-audit-core.ts';

function mkFinding(p: Partial<OpdFinding>): OpdFinding {
  return {
    subject: 'x', verdict: 'high-value', confidence: 0.9, domain: 'appropriateness',
    rationale: '', evidence: [], estimates: [], citation_ids: [], source: 'llm', ...p,
  } as OpdFinding;
}

// The bug-9a exhibit, as it actually read.
const BUG9A = mkFinding({
  subject: 'Evidence-based supplementation post-cranioplasty',
  rationale: 'The prescription of vitamin supplementation (Cholecalciferol) following a cranioplasty is consistent with an evidence-based wound healing protocol.',
  evidence: ['A study of a wound healing protocol instituted after cranioplasty, which consisted of vitamin and mineral supplementation, was found to reduce the rate of infections and reoperations.'],
  citation_ids: [4],
});
const RAE_PROTOCOL = {
  id: 4,
  text: 'Low-Cost Wound Healing Protocol Reduces Infection and Reoperation Rates After Cranioplasty. '
      + 'The protocol consisted of sodium chloride 0.9% 15 mL/kg/day continuous IV, oxygen 2 L via nasal cannula, '
      + 'vitamin A 20,000 units daily for 7 days, ascorbic acid 500 mg orally twice daily for 7 days, and '
      + 'zinc sulfate 220 mg orally daily for 7 days.',
};

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · The strip, and the reasons NOT to strip
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§6.8 BUG 9a: the citation is stripped and evidence moves to estimates', () => {
  const out = stripUnsupportedCitations([BUG9A], [RAE_PROTOCOL]);
  assert.deepEqual(out[0].citation_ids, [], 'no cited excerpt names vitamin D');
  assert.deepEqual(out[0].evidence, [], 'the unsupported point leaves evidence');
  assert.deepEqual(out[0].estimates, BUG9A.evidence, '…and lands in estimates, not the bin');
  // the finding itself is NOT altered otherwise
  assert.equal(out[0].verdict, 'high-value');
  assert.equal(out[0].subject, BUG9A.subject);
  assert.equal(out[0].rationale, BUG9A.rationale);
});

test('§6.7 THE 700-CHAR REASON: support beyond character 600 still counts', () => {
  // The molecule appears at ~char 640 — inside what the model read (700), outside what is stored (600).
  const pad = 'a'.repeat(620);
  const hit = { id: 4, text: `${pad} cholecalciferol repletion reduced reoperation rates.` };
  assert.ok(hit.text.indexOf('cholecalciferol') > 600, 'the fixture really sits past the stored preview');
  const out = stripUnsupportedCitations([BUG9A], [hit]);
  assert.deepEqual(out[0].citation_ids, [4], 'a citation the model legitimately read must survive');
  assert.deepEqual(out[0].evidence, BUG9A.evidence);
});

test('a supporting excerpt naming the molecule keeps the citation', () => {
  const hit = { id: 4, text: 'Vitamin D3 supplementation after cranial surgery improved outcomes.' };
  assert.deepEqual(stripUnsupportedCitations([BUG9A], [hit])[0].citation_ids, [4]);
});

test('CONSERVATIVE: an undeterminable molecule ⇒ do nothing', () => {
  const vague = mkFinding({ subject: 'Good documentation of the plan', rationale: 'The plan is clear.', citation_ids: [4], evidence: ['x'] });
  const out = stripUnsupportedCitations([vague], [RAE_PROTOCOL]);
  assert.deepEqual(out[0].citation_ids, [4], 'never strip on uncertainty');
});

test('CONSERVATIVE: a cited excerpt with no text available ⇒ do nothing', () => {
  for (const hits of [[{ id: 4, text: '' }], [{ id: 4, text: null }], [{ id: 9, text: 'other' }]]) {
    const out = stripUnsupportedCitations([BUG9A], hits as never);
    assert.deepEqual(out[0].citation_ids, [4], 'missing excerpt text is not evidence of absence');
  }
});

test('deterministic findings and uncited findings are untouched', () => {
  const det = mkFinding({ ...BUG9A, source: 'deterministic' });
  assert.deepEqual(stripUnsupportedCitations([det], [RAE_PROTOCOL])[0].citation_ids, [4]);
  const uncited = mkFinding({ ...BUG9A, citation_ids: [] });
  assert.deepEqual(stripUnsupportedCitations([uncited], [RAE_PROTOCOL])[0].evidence, BUG9A.evidence);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · The reuse-path guard
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§6.9: the check does NOT run on the reuse path — empty hits, untouched findings', () => {
  for (const hits of [[], undefined, null]) {
    const out = stripUnsupportedCitations([BUG9A], hits as never);
    assert.deepEqual(out[0].citation_ids, [4], 'a reuse backfill carries only 600-char previews');
    assert.deepEqual(out[0].evidence, BUG9A.evidence);
  }
});

test('the guard is structural in the engine: latestHits is set ONLY on the generation path', () => {
  const src = readFileSync('lib/opd-note-audit.ts', 'utf8');
  assert.ok(src.includes('let latestHits: { id: number; text?: string | null }[] = [];'), 'defaults empty');
  assert.equal((src.match(/latestHits = hits;/g) || []).length, 1, 'assigned exactly once');
  // …and that one assignment is AFTER the retrieval, i.e. on the generation path only.
  const assignIdx = src.indexOf('latestHits = hits;');
  // RE-PINNED (pass 4 forward correction, Rep 43 A1). The statement is now a ternary whose FALSE
  // arm is the unchanged five-argument production call; the assignment no longer begins with
  // `const hits = await`. This anchors the PRODUCTION FALSE ARM, which is the thing this test is
  // about — the retrieval that runs when no fault plan exists — and is still unique in the file.
  const retrieveIdx = src.indexOf(': await defaultRetrieve(query, mini, opts.evalNormativeLeg, opts.rerankBackend, primaryCapture);');
  const reuseIdx = src.indexOf('if (opts.reuse)');
  assert.ok(assignIdx > retrieveIdx, 'set after retrieval');
  assert.ok(reuseIdx < retrieveIdx, 'the reuse path returns before retrieval ever runs');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · It cannot move a score — and nothing in the provenance stack changed
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§6.10: stripping a citation does NOT change the index', () => {
  const scoring = mkFinding({
    ...BUG9A, verdict: 'low-value', confidence: 0.9, domain: 'appropriateness',
  });
  const score = (f: OpdFinding) => computeOpdScore({
    findings: [{ verdict: f.verdict, confidence: f.confidence, domain: 'appropriateness' }],
    completenessCoverage: 1, pdqi9: null, patientCentred: { present: 1, total: 1 },
  });
  const before = score(scoring);
  const after = score(stripUnsupportedCitations([scoring], [RAE_PROTOCOL])[0]);
  assert.equal(after.headline, before.headline, 'display/provenance only');
  assert.equal(after.band, before.band);
  // The structural reason: findingPenalty reads verdict, confidence and direction — never citations.
  const core = readFileSync('lib/opd-note-score-core.ts', 'utf8');
  const fn = core.slice(core.indexOf('function findingPenalty'), core.indexOf('export function bandFor'));
  assert.ok(!/citation/i.test(fn), 'citations do not enter scoring');
});

test('§6.11: groundingKind, SEVERITY, PENALTY_BASE and findingPenalty are BYTE-IDENTICAL', async () => {
  const prov = readFileSync('lib/provenance-tier-core.ts', 'utf8');
  assert.ok(prov.includes(`export function groundingKind(
  f: { source?: string; citation_ids?: number[] },
  ruleResolves: boolean,
): GroundingKind {
  if (f.source === 'deterministic') return 'deterministic_rule';
  if (ruleResolves) return 'external_source';
  if (Array.isArray(f.citation_ids) && f.citation_ids.length > 0) return 'internal_corpus';
  return 'no_source';
}`), 'a stripped citation falls to no_source through the EXISTING logic');
  const score = readFileSync('lib/opd-note-score-core.ts', 'utf8');
  assert.ok(score.includes("export const PENALTY_BASE = 45;"));
  assert.ok(score.includes("export const SEVERITY: Record<NetValue, number> = { 'low-value': 1.0, 'context-dependent': 0.5, uncertain: 0.2, 'high-value': 0 };"));
  assert.ok(score.includes(`  if (f.direction === 'underuse') return 0;`));
  assert.ok(score.includes(`  return PENALTY_BASE * (SEVERITY[f.verdict] ?? 0.2) * clamp(Number(f.confidence) || 0, 0, 1);`));
});

test('a stripped finding really does render as no_source', async () => {
  const { groundingKind } = await import('../provenance-tier-core.ts');
  const stripped = stripUnsupportedCitations([BUG9A], [RAE_PROTOCOL])[0];
  assert.equal(groundingKind({ source: stripped.source, citation_ids: stripped.citation_ids }, false), 'no_source');
  // …whereas before the strip it claimed internal corpus.
  assert.equal(groundingKind({ source: BUG9A.source, citation_ids: BUG9A.citation_ids }, false), 'internal_corpus');
});

test('the 600 and 700 constants are byte-identical — the gap this design exists for', () => {
  const cit = readFileSync('lib/citations-core.ts', 'utf8');
  assert.ok(/perChunkChars\s*=\s*700/.test(cit), 'buildCitedContext still reads 700 chars');
  assert.ok(/\.slice\(0,\s*600\)/.test(cit), 'hitsToSources still stores 600');
});
