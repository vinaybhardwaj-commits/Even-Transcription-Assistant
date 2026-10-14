// Unit C — the LVC judge A/A comparator (DETERMINISM-TRIO PRD v1.0 §4.2, D-4: measure only).
// Pure; no DB, no LLM. The comparator DECIDES nothing — §4.3's 95% rule is V's, made on the report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareJudgedRuns, summarizeAa, AA_VERDICTS } from '../lvc-judge-aa-core';
import type { JudgedRec, LvcRecommendation, Verdict } from '../lvc-core';

const rec = (id: string): LvcRecommendation => ({
  id, region: 'IN', society: 'Test Society', specialty: null, statement: `statement ${id}`,
  precondition: null, action_type: 'lab', consider_instead: null, rationale: null, keywords: [],
  citation_doi: null, citation_pmid: null, citation_url: null, source_release_year: 2024,
} as unknown as LvcRecommendation);
const j = (id: string, verdict: Verdict, confidence: number): JudgedRec =>
  ({ rec: rec(id), verdict, confidence, why: '', consider_instead: null });

test('identical runs: full agreement, no flips, zero confidence drift', () => {
  const run = [j('r1', 'applies', 0.8), j('r2', 'does_not_apply', 0.9)];
  const c = compareJudgedRuns('uid-1', run, run.map((x) => ({ ...x })));
  assert.equal(c.nRecs, 2);
  assert.equal(c.identicalVerdictSet, true);
  assert.equal(c.nAgree, 2);
  assert.equal(c.nFlips, 0);
  assert.deepEqual(c.flipMatrix, {});
  assert.equal(c.meanAbsConfidenceDelta, 0);
  assert.deepEqual(c.unmatched, []);
});

test('pairing is by rec id, never by position — reordering is not a flip', () => {
  const a = [j('r1', 'applies', 0.8), j('r2', 'insufficient_info', 0.2)];
  const b = [j('r2', 'insufficient_info', 0.2), j('r1', 'applies', 0.8)];
  const c = compareJudgedRuns('uid-1', a, b);
  assert.equal(c.identicalVerdictSet, true);
  assert.equal(c.nFlips, 0);
});

test('a flip is recorded in the matrix with its direction, and the delta is signed', () => {
  const a = [j('r1', 'applies', 0.8), j('r2', 'applies', 0.6)];
  const b = [j('r1', 'does_not_apply', 0.5), j('r2', 'applies', 0.9)];
  const c = compareJudgedRuns('uid-1', a, b);
  assert.equal(c.identicalVerdictSet, false);
  assert.equal(c.nFlips, 1);
  assert.equal(c.nAgree, 1);
  assert.deepEqual(c.flipMatrix, { 'applies→does_not_apply': 1 });
  const r1 = c.perRec.find((r) => r.recId === 'r1');
  assert.equal(r1?.confidenceDelta, -0.3);       // signed B − A
  const r2 = c.perRec.find((r) => r.recId === 'r2');
  assert.equal(r2?.confidenceDelta, 0.3);
  assert.equal(c.meanAbsConfidenceDelta, 0.3);   // (0.3 + 0.3) / 2
});

test('a rec present in only one run is unmatched, never silently dropped or counted as a flip', () => {
  const a = [j('r1', 'applies', 0.8), j('r2', 'applies', 0.7)];
  const b = [j('r1', 'applies', 0.8), j('r3', 'applies', 0.7)];
  const c = compareJudgedRuns('uid-1', a, b);
  assert.equal(c.nRecs, 1);
  assert.deepEqual(c.unmatched, ['r2', 'r3']);
  assert.equal(c.identicalVerdictSet, true);     // the one comparable rec agreed
  assert.equal(c.nFlips, 0);
});

test('an empty comparable set is NOT agreement — it is nothing measured', () => {
  const c = compareJudgedRuns('uid-1', [], []);
  assert.equal(c.nRecs, 0);
  assert.equal(c.identicalVerdictSet, false);
  const s = summarizeAa([c]);
  assert.equal(s.nCases, 1);
  assert.equal(s.nEmptyCases, 1);
  assert.equal(s.identicalVerdictSetPct, 0);     // no denominator to flatter
  assert.equal(s.flipPct, 0);
});

test('summary: percentages are over what actually compared, and the matrix sums across cases', () => {
  const stable = compareJudgedRuns('u1', [j('r1', 'applies', 0.8)], [j('r1', 'applies', 0.8)]);
  const flipped = compareJudgedRuns('u2',
    [j('r1', 'applies', 0.8), j('r2', 'insufficient_info', 0.1)],
    [j('r1', 'insufficient_info', 0.4), j('r2', 'insufficient_info', 0.1)]);
  const empty = compareJudgedRuns('u3', [], []);
  const s = summarizeAa([stable, flipped, empty]);
  assert.equal(s.nCases, 3);
  assert.equal(s.nEmptyCases, 1);
  assert.equal(s.nRecs, 3);                                   // 1 + 2, the empty case contributes none
  assert.equal(s.identicalVerdictSetPct, 50);                 // 1 of the 2 that compared
  assert.equal(s.flipPct, round((1 / 3) * 100));              // 1 flip in 3 comparable recs
  assert.deepEqual(s.flipMatrix, { 'applies→insufficient_info': 1 });
  assert.equal(s.meanAbsConfidenceDelta, round(0.4 / 3));     // |0| + |0.8−0.4| + |0|, over 3 recs
});

test('degenerate input never throws: nulls, missing recs, duplicate ids, non-numeric confidence', () => {
  assert.doesNotThrow(() => compareJudgedRuns('u', null as unknown as JudgedRec[], undefined as unknown as JudgedRec[]));
  const c = compareJudgedRuns('u',
    [j('r1', 'applies', 0.5), j('r1', 'does_not_apply', 0.1), { rec: undefined, verdict: 'applies', confidence: 1 } as unknown as JudgedRec],
    [{ ...j('r1', 'applies', NaN) }]);
  assert.equal(c.nRecs, 1);                    // first occurrence of r1 wins; the rec-less entry is skipped
  assert.equal(c.perRec[0].confidenceB, 0);    // NaN degrades to 0 rather than poisoning the mean
  assert.equal(c.perRec[0].agree, true);
  assert.deepEqual(summarizeAa([]), {
    nCases: 0, nRecs: 0, identicalVerdictSetPct: 0, flipPct: 0, meanAbsConfidenceDelta: 0,
    flipMatrix: {}, nEmptyCases: 0, nUnmatchedRecs: 0,
  });
});

test('the verdict vocabulary is the judge\'s own three', () => {
  assert.deepEqual(AA_VERDICTS, ['applies', 'does_not_apply', 'insufficient_info']);
});

function round(n: number): number { return Math.round(n * 10000) / 10000; }
