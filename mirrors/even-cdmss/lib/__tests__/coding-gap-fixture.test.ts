/**
 *   node --test --import tsx lib/__tests__/coding-gap-fixture.test.ts
 *
 * PRD §5.6 — CODING_GAP_RE is VERIFIED WORKING in production (note VZD2XTKn… carries "Diagnosis
 * documented without a code" with informational:true and signal_type coding_completeness). This
 * fixture exists so the phase-2 batch — which adds a neutralizer beside it — cannot regress it.
 * CHANGE NOTHING about the regex; this file only pins what already works.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { neutralizeMetadataFindings, type OpdFinding } from '../opd-note-audit-core.ts';

function mkFinding(p: Partial<OpdFinding>): OpdFinding {
  return {
    subject: 'x', verdict: 'context-dependent', confidence: 0.7, domain: 'appropriateness',
    rationale: '', evidence: [], estimates: [], citation_ids: [], source: 'llm', ...p,
  } as OpdFinding;
}

test('the production exhibit shape: "Diagnosis documented without a code" → coding_completeness', () => {
  const f = mkFinding({
    subject: 'Diagnosis documented without a code',
    rationale: 'The clinical diagnosis of cervical spondylosis is stated in words but no ICD-10 code is assigned.',
  });
  const out = neutralizeMetadataFindings([f]);
  assert.equal(out[0].informational, true);
  assert.equal(out[0].signal_type, 'coding_completeness');
  // marked, never dropped; verdict/text untouched
  assert.equal(out[0].verdict, 'context-dependent');
  assert.equal(out[0].rationale, f.rationale);
});

test('the regex catches the documented phrasings', () => {
  for (const rationale of [
    'Missing ICD-10 code for the stated diagnosis.',
    'The impression should be coded to ICD-10.',
    'Coding gap: the diagnosis carries no mapped code.',
    'The diagnosis code is not documented.',
    'Uncoded diagnosis in the impression field.',
  ]) {
    const out = neutralizeMetadataFindings([mkFinding({ rationale })]);
    assert.equal(out[0].signal_type, 'coding_completeness', rationale);
  }
});

test('a CLINICAL diagnosis-missing finding is NOT a coding gap and passes through', () => {
  const f = mkFinding({ subject: 'No working diagnosis', rationale: 'The note documents no diagnosis or impression for the presenting complaint.' });
  assert.notEqual(neutralizeMetadataFindings([f])[0].signal_type, 'coding_completeness');
});

test('deterministic findings pass through the metadata neutralizer untouched', () => {
  const f = mkFinding({ source: 'deterministic', rationale: 'Missing ICD-10 code for the diagnosis.' });
  assert.notEqual(neutralizeMetadataFindings([f])[0].informational, true);
});

test('CODING_GAP_RE is byte-identical — the batch changed nothing', () => {
  const core = readFileSync('lib/opd-note-audit-core.ts', 'utf8');
  assert.ok(core.includes(String.raw`const CODING_GAP_RE = /(?:missing|absent|no|add|assign|map|include)[^.]*\bicd(?:[- ]?10)?\b|\bicd(?:[- ]?10)?\b[^.]*(?:code|mapping|missing|absent)|coding (?:gap|completeness|error|omission)|\bcode (?:is )?(?:not )?(?:documented|assigned|mapped|present)|should be coded|uncoded diagnosis/i;`));
});
