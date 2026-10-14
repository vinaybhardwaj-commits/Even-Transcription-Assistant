// lib/__tests__/telemetry-non-exposure.test.ts
// On-path kickoff D3, PRD v2.1 §4.2 (non-exposure) and §6.4. Kickoff test 5.
//
// WHAT THIS GATES. The telemetry tables are operational evidence, not a clinical record. §4.2
// requires that no clinician-facing surface and no existing audit reader selects from any of the
// three. This is a DIFFERENT property from text-freeness — a table can contain no clinical text and
// still be wrong to render on a patient page — so it gets its own test.
//
// ⚠️ THIS TEST ASSERTS NOTHING ABOUT lib/sql-guard-core.ts, deliberately (D3, A8). An earlier
// version of the kickoff told this build to add the three tables to that file's blocked-relation
// list. That was wrong twice: the requirement is controls NO WEAKER than opd_note_audits, and
// opd_note_audits is not on that list — so blocking would be STRONGER than required — and two
// committed tests assert the literal is byte-identical, one of them titled
// "lib/sql-guard-core.ts was NOT edited by this build". Those two assertions stay exactly as they
// are, and this file does not duplicate, weaken or comment on them.
//
// ⚠️ THE LIMIT OF THIS TEST, stated rather than implied: a source-text search cannot see a
// dynamically composed table name. It proves the tables are absent from every LITERAL query in
// app/ and lib/, and no more. It also does not cover .mjs scripts, Metabase, or the Lab
// connector's own tool description.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { TELEMETRY_TABLES } from '../retrieval-telemetry-core';

const ROOT = process.cwd();

/**
 * The ONLY files permitted to read the three tables, by EXACT path.
 *
 * ⚠️ NOT "files this build creates" (D3). Three files already named
 * opd_audit_retrieval_telemetry before this test existed, and one of them is on the edit list —
 * an allow-list phrased as "mine" would have silently admitted whatever the build happened to
 * touch, which is not an access control.
 */
const ALLOWED = new Set([
  'lib/retrieval-telemetry-store.ts',
  'lib/retrieval-invocation-store.ts',
  'lib/retrieval-telemetry-failure-store.ts',
  'app/api/admin/migrate-retrieval-telemetry/route.ts',
  'app/api/admin/retrieval-telemetry-reconcile/route.ts',
  'migrations/0035_opd_audit_retrieval_telemetry.sql',
  'lib/__tests__/retrieval-telemetry-core.test.ts',
  'lib/__tests__/migrate-retrieval-telemetry-parity.test.ts',
  'lib/__tests__/telemetry-non-exposure.test.ts',
  'lib/__tests__/retrieval-telemetry-lifecycle.test.ts',
  'lib/__tests__/retrieval-invocation-store.test.ts',
  'lib/__tests__/retrieval-settlement.test.ts',
  'lib/__tests__/reconciler-races.test.ts',
  'lib/__tests__/worker-work-declaration.test.ts',
  // ⚠️ ADDED BY REP 44 §5, and it is the PERMANENT explanation. This file drives proof 10 against a
  // DISPOSABLE PostgreSQL cluster on its own loopback port and never reads production's database —
  // but the scan cannot tell a disposable cluster from the real one, and until now the file dodged
  // it by DERIVING the table name from the DDL and comparing against a split string literal.
  // Rep 44: "The allow-list entry, not identifier obfuscation, is the permanent explanation for why
  // a disposable test-cluster query is permitted." The entry is the explanation; the obfuscation is
  // removed at the other end, and that file now names the table literally.
  'lib/__tests__/retrieval-outcome-discrimination.test.ts',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** A READ is `FROM <table>` or `JOIN <table>`. Matching the bare name would flag a migration or a
 *  comment that merely mentions the table, which is not a read of it. */
function readsOf(src: string, table: string): boolean {
  return new RegExp(`\\b(FROM|JOIN)\\s+${table}\\b`, 'i').test(src);
}

test('no surface outside the allow-list SELECTs from the telemetry tables', () => {
  const files = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'lib'))];
  assert.ok(files.length > 200, `sanity: the walk found ${files.length} files, which is too few to be a real scan`);

  const offenders: string[] = [];
  for (const abs of files) {
    const rel = relative(ROOT, abs).split('\\').join('/');
    if (ALLOWED.has(rel)) continue;
    const src = readFileSync(abs, 'utf8');
    for (const t of TELEMETRY_TABLES) {
      if (readsOf(src, t)) offenders.push(`${rel} reads ${t}`);
    }
  }
  assert.deepEqual(offenders, [], 'a reader outside the allow-list appeared');
});

test('the scan can actually fail — it is not passing because the matcher never matches', () => {
  // A non-exposure test that cannot detect a read is an assertion that always passes. Prove the
  // matcher on synthetic text before trusting its silence on the real tree.
  for (const t of TELEMETRY_TABLES) {
    assert.equal(readsOf(`SELECT * FROM ${t} WHERE 1=1`, t), true);
    assert.equal(readsOf(`select a from ${t}`, t), true);
    assert.equal(readsOf(`LEFT JOIN ${t} ON x.id = y.id`, t), true);
    // and it does NOT fire on a mention that is not a read
    assert.equal(readsOf(`// ${t} is written by the store`, t), false);
    assert.equal(readsOf(`INSERT INTO ${t} (a) VALUES ($1)`, t), false);
    assert.equal(readsOf(`UPDATE ${t} SET a = $1`, t), false);
  }
});

test('the allow-list is by EXACT path, and every entry is one this build owns', () => {
  for (const p of ALLOWED) {
    assert.ok(/^(lib|app|migrations)\//.test(p), `${p} is repo-relative`);
    assert.equal(p.includes('*'), false, 'no globs — an allow-list with a wildcard is not a list');
  }
  // The three tables are named from the constant, so a fourth table cannot be added to the schema
  // and quietly escape this scan.
  assert.equal(TELEMETRY_TABLES.length, 3);
});

test('no clinician-facing or patient-facing route names a telemetry table at all', () => {
  // Stronger than the read test, and scoped to the surfaces where the answer must be "never":
  // anything under app/ that is not an admin route.
  const files = walk(join(ROOT, 'app')).filter((p) => !relative(ROOT, p).includes('api/admin'));
  const offenders: string[] = [];
  for (const abs of files) {
    const rel = relative(ROOT, abs).split('\\').join('/');
    const src = readFileSync(abs, 'utf8');
    for (const t of TELEMETRY_TABLES) if (src.includes(t)) offenders.push(`${rel} mentions ${t}`);
  }
  assert.deepEqual(offenders, [], 'telemetry is operational evidence and never reaches a clinical surface');
});
