// lib/__tests__/opd-audit-layers-core.test.ts — facts-then-rules PR 1: the origin vocabulary and
// the three-layer labelling on app/admin/opd-audit/[id]/page.tsx.
// Pure core tests + source-string assertions on the page (there is no render harness for it —
// Annex B.1.2; these are deliberately literal for the same reason the three existing guards are).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findingOrigin, ORIGIN_PRESENTATION, LAYER_COPY } from '../opd-audit-layers-core';

const PAGE = readFileSync('app/admin/opd-audit/[id]/page.tsx', 'utf8');

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · Origin comes from the stored field, and from nothing else
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('findingOrigin maps the stored source field to the three governed values', () => {
  assert.equal(findingOrigin('deterministic'), 'deterministic');
  assert.equal(findingOrigin('llm'), 'model');
});

test('findingOrigin: absent / null / unrecognised → unknown, never a guess', () => {
  assert.equal(findingOrigin(undefined), 'unknown');
  assert.equal(findingOrigin(null), 'unknown');
  assert.equal(findingOrigin(''), 'unknown');
  assert.equal(findingOrigin('LLM'), 'unknown', 'case-sensitive: only the stored literal counts');
  assert.equal(findingOrigin('rule'), 'unknown');
  assert.equal(findingOrigin('gemini-2.5-pro'), 'unknown', 'a model name is not the source field');
});

test('BLOCKER 2: origin cannot be derived from rule_ref — the signature admits only the source field', () => {
  // The matcher stamps rule_ref onto model-authored PROSE after findings exist, so a rule_ref
  // proves nothing fired. A model-authored finding carrying a rule_ref stays `model`; a
  // deterministic finding with NO rule_ref stays `deterministic`. Both are the source field alone.
  const modelFindingWithRuleRef = { source: 'llm', rule_ref: 'lvc-antibiotic-uri-001' };
  const deterministicWithoutRuleRef = { source: 'deterministic', rule_ref: null };
  const legacyRowWithOnlyARuleRef = { rule_ref: 'lvc-antibiotic-uri-001' };
  assert.equal(findingOrigin(modelFindingWithRuleRef.source), 'model');
  assert.equal(findingOrigin(deterministicWithoutRuleRef.source), 'deterministic');
  assert.equal(findingOrigin((legacyRowWithOnlyARuleRef as { source?: string }).source), 'unknown',
    'a rule_ref alone can never manufacture an origin');
  // findingOrigin takes a string — there is no finding-shaped parameter for rule_ref to ride in on.
  assert.equal(findingOrigin.length, 1);
});

test('GREP: the page derives the origin chip from f.source only — no rule_ref path', () => {
  assert.ok(PAGE.includes('findingOrigin(f.source)'), 'the chip reads the stored field through the core');
  // Every rule_ref mention on the page must belong to the Right Care rule-metadata lookup, never
  // to origin. Assert no line mentions both rule_ref and origin/findingOrigin.
  const offending = PAGE.split('\n')
    .map((l, i) => ({ l, n: i + 1 }))
    .filter(({ l }) => /rule_ref/.test(l) && /findingOrigin|origin/i.test(l));
  assert.deepEqual(offending.map((o) => o.n), [], 'no line couples rule_ref to origin');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · The chip presentation: three values, one home, honest copy
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('ORIGIN_PRESENTATION covers exactly the three values and labels them verbatim', () => {
  assert.deepEqual(Object.keys(ORIGIN_PRESENTATION).sort(), ['deterministic', 'model', 'unknown']);
  for (const k of ['deterministic', 'model', 'unknown'] as const) {
    assert.equal(ORIGIN_PRESENTATION[k].label, k, 'the visible chip text IS the governed value');
    assert.ok(ORIGIN_PRESENTATION[k].title.length > 20, 'each value explains itself in plain words');
  }
});

test('the model chip carries the legacy-finding meaning and never the word proposal', () => {
  const t = ORIGIN_PRESENTATION.model.title.toLowerCase();
  assert.ok(t.includes('legacy') && t.includes('model-authored') && t.includes('finding'));
  assert.ok(t.includes('not a proposal'), 'the meaning the kickoff fixed: a finding, not a proposal');
});

test('unknown is presented as an honest gap, not an error state', () => {
  const t = ORIGIN_PRESENTATION.unknown.title.toLowerCase();
  assert.ok(t.includes('not an error'));
  assert.ok(!/fail|broken|missing data|error state/.test(t));
});

test('NO PROPOSAL VOCABULARY: ModelProposal appears nowhere in the core or on the page', () => {
  const core = readFileSync('lib/opd-audit-layers-core.ts', 'utf8');
  for (const [name, src] of [['core', core], ['page', PAGE]] as const) {
    assert.ok(!src.includes('ModelProposal'), `${name}: ModelProposal arrives in PR 2, not here`);
  }
  // No rendered string may relabel a historical finding as a proposal.
  assert.ok(!/>\s*proposal/i.test(PAGE), 'no rendered "proposal" label on the page');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · The three layers, in the page's existing order
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('LAYER_COPY numbers the three layers Facts → Findings → Model', () => {
  assert.equal(LAYER_COPY.facts.n, 1);
  assert.equal(LAYER_COPY.findings.n, 2);
  assert.equal(LAYER_COPY.model.n, 3);
});

test('the facts layer is labelled CURRENT-source and never claims to be audit-time', () => {
  const line = LAYER_COPY.facts.line;
  assert.ok(/current source data/i.test(line));
  assert.ok(/not the facts as they were when this note was audited/i.test(line));
  // The page must render that line, and must not claim the pane drove the audit.
  assert.ok(PAGE.includes('LAYER_COPY.facts') || PAGE.includes(line));
});

test('the model layer states PDQI is model-derived and roughly a quarter of the index', () => {
  const line = LAYER_COPY.model.line;
  assert.ok(/model-derived/i.test(line));
  assert.ok(/25%/.test(line));
});

test('the page renders all three layer headers, in source order Facts → Findings → Model', () => {
  const facts = PAGE.indexOf('LAYER_COPY.facts');
  const findings = PAGE.indexOf('LAYER_COPY.findings');
  const model = PAGE.indexOf('LAYER_COPY.model');
  assert.ok(facts > 0 && findings > 0 && model > 0, 'all three layer headers render');
  assert.ok(facts < findings && findings < model, 'in the page order Facts → Findings → Model');
  // Anchored to the existing sections, not moved.
  assert.ok(facts > PAGE.indexOf('id="note"'), 'the facts header sits in the note section');
  assert.ok(findings > PAGE.indexOf('id="findings"'), 'the findings header sits in the findings section');
  assert.ok(model > PAGE.indexOf('id="pdqi"'), 'the model header sits in the PDQI section');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · Severity ordering inside the findings layer is untouched (acceptance 4)
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the tier machinery the findings layer wraps is unchanged', () => {
  assert.ok(PAGE.includes('const tiers = bucketByTier(renderFindings);'), 'derived, not reimplemented');
  assert.ok(PAGE.includes('const tier2Sorted = tiers.tier2.slice().sort((a, b) => groupRank(a.domain) - groupRank(b.domain));'));
  assert.ok(PAGE.includes('const displayFindings = [...tiers.tier1, ...tier2Sorted];'));
  assert.ok(PAGE.includes('Tier 1 · Escalate now'));
  assert.ok(PAGE.includes('Tier 2 · Act this week'));
  assert.ok(PAGE.includes('Tier 3 · Log only'), 'tier 3 stays a count');
});

test('the stored index is read, never recomputed (acceptance 5)', () => {
  assert.ok(PAGE.includes('const index = n(r.note_quality_index);'));
});
