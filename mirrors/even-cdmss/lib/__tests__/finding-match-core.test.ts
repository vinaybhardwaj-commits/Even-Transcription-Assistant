/**
 * Pure-core tests for lib/finding-match-core.ts (Gold-Label Review-Mode §4).
 * Run: node --test --import tsx lib/__tests__/finding-match-core.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  subjectTokens, jaccard, matchFindings, disagreementsOf, JACCARD_THRESHOLD,
  type MatchFinding,
} from '../finding-match-core.ts';

const f = (o: Partial<MatchFinding>): MatchFinding => ({ ...o });

test('jaccard basics + empty-set guard', () => {
  assert.equal(jaccard(subjectTokens('alpha beta'), subjectTokens('alpha')), 0.5); // {a,b} vs {a}
  assert.equal(jaccard(new Set(), new Set()), 0);
  assert.equal(jaccard(subjectTokens('a b c'), subjectTokens('a')), 1 / 3);
});

test('exact finding_ref match when both stamped — regardless of subject', () => {
  const t = [f({ finding_ref: 'ref1', signal_type: 'drug_interaction', subject: 'Interaction: A+B', verdict: 'low-value' })];
  const s = [f({ finding_ref: 'ref1', signal_type: 'other', subject: 'totally different words', verdict: 'low-value' })];
  const r = matchFindings(t, s);
  assert.equal(r.pairs.length, 1);
  assert.equal(r.pairs[0].match_kind, 'ref');
  assert.equal(r.pairs[0].jaccard, 1);
  assert.equal(r.pairs[0].tier_agreement, true);
  assert.equal(r.teacherOnly.length, 0);
  assert.equal(r.studentOnly.length, 0);
});

test('fuzzy match needs signal_type equality AND Jaccard ≥ threshold', () => {
  assert.equal(JACCARD_THRESHOLD, 0.5);
  // same signal_type, Jaccard exactly 0.5 → match
  const r1 = matchFindings(
    [f({ signal_type: 'sig', subject: 'alpha beta', domain: 'd', verdict: 'low-value' })],
    [f({ signal_type: 'sig', subject: 'alpha', domain: 'd', verdict: 'high-value' })],
  );
  assert.equal(r1.pairs.length, 1);
  assert.equal(r1.pairs[0].match_kind, 'fuzzy');
  assert.equal(r1.pairs[0].tier_agreement, false); // low-value vs high-value
  // Jaccard below threshold → no pair (both become "only")
  const r2 = matchFindings(
    [f({ signal_type: 'sig', subject: 'alpha beta gamma' })],
    [f({ signal_type: 'sig', subject: 'alpha' })],
  );
  assert.equal(r2.pairs.length, 0);
  assert.equal(r2.teacherOnly.length, 1);
  assert.equal(r2.studentOnly.length, 1);
  // different signal_type but identical subject → no fuzzy match
  const r3 = matchFindings(
    [f({ signal_type: 'a', subject: 'same words here' })],
    [f({ signal_type: 'b', subject: 'same words here' })],
  );
  assert.equal(r3.pairs.length, 0);
});

test('tie-break prefers the domain-equal student at equal Jaccard', () => {
  const t = [f({ signal_type: 'sig', subject: 'alpha beta', domain: 'prescribing_safety' })];
  const s = [
    f({ signal_type: 'sig', subject: 'alpha beta', domain: 'appropriateness' }),   // jac 1, domain differs
    f({ signal_type: 'sig', subject: 'alpha beta', domain: 'prescribing_safety' }), // jac 1, domain equal
  ];
  const r = matchFindings(t, s);
  assert.equal(r.pairs.length, 1);
  assert.equal(r.pairs[0].student.domain, 'prescribing_safety');
});

test('disagreementsOf classifies tier-differs / teacher-only / student-only with reasons', () => {
  const t = [
    f({ finding_ref: 'p', signal_type: 's', subject: 'shared subject', verdict: 'low-value' }),   // paired, tier differs
    f({ finding_ref: 'to', signal_type: 's2', subject: 'unique teacher thing' }),                 // teacher-only
  ];
  const s = [
    f({ finding_ref: 'p', signal_type: 's', subject: 'shared subject', verdict: 'high-value' }),
    f({ finding_ref: 'so', signal_type: 's3', subject: 'unique student thing' }),                 // student-only
  ];
  const dis = disagreementsOf(matchFindings(t, s));
  const types = dis.map((d) => d.type).sort();
  assert.deepEqual(types, ['student_only', 'teacher_only', 'tier_differs']);
  const tierD = dis.find((d) => d.type === 'tier_differs')!;
  assert.equal(tierD.reason, 'tier differs');
  assert.equal(dis.find((d) => d.type === 'teacher_only')!.reason, 'student model missed this');
});

test('agreeing matched pairs are NOT disagreements', () => {
  const t = [f({ finding_ref: 'x', verdict: 'low-value' })];
  const s = [f({ finding_ref: 'x', verdict: 'low-value' })];
  assert.equal(disagreementsOf(matchFindings(t, s)).length, 0);
});
