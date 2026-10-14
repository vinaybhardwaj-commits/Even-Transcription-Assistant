/**
 * LAB-MCP-V2 §17.7 round C1 — the release core and the corpus target.
 *
 * ⚠️ THE MOST IMPORTANT TEST IN THIS FILE IS THE GREP. Decision 79 says v2 wraps v1's activation
 * and never writes a second path to `mksap_chunks`; decision 80a carves out exactly ONE statement,
 * in exactly ONE file, because v1 has no deactivate. That carve-out is only safe if it stays a
 * carve-out, and the only thing that keeps it one is a test that reads every release file and
 * every line of `tools/corpus.ts` and fails on a second write.
 *
 * ⚠️ AND THE SECOND MOST IMPORTANT IS THE ORDER OF THE REFUSALS. `release_apply` is the first thing
 * in this platform that changes what a clinician's retrieval returns. Each of its five refusals is
 * tested on its own, and the order is tested too: an approval that is both expired AND on a
 * superseded hash reports the HASH, because re-approving would not fix it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { embedded, type Db } from '../db';
import {
  APPROVAL_TTL_MS, LabError, RELEASE_TARGETS, ROLLBACK_CAVEAT, hash,
} from '../contracts';
import {
  advanceTarget, applyMigrations, getReceipt, getTarget, listTargets, putObject, putReview,
} from '../store';
import {
  CHUNK_STATE_SQL, NEAR_DUPLICATE_SQL, OVERLAP_SQL, PG_TRGM_SQL, STAGED_CHUNKS_SQL,
  STAGED_IDS_SQL, VISIBLE_SUMMARY_SQL, MAX_CHUNK_ID_SQL, candidateLegs, corpusDiff, corpusStage,
  corpusValidate, quarantinedSource, readStagedIds,
} from '../tools/corpus';
import { CORPUS_QUARANTINE_INSERT_SQL, labLabel } from '../../lab';
import {
  ACTIVATED_IDS_SQL, CORPUS_DEACTIVATE_SQL, activateLabel, deactivateIds,
} from '../releases/corpus-writer';
import { releasePrepare } from '../releases/prepare';
import { reviewSubmit } from '../releases/review';
import { releaseApply } from '../releases/apply';
import { releaseRollback } from '../releases/rollback';
import { releaseStatus } from '../tools/release';

// ─────────────────────────────────────────────────────────────────────────────────────
// A database with BOTH migrations. `helpers.ts` loads 0001 only and §17.7 leaves it alone,
// so C1 builds its own rather than editing a file the contract froze.
// ─────────────────────────────────────────────────────────────────────────────────────
function migrationFiles() {
  const dir = join(process.cwd(), 'migrations', 'lab-v2');
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => {
    const sql = readFileSync(join(dir, name), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  });
}

async function releaseDb(): Promise<Db> {
  const db = await embedded();
  await applyMigrations(db, migrationFiles());
  return db;
}

const LABEL = 'c1-batch';
const IDS = [4145286, 4145287, 4145288];

/** A staged set object, without touching a corpus. */
async function stageFixture(db: Db, ids: number[] = IDS, label = LABEL) {
  return corpusStage(db, 'research', { label, idempotency_key: `stage-${label}-${ids.join('-')}` }, {
    read: (async () => ids.map((id) => ({ id: String(id) }))) as never,
  });
}

/** The chunk-state read a prepare makes: every id quarantined and invisible, as v1 leaves them. */
const quarantinedState = (ids: number[]) =>
  (async () => ids.map((id) => ({ id: String(id), source: `labq:${LABEL}`, visible: false }))) as never;

async function prepareFixture(db: Db, ids: number[] = IDS, key = 'prep-1') {
  const staged = await stageFixture(db, ids);
  return releasePrepare(db, 'release', { target: 'corpus', staged_set_id: staged.staged_set_id, idempotency_key: key }, {
    read: quarantinedState(ids),
    stagedIds: async () => ids,
  });
}

async function approve(db: Db, releaseId: string, key = 'rev-1') {
  return reviewSubmit(db, 'reviewer', { release_id: releaseId, decision: 'approved', rationale: 'read all three passages against the source', idempotency_key: key });
}

/** An apply that never touches a corpus: v1's activation and the id read-back are both injected. */
const applyDeps = (ids: number[], landed: number[] = ids) => ({
  stagedIds: async () => ids,
  activate: async () => ({ source: `lab:${LABEL}`, activated: landed.length }),
  run: (async () => landed.map((id) => ({ id: String(id) }))) as never,
});

// ─────────────────────────────────────────────────────────────────────────────────────
// DECISION 79 / 80a — the grep, and the one carve-out
// ─────────────────────────────────────────────────────────────────────────────────────

test('§17.7 decision 79: v2 writes to mksap_chunks in exactly ONE place, with exactly ONE statement', () => {
  const root = process.cwd();
  const files: string[] = [join(root, 'lib/lab-v2/tools/corpus.ts')];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p);
    }
  };
  walk(join(root, 'lib/lab-v2/releases'));
  assert.ok(files.length >= 6, `expected the release tree to be walked, saw ${files.length}`);

  // The single exemption, matched VERBATIM. Decision 80a names this file and this statement.
  const EXEMPT_FILE = join(root, 'lib/lab-v2/releases/corpus-writer.ts');
  const EXEMPT = `UPDATE mksap_chunks SET source = $1, visible = false WHERE id = ANY($2) RETURNING id`;
  assert.equal(CORPUS_DEACTIVATE_SQL, EXEMPT, 'the exempt statement is the one the writer exports');

  const hits: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    // Comments stripped: these files EXPLAIN the v1 statement they wrap, and prose about a write
    // is not a write. What is scanned is code.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const body = f === EXEMPT_FILE ? code.split(EXEMPT).join('«exempt»') : code;
    for (const [i, line] of body.split('\n').entries()) {
      for (const verb of ['INSERT INTO', 'UPDATE ', 'DELETE FROM']) {
        if (!line.includes(verb)) continue;
        if (!/mksap_chunks|lvc_/.test(line)) continue;
        hits.push(`${f.slice(root.length + 1)}:${i + 1} — ${line.trim().slice(0, 120)}`);
      }
    }
  }
  assert.deepEqual(hits, [], `a second write path to mksap_chunks or lvc_*:\n${hits.join('\n')}`);

  // And prove the grep can actually see one, so a green result means something.
  const probe = `${'UPDATE '}mksap_chunks SET visible = true`;
  assert.ok(/mksap_chunks/.test(probe) && probe.includes('UPDATE '), 'the pattern matches a real write');
});

test('§17.7 decision 79: the activation is v1’s function, imported and called', () => {
  const src = readFileSync(join(process.cwd(), 'lib/lab-v2/releases/corpus-writer.ts'), 'utf8');
  // ⚠️ IMPORTED, NEVER COPIED. A second activation path would be a second set of bugs, and the
  // first time the two disagreed nobody would know which rows were live.
  assert.match(src, /import \{[^}]*corpusActivate[^}]*\} from '\.\.\/\.\.\/lab'/);
  // Comments stripped: the header QUOTES v1's statement so a reader knows what is being wrapped,
  // and prose about a write is not a write. What must not appear is a second copy in code.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!code.includes('visible = true'), 'the activation SQL is v1’s and is not restated in code here');
  const v1 = readFileSync(join(process.cwd(), 'lib/lab.ts'), 'utf8');
  assert.ok(v1.includes(`UPDATE mksap_chunks SET source = $1, visible = true WHERE source = $2 RETURNING id`),
    'v1’s activation statement is where it was; if this fails, read lib/lab.ts before touching anything here');
});

test('§17.7 decision 80a: the inverse is id-keyed, flips both flags, and refuses an empty set', async () => {
  const seen: unknown[][] = [];
  const out = await deactivateIds(LABEL, IDS, {
    run: (async (_s: string, p: unknown[]) => { seen.push(p); return IDS.map((id) => ({ id: String(id) })); }) as never,
  });
  assert.deepEqual(out.ids, IDS);
  assert.equal(out.source, `labq:${LABEL}`);
  assert.deepEqual(seen[0], [`labq:${LABEL}`, IDS], 'by id, never by label');
  // ⚠️ BOTH FLAGS. v1's quarantine INSERT writes visible = false and activation flips it true; an
  // inverse that moved only the prefix would leave a row two guards disagree about.
  assert.match(CORPUS_DEACTIVATE_SQL, /SET source = \$1, visible = false/);
  assert.match(CORPUS_DEACTIVATE_SQL, /WHERE id = ANY\(\$2\)/);
  await assert.rejects(() => deactivateIds(LABEL, [], {}), (e: { code?: string }) => e.code === 'INVALID_INPUT');
  await assert.rejects(() => deactivateIds(LABEL, [1.5], {}), (e: { code?: string }) => e.code === 'INVALID_INPUT');
});

// ─────────────────────────────────────────────────────────────────────────────────────
// The inferred reads
// ─────────────────────────────────────────────────────────────────────────────────────

test('§17.7: every inferred mksap_chunks read is a bounded SELECT, and none is a write', () => {
  const statements: [string, string][] = [
    ['staged chunks', STAGED_CHUNKS_SQL],
    ['staged ids', STAGED_IDS_SQL],
    ['visible summary', VISIBLE_SUMMARY_SQL],
    ['max chunk id', MAX_CHUNK_ID_SQL],
    ['overlap', OVERLAP_SQL],
    ['near duplicate', NEAR_DUPLICATE_SQL(0.9)],
    ['pg_trgm', PG_TRGM_SQL],
    ['chunk state', CHUNK_STATE_SQL(IDS)],
    ['activated ids', ACTIVATED_IDS_SQL],
    ['candidate vector', candidateLegs(null, 4145285).vector.sql],
    ['candidate bm25', candidateLegs(null, 4145285).bm25.sql.trim()],
  ];
  for (const [name, sql] of statements) {
    assert.match(sql.trimStart(), /^SELECT/, `${name}: read only`);
    assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|GRANT|TRUNCATE)\b/.test(sql), `${name}: a write token`);
    assert.equal((sql.match(/;/g) ?? []).length, 0, `${name}: a single statement`);
    assert.ok(!/SELECT\s+\*/.test(sql), `${name}: never SELECT *`);
  }
  for (const [name, sql] of statements.filter(([n]) => !['visible summary', 'max chunk id', 'pg_trgm'].includes(n))) {
    assert.ok(/LIMIT \d+/.test(sql), `${name} must be bounded`);
  }
  // ⚠️ THE SERVABLE PREDICATE IS PRODUCTION'S, WORD FOR WORD (lib/retrieve.ts:167) — and it belongs
  // ONLY to the statements that ask about servability.
  for (const sql of [VISIBLE_SUMMARY_SQL, OVERLAP_SQL]) {
    assert.ok(sql.includes('visible IS NOT FALSE'));
    assert.ok(sql.includes("source NOT LIKE 'labq:%'"));
  }
  for (const leg of [candidateLegs(null, 10).vector.sql, candidateLegs(null, 10).bm25.sql]) {
    assert.ok(leg.includes("source NOT LIKE 'labq:%'"), 'side A never sees a quarantined chunk');
  }
});

test('§17.7 decision 86: the staged-set reader binds the source and carries NO visibility predicate', () => {
  /**
   * ⚠️ THE FAILURE THIS PINS. On `8110b22f` these statements built `WHERE source = '<label>'`; the
   * rows live under `labq:<label>`, so the reader matched nothing that exists. `corpus_stage` wrote
   * chunk 4145293 through v1's own ingest and then reported `CASE_NOT_FOUND` for the label it had
   * just written, and `corpus_validate` did the same on 15 real pre-existing rows.
   *
   * Two properties now, and BOTH are ways the reader could have returned nothing:
   *   · the source is a BOUND parameter, `$1`, whose value is `'labq:' || slug`;
   *   · no visibility or servability predicate — a quarantined row is `visible = false` by
   *     construction, so `visible IS NOT FALSE` would exclude every row it is meant to find.
   */
  for (const [name, sql] of [
    ['staged ids', STAGED_IDS_SQL],
    ['staged chunks', STAGED_CHUNKS_SQL],
    ['near duplicate', NEAR_DUPLICATE_SQL(0.9)],
  ] as [string, string][]) {
    assert.match(sql, /(?:^|\s)(?:s\.)?source = \$1/m, `${name} binds the source`);
    // ⚠️ The STAGED side must not be interpolated. `NEAR_DUPLICATE_SQL` legitimately carries
    // `source NOT LIKE 'labq:%'` on the VISIBLE side — that is the servable predicate, on the half
    // of the join where it belongs — so the check is about the staged predicate, not the string.
    assert.ok(!/(?:^|\s)(?:s\.)?source = '/m.test(sql), `${name} must not interpolate the staged source`);
    assert.ok(!/visible IS NOT FALSE/.test(sql.split('JOIN')[0]), `${name} must carry no visibility predicate on the STAGED side`);
  }
  // ⚠️ The overlap read no longer touches the staged source AT ALL — decision 88 rekeyed it to the
  // staged set's BOOKS, bound, because `mksap_chunks` has a btree on `book` and nothing on the
  // (book, chapter) pair. It is servable-only by construction, which is the half it asks about.
  assert.match(OVERLAP_SQL, /AND c\.book = ANY\(\$1\)/);
  assert.ok(!/source = \$1/.test(OVERLAP_SQL), 'the overlap is keyed by book, not by the staged source');
  // And the value that gets bound is the quarantined source, built once.
  assert.equal(quarantinedSource('c1-batch'), 'labq:c1-batch');
  assert.equal(quarantinedSource('UPPER'), 'labq:upper');
  assert.equal(quarantinedSource("x'; DROP TABLE mksap_chunks --"), 'labq:x-drop-table-mksap_chunks');
});

test('§17.7: a label is SLUGGED by v1, and the slug that means "default" is refused', () => {
  /**
   * ⚠️ v1's `labLabel` SANITISES rather than refuses, and one of its outputs is a trap. Measured
   * 06 Sep 2026:
   *     "x'; DROP TABLE mksap_chunks --" → "x-drop-table-mksap_chunks"
   *     "a b"   → "a-b"        "UPPER" → "upper"
   *     ""      → "default"    "  "    → "default"     "!!!" → "default"
   * The first three are genuine sanitisations and are trusted. The last three are the hazard: a
   * blank label would silently address the batch NAMED `default`. That is refused.
   */
  for (const dangerous of ["x'; DROP TABLE mksap_chunks --", 'a b', 'UPPER']) {
    const bound = quarantinedSource(dangerous);
    assert.ok(!/['";\s]/.test(bound), `the bound source for ${dangerous} carries no punctuation`);
    assert.match(bound, /^labq:[a-z0-9][a-z0-9_-]*$/);
  }
  for (const blank of ['', '  ', '!!!']) {
    assert.throws(() => quarantinedSource(blank), (e: { code?: string; message?: string }) =>
      e.code === 'INVALID_INPUT' && /slugs to 'default'/.test(String(e.message)), JSON.stringify(blank));
  }
  // A batch legitimately named `default` is still addressable.
  assert.equal(quarantinedSource('default'), 'labq:default');
});

test('§17.7: the impact estimate admits the staged batch through production’s OWN quarantine seam', () => {
  const a = candidateLegs(null, 4145285);
  const b = candidateLegs(LABEL, 4145285);
  // Side A excludes every labq: row. Side B relaxes the guard for ONE named batch, by bound
  // parameter, through `buildFilterClauses` — never by editing the predicate.
  assert.ok(!a.vector.params.length, 'side A binds no quarantine parameter');
  assert.deepEqual(b.vector.params, [`labq:${LABEL}`], 'side B names exactly one batch, bound');
  // Both sides are pinned to the SAME snapshot, so a concurrent ingest cannot move one under the
  // other and be read as impact.
  for (const sql of [a.vector.sql, a.bm25.sql, b.vector.sql, b.bm25.sql]) {
    assert.ok(sql.includes('AND id <= 4145285'), 'both sides share one corpus snapshot');
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────
// corpus_validate — decision 83
// ─────────────────────────────────────────────────────────────────────────────────────

const chunkRow = (id: number, over: Record<string, unknown> = {}) => ({
  id: String(id), book: 'Even Protocols', chapter: 'Sepsis', section: 'lab', source: `labq:${LABEL}`,
  chunk_type: 'note', token_count: 120, visible: false, text_chars: 900, preview: 'a passage',
  has_embedding: true, has_tsv: true, text_hash: `h${id}`, ...over,
});

test('§17.7 decision 83: the near-duplicate check reports SKIPPED where pg_trgm is absent, never passed', async () => {
  const db = await releaseDb();
  const read = (async (_s: string, sql: string) => (sql === PG_TRGM_SQL
    ? [{ installed: false }]
    : IDS.map((id) => chunkRow(id)))) as never;
  const out = await corpusValidate(db, { label: LABEL }, { read });
  const dup = out.checks.find((c) => c.name === 'near_duplicate')!;
  // ⚠️ "We did not look" and "we looked and found nothing" are different claims, and only one of
  // them is safe to act on. This is the one that is not.
  assert.equal(dup.status, 'skipped');
  assert.notEqual(dup.status, 'passed' as string);
  assert.match(String(dup.detail), /pg_trgm not installed/);
  assert.match(String(dup.detail), /NOT a pass/);
  // A skipped check does not fail the batch either — `ok` is "nothing FAILED".
  assert.equal(out.ok, true);
  assert.ok(out.checks.some((c) => c.status === 'skipped'), 'and the skip is visible in the array');
  await db.close();
});

test('§17.7: corpus_validate runs the duplicate check where pg_trgm IS present', async () => {
  const db = await releaseDb();
  const read = (async (_s: string, sql: string) => {
    if (sql === PG_TRGM_SQL) return [{ installed: true }];
    if (sql.includes('similarity(')) return [{ staged_id: '4145286', visible_id: '99', visible_source: 'choosing-wisely', similarity: '0.94' }];
    return IDS.map((id) => chunkRow(id));
  }) as never;
  const out = await corpusValidate(db, { label: LABEL }, { read });
  const dup = out.checks.find((c) => c.name === 'near_duplicate')!;
  assert.equal(dup.status, 'failed');
  assert.deepEqual(dup.offenders, [4145286]);
  assert.equal(out.ok, false);
  assert.deepEqual(out.near_duplicates, [{ staged_id: 4145286, visible_id: 99, visible_source: 'choosing-wisely', similarity: 0.94 }]);
  assert.match(NEAR_DUPLICATE_SQL(0.9), /similarity\(s\.text, v\.text\) > 0\.9/);
  await db.close();
});

test('§17.7: corpus_validate names every offender, and an already-live chunk is not stageable', async () => {
  const db = await releaseDb();
  const read = (async (_s: string, sql: string) => (sql === PG_TRGM_SQL ? [{ installed: false }] : [
    chunkRow(1, { has_embedding: false }),
    chunkRow(2, { chapter: null }),
    chunkRow(3, { text_chars: 4 }),
    // Already activated: `visible` true and the prefix gone. Staging it would mean a release
    // "activating" something that is already live, and its rollback would quarantine a live chunk.
    chunkRow(4, { visible: true, source: `lab:${LABEL}` }),
    chunkRow(5, { has_tsv: false }),
  ])) as never;
  const out = await corpusValidate(db, { label: LABEL }, { read });
  assert.equal(out.ok, false);
  const by = new Map(out.checks.map((c) => [c.name, c]));
  assert.deepEqual(by.get('has_embedding')!.offenders, [1]);
  assert.deepEqual(by.get('has_chapter')!.offenders, [2]);
  assert.deepEqual(by.get('text_present')!.offenders, [3]);
  assert.deepEqual(by.get('still_quarantined')!.offenders, [4]);
  assert.deepEqual(by.get('has_tsv')!.offenders, [5]);
  for (const c of out.checks) {
    if (c.status === 'failed') assert.ok(c.detail, `${c.name} must say why it failed`);
  }
  await db.close();
});

// ─────────────────────────────────────────────────────────────────────────────────────
// The ledger: §11's three tables
// ─────────────────────────────────────────────────────────────────────────────────────

test('§17.7: 0002 creates exactly two targets, at revision 0, and refuses a third', async () => {
  const db = await releaseDb();
  const targets = await listTargets(db);
  // DECISION 77: `config:opd` was withdrawn. A third target is a PRD decision, not an INSERT.
  assert.deepEqual(targets.map((t) => t.name), [...RELEASE_TARGETS]);
  for (const t of targets) {
    assert.equal(t.revision, 0);
    assert.equal(t.artifact_id, null, 'a target that has never been released is a real state');
  }
  await assert.rejects(() => db.query(`INSERT INTO lab_v2.targets (name) VALUES ('config:opd')`, []));
  await db.close();
});

test('§17.7: the compare-and-swap is atomic — two releases on one revision cannot both land', async () => {
  const db = await releaseDb();
  const first = await advanceTarget(db, 'corpus', 0, { artifact_id: null, predecessor_id: null, release_id: null });
  assert.equal(first, 1);
  // The second prepared against revision 0 as well. Zero rows updated IS the refusal.
  const second = await advanceTarget(db, 'corpus', 0, { artifact_id: null, predecessor_id: null, release_id: null });
  assert.equal(second, null);
  assert.equal((await getTarget(db, 'corpus'))!.revision, 1, 'and the winner is untouched');
  await db.close();
});

test('§17.7: a review needs a rationale, and the database says so as well as the handler', async () => {
  const db = await releaseDb();
  await assert.rejects(
    () => db.query(
      `INSERT INTO lab_v2.reviews (release_id, reviewer, artifact_hash, decision, rationale, expires_at)
       VALUES ('00000000-0000-4000-8000-000000000000', 'reviewer', 'h', 'approved', '   ', now())`, []),
    'a blank rationale is refused by the CHECK, not only by the handler',
  );
  await assert.rejects(
    () => db.query(
      `INSERT INTO lab_v2.reviews (release_id, reviewer, artifact_hash, decision, rationale, expires_at)
       VALUES ('00000000-0000-4000-8000-000000000000', 'reviewer', 'h', 'maybe', 'ok', now())`, []),
    'and so is a decision outside {approved, rejected}',
  );
  await db.close();
});

// ─────────────────────────────────────────────────────────────────────────────────────
// release_apply — the five refusals, in order
// ─────────────────────────────────────────────────────────────────────────────────────

test('§17.7 decision 81: apply refuses a release nobody approved', async () => {
  const db = await releaseDb();
  const prep = await prepareFixture(db);
  await assert.rejects(
    () => releaseApply(db, 'release', { release_id: prep.release_id }, applyDeps(IDS)),
    (e: { code?: string }) => e.code === 'APPROVAL_MISSING',
  );
  // A REJECTION is on the record and is still not an approval.
  await reviewSubmit(db, 'reviewer', { release_id: prep.release_id, decision: 'rejected', rationale: 'the second passage is not sourced', idempotency_key: 'r' });
  await assert.rejects(
    () => releaseApply(db, 'release', { release_id: prep.release_id }, applyDeps(IDS)),
    (e: { code?: string; message?: string }) => e.code === 'APPROVAL_MISSING' && /none approved/.test(String(e.message)),
  );
  await db.close();
});

test('§17.7 decision 81: an approval expires after seven days, and apply says APPROVAL_STALE', async () => {
  const db = await releaseDb();
  const prep = await prepareFixture(db);
  const release = (await db.query<{ hash: string }>(`SELECT hash FROM lab_v2.objects WHERE id = $1`, [prep.release_id]))[0];
  await putReview(db, {
    release_id: prep.release_id, reviewer: 'reviewer', artifact_hash: release.hash,
    decision: 'approved', rationale: 'read it',
    expires_at: new Date(Date.now() - 1000).toISOString(), idempotency_key: 'old',
  });
  await assert.rejects(
    () => releaseApply(db, 'release', { release_id: prep.release_id }, applyDeps(IDS)),
    (e: { code?: string; message?: string }) => e.code === 'APPROVAL_STALE' && /7 days/.test(String(e.message)),
  );
  assert.equal(APPROVAL_TTL_MS, 7 * 24 * 60 * 60 * 1000);
  await db.close();
});

test('§17.7 decision 81: a changed artifact invalidates the approval by HASH', async () => {
  const db = await releaseDb();
  const prep = await prepareFixture(db);
  await putReview(db, {
    release_id: prep.release_id, reviewer: 'reviewer', artifact_hash: 'a-hash-of-something-else',
    decision: 'approved', rationale: 'read a different artifact', expires_at: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
    idempotency_key: 'wrong-hash',
  });
  await assert.rejects(
    () => releaseApply(db, 'release', { release_id: prep.release_id }, applyDeps(IDS)),
    (e: { code?: string; message?: string }) => e.code === 'APPROVAL_HASH_MISMATCH' && /changed after it was reviewed/.test(String(e.message)),
  );
  await db.close();
});

test('§17.7 decision 81: the hash is reported before the expiry, because re-approving would not fix it', async () => {
  const db = await releaseDb();
  const prep = await prepareFixture(db);
  // Both wrong at once. The message must name the one that actually blocks progress.
  await putReview(db, {
    release_id: prep.release_id, reviewer: 'reviewer', artifact_hash: 'stale-and-superseded',
    decision: 'approved', rationale: 'x', expires_at: new Date(Date.now() - 1000).toISOString(), idempotency_key: 'both',
  });
  await assert.rejects(
    () => releaseApply(db, 'release', { release_id: prep.release_id }, applyDeps(IDS)),
    (e: { code?: string }) => e.code === 'APPROVAL_HASH_MISMATCH',
  );
  await db.close();
});

test('§17.7 decision 5: the preparer may not review its own release, at review AND at apply', async () => {
  const db = await releaseDb();
  const prep = await prepareFixture(db);
  // Refused where it is attempted, so the ledger never acquires a self-approval at all.
  await assert.rejects(
    () => reviewSubmit(db, 'release', { release_id: prep.release_id, decision: 'approved', rationale: 'mine', idempotency_key: 'self' }),
    (e: { code?: string; message?: string }) => e.code === 'REVIEWER_IS_PREPARER' && /decision 5/.test(String(e.message)),
  );
  // And refused again at apply, from a row written before a key changed hands.
  const release = (await db.query<{ hash: string }>(`SELECT hash FROM lab_v2.objects WHERE id = $1`, [prep.release_id]))[0];
  await putReview(db, {
    release_id: prep.release_id, reviewer: 'release', artifact_hash: release.hash, decision: 'approved',
    rationale: 'snuck in', expires_at: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(), idempotency_key: 'snuck',
  });
  await assert.rejects(
    () => releaseApply(db, 'release', { release_id: prep.release_id }, applyDeps(IDS)),
    (e: { code?: string }) => e.code === 'REVIEWER_IS_PREPARER',
  );
  await db.close();
});

test('§17.7 decision 79a: a staged set that moved after review is STAGED_SET_CHANGED', async () => {
  const db = await releaseDb();
  const prep = await prepareFixture(db);
  await approve(db, prep.release_id);
  // ⚠️ v1's activation is keyed on the LABEL, so a chunk added to the batch after review would be
  // activated unreviewed. This is the check that stops it.
  await assert.rejects(
    () => releaseApply(db, 'release', { release_id: prep.release_id }, applyDeps([...IDS, 4145299])),
    (e: { code?: string; message?: string }) => e.code === 'STAGED_SET_CHANGED' && /1 added/.test(String(e.message)),
  );
  await assert.rejects(
    () => releaseApply(db, 'release', { release_id: prep.release_id }, applyDeps(IDS.slice(0, 2))),
    (e: { code?: string; message?: string }) => e.code === 'STAGED_SET_CHANGED' && /1 gone/.test(String(e.message)),
  );
  // The ORDER of ids is not a change.
  const ok = await releaseApply(db, 'release', { release_id: prep.release_id }, applyDeps([...IDS].reverse()));
  assert.equal(ok.outcome, 'applied');
  await db.close();
});

test('§17.7 decision 81: a revision that moved under the release is REVISION_MISMATCH', async () => {
  const db = await releaseDb();
  const prep = await prepareFixture(db);
  await approve(db, prep.release_id);
  // Something else landed first.
  await advanceTarget(db, 'corpus', 0, { artifact_id: null, predecessor_id: null, release_id: null });
  await assert.rejects(
    () => releaseApply(db, 'release', { release_id: prep.release_id }, applyDeps(IDS)),
    (e: { code?: string; message?: string }) => e.code === 'REVISION_MISMATCH' && /re-prepare/.test(String(e.message)),
  );
  await db.close();
});

// ─────────────────────────────────────────────────────────────────────────────────────
// release_apply — the happy path, idempotence, and drift
// ─────────────────────────────────────────────────────────────────────────────────────

test('§17.7: an approved release applies, bumps the revision, and writes one receipt', async () => {
  const db = await releaseDb();
  const prep = await prepareFixture(db);
  await approve(db, prep.release_id);
  const out = await releaseApply(db, 'release', { release_id: prep.release_id }, applyDeps(IDS));

  assert.equal(out.outcome, 'applied');
  assert.equal(out.replayed_receipt, false);
  assert.equal(out.revision, 1);
  assert.deepEqual(out.chunk_ids, IDS);
  const body = out.body as Record<string, unknown>;
  assert.equal(body.preparer, 'release');
  assert.equal((body.approval as { reviewer: string }).reviewer, 'reviewer');
  // The receipt names the writer, by file and statement, so a reader never has to go and look.
  assert.match(String(body.writer), /lib\/lab\.ts corpusActivate \(v1\), imported/);
  const t = (await getTarget(db, 'corpus'))!;
  assert.equal(t.revision, 1);
  assert.equal(t.artifact_id, prep.release_id);
  await db.close();
});

test('§17.7 §11: a second apply returns the FIRST receipt and activates nothing', async () => {
  const db = await releaseDb();
  const prep = await prepareFixture(db);
  await approve(db, prep.release_id);
  const first = await releaseApply(db, 'release', { release_id: prep.release_id }, applyDeps(IDS));

  let activations = 0;
  const second = await releaseApply(db, 'release', { release_id: prep.release_id }, {
    ...applyDeps(IDS),
    activate: async () => { activations += 1; return { source: `lab:${LABEL}`, activated: 3 }; },
  });
  assert.equal(second.receipt_id, first.receipt_id, 'the same receipt, not a new one');
  assert.equal(second.replayed_receipt, true);
  // ⚠️ THE POINT OF IDEMPOTENCE: a retry after a timeout must not re-activate.
  assert.equal(activations, 0);
  assert.equal((await getTarget(db, 'corpus'))!.revision, 1, 'and the revision did not move twice');
  await db.close();
});

test('§17.7 decision 79a: an activation that moves a different set is ACTIVATION_DRIFT and stops', async () => {
  const db = await releaseDb();
  const prep = await prepareFixture(db);
  await approve(db, prep.release_id);
  // v1's activation moved a fourth row nobody reviewed — the shape decision 79a exists for.
  const landed = [...IDS, 4145299];
  await assert.rejects(
    () => releaseApply(db, 'release', { release_id: prep.release_id }, applyDeps(IDS, landed)),
    (e: { code?: string; message?: string }) => e.code === 'ACTIVATION_DRIFT' && /receipt/.test(String(e.message)),
  );
  // ⚠️ THE RECEIPT IS STILL WRITTEN, WITH BOTH SETS. A rollback is driven off what ACTUALLY moved.
  const receipt = await getReceipt(db, prep.release_id, 'apply');
  assert.ok(receipt);
  const body = receipt!.body as Record<string, unknown>;
  assert.equal(body.outcome, 'activation_drift');
  assert.deepEqual(body.activated_chunk_ids, landed);
  assert.deepEqual((body.drift as { extra: number[] }).extra, [4145299]);
  await db.close();
});

// ─────────────────────────────────────────────────────────────────────────────────────
// release_rollback — decision 80
// ─────────────────────────────────────────────────────────────────────────────────────

test('§17.7 decision 80: rollback flips exactly the recorded ids and carries the caveat', async () => {
  const db = await releaseDb();
  const prep = await prepareFixture(db);
  await approve(db, prep.release_id);
  await releaseApply(db, 'release', { release_id: prep.release_id }, applyDeps(IDS));

  const seen: unknown[][] = [];
  const out = await releaseRollback(db, 'release', { release_id: prep.release_id }, {
    run: (async (_s: string, p: unknown[]) => { seen.push(p); return IDS.map((id) => ({ id: String(id) })); }) as never,
  });
  assert.equal(out.outcome, 'rolled_back');
  assert.deepEqual(out.chunk_ids, IDS);
  assert.deepEqual(seen[0], [`labq:${LABEL}`, IDS], 'exactly the recorded ids, by id');
  // §11, verbatim, on every rollback receipt.
  assert.equal(out.caveat, ROLLBACK_CAVEAT);
  assert.match(ROLLBACK_CAVEAT, /does NOT delete audits/);
  assert.equal((out.body as { caveat: string }).caveat, ROLLBACK_CAVEAT);
  // A rollback is a NEW activation: the revision advances rather than going back.
  assert.equal(out.revision, 2);
  assert.equal((await getTarget(db, 'corpus'))!.revision, 2);
  await db.close();
});

test('§17.7 decision 80: a rollback after DRIFT flips what actually moved, not what was reviewed', async () => {
  const db = await releaseDb();
  const prep = await prepareFixture(db);
  await approve(db, prep.release_id);
  const landed = [...IDS, 4145299];
  await releaseApply(db, 'release', { release_id: prep.release_id }, applyDeps(IDS, landed)).catch(() => null);

  const seen: unknown[][] = [];
  const out = await releaseRollback(db, 'release', { release_id: prep.release_id }, {
    run: (async (_s: string, p: unknown[]) => { seen.push(p); return landed.map((id) => ({ id: String(id) })); }) as never,
  });
  // ⚠️ The case nobody plans for. The receipt recorded what moved, so the rollback undoes THAT.
  assert.deepEqual(seen[0][1], landed);
  assert.deepEqual(out.chunk_ids, landed);
  await db.close();
});

test('§17.7: a partial rollback is reported as partial, never retried blindly', async () => {
  const db = await releaseDb();
  const prep = await prepareFixture(db);
  await approve(db, prep.release_id);
  await releaseApply(db, 'release', { release_id: prep.release_id }, applyDeps(IDS));
  const out = await releaseRollback(db, 'release', { release_id: prep.release_id }, {
    run: (async () => IDS.slice(0, 2).map((id) => ({ id: String(id) }))) as never,
  });
  assert.equal(out.outcome, 'partial');
  assert.deepEqual((out.body as { not_flipped: number[] }).not_flipped, [IDS[2]]);
  await db.close();
});

test('§17.7: rollback is idempotent, and refuses a release that was never applied', async () => {
  const db = await releaseDb();
  const prep = await prepareFixture(db);
  await assert.rejects(
    () => releaseRollback(db, 'release', { release_id: prep.release_id }, {}),
    (e: { code?: string; message?: string }) => e.code === 'INVALID_INPUT' && /never applied/.test(String(e.message)),
  );
  await approve(db, prep.release_id);
  await releaseApply(db, 'release', { release_id: prep.release_id }, applyDeps(IDS));
  const run = (async () => IDS.map((id) => ({ id: String(id) }))) as never;
  const first = await releaseRollback(db, 'release', { release_id: prep.release_id }, { run });
  let flips = 0;
  const second = await releaseRollback(db, 'release', { release_id: prep.release_id }, {
    run: (async () => { flips += 1; return []; }) as never,
  });
  assert.equal(second.receipt_id, first.receipt_id);
  assert.equal(second.replayed_receipt, true);
  assert.equal(flips, 0, 'a second rollback flips nothing');
  await db.close();
});

// ─────────────────────────────────────────────────────────────────────────────────────
// prepare, and release_status
// ─────────────────────────────────────────────────────────────────────────────────────

test('§17.7: prepare refuses a chunk that is already live, and records the predecessor state', async () => {
  const db = await releaseDb();
  const staged = await stageFixture(db);
  await assert.rejects(
    () => releasePrepare(db, 'release', { target: 'corpus', staged_set_id: staged.staged_set_id, idempotency_key: 'p' }, {
      // One of the three is already activated.
      read: (async () => [
        { id: '4145286', source: `labq:${LABEL}`, visible: false },
        { id: '4145287', source: `lab:${LABEL}`, visible: true },
        { id: '4145288', source: `labq:${LABEL}`, visible: false },
      ]) as never,
      stagedIds: async () => IDS,
    }),
    (e: { code?: string; message?: string }) => e.code === 'INVALID_INPUT' && /already live/.test(String(e.message)),
  );
  const prep = await prepareFixture(db);
  assert.match(prep.predecessor_visible_hash, /^[0-9a-f]{64}$/);
  assert.equal(prep.predecessor_visible_hash,
    hash(IDS.map((id) => ({ id, source: `labq:${LABEL}`, visible: false }))));
  // In words, for the reviewer.
  assert.match(prep.will, /activate 3 chunk\(s\).*corpusActivate.*revision 0 to 1/);
  assert.match(prep.rollback, /return exactly those 3 id\(s\)/);
  await db.close();
});

test('§17.7: prepare refuses a target this staged set is not for, by name', async () => {
  const db = await releaseDb();
  const staged = await stageFixture(db);
  // ⚠️ ROUND C2 EDIT, RULE 1a. This asserted `ENGINE_UNSUPPORTED … arrives in round C2` while the
  // rules target had no prepare path. C2 built that path, so the round-boundary pin is replaced by
  // the check that outlives it: a CORPUS staged set may not be released as `rules`. A corpus set
  // prepared as a rulebook change would produce an artifact whose predecessor described a different
  // thing entirely, so this is the stronger assertion, not merely the surviving one.
  await assert.rejects(
    () => releasePrepare(db, 'release', { target: 'rules', staged_set_id: staged.staged_set_id, idempotency_key: 'p2' }, {}),
    (e: { code?: string; message?: string }) => e.code === 'INVALID_INPUT' && /is a 'corpus' set/.test(String(e.message)),
  );
  await assert.rejects(
    () => releasePrepare(db, 'release', { target: 'config:opd', staged_set_id: staged.staged_set_id, idempotency_key: 'p3' } as never, {}),
    (e: { code?: string; message?: string }) => e.code === 'INVALID_INPUT' && /decision 77/.test(String(e.message)),
  );
  await db.close();
});

test('§17.7: release_status says what is in force and WHY anything pending is still pending', async () => {
  const db = await releaseDb();
  // one applied, one unreviewed, one rejected, one expired
  const applied = await prepareFixture(db, IDS, 'k-applied');
  await approve(db, applied.release_id, 'rev-applied');
  await releaseApply(db, 'release', { release_id: applied.release_id }, applyDeps(IDS));

  const unreviewed = await prepareFixture(db, [1, 2], 'k-unreviewed');
  const rejected = await prepareFixture(db, [3, 4], 'k-rejected');
  await reviewSubmit(db, 'reviewer', { release_id: rejected.release_id, decision: 'rejected', rationale: 'no source', idempotency_key: 'rj' });
  const expired = await prepareFixture(db, [5, 6], 'k-expired');
  const exp = (await db.query<{ hash: string }>(`SELECT hash FROM lab_v2.objects WHERE id = $1`, [expired.release_id]))[0];
  await putReview(db, {
    release_id: expired.release_id, reviewer: 'reviewer', artifact_hash: exp.hash, decision: 'approved',
    rationale: 'read', expires_at: new Date(Date.now() - 1000).toISOString(), idempotency_key: 'ex',
  });

  const out = await releaseStatus({ db, principal: 'operator' }, { limit: 5 });
  const corpus = out.targets.find((t) => t.name === 'corpus')!;
  assert.equal(corpus.revision, 1);
  assert.equal(corpus.artifact_id, applied.release_id);
  assert.ok(corpus.in_force, 'the artifact in force travels with the target');
  assert.equal(out.recent[0].kind, 'apply');
  assert.equal(out.recent[0].chunks, 3);

  const states = new Map(out.pending_approval.map((p) => [p.release_id, p.state]));
  assert.equal(states.get(unreviewed.release_id), 'unreviewed');
  assert.equal(states.get(rejected.release_id), 'rejected');
  assert.equal(states.get(expired.release_id), 'expired');
  assert.ok(!states.has(applied.release_id), 'an applied release is not pending');
  await db.close();
});

test('§17.7: corpus_stage records the ids under the label, and is content-addressed', async () => {
  const db = await releaseDb();
  const a = await stageFixture(db);
  assert.deepEqual(a.chunk_ids, IDS, 'bigint strings coerced at the boundary (decision 72)');
  assert.equal(a.source, `labq:${LABEL}`);
  assert.equal(a.added, null, 'nothing was added: this staged an existing quarantined batch');
  // The same label with the same ids IS the same staged set.
  const b = await stageFixture(db);
  assert.equal(b.staged_set_id, a.staged_set_id);
  assert.equal(b.deduplicated, true);
  // An empty label is a refusal, not an empty staged set.
  await assert.rejects(
    () => corpusStage(db, 'research', { label: 'empty-one', idempotency_key: 'e' }, { read: (async () => []) as never }),
    (e: { code?: string }) => e.code === 'CASE_NOT_FOUND',
  );
  await db.close();
});

test('§17.7: activateLabel calls v1 and reads back the ids it must be checked against', async () => {
  let called: string | null = null;
  const out = await activateLabel(LABEL, {
    activate: async (l: string) => { called = l; return { source: `lab:${l}`, activated: 3 }; },
    run: (async (_s: string, p: unknown[]) => {
      assert.deepEqual(p, [`lab:${LABEL}`], 'the read-back is keyed on the ACTIVE source');
      return IDS.map((id) => ({ id: String(id) }));
    }) as never,
  });
  assert.equal(called, LABEL);
  assert.deepEqual(out.ids, IDS);
  assert.equal(out.activated, 3);
  // ⚠️ v1 returns a COUNT, not ids, so the ids are read back rather than invented — which is what
  // makes decision 79a's post-check possible at all.
  assert.match(ACTIVATED_IDS_SQL, /^SELECT id FROM mksap_chunks WHERE source = \$1 ORDER BY id LIMIT 500$/);
});

test('§17.7 decision 86: the reader finds a row v1’s OWN quarantine ingest just wrote', async () => {
  /**
   * ⚠️ THE TEST THAT WOULD HAVE CAUGHT IT, AND WHY IT LOOKS LIKE THIS.
   *
   * Every other corpus test injects its read, so none of them ever exercised the predicate — which
   * is exactly how `WHERE source = '<label>'` reached production. This one does not inject: it
   * writes a row with **v1's own `CORPUS_QUARANTINE_INSERT_SQL`**, the statement
   * `corpusAddQuarantined` runs, into a real `mksap_chunks`, and then asks the real reader to find
   * it. If the predicate is wrong the read comes back empty and this fails.
   *
   * ⚠️ ONE SUBSTITUTION, STATED. `corpusAddQuarantined` itself cannot run here: it embeds on the
   * mini over the network and writes through production's `sql`. And PGlite 0.5.8 in this repo
   * ships no `vector` extension (`@electric-sql/pglite/vector` is not in its exports), so
   * `$9::vector` cannot execute. So the fixture runs v1's statement with the `::vector` cast
   * neutralised and NOTHING else changed — and the test asserts that is the only difference,
   * character for character, rather than asking anyone to take it on trust. The predicate under
   * test never touches `embedding`; what it depends on is `source` and the `visible = false`
   * literal, and both come from v1's statement unmodified.
   */
  const V1 = CORPUS_QUARANTINE_INSERT_SQL;
  const forPglite = V1.replace('$9::vector', '$9');
  // The ONE difference, pinned. A reworded v1 statement fails here rather than silently diverging.
  assert.equal(forPglite.split('$9').length, V1.split('$9::vector').length, 'exactly one cast was neutralised');
  assert.equal(V1.replace('$9::vector', '$9'), forPglite);
  assert.ok(V1.includes('visible'), 'v1 writes the visibility flag explicitly');
  assert.match(V1, /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9::vector, \$10, false,/,
    'and the literal it writes is FALSE — which is why the reader may carry no visibility predicate');

  const db = await embedded();
  // v1's own column list, and `visible boolean NOT NULL` as production has it. `embedding` is text
  // here for the reason above; every other column is production's type.
  await db.exec(`CREATE TABLE mksap_chunks (
    id bigserial PRIMARY KEY, source text, book text NOT NULL, chapter text, section text,
    item_number text, chunk_type text, text text NOT NULL, text_hash text NOT NULL,
    embedding text NOT NULL, token_count integer, visible boolean NOT NULL,
    citation_url text, citation_doi text, citation_pmid text, source_release_year integer,
    license_status text, provenance text, text_tsv tsvector,
    UNIQUE (book, text_hash))`);

  const label = 'lab-v2-c1-verify';
  const source = `labq:${labLabel(label)}`;
  const inserted = await db.query<{ id: string }>(forPglite, [
    source, 'Even Protocols', 'Sepsis', 'lab', '1', 'note',
    'A staged passage about early antibiotic administration in suspected sepsis.',
    'hash-c1-verify', '[0.1,0.2]', 120, null, null, null, null, null, null,
  ]);
  assert.equal(inserted.length, 1, 'v1’s statement wrote one row');
  const writtenId = Number(inserted[0].id);

  // The row has production's shape: quarantined and INVISIBLE.
  const row = (await db.query<{ source: string; visible: boolean }>(
    `SELECT source, visible FROM mksap_chunks WHERE id = $1`, [writtenId]))[0];
  assert.equal(row.source, source);
  assert.equal(row.visible, false, 'quarantine means invisible — v1’s own literal');

  // ⚠️ THE ASSERTION. The real reader, the real statement, no injection.
  const found = await readStagedIds(label, {
    read: (async <T,>(_s: string, statement: string, params: unknown[] = []) =>
      db.query(statement, params) as Promise<T[]>) as never,
  });
  assert.deepEqual(found, [writtenId],
    'the staged-set reader must find the row v1’s ingest just wrote; on 8110b22f it found nothing');

  // And it is found by the BOUND source, not by a label that happens to match.
  const byBareLabel = await db.query(STAGED_IDS_SQL, [labLabel(label)]);
  assert.equal(byBareLabel.length, 0, 'the bare label matches nothing — which is what the bug did');
  await db.close();
});

/**
 * DECISION 87 — every inferred statement is exercised against a REAL table at least once, with a
 * fixture written by the production writer.
 *
 * ⚠️ THIS IS THE RULE DECISION 86 BOUGHT. `WHERE source = '<label>'` reached production because
 * every corpus test injected its read: the statements were asserted as STRINGS and never executed.
 * A string assertion can only check what its author already believed. Running the statement can
 * check what the data actually is.
 */
async function corpusFixture(): Promise<{ db: Db; ids: number[]; source: string; label: string }> {
  const db = await embedded();
  // v1's own column list and types, `visible boolean NOT NULL` as production has it. `embedding` is
  // text here for one reason, stated in the decision 86 test: PGlite 0.5.8 ships no vector.
  await db.exec(`CREATE TABLE mksap_chunks (
    id bigserial PRIMARY KEY, source text, book text NOT NULL, chapter text, section text,
    item_number text, chunk_type text, text text NOT NULL, text_hash text NOT NULL,
    embedding text NOT NULL, token_count integer, visible boolean NOT NULL,
    citation_url text, citation_doi text, citation_pmid text, source_release_year integer,
    license_status text, provenance text, text_tsv tsvector,
    UNIQUE (book, text_hash))`);
  const label = 'c87-batch';
  const source = quarantinedSource(label);
  const insert = CORPUS_QUARANTINE_INSERT_SQL.replace('$9::vector', '$9');
  const ids: number[] = [];
  for (const [i, text] of [
    'Early antibiotics in suspected sepsis reduce mortality when given within one hour.',
    'Routine preoperative chest radiography is not indicated in asymptomatic adults.',
  ].entries()) {
    const r = await db.query<{ id: string }>(insert, [
      source, 'Even Protocols', i === 0 ? 'Sepsis' : 'Preoperative', 'lab', String(i + 1), 'note',
      text, `hash-c87-${i}`, '[0.1,0.2]', 40, null, null, null, null, null, null,
    ]);
    ids.push(Number(r[0].id));
  }
  // One SERVABLE row in the same book, so the overlap read has something real to find.
  await db.query(insert.replace(', false,', ', true,'), [
    'choosing-wisely', 'Even Protocols', 'Sepsis', 'ref', '1', 'note',
    // Shares the query's terms, so the real bm25 leg has something to rank.
    'Sepsis antibiotics: a servable passage in the same book and chapter as the staged batch.',
    'hash-c87-visible', '[0.3,0.4]', 30, null, null, null, null, null, null,
  ]);
  await db.exec(`UPDATE mksap_chunks SET text_tsv = to_tsvector('english', text)`);
  return { db, ids, source, label };
}

test('§17.7 decision 87: every corpus statement runs against a real table, on a v1-written fixture', async () => {
  const { db, ids, source, label } = await corpusFixture();
  const q = async <T,>(statement: string, params: unknown[] = []) => db.query(statement, params) as Promise<T[]>;

  // 1. the staged ids — the statement decision 86 fixed
  assert.deepEqual((await q<{ id: string }>(STAGED_IDS_SQL, [source])).map((r) => Number(r.id)), ids);
  // 2. the staged batch, with the derived columns corpus_validate reads
  const chunks = await q<Record<string, unknown>>(STAGED_CHUNKS_SQL, [source]);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].has_embedding, true);
  assert.equal(chunks[0].has_tsv, true, 'to_tsvector ran, and the statement can see it');
  assert.equal(chunks[0].visible, false, 'v1 writes quarantined rows invisible');
  assert.ok(Number(chunks[0].text_chars) > 40);
  assert.equal(String(chunks[0].preview).length <= 240, true);
  // 3. the snapshot — required by the impact estimate
  const max = await q<{ max_chunk_id: string }>(MAX_CHUNK_ID_SQL);
  assert.equal(Number(max[0].max_chunk_id), Math.max(...ids) + 1, 'the servable row is the newest');
  // 4. the servable counts — the statement that actually blew the deadline on production
  const vis = await q<Record<string, unknown>>(VISIBLE_SUMMARY_SQL);
  assert.equal(Number(vis[0].visible_chunks), 1, 'only the servable row; the two quarantined ones are excluded');
  assert.equal(Number(vis[0].visible_sources), 1);
  // 5. the overlap — bound to BOOKS, and it finds the servable twin
  const overlap = await q<Record<string, unknown>>(OVERLAP_SQL, [['Even Protocols']]);
  assert.equal(overlap.length, 1);
  assert.equal(overlap[0].book, 'Even Protocols');
  assert.equal(overlap[0].chapter, 'Sepsis');
  assert.equal(Number(overlap[0].visible_chunks), 1);
  // and a book the batch does not touch finds nothing
  assert.deepEqual(await q(OVERLAP_SQL, [['Some Other Book']]), []);
  // 6. the predecessor state
  const state = await q<Record<string, unknown>>(CHUNK_STATE_SQL(ids));
  assert.deepEqual(state.map((r) => Number(r.id)), ids);
  assert.ok(state.every((r) => r.source === source && r.visible === false));
  // 7. pg_trgm — absent here as it is on production, which is decision 83's whole case
  const trgm = await q<{ installed: boolean }>(PG_TRGM_SQL);
  assert.equal(trgm[0].installed, false);
  // 8. the bm25 candidate leg — production's own builder, run for real
  const bm25 = candidateLegs(null, Math.max(...ids) + 1).bm25;
  const hits = await q<{ id: string; rank: string }>(bm25.sql, ['sepsis antibiotics', ...bm25.params]);
  assert.ok(hits.length >= 1, 'the servable row is reachable by the real bm25 leg');
  assert.ok(!hits.some((h) => ids.includes(Number(h.id))), 'and the quarantined rows are NOT');
  // 9. side B admits exactly the named batch, through production's own seam
  const legB = candidateLegs(label, Math.max(...ids) + 1).bm25;
  const hitsB = await q<{ id: string }>(legB.sql, ['sepsis antibiotics', ...legB.params]);
  assert.ok(hitsB.some((h) => ids.includes(Number(h.id))), 'side B sees the staged batch');

  // 10. THE ONE WRITE (decision 80a), against a real table.
  const { deactivateIds: flip } = await import('../releases/corpus-writer');
  await db.query(`UPDATE mksap_chunks SET source = $1, visible = true WHERE id = ANY($2)`, [`lab:${label}`, ids]);
  const back = await flip(label, ids, { run: (async (st: string, p: unknown[]) => db.query(st, p)) as never });
  assert.deepEqual(back.ids.sort((a, b) => a - b), ids);
  const after = await q<Record<string, unknown>>(CHUNK_STATE_SQL(ids));
  assert.ok(after.every((r) => r.source === source && r.visible === false),
    'the inverse returns BOTH flags, on exactly those ids');
  await db.close();
});

test('§17.7 decision 88: a count that exceeds the deadline is SKIPPED, and the impact still returns', async () => {
  const { db, label } = await corpusFixture();
  /**
   * ⚠️ MEASURED ON PRODUCTION, 06 Sep 2026, before anything was changed: `count(DISTINCT source)`
   * over 2,247,994 servable rows takes 30,527 ms and `count(*)` 14,223 ms, against a 15 s deadline.
   * `max(id)` is 178 ms and the overlap read is 57 ms. Decision 88 attributes the timeout to the
   * overlap; it is the counts. Both degrade now, and neither takes the tool down with it.
   */
  const slow = new LabError('SOURCE_UNAVAILABLE', 'mksap_chunks exceeded the 15000 ms read deadline');
  const read = (async <T,>(_s: string, statement: string, params: unknown[] = []): Promise<T[]> => {
    if (statement === VISIBLE_SUMMARY_SQL || statement === OVERLAP_SQL) throw slow;
    return db.query(statement, params) as Promise<T[]>;
  }) as never;
  const out = await corpusDiff(db, { label, queries: ['sepsis antibiotics'], k: 3 }, { read, embed: async () => [0.1, 0.2] });

  assert.equal(out.visible_status, 'skipped');
  assert.equal(out.overlap_status, 'skipped');
  // ⚠️ NULL, NEVER ZERO. A zero here would read as "the corpus is empty".
  assert.equal(out.visible.chunks, null);
  assert.equal(out.visible.sources, null);
  assert.deepEqual(out.overlap, []);
  assert.match(String(out.skipped_detail!.visible), /^skipped: /);
  assert.match(String(out.skipped_detail!.overlap), /15000 ms/);
  // The parts that matter still came back.
  assert.ok(out.visible.max_chunk_id > 0, 'the snapshot is required and is its own fast statement');
  assert.equal(out.staged.chunks, 2);
  assert.equal(out.impact.model_calls, 0);
  assert.equal(out.impact.queries, 1);
  assert.equal(out.impact.snapshot_max_chunk_id, out.visible.max_chunk_id);
  await db.close();
});

test('§17.7 decision 88: the overlap is keyed to the staged books and filtered to the staged pairs', async () => {
  const { db, label } = await corpusFixture();
  let boundTo: unknown = null;
  const read = (async <T,>(_s: string, statement: string, params: unknown[] = []): Promise<T[]> => {
    if (statement === OVERLAP_SQL) {
      boundTo = params[0];
      // The same book, a DIFFERENT chapter: indexable by book, and not a pair the batch has.
      return [
        { book: 'Even Protocols', chapter: 'Sepsis', visible_chunks: '1' },
        { book: 'Even Protocols', chapter: 'Cardiology', visible_chunks: '900' },
      ] as unknown as T[];
    }
    return db.query(statement, params) as Promise<T[]>;
  }) as never;
  const out = await corpusDiff(db, { label, queries: ['sepsis'], k: 3 }, { read, embed: async () => [0.1, 0.2] });
  assert.deepEqual(boundTo, ['Even Protocols'], 'bound by BOOK — the column that has an index');
  // ⚠️ The pair filter is what keeps the answer exact: `Cardiology` is the same book and is not a
  // chapter this batch stages, so it is not overlap.
  assert.deepEqual(out.overlap, [{ book: 'Even Protocols', chapter: 'Sepsis', visible_chunks: 1 }]);
  assert.equal(out.overlap_status, 'ok');
  assert.equal(out.skipped_detail, null);
  await db.close();
});

test('§17.7: the 0002 migration is applied by the same route, and is checksum-stable', async () => {
  const files = migrationFiles();
  assert.deepEqual(files.map((f) => f.name), ['0001_platform.sql', '0002_releases.sql']);
  const db = await embedded();
  const first = await applyMigrations(db, files);
  assert.deepEqual(first.applied, ['0001_platform.sql', '0002_releases.sql']);
  // Idempotent: the route may be opened twice.
  const second = await applyMigrations(db, files);
  assert.deepEqual(second.applied, []);
  assert.deepEqual(second.skipped, ['0001_platform.sql', '0002_releases.sql']);
  // ⚠️ An EDITED file that was already applied is an error, never a silent re-apply.
  await assert.rejects(
    () => applyMigrations(db, [{ ...files[1], sql: `${files[1].sql}\n-- edited`, checksum: 'different' }]),
    (e: LabError) => e.code === 'STORE_UNAVAILABLE',
  );
  await db.close();
});
