// LAB-MCP Phase 1 — F1 identity core + F2/F4 rollup budget/reconciliation.
// Pure-core only: no DB, no Next, no model calls. Runs under the strip-types runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeStableRef, normStableText, resolveLabel, normalizeClusterKey, sha1Hex, STABLE_REF_DELIM,
} from '../opd-finding-identity-core';
import { stampFindingIdentity, type OpdFinding } from '../opd-note-audit-core';
import { reduceRollup, reduceLedgerList, ROLLUP_CHAR_BUDGET, type FindingCountRow, type FiredRow, type ReviewerRow, type LedgerRow } from '../opd-feedback-rollup-core';

const mk = (over: Partial<OpdFinding> = {}): OpdFinding => ({
  subject: 'Interaction (major): Aceclofenac + Methotrexate', verdict: 'low-value', confidence: 0.8,
  domain: 'prescribing_safety', rationale: 'r', evidence: [], estimates: [], citation_ids: [],
  source: 'deterministic', ...over,
} as OpdFinding);

// ── SHA-1 + normalisation ─────────────────────────────────────────────────────
test('the zero-import SHA-1 matches the standard test vector (addendum A3)', () => {
  assert.equal(sha1Hex('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.equal(sha1Hex(''), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
  assert.equal(sha1Hex('abc').length, 40);
});

test('normStableText: NFKC, lowercase, whitespace collapse, trailing punctuation/quotes stripped', () => {
  assert.equal(normStableText('  Interaction  (MAJOR):   A + B.  '), 'interaction (major): a + b');
  assert.equal(normStableText('Duplicate prescription: X!!'), 'duplicate prescription: x');
  assert.equal(normStableText('trailing quote"'), 'trailing quote');
  assert.equal(normStableText('ﬁx the dose'), 'fix the dose');          // NFKC ligature
  assert.equal(normStableText('a\n\tb'), 'a b');
  assert.equal(normStableText(null), '');
  // deliberately NOT clever: no stemming / stopword / synonym collapsing
  assert.notEqual(normStableText('antibiotics'), normStableText('antibiotic'));
});

// ── computeStableRef (addendum A1 — uid is NOT in the hash) ───────────────────
test('stable_ref is deterministic and full 40-char lowercase hex', () => {
  const a = computeStableRef('drug_interaction', 'Interaction (major): A + B');
  const b = computeStableRef('drug_interaction', 'Interaction (major): A + B');
  assert.equal(a, b);
  assert.equal(a?.length, 40);
  assert.match(a as string, /^[0-9a-f]{40}$/);
});

test('A1: the SAME (signal_type, subject) on two DIFFERENT notes produces the SAME ref — by design', () => {
  // stable_ref is a finding-KIND token, unique within a note, NOT globally. Note scoping is
  // resolveLabel's job. This asserts the intended behaviour rather than guarding against it.
  const onNoteA = computeStableRef('drug_interaction', 'Interaction (major): A + B');
  const onNoteB = computeStableRef('drug_interaction', 'Interaction (major): A + B');
  assert.equal(onNoteA, onNoteB);
});

test('stable_ref survives an engine bump: same note re-audited under two engine versions ⇒ same ref', () => {
  // The whole point of F1. The engine version is nowhere in the key, so a 0.81.3 label resolves
  // against a 0.81.14 finding as long as signal_type + subject are unchanged.
  const v3 = stampFindingIdentity([mk()])[0];
  const v14 = stampFindingIdentity([mk()])[0];
  assert.ok(v3.stable_ref);
  assert.equal(v3.stable_ref, v14.stable_ref);
});

test('stable_ref differs when signal_type differs, even for an identical subject', () => {
  const a = computeStableRef('drug_interaction', 'same subject text');
  const b = computeStableRef('duplicate_prescription', 'same subject text');
  assert.notEqual(a, b);
});

test('THE ONE-FUNCTION INVARIANT: engine stamp and backfill produce byte-identical refs', () => {
  // The backfill computes from the STORED (signal_type, subject); the engine computes from the same
  // two fields at stamp time. Two implementations would diverge here.
  const stamped = stampFindingIdentity([mk({ subject: 'Daily dose exceeds ceiling: Paracetamol' })])[0];
  const backfilled = computeStableRef(stamped.signal_type as string, 'Daily dose exceeds ceiling: Paracetamol');
  assert.equal(stamped.stable_ref, backfilled);
});

test('null — never a hash of "" — on an empty subject or signal_type', () => {
  assert.equal(computeStableRef('drug_interaction', ''), null);
  assert.equal(computeStableRef('drug_interaction', '   '), null);
  assert.equal(computeStableRef('drug_interaction', '...'), null);   // normalises to empty
  assert.equal(computeStableRef('', 'a real subject'), null);
  assert.equal(computeStableRef(null, null), null);
  // and the sentinel is genuinely unreachable by a real call
  assert.notEqual(computeStableRef('x', 'y'), sha1Hex(''));
});

test('U+0001 delimiter: a subject containing "|" cannot collide across fields', () => {
  assert.equal(STABLE_REF_DELIM.charCodeAt(0), 1);
  // With "|" as the delimiter these two would both key "a|b|c" and collide.
  const x = computeStableRef('a|b', 'c');
  const y = computeStableRef('a', 'b|c');
  assert.notEqual(x, y);
});

// ── stampFindingIdentity is unchanged apart from the additive key ─────────────
test('stampFindingIdentity keeps its ORIGINAL signature and always stamps (addenda A1/A4)', () => {
  // No uid argument. Called exactly as all 9 existing call sites call it.
  const out = stampFindingIdentity([mk()]);
  assert.equal(out.length, 1);
  assert.ok(out[0].stable_ref, 'stable_ref must be stamped with no uid argument — an optional uid shipped F1 as a no-op');
  assert.equal(stampFindingIdentity.length, 1, 'stampFindingIdentity must take exactly one parameter');
});

test('finding_ref behaviour is untouched: same hash, same within-note #2 suffixing', () => {
  const two = stampFindingIdentity([
    mk({ subject: 'Incomplete dosing: Cefixime' }),
    mk({ subject: 'Incomplete dosing: Cefixime' }),
  ]);
  assert.equal(two[0].finding_ref?.length, 12);
  assert.equal(two[1].finding_ref, `${two[0].finding_ref}#2`);
  // …and both share a stable_ref, which is exactly the collision resolveLabel must refuse to guess.
  assert.equal(two[0].stable_ref, two[1].stable_ref);
});

// ── resolveLabel (uid REQUIRED) ───────────────────────────────────────────────
const findings = [
  { stable_ref: 'aaa', finding_ref: 'f1', subject: 'one' },
  { stable_ref: 'bbb', finding_ref: 'f2', subject: 'two' },
];

test('resolveLabel matches by stable_ref first', () => {
  const r = resolveLabel({ uid: 'note-1', stableRef: 'bbb', findingRef: 'f1', findings });
  assert.equal(r.matched_by, 'stable_ref');
  assert.equal(r.finding?.subject, 'two');      // stable_ref wins over the (stale) finding_ref
  assert.equal(r.ambiguous, false);
});

test('resolveLabel falls back to finding_ref when the stable_ref is absent or dead', () => {
  const r = resolveLabel({ uid: 'note-1', stableRef: null, findingRef: 'f2', findings });
  assert.equal(r.matched_by, 'finding_ref');
  assert.equal(r.finding?.subject, 'two');
  const dead = resolveLabel({ uid: 'note-1', stableRef: 'not-present', findingRef: 'f1', findings });
  assert.equal(dead.matched_by, 'finding_ref', 'a dead stable_ref must fall through, not fail');
  assert.equal(dead.finding?.subject, 'one');
});

test('collision ⇒ null + ambiguous:true; never a guess', () => {
  const dup = [
    { stable_ref: 'same', finding_ref: 'f1', subject: 'one' },
    { stable_ref: 'same', finding_ref: 'f2', subject: 'two' },
  ];
  const r = resolveLabel({ uid: 'note-1', stableRef: 'same', findings: dup });
  assert.equal(r.finding, null);
  assert.equal(r.ambiguous, true);
  assert.equal(r.matched_by, null);
});

test('A1: uid scoping picks the right finding when two notes share a stable_ref', () => {
  // The caller supplies the findings OF THAT uid; the ref is identical across notes by design, so
  // correctness comes from which note's findings are passed. Both resolve, each within its own note.
  const noteA = [{ stable_ref: 'shared', finding_ref: 'a1', subject: 'A-side finding' }];
  const noteB = [{ stable_ref: 'shared', finding_ref: 'b1', subject: 'B-side finding' }];
  assert.equal(resolveLabel({ uid: 'note-A', stableRef: 'shared', findings: noteA }).finding?.subject, 'A-side finding');
  assert.equal(resolveLabel({ uid: 'note-B', stableRef: 'shared', findings: noteB }).finding?.subject, 'B-side finding');
});

test('a blank uid resolves to nothing — never an unscoped lookup (A1)', () => {
  const r = resolveLabel({ uid: '', stableRef: 'aaa', findings });
  assert.equal(r.finding, null);
  assert.equal(r.matched_by, null);
  assert.equal(r.ambiguous, false);
});

// ── cluster_key normalisation (normative detail 5) ────────────────────────────
test('normalizeClusterKey strips "@version" and leaves a bare key unchanged', () => {
  assert.equal(normalizeClusterKey('lasa_pair@opd-note-audit/0.81.8'), 'lasa_pair');
  assert.equal(normalizeClusterKey('lasa_pair'), 'lasa_pair');
  assert.equal(normalizeClusterKey(''), '');
  assert.equal(normalizeClusterKey(null), '');
  assert.equal(normalizeClusterKey('@leading'), '@leading');   // no signal to keep ⇒ unchanged
});

// ── F2 budget + F4 reconciliation ─────────────────────────────────────────────
const fRow = (st: string, verdict: string, n: number, ev = 'opd-note-audit/0.81.14'): FindingCountRow =>
  ({ engine_version: ev, signal_type: st, verdict, n });
const firedRow = (st: string, fired: number, ev = 'opd-note-audit/0.81.14'): FiredRow =>
  ({ engine_version: ev, signal_type: st, fired });

test('F2 min_triaged excludes zero-triaged buckets while every total still reconciles', () => {
  const inputs = {
    findingRows: [fRow('a', 'true_positive', 5), fRow('a', 'false', 2), fRow('b', 'nitpick', 1)],
    firedRows: [firedRow('a', 50), firedRow('b', 10), firedRow('zero', 99)],
    missedRows: [], auditRows: [], reviewerRows: [], ledgerRows: [],
  };
  const full = reduceRollup(inputs, { mode: 'full', minTriaged: 0 });
  const filtered = reduceRollup(inputs, { mode: 'full', minTriaged: 1 });
  // the zero-triaged bucket leaves `buckets` …
  assert.equal(full.buckets.length, 3);
  assert.equal(filtered.buckets.length, 2);
  assert.ok(!filtered.buckets.some((b) => b.signal_type === 'zero'));
  // … but is still counted, and NO total moves
  assert.equal(filtered.totals.n_buckets_untriaged, 1);
  assert.equal(filtered.totals.fired_untriaged, 99);
  for (const k of ['tp', 'nitpick', 'false', 'contested', 'triaged', 'fired', 'buckets']) {
    assert.equal(filtered.totals[k], full.totals[k], `totals.${k} must not move`);
  }
  assert.equal(filtered.totals.tp, 5);
  assert.equal(filtered.totals.false, 2);
  assert.equal(filtered.totals.fired, 159);
});

test('F2 mode=summary respects the 20k budget and sets truncated + n_buckets_omitted', () => {
  // 400 buckets, each with enough triaged to survive min_triaged and the summary rule, so the only
  // thing that can trim them is the character ceiling.
  const findingRows: FindingCountRow[] = [];
  const firedRows: FiredRow[] = [];
  for (let i = 0; i < 400; i++) {
    findingRows.push(fRow(`signal_type_with_a_longish_name_${i}`, 'true_positive', 9));
    firedRows.push(firedRow(`signal_type_with_a_longish_name_${i}`, 20));
  }
  const r = reduceRollup({ findingRows, firedRows, missedRows: [], auditRows: [], reviewerRows: [], ledgerRows: [] }, { mode: 'summary' });
  assert.equal(JSON.stringify(r.buckets).length <= ROLLUP_CHAR_BUDGET, true, 'buckets must fit the budget');
  assert.equal(r.truncated, true);
  assert.ok(r.n_buckets_omitted > 0);
  assert.equal(r.mode, 'summary');
  // SEMANTICS UNCHANGED: totals still describe all 400 buckets.
  assert.equal(r.totals.buckets, 400);
  assert.equal(r.totals.tp, 3600);
  assert.equal(r.totals.triaged, 3600);
});

test('F2 summary keeps the top-20 by fired AND every bucket with triaged >= 5', () => {
  const findingRows: FindingCountRow[] = [];
  const firedRows: FiredRow[] = [];
  for (let i = 0; i < 30; i++) { firedRows.push(firedRow(`hi${i}`, 1000 - i)); findingRows.push(fRow(`hi${i}`, 'true_positive', 1)); }
  // a low-fired but well-reviewed bucket must survive summary mode
  firedRows.push(firedRow('reviewed', 1));
  findingRows.push(fRow('reviewed', 'true_positive', 7));
  const r = reduceRollup({ findingRows, firedRows, missedRows: [], auditRows: [], reviewerRows: [], ledgerRows: [] }, { mode: 'summary' });
  assert.ok(r.buckets.some((b) => b.signal_type === 'reviewed'), 'a triaged>=5 bucket must not be dropped by summary');
  assert.ok(r.buckets.length < 31);
});

test('F4 reviewers_current sums to totals.triaged; reviewers_all_rows keeps its own basis', () => {
  const inputs = {
    findingRows: [fRow('a', 'true_positive', 4), fRow('a', 'false', 2)],   // triaged = 6
    firedRows: [firedRow('a', 10)],
    missedRows: [], auditRows: [], ledgerRows: [],
    reviewerRows: [{ author: 'V', n: 40 }, { author: 'S', n: 11 }] as ReviewerRow[],   // all rows, all scopes
    reviewerCurrentRows: [{ author: 'V', n: 4 }, { author: 'S', n: 2 }] as ReviewerRow[],
  };
  const r = reduceRollup(inputs, {});
  assert.equal(r.totals.triaged, 6);
  assert.equal(r.reviewers_current.reduce((s, x) => s + x.n, 0), r.totals.triaged);
  assert.equal(r.reviewers_all_rows.reduce((s, x) => s + x.n, 0), 51);   // deliberately different
  assert.match(r.reviewers_basis, /ALL scopes/);
  assert.match(r.reviewers_basis, /superseded/);
});

test('F4 reviewers_current degrades to [] when its query fails, without breaking the rollup', () => {
  const r = reduceRollup({
    findingRows: [fRow('a', 'true_positive', 3)], firedRows: [firedRow('a', 5)],
    missedRows: [], auditRows: [], reviewerRows: [], ledgerRows: [],
  }, {});
  assert.deepEqual(r.reviewers_current, []);
  assert.equal(r.totals.tp, 3);
});

test('open_adjudications uses the BARE signal_type and honours a normalised historical ledger key', () => {
  const inputs = {
    findingRows: [fRow('lasa_pair', 'false', 2), fRow('lasa_pair', 'nitpick', 2)],   // 4 ≥ threshold 3
    firedRows: [firedRow('lasa_pair', 10)],
    missedRows: [], auditRows: [], reviewerRows: [],
    ledgerRows: [] as { cluster_key: string; decision: string }[],
  };
  const open = reduceRollup(inputs, {});
  assert.deepEqual(open.open_adjudications, ['lasa_pair'], 'cluster key must be the bare signal_type');

  // a historical '<signal>@<version>' decision must close it after read-time normalisation
  const closed = reduceRollup({ ...inputs, ledgerRows: [{ cluster_key: 'lasa_pair@opd-note-audit/0.81.8', decision: 'accept' }] }, {});
  assert.deepEqual(closed.open_adjudications, []);
  // …and a 'defer' must NOT close it
  const deferred = reduceRollup({ ...inputs, ledgerRows: [{ cluster_key: 'lasa_pair@opd-note-audit/0.81.8', decision: 'defer' }] }, {});
  assert.deepEqual(deferred.open_adjudications, ['lasa_pair']);
});

test('ledger folding is newest-first-wins when several versioned keys normalise onto one', () => {
  const inputs = {
    findingRows: [fRow('x', 'false', 3)], firedRows: [firedRow('x', 9)],
    missedRows: [], auditRows: [], reviewerRows: [],
    // rows arrive newest-first: the newest is 'defer', so the cluster stays OPEN despite an older accept
    ledgerRows: [
      { cluster_key: 'x@0.81.14', decision: 'defer' },
      { cluster_key: 'x@0.81.8', decision: 'accept' },
    ],
  };
  assert.deepEqual(reduceRollup(inputs, {}).open_adjudications, ['x']);
});

test('reduceLedgerList decides currency on the NORMALISED key (normative detail 5)', () => {
  // Append-only ledger: two historical rows for what is now ONE cluster. Newest-first.
  const rows: LedgerRow[] = [
    { id: 2, cluster_key: 'lasa_pair@opd-note-audit/0.81.14', decision: 'accept', rationale: 'r', prd_ref: null, author: 'V', created_at: '2026-07-26T10:00:00Z' },
    { id: 1, cluster_key: 'lasa_pair@opd-note-audit/0.81.8', decision: 'defer', rationale: 'r', prd_ref: null, author: 'V', created_at: '2026-07-10T10:00:00Z' },
    { id: 3, cluster_key: 'other_signal', decision: 'fix', rationale: 'r', prd_ref: null, author: 'V', created_at: '2026-07-20T10:00:00Z' },
  ];
  const out = reduceLedgerList(rows);
  assert.equal(out[0].is_current, true,  'the newest row of the folded cluster is current');
  assert.equal(out[1].is_current, false, 'the older versioned row of the SAME cluster must NOT also be current');
  assert.equal(out[2].is_current, true,  'an unrelated bare key is unaffected');
  // the stored key is returned verbatim (append-only), with the normalised form alongside
  assert.equal(out[1].cluster_key, 'lasa_pair@opd-note-audit/0.81.8');
  assert.equal(out[0].cluster_key_normalized, 'lasa_pair');
  assert.equal(out[1].cluster_key_normalized, 'lasa_pair');
  assert.equal(out[2].cluster_key_normalized, 'other_signal');
});
