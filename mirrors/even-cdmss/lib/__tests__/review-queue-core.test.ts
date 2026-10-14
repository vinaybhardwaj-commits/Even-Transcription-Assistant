/**
 * Pure-core tests for lib/review-queue-core.ts (Gold-Label Review-Mode §2).
 * Run: node --test --import tsx lib/__tests__/review-queue-core.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashBucket, isOverlap, partitionIndex, assignedToReviewer,
  balanceBySignalType, buildReviewQueue, itemKey,
  type QueueFinding, type QueueItem,
} from '../review-queue-core.ts';

const REFS = Array.from({ length: 400 }, (_, i) => `ref${i.toString(16)}beef`);

function mkFinding(over: Partial<QueueFinding> & { finding_ref: string }): QueueFinding {
  return {
    audit_id: over.audit_id ?? 'aud-' + over.finding_ref,
    finding_ref: over.finding_ref,
    signal_type: over.signal_type ?? 'drug_interaction',
    domain: over.domain ?? 'prescribing_safety',
    subject: over.subject ?? 'Interaction: X + Y',
    rationale: over.rationale ?? '',
    verdict: over.verdict ?? 'low-value',
    note_date: over.note_date ?? '2026-07-01',
    doctor_uid: over.doctor_uid ?? 'doc1',
    informational: over.informational,
  };
}

// ── assignment determinism ─────────────────────────────────────────────────────
test('hashBucket is deterministic and in 0..99', () => {
  for (const r of REFS) {
    const b = hashBucket(r);
    assert.ok(b >= 0 && b < 100 && Number.isInteger(b));
    assert.equal(hashBucket(r), b); // stable across calls
  }
});

test('overlap is ~20% and buckets < 20', () => {
  for (const r of REFS) assert.equal(isOverlap(r), hashBucket(r) < 20);
  const overlap = REFS.filter(isOverlap).length / REFS.length;
  assert.ok(overlap > 0.1 && overlap < 0.3, `overlap share ${overlap}`);
});

test('overlap findings are served to EVERY reviewer; partitioned to exactly one', () => {
  const roster = ['V', 'Zaki'];
  for (const r of REFS) {
    if (isOverlap(r)) {
      assert.ok(assignedToReviewer(r, 'V', roster) && assignedToReviewer(r, 'Zaki', roster));
    } else {
      const owners = roster.filter((rev) => assignedToReviewer(r, rev, roster));
      assert.equal(owners.length, 1, `partitioned ${r} owned by exactly one, got ${owners.length}`);
      assert.equal(owners[0], roster[partitionIndex(r, roster.length)]);
    }
  }
});

test('a reviewer not on the roster still gets the overlap set (only)', () => {
  const roster = ['V', 'Zaki'];
  for (const r of REFS) {
    assert.equal(assignedToReviewer(r, 'Ghost', roster), isOverlap(r));
  }
});

test('partition is roughly even across the roster', () => {
  const roster = ['V', 'Zaki', 'Sam'];
  const counts = [0, 0, 0];
  for (const r of REFS) { const i = partitionIndex(r, roster.length); if (i >= 0) counts[i]++; }
  const total = counts.reduce((a, b) => a + b, 0);
  for (const c of counts) assert.ok(Math.abs(c / total - 1 / 3) < 0.12, `share ${c / total}`);
});

// ── balancing ──────────────────────────────────────────────────────────────────
test('balanceBySignalType interleaves types and is newest-first within a type', () => {
  const items: QueueFinding[] = [
    mkFinding({ finding_ref: 'a1', signal_type: 'A', note_date: '2026-07-01' }),
    mkFinding({ finding_ref: 'a2', signal_type: 'A', note_date: '2026-07-03' }),
    mkFinding({ finding_ref: 'a3', signal_type: 'A', note_date: '2026-07-02' }),
    mkFinding({ finding_ref: 'b1', signal_type: 'B', note_date: '2026-07-05' }),
  ];
  const out = balanceBySignalType(items);
  // no type appears twice before the other type appears once (head is interleaved)
  assert.notEqual(out[0].signal_type, out[1].signal_type);
  // within type A, newest first
  const a = out.filter((x) => x.signal_type === 'A').map((x) => x.note_date);
  assert.deepEqual(a, ['2026-07-03', '2026-07-02', '2026-07-01']);
});

// ── priority merge + exclusions ─────────────────────────────────────────────────
test('disagreement items come first, then fresh; limit respected', () => {
  const roster = ['V'];
  const fresh = REFS.slice(0, 40).filter((r) => assignedToReviewer(r, 'V', roster)).map((r) => mkFinding({ finding_ref: r }));
  const dref = REFS.find((r) => assignedToReviewer(r, 'V', roster))!;
  const dis: QueueItem[] = [{ ...mkFinding({ finding_ref: dref }), queue: 'disagreement', disagreement_type: 'teacher_only', disagreement_reason: 'student model missed this' }];
  const q = buildReviewQueue({ reviewer: 'V', roster, fresh, disagreements: dis, limit: 5 });
  assert.ok(q.length <= 5);
  assert.equal(q[0].queue, 'disagreement');
  // the disagreement finding is not duplicated by the fresh pass
  assert.equal(q.filter((x) => x.finding_ref === dref).length, 1);
});

test('passthrough: optional uid + prescription_url survive buildReviewQueue onto emitted items', () => {
  const roster = ['V']; // single-member roster owns every bucket, so any ref is assigned to V
  const f = mkFinding({ finding_ref: 'pdfref1' });
  f.uid = 'note-uid-123';
  f.prescription_url = 'https://storage.googleapis.com/even-prod-prescription/note-uid-123_1.pdf';
  const [out] = buildReviewQueue({ reviewer: 'V', roster, fresh: [f], limit: 10 });
  assert.equal(out.uid, 'note-uid-123');
  assert.equal(out.prescription_url, 'https://storage.googleapis.com/even-prod-prescription/note-uid-123_1.pdf');
  // and absent optional fields stay undefined (existing constructors unaffected)
  const plain = buildReviewQueue({ reviewer: 'V', roster, fresh: [mkFinding({ finding_ref: 'plain1' })], limit: 10 })[0];
  assert.equal(plain.uid, undefined);
  assert.equal(plain.prescription_url, undefined);
});

test('excludes labeled-by-this-reviewer, informational, unassigned, and filtered-out findings', () => {
  const roster = ['V', 'Zaki'];
  const mine = REFS.filter((r) => assignedToReviewer(r, 'V', roster)).slice(0, 10).map((r) => mkFinding({ finding_ref: r }));
  const theirs = REFS.filter((r) => !assignedToReviewer(r, 'V', roster)).slice(0, 5).map((r) => mkFinding({ finding_ref: r }));
  const info = mkFinding({ finding_ref: mine[0].finding_ref + 'info', signal_type: 'X', informational: true });
  const labeledKey = itemKey(mine[1]);
  const q = buildReviewQueue({
    reviewer: 'V', roster,
    fresh: [...mine, ...theirs, info],
    labeledKeys: [labeledKey],
    limit: 100,
  });
  const keys = new Set(q.map(itemKey));
  assert.ok(!keys.has(labeledKey), 'labeled excluded');
  assert.ok(!q.some((x) => x.informational), 'informational excluded');
  assert.ok(!q.some((x) => itemKey(x) === itemKey(theirs[0])), 'unassigned excluded');
  // domain filter
  const filtered = buildReviewQueue({ reviewer: 'V', roster, fresh: mine, limit: 100, filters: { domain: 'appropriateness' } });
  assert.equal(filtered.length, 0, 'all mine are prescribing_safety → domain filter removes them');
});
