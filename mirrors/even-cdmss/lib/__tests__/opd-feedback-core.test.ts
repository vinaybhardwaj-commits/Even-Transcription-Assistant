/**
 * Pure-core tests for lib/opd-feedback-core.ts.
 * Run: node --experimental-strip-types --test lib/__tests__/opd-feedback-core.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFeedbackBody, FEEDBACK_VERDICTS, FINDING_VERDICTS, AUDIT_VERDICTS, SCOPES,
  IMPACT_TAGS, MISSED_CATEGORIES,
} from '../opd-feedback-core.ts';

const AUDIT_ID = '00000000-0000-0000-0000-000000000001';

function ok(body: unknown) {
  const r = parseFeedbackBody(body);
  assert.equal(r.ok, true, 'expected ok, got: ' + (r.ok ? '' : r.error));
  if (!r.ok) throw new Error('unreachable');
  return r.value;
}
function err(body: unknown): string {
  const r = parseFeedbackBody(body);
  assert.equal(r.ok, false, 'expected error');
  if (r.ok) throw new Error('unreachable');
  return r.error;
}

test('verdict sets are wired by scope', () => {
  assert.deepEqual([...FEEDBACK_VERDICTS.finding].sort(), [...FINDING_VERDICTS].sort());
  assert.deepEqual([...FEEDBACK_VERDICTS.audit].sort(), [...AUDIT_VERDICTS].sort());
  assert.deepEqual([...FEEDBACK_VERDICTS.missed], ['missed']);
  assert.deepEqual([...FEEDBACK_VERDICTS.impact].sort(), [...IMPACT_TAGS].sort());
  assert.deepEqual([...SCOPES], ['audit', 'finding', 'missed', 'impact']);
});

test('impact scope: TP-only second tap — valid tag + finding_ref required, category always null', () => {
  for (const tag of IMPACT_TAGS) {
    const v = ok({ auditId: AUDIT_ID, scope: 'impact', verdict: tag, finding_ref: 'deadbeef0001', signal_type: 'drug_interaction' });
    assert.equal(v.scope, 'impact');
    assert.equal(v.verdict, tag);
    assert.equal(v.finding_ref, 'deadbeef0001');
    assert.equal(v.category, null);
  }
  assert.match(err({ auditId: AUDIT_ID, scope: 'impact', verdict: 'true_positive', finding_ref: 'x' }), /impact tag/);
  assert.match(err({ auditId: AUDIT_ID, scope: 'impact', verdict: 'changes_management' }), /finding_ref/);
});

test('missed scope: category is REQUIRED (F6/A10.1) and whitelisted; unknown category rejected', () => {
  // F6 (addendum A10.1) — category was OPTIONAL and this test asserted `no category → null`.
  // Rewritten, not deleted: omitting it is now a 400, because an optional classifier gave recall no
  // denominator to group by. The whitelist itself is unchanged and is still reused verbatim.
  assert.match(err({ auditId: AUDIT_ID, scope: 'missed', comment: 'BP never rechecked' }), /category required/);
  for (const cat of MISSED_CATEGORIES) {
    const v = ok({ auditId: AUDIT_ID, scope: 'missed', comment: 'x', category: cat });
    assert.equal(v.category, cat);
    assert.equal(v.verdict, 'missed');
  }
  assert.match(err({ auditId: AUDIT_ID, scope: 'missed', comment: 'x', category: 'nonsense' }), /category must be one of/);
});

test('non-missed/impact scopes carry category=null', () => {
  assert.equal(ok({ auditId: AUDIT_ID, comment: 'general' }).category, null);
  assert.equal(ok({ auditId: AUDIT_ID, scope: 'finding', verdict: 'true_positive', finding_ref: 'r1' }).category, null);
});

test('bad auditId is rejected before anything else', () => {
  assert.match(err({ auditId: 'nope', scope: 'finding', verdict: 'false', finding_ref: 'abc' }), /auditId/);
  assert.match(err({}), /auditId/);
});

test('unknown scope is rejected', () => {
  assert.match(err({ auditId: AUDIT_ID, scope: 'sideways', comment: 'hi' }), /scope/);
});

test('legacy audit scope: bare comment allowed, defaults to audit, verdict optional', () => {
  const v = ok({ auditId: AUDIT_ID, comment: 'general note' });
  assert.equal(v.scope, 'audit');
  assert.equal(v.verdict, null);
  assert.equal(v.comment, 'general note');
  assert.equal(v.finding_ref, null);
  assert.equal(v.signal_type, null);
});

test('audit scope: valid verdict kept, invalid verdict dropped to null', () => {
  assert.equal(ok({ auditId: AUDIT_ID, scope: 'audit', verdict: 'agree' }).verdict, 'agree');
  // invalid verdict + no comment => rejected (nothing to store)
  assert.match(err({ auditId: AUDIT_ID, scope: 'audit', verdict: 'true_positive' }), /verdict or a comment/);
  // invalid verdict but has comment => verdict nulled, comment kept
  const v = ok({ auditId: AUDIT_ID, scope: 'audit', verdict: 'true_positive', comment: 'x' });
  assert.equal(v.verdict, null);
  assert.equal(v.comment, 'x');
});

test('audit scope: empty body (no verdict, no comment) rejected', () => {
  assert.match(err({ auditId: AUDIT_ID, scope: 'audit' }), /verdict or a comment/);
});

test('finding scope: requires a finding verdict', () => {
  assert.match(err({ auditId: AUDIT_ID, scope: 'finding', finding_ref: 'abc123', verdict: 'agree' }), /finding verdict/);
  assert.match(err({ auditId: AUDIT_ID, scope: 'finding', finding_ref: 'abc123' }), /finding verdict/);
});

test('finding scope: requires finding_ref', () => {
  assert.match(err({ auditId: AUDIT_ID, scope: 'finding', verdict: 'false' }), /finding_ref/);
  assert.match(err({ auditId: AUDIT_ID, scope: 'finding', verdict: 'false', finding_ref: '   ' }), /finding_ref/);
});

test('finding scope: all four verdicts accepted, carries ref + signal_type + optional comment', () => {
  for (const verdict of FINDING_VERDICTS) {
    const v = ok({ auditId: AUDIT_ID, scope: 'finding', verdict, finding_ref: 'deadbeef0001', signal_type: 'drug_interaction', comment: 'why' });
    assert.equal(v.scope, 'finding');
    assert.equal(v.verdict, verdict);
    assert.equal(v.finding_ref, 'deadbeef0001');
    assert.equal(v.signal_type, 'drug_interaction');
    assert.equal(v.comment, 'why');
  }
});

test('missed scope: verdict forced to missed, comment required', () => {
  assert.match(err({ auditId: AUDIT_ID, scope: 'missed' }), /comment required/);
  assert.match(err({ auditId: AUDIT_ID, scope: 'missed', comment: '   ' }), /comment required/);
  // F6: a category is now required alongside the comment.
  const v = ok({ auditId: AUDIT_ID, scope: 'missed', comment: 'BP never rechecked', verdict: 'whatever', category: 'note_quality' });
  assert.equal(v.scope, 'missed');
  assert.equal(v.verdict, 'missed');
  assert.equal(v.finding_ref, null);
  assert.equal(v.comment, 'BP never rechecked');
});

test('fields are trimmed, empties collapse to null, oversized values are capped', () => {
  const v = ok({ auditId: AUDIT_ID, scope: 'finding', verdict: 'nitpick', finding_ref: '  ref1  ', author: '  Zaki  ', uid: '  u1  ', signal_type: '' });
  assert.equal(v.finding_ref, 'ref1');
  assert.equal(v.author, 'Zaki');
  assert.equal(v.uid, 'u1');
  assert.equal(v.signal_type, null);
  const long = ok({ auditId: AUDIT_ID, comment: 'x'.repeat(5000) });
  assert.equal(long.comment!.length, 4000);
});
