/**
 * lib/__tests__/feedback-study-filter.test.ts — the §4.2 ENFORCEMENT test for the study filter,
 * plus the new per-author builder and the §8.5 byte-identical proofs.
 *
 *   node --test --import tsx lib/__tests__/feedback-study-filter.test.ts
 *
 * THE RULE: every read of opd_audit_feedback carries `study IS NOT DISTINCT FROM $n`
 * (parameterised, default NULL — NULL must match NULL), so a production read can never see a
 * study's rows and a study read can never see production's. Exactly THREE reads are allowlisted
 * (D12 — reviewer-activity counts where study labels ARE the work), each carrying a
 * `study-filter-exempt` justification comment at the read.
 *
 * The scan walks the tree (the sql-twin §6 lesson: a hand-listed file set cannot catch a posture
 * in a file nobody listed) and keys the allowlist on the justification marker rather than raw line
 * numbers, which drift with every edit above them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildRollupFindingSql, buildRollupMissedSql, buildRollupImpactSql, buildRollupAuditSql,
  buildRollupReviewerSql, buildRollupReviewerCurrentSql, buildRollupFiredSql, buildDetailSql,
  buildFindingAuthorCurrentSql, AUTHOR_CURRENT_STATE_ORDER, CURRENT_STATE_ORDER,
} from '../opd-feedback-rollup-core.ts';
import { parseFeedbackBody } from '../opd-feedback-core.ts';

// ── §4.2 — the enforcement scan ───────────────────────────────────────────────
const ALLOWLIST_FILES = [
  'app/api/care/review-queue/route.ts',
  'app/api/care/review-stats/route.ts',
  'app/care/page.tsx',
].sort();

test('§4.2 every read of opd_audit_feedback is study-filtered — three D12-allowlisted, commented', () => {
  const offenders: string[] = [];
  const exemptFiles = new Map<string, number>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.next' || e.name === '__tests__') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(ts|tsx)$/.test(e.name)) continue;
      const raw = readFileSync(p, 'utf8');
      // Reads/predicates count CODE lines only — doc comments legitimately quote the predicate
      // they document. The exempt marker lives IN a comment by design, so it counts from raw.
      const src = raw.split('\n')
        .filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); })
        .join('\n');
      const reads = (src.match(/FROM opd_audit_feedback/g) ?? []).length;
      if (!reads) continue;
      const preds = (src.match(/study IS NOT DISTINCT FROM/g) ?? []).length;
      const exempt = (raw.match(/study-filter-exempt/g) ?? []).length;
      if (exempt) exemptFiles.set(p, exempt);
      if (reads !== preds + exempt) {
        offenders.push(`${p}: ${reads} read(s), ${preds} predicate(s), ${exempt} exempt marker(s)`);
      }
    }
  };
  walk('lib'); walk('app');
  assert.deepEqual(offenders, [],
    `these files read opd_audit_feedback without the study predicate (or carry a stale marker): ${offenders.join(' · ')}`);
  // The allowlist is EXACTLY three reads, one per file, in exactly these files (D12).
  assert.deepEqual([...exemptFiles.keys()].sort(), ALLOWLIST_FILES, 'only the three D12 sites may be exempt');
  for (const [f, n] of exemptFiles) assert.equal(n, 1, `${f}: exactly one exempt read`);
});

test('§4.2 the write paths: main INSERT names study; assertion_contest and doctor-response never set it', () => {
  const route = readFileSync('app/api/opd-audit/feedback/route.ts', 'utf8');
  const inserts = route.match(/INSERT INTO opd_audit_feedback \(([^)]*)\)/g) ?? [];
  assert.equal(inserts.length, 2, 'the two known write paths');
  const main = inserts.find((i) => i.includes('finding_ref'));
  const contest = inserts.find((i) => i.includes('assertion_id'));
  assert.ok(main?.includes('study'), 'the parseFeedbackBody INSERT must name study');
  assert.ok(contest && !contest.includes('study'), 'assertion_contest NEVER sets study (§8.3)');
  const gov = readFileSync('app/api/governance/doctor-response/route.ts', 'utf8');
  assert.ok(!/\bstudy\b/.test(gov), 'governance/doctor-response never sets study (D16) — left alone entirely');
});

// ── the predicate shape (8.3): parameterised, never hardcoded IS NULL ─────────
test('8.3 the predicate is parameterised IS NOT DISTINCT FROM — never = or a hardcoded IS NULL', () => {
  for (const f of ['lib/opd-feedback-rollup-core.ts', 'lib/learning.ts', 'lib/adjudication-ledger/federate.ts',
    'lib/even-lvc.ts', 'app/api/care/review-queue/route.ts', 'app/api/lab/ml-label-trial/route.ts']) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!/study\s*=\s*\$/.test(src), `${f}: study must use IS NOT DISTINCT FROM, not =`);
    assert.ok(!/study IS NULL/.test(src), `${f}: NULL rides the parameter, never the SQL text`);
  }
});

// ── the new builder (8.3) ─────────────────────────────────────────────────────
test('buildFindingAuthorCurrentSql: DISTINCT ON (audit_id, finding_ref, author), order leads with the same three', () => {
  const q = buildFindingAuthorCurrentSql({ appSource: 'x' });
  assert.match(q.text, /SELECT DISTINCT ON \(f\.audit_id, f\.finding_ref, f\.author\)/);
  assert.ok(q.text.trimEnd().endsWith(AUTHOR_CURRENT_STATE_ORDER), 'ORDER BY is the shared author variant');
  assert.equal(AUTHOR_CURRENT_STATE_ORDER,
    'ORDER BY f.audit_id, f.finding_ref, f.author, f.created_at DESC, f.id DESC');
  // …and it is DERIVED from the single definition of current state, not restated beside it.
  assert.equal(AUTHOR_CURRENT_STATE_ORDER, CURRENT_STATE_ORDER.replace('f.finding_ref,', 'f.finding_ref, f.author,'));
  // study threads like every other builder: same text, only the param moves.
  const withStudy = buildFindingAuthorCurrentSql({ appSource: 'x', study: 's1' });
  assert.equal(q.text, withStudy.text);
  assert.deepEqual(q.params, ['x', null]);
  assert.deepEqual(withStudy.params, ['x', 's1']);
});

// ── §8.5 — byte-identical proofs ──────────────────────────────────────────────
test('§8.5 rollup finding builder: study absent ⇒ SAME SQL text, param NULL — NULL matches NULL', () => {
  const plain = buildRollupFindingSql({ appSource: 'x' });
  const withStudy = buildRollupFindingSql({ appSource: 'x', study: 'pilot-1' });
  assert.equal(plain.text, withStudy.text, 'the predicate is ALWAYS present; only the parameter moves');
  assert.deepEqual(plain.params, ['x', null]);
  assert.deepEqual(withStudy.params, ['x', 'pilot-1']);
  // every feedback-reading builder defaults its study param to null the same way
  for (const b of [buildRollupMissedSql, buildRollupImpactSql, buildRollupAuditSql,
    buildRollupReviewerSql, buildRollupReviewerCurrentSql]) {
    const q = b({ appSource: 'x' });
    assert.ok(q.params.includes(null), `${b.name}: default study param must be null`);
    assert.match(q.text, /study IS NOT DISTINCT FROM \$\d+/, `${b.name}: predicate present`);
  }
  // fired reads opd_note_audits, not feedback — it must NOT carry the predicate.
  assert.ok(!/study/.test(buildRollupFiredSql({ appSource: 'x' }).text), 'fired is an audit-side denominator');
  // detail: both branches carry it (finding branch twice — cur CTE + outer WHERE).
  const df = buildDetailSql({ appSource: 'x', scope: 'finding', limit: 10 });
  assert.equal((df.text.match(/study IS NOT DISTINCT FROM/g) ?? []).length, 2);
  const da = buildDetailSql({ appSource: 'x', scope: 'audit', limit: 10 });
  assert.equal((da.text.match(/study IS NOT DISTINCT FROM/g) ?? []).length, 1);
});

test('§8.5 parseFeedbackBody: study absent ⇒ behaviour identical, study null; D8 author rule enforced', () => {
  const AUDIT_ID = '12345678-1234-1234-1234-123456789abc';
  const base = { auditId: AUDIT_ID, scope: 'finding', verdict: 'true_positive', finding_ref: 'f1' };
  const r = parseFeedbackBody(base);
  assert.ok(r.ok);
  assert.equal(r.ok && r.value.study, null, 'absent ⇒ null — the write is byte-identical in behaviour');
  assert.deepEqual(r.ok && r.value, {
    auditId: AUDIT_ID, scope: 'finding', uid: null, verdict: 'true_positive', comment: null,
    author: null, finding_ref: 'f1', signal_type: null, category: null, study: null,
  }, 'everything else exactly as before');

  // trimmed, ≤64, empty → null
  const t = parseFeedbackBody({ ...base, study: '  pilot-1  ', author: 'Dr K' });
  assert.ok(t.ok && t.value.study === 'pilot-1' && t.value.author === 'Dr K');
  const long = parseFeedbackBody({ ...base, study: 'x'.repeat(80), author: 'a' });
  assert.ok(long.ok && (long.value.study as string).length === 64);
  const empty = parseFeedbackBody({ ...base, study: '   ' });
  assert.ok(empty.ok && empty.value.study === null, 'whitespace-only study ⇒ null, no author demanded');

  // D8: non-null study ⇒ non-null non-empty author, a 400-worthy error from the PARSER.
  for (const bad of [{ study: 's' }, { study: 's', author: '' }, { study: 's', author: '   ' }]) {
    const e = parseFeedbackBody({ ...base, ...bad });
    assert.ok(!e.ok && /author required when study is set/.test(e.ok === false ? e.error : ''),
      `study without author must 400: ${JSON.stringify(bad)}`);
  }
  // author stored exactly as typed (D9/D10) — trailing/leading trim only, no casefold.
  const cased = parseFeedbackBody({ ...base, study: 's', author: '  Dr KHATIJA  ' });
  assert.ok(cased.ok && cased.value.author === 'Dr KHATIJA', 'trim only; case preserved exactly');
});
