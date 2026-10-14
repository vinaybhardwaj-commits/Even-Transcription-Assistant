/**
 * LAB-MCP-V2 §17.7 round C3 — `review_queue` (decision 97), `report_export`'s new sections
 * (item 3), decision 96's two totals (item 4), and `run_diff`'s `paired_on` (item 5).
 *
 * ⚠️ THE MOST IMPORTANT TEST IN THIS FILE IS THE GROUNDING ONE. §17.7's C3 grounding note says the
 * stored `experiment_compare` carries per-cluster `band_before` and `band_after`. It does not, and
 * `c3 grounding: the stored experiment_compare has NO per-case band rows` proves that against the
 * real writer rather than against my reading of it. Everything `review_queue` does on the band side
 * follows from that measurement, so if it ever stops being true the round should be re-read.
 *
 * ⚠️ DECISION 87 THROUGHOUT. The compare object is written by `experimentCompare` itself, the
 * pending release by `releasePrepare` and `reviewSubmit`, the applied one by `releaseApply`, and the
 * run items by `submitRun` + `claim` + `finish`. Nothing is hand-inserted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { embedded, type Db } from '../db';
import { hash } from '../contracts';
import {
  applyMigrations, claim, ensureBudget, finish, getObject, putObject, submitRun,
} from '../store';
import {
  COMPARE_OBJECTS_SQL, EXPERIMENT_RUNS_SQL, QUEUE_BASIS, USABLE_PREDICATE, reviewQueue,
} from '../tools/queue';
import { experimentCompare, runDiff } from '../tools/compare';
import {
  RECEIPTS_FOR_RELEASE_SQL, RELEASE_OBJECTS_SQL, REVIEWS_FOR_RELEASE_SQL, OBSERVATION_HANDLERS,
} from '../tools/observation';
import { retrievalCompare } from '../tools/retrieval-compare';
import { releasePrepare } from '../releases/prepare';
import { reviewSubmit } from '../releases/review';
import { BY_NAME } from '../registry';

const ROOT = process.cwd();

function migrationFiles() {
  const dir = join(ROOT, 'migrations', 'lab-v2');
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => {
    const sql = readFileSync(join(dir, name), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  });
}
async function storeDb(): Promise<Db> {
  const db = await embedded();
  await applyMigrations(db, migrationFiles());
  return db;
}

// ─────────────────────────────────────────────────────────────────────────────────────
// A real experiment: two arms, run through the production writers, then compared.
// ─────────────────────────────────────────────────────────────────────────────────────

interface CaseSpec { case_key: string; band_a: string | null; band_b: string | null; usable_b?: boolean }

async function experimentFixture(db: Db, cases: CaseSpec[]) {
  const { object: dataset } = await putObject(db, 'research', 'dataset', {
    kind: 'dataset', engine: 'opd_note_audit', replay_exactness: 'frozen',
    cases: cases.map((c) => ({ case_key: c.case_key })),
  }, 'deidentified', 'ds-c3');
  const { object: armA } = await putObject(db, 'research', 'arm', { kind: 'arm', name: 'baseline' }, 'deidentified', 'arm-a');
  const { object: armB } = await putObject(db, 'research', 'arm', { kind: 'arm', name: 'candidate' }, 'deidentified', 'arm-b');
  // `experimentBodySchema`'s full shape — experimentCompare parses it, so a partial fixture would
  // be testing the parser's error path rather than the compare.
  const { object: experiment } = await putObject(db, 'research', 'experiment', {
    kind: 'experiment', dataset_id: dataset.id, dataset_hash: dataset.hash,
    arm_ids: [armA.id, armB.id], baseline_arm_id: armA.id,
    hypothesis: 'the candidate moves bands', repeats: 1, endpoints: ['band'],
    budget_name: 'c3q', purpose: 'round C3 fixture',
  }, 'deidentified', 'exp-c3');

  const budget = await ensureBudget(db, 'research', 'c3q', 1_000_000);
  const items = cases.flatMap((c) => [
    { case_key: c.case_key, arm_hash: armA.hash, repetition: 0, payload: { engine: 'opd_note_audit', frozen: {} }, band: c.band_a, usable: true },
    { case_key: c.case_key, arm_hash: armB.hash, repetition: 0, payload: { engine: 'opd_note_audit', frozen: {} }, band: c.band_b, usable: c.usable_b !== false },
  ]);
  const { run } = await submitRun(db, 'research', 'experiment_run', experiment.id, budget.id, 'run-c3', 'h', 86_400_000, items);

  const byKey = new Map(items.map((i) => [`${i.case_key}|${i.arm_hash}`, i]));
  for (let n = 0; n < items.length; n += 1) {
    const item = await claim(db, 'w-c3');
    if (!item) break;
    const spec = byKey.get(`${item.case_key}|${item.arm_hash}`)!;
    await finish(db, item.id, item.lease_token, {
      state: 'succeeded',
      result: { summary: { engine: 'opd_note_audit', findings: 1, n_low_value: 0, band: spec.band, finding_subjects: [] }, result_hash: hash(spec) },
      error: null,
      execution_status: 'succeeded',
      assessment_status: spec.usable ? 'assessed' : 'unassessable',
      attribution_status: spec.usable ? 'verified' : 'unknown',
      outcome: 'succeeded',
    });
  }
  return { dataset, armA, armB, experiment, run };
}

// ═════════════════════════════════════════════════════════════════════════════════════
// GROUNDING — the note this round had to correct
// ═════════════════════════════════════════════════════════════════════════════════════

test('§17.7 C3 grounding: the stored experiment_compare has NO per-case band rows, only a per-arm COUNT', async () => {
  const db = await storeDb();
  const f = await experimentFixture(db, [
    { case_key: 'c1', band_a: 'amber', band_b: 'green' },
    { case_key: 'c2', band_a: 'green', band_b: 'green' },
  ]);
  await experimentCompare({ db, principal: 'research' }, { experiment_id: f.experiment.id });

  const rows = await db.query<{ id: string; kind: string; body: Record<string, unknown> }>(
    `SELECT id::text AS id, kind, body FROM lab_v2.objects WHERE body->>'kind' = 'experiment_compare'`);
  assert.equal(rows.length, 1);
  // ⚠️ THE OBJECT KIND IS `report`, NOT `experiment_compare`. The discriminator is a BODY field.
  assert.equal(rows[0].kind, 'report',
    'if this is now `experiment_compare`, COMPARE_OBJECTS_SQL must change with it');
  const serialised = JSON.stringify(rows[0].body);
  assert.ok(!serialised.includes('band_before'), 'the stored compare carries no band_before');
  assert.ok(!serialised.includes('band_after'), 'nor band_after');
  assert.ok(serialised.includes('band_changed'), 'only the per-arm count');
  const arms = rows[0].body.arms as { band_changed: number }[];
  assert.equal(arms.reduce((n, a) => n + a.band_changed, 0), 1, 'one case moved, recorded as a count');

  // And `band_before`/`band_after` DO exist in compare.ts — on run_diff's per-case output, which is
  // never persisted. That is the conflation the grounding note made.
  const src = readFileSync(join(ROOT, 'lib/lab-v2/tools/compare.ts'), 'utf8');
  assert.match(src, /band_before: sx\.band \?\? null/);
  assert.match(src, /putObject\(db, principal, 'report', report/, 'the compare is stored under the generic report kind');
});

test('§17.7 C3: the re-derivation uses compare.ts’s OWN pairing predicate', () => {
  const src = readFileSync(join(ROOT, 'lib/lab-v2/tools/compare.ts'), 'utf8');
  const normalise = (x: string) => x.replace(/\s+/g, ' ').trim();
  assert.ok(normalise(src).includes(normalise(USABLE_PREDICATE)),
    'review_queue restates compare.ts’s `usable` predicate; if that file has changed, the '
    + 're-derivation would count band changes the compare never counted');
});

// ═════════════════════════════════════════════════════════════════════════════════════
// review_queue — the two lists
// ═════════════════════════════════════════════════════════════════════════════════════

test('§17.7 C3: the two reads are bounded SELECTs over lab_v2 only', () => {
  for (const [name, sql] of [['compares', COMPARE_OBJECTS_SQL], ['experiment runs', EXPERIMENT_RUNS_SQL]] as const) {
    assert.match(sql, /^SELECT/, name);
    for (const verb of ['INSERT', 'UPDATE', 'DELETE', 'ALTER', 'DROP']) {
      assert.ok(!new RegExp(`\\b${verb}\\b`).test(sql), `${name} contains ${verb}`);
    }
    const tables = [...sql.matchAll(/\bFROM\s+([a-z0-9_.]+)/g)].map((m) => m[1]);
    for (const t of tables) assert.match(t, /^lab_v2\./, `${name} reads ${t}`);
  }
  assert.match(COMPARE_OBJECTS_SQL, /LIMIT \$2/);
  // ⚠️ BOTH HALVES OF THE DISCRIMINATOR. `kind = 'report'` alone would return every run_report and
  // every rule_simulation as well.
  assert.match(COMPARE_OBJECTS_SQL, /kind = 'report'/);
  assert.match(COMPARE_OBJECTS_SQL, /body->>'kind' = 'experiment_compare'/);
});

test('§17.7 C3 decision 97: a case whose band moved is listed with both arm hashes; one that did not is not', async () => {
  const db = await storeDb();
  const f = await experimentFixture(db, [
    { case_key: 'moved', band_a: 'amber', band_b: 'green' },
    { case_key: 'still', band_a: 'green', band_b: 'green' },
  ]);
  await experimentCompare({ db, principal: 'research' }, { experiment_id: f.experiment.id });

  const out = await reviewQueue(db, 'reviewer', { window_hours: 168 });
  assert.equal(out.model_calls, 0);
  assert.equal(out.basis, QUEUE_BASIS);
  // The one sentence §17.7 asks for: cases are listed, never scored.
  assert.match(out.basis, /neither is a ranking/i);
  assert.match(out.basis, /this tool scores nothing/i);
  assert.equal(out.totals.band_changes, 1);
  const row = out.band_changes[0];
  assert.equal(row.case_key, 'moved');
  assert.equal(row.band_before, 'amber');
  assert.equal(row.band_after, 'green');
  assert.equal(row.baseline_arm_hash, f.armA.hash, 'both arm hashes, so "which arm" is never a guess');
  assert.equal(row.arm_hash, f.armB.hash);
  assert.equal(row.experiment_id, f.experiment.id);
  assert.ok(out.compares.some((c) => c.compare_object_id === row.compare_object_id));
  assert.ok(!out.band_changes.some((b) => b.case_key === 'still'));

  // ⚠️ THE CROSS-CHECK. The re-derivation must agree with the count the compare object recorded.
  assert.equal(out.compares.length, 1);
  assert.equal(out.compares[0].band_changes_found, 1);
  assert.equal(out.compares[0].band_changed_recorded, 1);
  assert.equal(out.compares[0].consistent, true);
  assert.equal(out.compares[0].note, null);
  assert.equal(out.totals.inconsistent_compares, 0);
});

test('§17.7 C3: a case not usable on both arms is not a band change, exactly as the compare says', async () => {
  const db = await storeDb();
  const f = await experimentFixture(db, [
    // The band "moved", but the candidate arm was unassessable — the compare never paired it, and
    // neither does this. A looser predicate here would report a change the compare did not count.
    { case_key: 'unpaired', band_a: 'amber', band_b: 'green', usable_b: false },
  ]);
  await experimentCompare({ db, principal: 'research' }, { experiment_id: f.experiment.id });
  const out = await reviewQueue(db, 'reviewer', { window_hours: 168 });
  assert.equal(out.totals.band_changes, 0);
  assert.equal(out.compares[0].band_changes_found, 0);
  assert.equal(out.compares[0].band_changed_recorded, 0);
  assert.equal(out.compares[0].consistent, true);
});

test('§17.7 C3: the window excludes an older compare', async () => {
  const db = await storeDb();
  const f = await experimentFixture(db, [{ case_key: 'moved', band_a: 'amber', band_b: 'green' }]);
  await experimentCompare({ db, principal: 'research' }, { experiment_id: f.experiment.id });
  await db.query(`UPDATE lab_v2.objects SET created_at = now() - interval '20 days' WHERE body->>'kind' = 'experiment_compare'`);

  const narrow = await reviewQueue(db, 'reviewer', { window_hours: 168 });
  assert.equal(narrow.totals.compares_read, 0, 'a 7-day window excludes a 20-day-old compare');
  assert.equal(narrow.totals.band_changes, 0);
  const wide = await reviewQueue(db, 'reviewer', { window_hours: 2160 });
  assert.equal(wide.totals.compares_read, 1);
  assert.equal(wide.totals.band_changes, 1);
});

test('§17.7 C3: an inconsistent compare is REPORTED per compare, never smoothed over', async () => {
  const db = await storeDb();
  const f = await experimentFixture(db, [{ case_key: 'moved', band_a: 'amber', band_b: 'green' }]);
  await experimentCompare({ db, principal: 'research' }, { experiment_id: f.experiment.id });
  // Something moved after the compare was stored — the case the cross-check exists for.
  await db.query(
    `UPDATE lab_v2.items SET result = jsonb_set(result, '{summary,band}', '"amber"') WHERE arm_hash = $1`,
    [f.armB.hash]);

  const out = await reviewQueue(db, 'reviewer', { window_hours: 168 });
  assert.equal(out.compares[0].band_changes_found, 0);
  assert.equal(out.compares[0].band_changed_recorded, 1);
  assert.equal(out.compares[0].consistent, false);
  assert.match(String(out.compares[0].note), /re-run experiment_compare/);
  assert.equal(out.totals.inconsistent_compares, 1);
});

// ── the pending list ─────────────────────────────────────────────────────────────────

async function stagedCorpusRelease(db: Db, key: string) {
  const { object: staged } = await putObject(db, 'release', 'staged_set', {
    kind: 'staged_set', target: 'corpus', label: `c3-${key}`, chunk_ids: [1, 2],
  }, 'deidentified', `set-${key}`);
  return releasePrepare(db, 'release', {
    target: 'corpus', staged_set_id: staged.id, impact_ref: `diff-${key}`, idempotency_key: `rel-${key}`,
  }, {
    stagedIds: async () => [1, 2],
    read: (async () => [1, 2].map((id) => ({ id: String(id), source: `labq:c3-${key}`, visible: false }))) as never,
  });
}

test('§17.7 C3: pending releases carry release_status’s OWN reason, and an applied one is omitted', async () => {
  const db = await storeDb();
  const unreviewed = await stagedCorpusRelease(db, 'a');
  const rejected = await stagedCorpusRelease(db, 'b');
  await reviewSubmit(db, 'reviewer', {
    release_id: rejected.release_id, decision: 'rejected', rationale: 'the third passage is not in the source',
    idempotency_key: 'rev-b',
  });

  const out = await reviewQueue(db, 'reviewer', { window_hours: 168 });
  const byId = new Map(out.pending_releases.map((p) => [p.release_id, p]));
  const a = byId.get(unreviewed.release_id)!;
  assert.equal(a.waiting_because, 'unreviewed', 'release_status’s own word, passed through');
  assert.equal(a.target, 'corpus');
  assert.equal(a.label, 'c3-a');
  assert.equal(a.artifact_hash, unreviewed.artifact_hash);
  assert.equal(a.impact_ref, 'diff-a', 'read off the release OBJECT, which release_status does not return');
  assert.equal(a.prepared_by, 'release');
  assert.ok(a.prepared_at, 'and its creation time');
  assert.equal(a.reviews, 0);
  const b = byId.get(rejected.release_id)!;
  assert.equal(b.waiting_because, 'rejected');
  assert.equal(b.reviews, 1);
  assert.equal(out.totals.pending_releases, 2);

  // An APPLIED release leaves the queue — and the omission comes from release_status, not from here.
  const { putReceipt } = await import('../store');
  await putReceipt(db, { release_id: unreviewed.release_id, target: 'corpus', revision: 1, kind: 'apply', body: { outcome: 'applied' } });
  const after = await reviewQueue(db, 'reviewer', { window_hours: 168 });
  assert.equal(after.totals.pending_releases, 1);
  assert.deepEqual(after.pending_releases.map((p) => p.release_id), [rejected.release_id]);
});

test('§17.7 C3: review_queue is registered `review` alone, read, free, slice C-3', () => {
  const spec = BY_NAME.review_queue;
  assert.ok(spec);
  assert.deepEqual([...spec.scopes], ['review']);
  assert.equal(spec.effect, 'read');
  assert.equal(spec.cost_class, 'free');
  assert.equal(spec.slice, 'C-3');
  // ⚠️ NOT research_read. The reviewer's work list is not a second window onto what is pending.
  assert.ok(!spec.scopes.includes('research_read'));
});

// ═════════════════════════════════════════════════════════════════════════════════════
// ITEM 3 — report_export's two new sections
// ═════════════════════════════════════════════════════════════════════════════════════

test('§17.7 C3 item 3: the three release reads are bounded SELECTs over lab_v2 only', () => {
  for (const [name, sql] of [
    ['releases', RELEASE_OBJECTS_SQL], ['receipts', RECEIPTS_FOR_RELEASE_SQL], ['reviews', REVIEWS_FOR_RELEASE_SQL],
  ] as const) {
    assert.match(sql, /^SELECT/, name);
    for (const verb of ['INSERT', 'UPDATE', 'DELETE']) {
      assert.ok(!new RegExp(`\\b${verb}\\b`).test(sql), `${name} contains ${verb}`);
    }
    for (const t of [...sql.matchAll(/\bFROM\s+([a-z0-9_.]+)/g)].map((m) => m[1])) {
      assert.match(t, /^lab_v2\./, `${name} reads ${t}`);
    }
  }
  assert.match(RELEASE_OBJECTS_SQL, /LIMIT 200/);
});

async function simpleRun(db: Db, key: string) {
  const { object: dataset } = await putObject(db, 'research', 'dataset', {
    kind: 'dataset', engine: 'opd_note_audit', replay_exactness: 'frozen', cases: [{ case_key: 'k1' }],
  }, 'deidentified', `ds-${key}`);
  const { object: experiment } = await putObject(db, 'research', 'experiment', {
    kind: 'experiment', dataset_id: dataset.id, arm_ids: [], baseline_arm_id: null,
  }, 'deidentified', `exp-${key}`);
  const budget = await ensureBudget(db, 'research', `b-${key}`, 1000);
  const { run } = await submitRun(db, 'research', 'experiment_run', experiment.id, budget.id, `run-${key}`, 'h', 86_400_000,
    [{ case_key: 'k1', arm_hash: 'a', repetition: 0, payload: { engine: 'opd_note_audit', frozen: {} } }]);
  return { dataset, experiment, run };
}

test('§17.7 C3 item 3: a run with no release has NO releases key, and its report hash is unchanged', async () => {
  const db = await storeDb();
  const f = await simpleRun(db, 'norel');
  const out = await OBSERVATION_HANDLERS.report_export({ db, principal: 'research' } as never, { run_id: f.run.id } as never) as { artifact_id: string };
  const body = (await getObject(db, out.artifact_id))!.body as Record<string, unknown>;

  // ⚠️ ABSENT KEYS, NOT EMPTY ARRAYS. `putObject` is content-addressed, so an empty `releases: []`
  // would move the hash of every stored run_report in the platform.
  assert.ok(!('releases' in body), 'no releases key at all');
  assert.ok(!('reviews' in body), 'nor reviews');
  // The pre-C3 hash, proved by re-hashing the body with the two keys explicitly absent.
  const artifact = (await getObject(db, out.artifact_id))!;
  assert.equal(artifact.hash, hash(body), 'the stored hash is the hash of exactly these keys');
  assert.equal(Object.keys(body).filter((k) => k === 'releases' || k === 'reviews').length, 0);
  assert.match(String(body.caveat), /.+/, 'and the fixed single-run caveat is untouched');
});

test('§17.7 C3 item 3: a release whose impact_ref names this run carries the section, with its reviews', async () => {
  const db = await storeDb();
  const f = await simpleRun(db, 'withrel');
  // A rule_simulate artifact naming this run — the link §17.7 describes.
  const { object: sim } = await putObject(db, 'release', 'report', {
    kind: 'rule_simulation', proposal_id: 'p-1', baseline_run_id: f.run.id, changed_audits: 1,
  }, 'deidentified', 'sim-1');
  const { object: staged } = await putObject(db, 'release', 'staged_set', {
    kind: 'staged_set', target: 'corpus', label: 'c3-rel', chunk_ids: [1],
  }, 'deidentified', 'set-rel');
  const release = await releasePrepare(db, 'release', {
    target: 'corpus', staged_set_id: staged.id, impact_ref: sim.id, idempotency_key: 'rel-1',
  }, {
    stagedIds: async () => [1],
    read: (async () => [{ id: '1', source: 'labq:c3-rel', visible: false }]) as never,
  });
  await reviewSubmit(db, 'reviewer', {
    release_id: release.release_id, decision: 'approved', rationale: 'read the passage against the source',
    idempotency_key: 'rev-1',
  });

  const out = await OBSERVATION_HANDLERS.report_export({ db, principal: 'research' } as never, { run_id: f.run.id } as never) as { artifact_id: string };
  const body = (await getObject(db, out.artifact_id))!.body as Record<string, unknown>;
  const releases = body.releases as Record<string, unknown>[];
  assert.equal(releases.length, 1);
  assert.equal(releases[0].release_id, release.release_id);
  assert.equal(releases[0].target, 'corpus');
  assert.equal(releases[0].label, 'c3-rel');
  assert.equal(releases[0].artifact_hash, release.artifact_hash);
  assert.equal(releases[0].impact_ref, sim.id);
  assert.equal(releases[0].prepared_by, 'release');
  assert.equal(releases[0].state, 'prepared', 'no receipt yet');
  assert.deepEqual(releases[0].receipts, []);

  const reviews = body.reviews as Record<string, unknown>[];
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].reviewer, 'reviewer');
  assert.equal(reviews[0].decision, 'approved');
  assert.equal(reviews[0].artifact_hash, release.artifact_hash);
  assert.equal(reviews[0].bound_to_current, true, 'decision 81 — a review of another artifact is not a review of this one');
  assert.ok(reviews[0].expires_at);

  // A release whose impact_ref names a DIFFERENT run must not appear in this run's report.
  const other = await simpleRun(db, 'other');
  const otherOut = await OBSERVATION_HANDLERS.report_export({ db, principal: 'research' } as never, { run_id: other.run.id } as never) as { artifact_id: string };
  const otherBody = (await getObject(db, otherOut.artifact_id))!.body as Record<string, unknown>;
  assert.ok(!('releases' in otherBody));
});

// ═════════════════════════════════════════════════════════════════════════════════════
// ITEM 4 — decision 96
// ═════════════════════════════════════════════════════════════════════════════════════

test('§17.7 C3 decision 96: per-query counts 0, 0, 2 at k=10 give mean_overlap_at_k 0.67 and mean_overlap_pct 6.67', async () => {
  /**
   * The live shapes decision 76 reported: BM25 returned nothing on two prose queries and two hits
   * on the third, against ten on the other side. `plainto_tsquery` ANDs every term, which is why —
   * and that finding for the retrieval owner is unchanged by this fix.
   *
   * Both configurations are bm25-only, so each makes exactly one leg read and nothing is embedded.
   * The six reads arrive in order: q1-a, q1-b, q2-a, q2-b, q3-a, q3-b.
   */
  const legs: number[][] = [
    [], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    [], [11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
    [21, 22], [21, 22, 23, 24, 25, 26, 27, 28, 29, 30],
  ];
  let n = 0;
  let embeds = 0;
  const out = await retrievalCompare(
    { queries: ['q1', 'q2', 'q3'], k: 10, a: { bm25: true, embedding: false }, b: { bm25: true, embedding: false } },
    {
      embed: async () => { embeds += 1; return [0]; },
      read: async () => (legs[n++] ?? []).map((id, rank) => ({ id: String(id), rank: String(rank + 1) })),
    },
  );

  assert.equal(embeds, 0, 'no vector leg on either side, so nothing is embedded');
  assert.deepEqual(out.per_query.map((p) => p.overlap_at_k), [0, 0, 2]);
  assert.deepEqual(out.per_query.map((p) => p.overlap_pct), [0, 0, 20]);
  // ⚠️ THE UNITS FIX. The count mean under the count's name, the percent mean under the percent's.
  assert.equal(out.totals.mean_overlap_at_k, 0.67);
  assert.equal(out.totals.mean_overlap_pct, 6.67);
  assert.equal(typeof out.totals.mean_overlap_at_k, 'number');
  assert.equal(typeof out.totals.mean_overlap_pct, 'number');
  // ⚠️ NOTHING RE-MEANED UNDER AN OLD NAME: 6.67 is exactly what the old field carried, and it is
  // still available — under the name that describes it.
  assert.notEqual(out.totals.mean_overlap_at_k, out.totals.mean_overlap_pct);
  assert.equal(out.model_calls, 0);
});

test('§17.7 C3 decision 96: both totals are null when no query produced a denominator', async () => {
  const out = await retrievalCompare(
    { queries: ['q1'], k: 10, a: { bm25: true, embedding: false }, b: { bm25: true, embedding: false } },
    { embed: async () => [0], read: async () => [] },
  );
  assert.equal(out.per_query[0].overlap_at_k, 0);
  assert.equal(out.per_query[0].overlap_pct, null, 'no candidates on either side is no denominator');
  // ⚠️ NULL, NEVER 0. A mean of nothing is not agreement, and `Number(null) === 0` has cost this
  // platform a round already.
  assert.equal(out.totals.mean_overlap_at_k, null);
  assert.equal(out.totals.mean_overlap_pct, null);
});

// ═════════════════════════════════════════════════════════════════════════════════════
// ITEM 5 — run_diff's paired_on (decision 58a), verification only
// ═════════════════════════════════════════════════════════════════════════════════════

test('§17.7 C3 item 5: run_diff reports paired_on on BOTH branches of the shared-arm rule', async () => {
  const db = await storeDb();
  const budget = await ensureBudget(db, 'research', 'pd', 1000);
  const mk = async (key: string, armHash: string) => {
    const { run } = await submitRun(db, 'research', 'experiment_run', null, budget.id, key, 'h', 86_400_000,
      [{ case_key: 'c1', arm_hash: armHash, repetition: 0, payload: { engine: 'opd_note_audit', frozen: {} } }]);
    return run.id;
  };
  // Shared arms ⇒ the full triple.
  const shared = await runDiff({ db, principal: 'research' }, { run_a: await mk('d1', 'arm-x'), run_b: await mk('d2', 'arm-x') });
  assert.equal(shared.paired_on, 'case_key+arm_hash+repetition');
  assert.equal(shared.paired, 1);
  // Disjoint arms ⇒ the arm stands aside, and the output SAYS which key was used.
  const disjoint = await runDiff({ db, principal: 'research' }, { run_a: await mk('d3', 'arm-y'), run_b: await mk('d4', 'arm-z') });
  assert.equal(disjoint.paired_on, 'case_key+repetition');
  assert.equal(disjoint.paired, 1, 'decision 58a: pairing to zero on the commonest diff is the bug this fixed');
  assert.deepEqual(disjoint.arms_a, ['arm-y']);
  assert.deepEqual(disjoint.arms_b, ['arm-z']);
});
