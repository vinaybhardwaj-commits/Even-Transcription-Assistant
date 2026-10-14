/**
 *   node --test --import tsx lib/__tests__/audit-canonical-sql-twin.test.ts
 *
 * THE RULE has two expressions (addendum C): `canonicalByUid` in TypeScript, for surfaces that
 * fetch rows, and `canonicalDistinctOnSql` in SQL, for the four doctor aggregates that compute
 * server-side and never return rows. Two implementations do not stay in agreement on their own —
 * that is the stated reason lib/audit-canonical.ts has ONE TypeScript implementation — so this
 * feeds the SAME fixture to both and asserts they select the same row.
 *
 * Without this, the SQL fragment becomes the sixth dedup posture the moment either side is edited.
 *
 * The SQL side is evaluated by an in-test reimplementation of Postgres' ordering semantics —
 * `string_to_array(...)::int[] DESC, audited_at DESC` — driven by the REAL exported fragment, so a
 * change to the fragment's ordering is what the test detects. It runs with no database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalByUid, canonicalDistinctOnSql, CANONICAL_RANK_SQL, REFERENCE_MODELS, isReferenceModel,
} from '../audit-canonical.ts';

interface Row { uid: string | null; engine_version: string; audited_at: string; id: string; model?: string }

/** The four traps of §7 plus the model-tier trap of addendum H, in one fixture. */
const FIXTURE: Row[] = [
  // 1. lexicographic trap — '0.81.9' sorts above '0.81.17' as text, but 17 > 9 numerically.
  { uid: 'n1', engine_version: 'opd-note-audit/0.81.9', audited_at: '2026-07-29T10:00:00Z', id: 'zzz' },
  { uid: 'n1', engine_version: 'opd-note-audit/0.81.17', audited_at: '2026-07-20T10:00:00Z', id: 'aaa' },
  // 2. same engine version, different audited_at — the tiebreak.
  { uid: 'n2', engine_version: 'opd-note-audit/0.81.17', audited_at: '2026-07-20T10:00:00Z', id: 'bbb' },
  { uid: 'n2', engine_version: 'opd-note-audit/0.81.17', audited_at: '2026-07-30T10:00:00Z', id: 'aaa' },
  // 3. a -mini row, which the engine-family filter removes BEFORE ranking.
  { uid: 'n3', engine_version: 'opd-note-audit/0.81.14-mini', audited_at: '2026-07-31T10:00:00Z', id: 'ccc' },
  { uid: 'n3', engine_version: 'opd-note-audit/0.81.14', audited_at: '2026-07-10T10:00:00Z', id: 'ddd' },
  // 4. a null uid — canonicalByUid PASSES IT THROUGH rather than dropping it (silent data loss).
  { uid: null, engine_version: 'opd-note-audit/0.81.17', audited_at: '2026-07-28T10:00:00Z', id: 'eee' },
  // 5. THE ADDENDUM H HAZARD, as observed live 31 Jul: a candidate-model backfill row carrying the
  //    PLAIN production engine version, written AFTER the reference sweep. `-mini` never matches it;
  //    without the tier, audited_at hands the note to the candidate. Reference must win.
  { uid: 'n5', engine_version: 'opd-note-audit/0.81.17', audited_at: '2026-07-27T10:00:00Z', id: 'ref-old', model: 'gemini-2.5-pro' },
  { uid: 'n5', engine_version: 'opd-note-audit/0.81.17', audited_at: '2026-07-31T19:16:00Z', id: 'cand-new', model: 'qwen2.5:14b' },
  //    …and with the bridge-era model spelling too.
  { uid: 'n6', engine_version: 'opd-note-audit/0.81.17', audited_at: '2026-07-27T10:00:00Z', id: 'ref-bridge', model: 'google/gemini-2.5-pro' },
  { uid: 'n6', engine_version: 'opd-note-audit/0.81.17', audited_at: '2026-07-31T19:33:00Z', id: 'cand-new2', model: 'qwen2.5:14b' },
  // 6. ⚠️ REVERSED 2 Aug 2026 by GRADER-PROVENANCE D2. Addendum H made the model tier a TIEBREAK
  //    WITHIN a version, so a qwen row at a newer version beat a Gemini row at an older one — and
  //    that is exactly how the mini backfill's prod-labelled rows took the dashboard. V ruled the
  //    §6 open question: CLOUD OUTRANKS LOCAL REGARDLESS OF VERSION. The GRADER tier (first key)
  //    decides this now; the REFERENCE tier still tiebreaks cloud-vs-cloud after the version.
  { uid: 'n7', engine_version: 'opd-note-audit/0.81.14', audited_at: '2026-07-31T10:00:00Z', id: 'ref-oldver', model: 'gemini-2.5-pro' },
  { uid: 'n7', engine_version: 'opd-note-audit/0.81.17', audited_at: '2026-07-10T10:00:00Z', id: 'cand-newver', model: 'qwen2.5:14b' },
  // 7. a NON-NUMERIC TAIL THAT IS NOT `-mini` — `opd-note-audit/0.5-verify` exists in the live
  //    table (Mar 2024, qwen). A suffix guard (`NOT LIKE '%-mini'`) passes it through and the
  //    int[] cast RAISES; only a SHAPE test excludes it by construction (lib/learning.ts).
  { uid: 'n8', engine_version: 'opd-note-audit/0.5-verify', audited_at: '2026-07-31T10:00:00Z', id: 'fff', model: 'qwen2.5:14b' },
];

/** What the caller's engine-family filter does before ranking: `engine_version = ANY(family)`.
 *  No family entry carries a -mini suffix, which is what makes the int[] cast safe. */
const FAMILY = ['opd-note-audit/0.81.9', 'opd-note-audit/0.81.14', 'opd-note-audit/0.81.17'];
const familyFiltered = FIXTURE.filter((r) => FAMILY.includes(r.engine_version));

/**
 * Evaluate the exported SQL ordering the way Postgres would, driven by CANONICAL_RANK_SQL itself
 * so the assertion is against the REAL fragment rather than a copy of it.
 */
function sqlDistinctOn(rows: Row[]): Row[] {
  assert.match(CANONICAL_RANK_SQL, /^CASE WHEN model LIKE 'qwen%' OR engine_version LIKE '%-mini' THEN 1 ELSE 0 END, /,
    'D2: the grader tier is the FIRST key — cloud before local, ahead of the version');
  assert.match(CANONICAL_RANK_SQL, /string_to_array\(split_part\(engine_version, '\/', 2\), '\.'\)::int\[\] DESC/,
    'the fragment must rank by the component-wise numeric tail');
  assert.match(CANONICAL_RANK_SQL, /CASE WHEN model IN \(.+\) THEN 0 ELSE 1 END/,
    'version ties must rank the model tier — reference before candidate (addendum H)');
  for (const m of REFERENCE_MODELS) {
    assert.ok(CANONICAL_RANK_SQL.includes(`'${m}'`), `the tier CASE must derive from REFERENCE_MODELS (missing '${m}')`);
  }
  assert.match(CANONICAL_RANK_SQL, /audited_at DESC/, 'remaining ties must break on latest audited_at');

  // string_to_array(...)::int[] — and like Postgres, the cast RAISES on a non-numeric component
  // rather than silently mis-ranking (NaN would compare as "equal to everything").
  const tail = (v: string): number[] => v.split('/')[1].split('.').map((c) => {
    if (!/^\d+$/.test(c)) throw new Error(`invalid input syntax for type integer: "${c}"`);
    return Number(c);
  });
  const tier = (r: Row): number => (isReferenceModel(r.model) ? 0 : 1);           // the reference CASE
  const grader = (r: Row): number =>                                              // the grader CASE (D2, first key)
    (/^qwen/i.test(String(r.model ?? '')) || /-mini$/.test(r.engine_version) ? 1 : 0);
  const cmpIntArray = (a: number[], b: number[]): number => {                      // Postgres int[] compare
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] ?? 0) - (b[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  };
  const byUid = new Map<string, Row[]>();
  const nullUid: Row[] = [];
  for (const r of rows) {
    if (r.uid == null) { nullUid.push(r); continue; }
    if (!byUid.has(r.uid)) byUid.set(r.uid, []);
    byUid.get(r.uid)!.push(r);
  }
  // Postgres computes the ORDER BY key for EVERY row before sorting — a lazy comparator would
  // skip single-row groups and silently miss a cast that the real query raises on.
  const winners = [...byUid.values()].map((group) => {
    const keyed = group.map((r) => ({ r, vtail: tail(r.engine_version), t: tier(r) }));
    keyed.sort((a, b) =>
      grader(a.r) - grader(b.r)
      || cmpIntArray(b.vtail, a.vtail) || a.t - b.t || Date.parse(b.r.audited_at) - Date.parse(a.r.audited_at));
    return keyed[0].r;
  });
  for (const r of nullUid) tail(r.engine_version);
  return [...winners, ...nullUid];
}

test('SQL twin and canonicalByUid select the SAME row — all traps', () => {
  const ts = canonicalByUid(familyFiltered);
  const pg = sqlDistinctOn(familyFiltered);

  const key = (rows: Row[]) => rows.map((r) => `${r.uid ?? 'NULL'}:${r.id}`).sort();
  assert.deepEqual(key(ts as Row[]), key(pg), 'the two expressions of THE RULE must agree');

  const pick = (rows: Row[], uid: string) => rows.find((r) => r.uid === uid)!;
  // 1. numeric tail beats lexicographic: 0.81.17 wins over 0.81.9 despite the older audited_at.
  assert.equal(pick(ts as Row[], 'n1').engine_version, 'opd-note-audit/0.81.17');
  assert.equal(pick(pg, 'n1').engine_version, 'opd-note-audit/0.81.17');
  // 2. same version ⇒ latest audited_at wins (NOT id).
  assert.equal(pick(ts as Row[], 'n2').audited_at, '2026-07-30T10:00:00Z');
  assert.equal(pick(pg, 'n2').audited_at, '2026-07-30T10:00:00Z');
  // 3. the -mini row was removed by the family filter, so the base version wins on both sides
  //    even though the mini row has the latest audited_at of the whole fixture.
  assert.equal(pick(ts as Row[], 'n3').engine_version, 'opd-note-audit/0.81.14');
  assert.equal(pick(pg, 'n3').engine_version, 'opd-note-audit/0.81.14');
  // 4. the null-uid row survives on both sides — never silently dropped.
  assert.ok((ts as Row[]).some((r) => r.uid == null), 'canonicalByUid passes a null identity through');
  assert.ok(pg.some((r) => r.uid == null), 'the SQL twin must not drop it either');
  // 5. addendum H: at the SAME engine version the reference row wins even though the candidate row
  //    is newer — the exact live hazard (19:16/19:33 IST, 31 Jul). Remove the tier from either
  //    expression and these four assertions fail on audited_at.
  assert.equal(pick(ts as Row[], 'n5').id, 'ref-old');
  assert.equal(pick(pg, 'n5').id, 'ref-old');
  assert.equal(pick(ts as Row[], 'n6').id, 'ref-bridge');
  assert.equal(pick(pg, 'n6').id, 'ref-bridge');
  // 6. D2 (2 Aug 2026): the GRADER tier DOES reorder across engine versions — the Gemini row at the
  //    OLDER version beats the qwen row at the newer one. This assertion was 'cand-newver' until V
  //    ruled; it is the addendum-H §6 open question, closed.
  assert.equal(pick(ts as Row[], 'n7').id, 'ref-oldver');
  assert.equal(pick(pg, 'n7').id, 'ref-oldver');
});

test('the ordering is the one THE RULE states — reverting it fails this test', () => {
  // Guards the exact defect §4 found: `note_date DESC, id DESC` never breaks a duplicate tie
  // (note_date is identical across re-audits of one note), so the winner was an arbitrary UUID.
  assert.ok(!/note_date/.test(CANONICAL_RANK_SQL), 'note_date cannot rank re-audits of the same note');
  assert.ok(!/\bid DESC/.test(CANONICAL_RANK_SQL), 'a UUID tiebreak is arbitrary, not canonical');
  assert.ok(!/engine_version DESC/.test(CANONICAL_RANK_SQL), 'a bare lexicographic sort ranks 0.81.9 above 0.81.17');
  // D2 (2 Aug 2026): grader tier FIRST, then version, then the REFERENCE tier, then audited_at.
  // Dropping the grader tier, or demoting it below the version, fails here — that ordering is what
  // let a local 14B model's row displace a Gemini audit on the dashboard.
  assert.match(CANONICAL_RANK_SQL,
    /^CASE WHEN model LIKE 'qwen%' OR engine_version LIKE '%-mini' THEN 1 ELSE 0 END, string_to_array.+::int\[\] DESC, CASE WHEN model IN \(.+\) THEN 0 ELSE 1 END, audited_at DESC$/,
    'the four keys must be: grader tier, version, reference tier, audited_at');
});

test('§6 — SCAN lib/ and app/: nobody hand-writes a note-identity dedup on opd_note_audits', () => {
  // A HAND-LISTED FILE SET CANNOT CATCH A POSTURE IN A FILE NOBODY LISTED. The earlier version of
  // this guard checked three named files, which is exactly why the triage queue route and
  // lib/learning.ts were missed — both had been writing their own dedup the whole time.
  // This walks the tree instead.
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.next' || e.name === '__tests__') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(ts|tsx)$/.test(e.name)) continue;
      const src = readFileSync(p, 'utf8');
      // Only care about dedups over the OPD audit table, keyed on note identity.
      if (!/opd_note_audits/.test(src)) continue;
      if (/DISTINCT ON \(\s*uid\s*\)/.test(src)) offenders.push(p);
    }
  };
  walk('lib'); walk('app');
  assert.deepEqual(offenders, [],
    `these files hand-write DISTINCT ON (uid) over opd_note_audits — route them through canonicalDistinctOnSql: ${offenders.join(', ')}`);
});

test('no doctor-facing surface writes its own NOTE-IDENTITY dedup', () => {
  // lib/audit-canonical.ts: "no surface writes its own DISTINCT ON". Enforced, not trusted.
  //
  // Scoped to NOTE IDENTITY. `DISTINCT ON (uid)` is THE RULE and must come from the shared
  // fragment. A `DISTINCT ON` over a DIFFERENT key is a different operation and stays legal —
  // fetchDeptFindingNotes uses `DISTINCT ON (l.id)` to collapse a CROSS JOIN LATERAL fan-out (one
  // row per matching finding) back to one row per note, over rows the shared fragment has ALREADY
  // made canonical. Banning that outright would be a false positive.
  const doctor = readFileSync('lib/opd-audit-doctor.ts', 'utf8');
  assert.ok(!/DISTINCT ON \(\s*uid\s*\)/.test(doctor),
    'a hand-written DISTINCT ON (uid) is a competing dedup posture — use canonicalDistinctOnSql');
  assert.ok(doctor.includes('canonicalDistinctOnSql'), 'and it must use the shared fragment');
  // The lateral de-fan is keyed on the canonical row's id, never on uid.
  for (const m of doctor.match(/DISTINCT ON \([^)]*\)/g) ?? []) {
    assert.ok(/\bid\b/.test(m), `unexpected DISTINCT ON key: ${m}`);
  }
});

test('ONE RULE across every surface — governance and stewardship included (addendum D)', () => {
  // The real defect was three surfaces holding three different rules over one table: the doctor
  // pages deduped one way, governance PINNED a version, stewardship took the newest by TIME. This
  // is the test that stops a fourth appearing.
  // ⚠️ RE-POINTED by the stewardship MS ship (S2, 29 Aug 2026). The board's SQL moved off the page
  // into lib/stewardship-canonical.ts — one fragment now serves the board, the department roll-up,
  // the danger queue and the room's Ask box, so those four cannot become a fifth rule. The
  // INVARIANT is unchanged and is asserted against its new home; the page holds no SQL to check.
  for (const f of ['lib/opd-gov-read.ts', 'lib/stewardship-canonical.ts', 'lib/opd-audit-doctor.ts']) {
    const src = readFileSync(f, 'utf8');
    assert.ok(src.includes('canonicalDistinctOnSql'), `${f} must dedup through the shared fragment`);
    assert.ok(!/DISTINCT ON \(\s*uid\s*\)/.test(src), `${f} must not hand-write a note-identity dedup`);
  }

  // Governance: the version pin is gone from the METRICS path. It showed 4-7% of a doctor's notes
  // and collapsed at every engine bump. (resolveInstances still pins — reported, not changed here.)
  const gov = readFileSync('lib/opd-gov-read.ts', 'utf8');
  const metrics = gov.slice(gov.indexOf('export async function doctorAuditMetrics'));
  assert.ok(!/engine_version\s*=\s*\$\d/.test(metrics), 'doctorAuditMetrics must not pin a single engine version');
  assert.ok(metrics.includes('ENG_FAMILY_SQL'), 'it reads the engine family, like every other surface');
  // Option C, not B: the mix is DECLARED, never hidden.
  assert.ok(/engine_versions: number; oldest_engine_version: string \| null;/.test(gov),
    'AuditMetrics must carry the version spread behind the number');
  assert.ok(metrics.includes('count(DISTINCT engine_version)'), 'and it must actually be computed');

  // Stewardship: newest-by-time is not THE RULE, and it had no engine filter at all.
  const stew = readFileSync('lib/stewardship-canonical.ts', 'utf8');
  assert.ok(!/ORDER BY uid, audited_at DESC/.test(stew), 'newest-by-time ranking must be gone');
  assert.ok(stew.includes('ENG_FAMILY_SQL'), 'and it must now filter the engine family');
  // and the page it came from holds no competing copy
  const page = readFileSync('app/admin/stewardship/page.tsx', 'utf8');
  assert.ok(!/opd_note_audits/.test(page), 'the board page must read through the shared fragment, not its own SQL');
});

test('a non-numeric tail that is NOT -mini cannot reach the cast — shape, not suffix (learning.ts)', () => {
  // Negative test: the 0.5-verify row alone RAISES in the SQL twin — exactly what Postgres does
  // when a suffix-only guard (`NOT LIKE '%-mini'`) lets it through. No -mini suffix to match:
  const verifyRows = FIXTURE.filter((r) => r.uid === 'n8');
  assert.ok(verifyRows.length && verifyRows.every((r) => !/-mini$/.test(r.engine_version)),
    'the trap row must carry a non-numeric tail WITHOUT a -mini suffix');
  assert.throws(() => sqlDistinctOn(verifyRows), /invalid input syntax for type integer: "5-verify"/,
    'the int[] cast must raise on the tail a suffix guard fails to exclude');

  // The SHAPE test excludes it by construction — every -mini tail with it — and survivors rank
  // cleanly and identically on both sides.
  const SHAPE = /^[0-9]+(\.[0-9]+)*$/;
  const shaped = FIXTURE.filter((r) => SHAPE.test(r.engine_version.split('/')[1]));
  assert.ok(!shaped.some((r) => r.uid === 'n8'), 'shape test excludes 0.5-verify');
  assert.ok(!shaped.some((r) => /-mini$/.test(r.engine_version)), 'shape test subsumes the -mini exclusion');
  const key = (rows: Row[]) => rows.map((r) => `${r.uid ?? 'NULL'}:${r.id}`).sort();
  assert.deepEqual(key(sqlDistinctOn(shaped)), key(canonicalByUid(shaped) as Row[]),
    'the two expressions of THE RULE must agree over the shape-filtered set');

  // And lib/learning.ts actually carries the shape test, not the suffix enumeration.
  const learning = readFileSync('lib/learning.ts', 'utf8');
  assert.ok(learning.includes(String.raw`split_part(engine_version, '/', 2) ~ '^[0-9]+(\\.[0-9]+)*$'`),
    'loadRecentAuditRows must guard the int[] cast by tail SHAPE');
  assert.ok(!learning.includes(`engine_version NOT LIKE '%-mini'`),
    'the suffix-enumeration guard must be gone from the where clause');
});

test('canonicalDistinctOnSql composes the identity, the columns and the rank tail', () => {
  const sqlText = canonicalDistinctOnSql({
    table: 'opd_note_audits', identity: 'uid', cols: 'band, note_date', where: 'app_source = $1',
  });
  assert.match(sqlText, /SELECT DISTINCT ON \(uid\) uid, band, note_date/);
  assert.match(sqlText, /FROM opd_note_audits/);
  assert.match(sqlText, /WHERE app_source = \$1/);
  assert.ok(sqlText.includes(`ORDER BY uid, ${CANONICAL_RANK_SQL}`), 'the rank tail is the shared constant');
});
