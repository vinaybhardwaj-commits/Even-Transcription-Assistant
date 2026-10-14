/**
 * scripts/telemetry-overhead-measure.mjs — step 21, D18's five overhead numbers and three extras.
 *
 *   node --import tsx scripts/telemetry-overhead-measure.mjs
 *   node --import tsx scripts/telemetry-overhead-measure.mjs --cold-probe   # one cold activeRun sample
 *
 * ⚠️ EVERY NUMBER THIS PRINTS IS SYNTHETIC, AND EVERY NUMBER IS A FLOOR.
 * The database is `lib/__tests__/telemetry-db-stub.ts`, which answers over a replaced
 * `globalThis.fetch` with no network, no planner, no lock and no disk. The provider is
 * `lib/__tests__/judge-server-stub.ts` on 127.0.0.1. So what is measured here is the COST OF THE
 * CODE PATH — argument marshalling, canonicalisation, the SQL string build, the driver's own
 * encode/decode — and not the cost of the statement in Neon. A production number is this plus a
 * round trip plus whatever the database is doing at the time. Nothing here predicts production, and
 * nothing here is a threshold: D18 leaves thresholds to V, who judges start-write latency against
 * the throttling behaviour it could perturb rather than against a generic budget.
 *
 * ⚠️ NOTHING RUNS AGAINST A PRODUCTION DATABASE, AND NOTHING IS DEPLOYED TO MEASURE. The only
 * socket this opens is to 127.0.0.1.
 *
 * DISTRIBUTIONS, NEVER MEANS. Every figure is reported as minimum / median / maximum with its
 * sample size. A mean hides the tail and the tail is the part that perturbs a throttling boundary.
 */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { installDbStub } from '../lib/__tests__/telemetry-db-stub.ts';
import { startJudgeServer } from '../lib/__tests__/judge-server-stub.ts';

// ── sample sizes, and why ──────────────────────────────────────────────────────────────────────
// The cheap in-process paths (numbers 1, 2, 3, 6) settle within a few hundred iterations and their
// spread is dominated by GC and JIT warm-up, so 300 gives a stable median while still showing the
// tail those two produce. The retrieval paths (4, 5) each do one expansion, one embedding and five
// judge round trips over loopback at roughly 10–20 ms, so 40 keeps the whole script inside a few
// seconds while giving a median over enough samples to be readable. Cold `activeRun` (7) can only
// be sampled ONCE per process — `ensured` is module state (`lib/backfill-runs.ts:39`) — so each
// cold sample is a fresh child process, and 12 of them is the point where the median stopped moving.
const N_CHEAP = 300;
const N_RETRIEVAL = 40;
const N_COLD = 12;

const AT = '2026-08-13T00:00:00.000Z';
const AUDIT_ID = '11111111-1111-1111-1111-111111111111';

const ctx = {
  invocationId: 'inv-measure', route: 'opd_audit_worker', routeClass: 'worker',
  deploymentSha: 'sha', vercelRequestId: null, startedAt: AT, routingFlags: {},
};
const operational = (role) => ({
  route: 'opd_audit_worker', route_class: 'worker', retrieval_role: role,
  invocation_id: ctx.invocationId, trace_id: null, deployment_sha: 'sha',
  started_at: AT, completed_at: AT, routing_flags: {},
  active_backfill_run_id: null, active_backfill_target: null, active_backfill_state: null,
  active_lab_experiment_id: null,
});

// ── statistics ─────────────────────────────────────────────────────────────────────────────────
function stats(samples) {
  const s = samples.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return {
    n: s.length,
    min: s[0],
    median: s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2,
    max: s[s.length - 1],
  };
}
const ms = (v) => `${v.toFixed(4)} ms`;
const rows = [];
function report(group, name, unit, st, note = '') {
  rows.push({ group, name, unit, ...st, note });
  const fmt = unit === 'ms' ? ms : (v) => `${Math.round(v)} ${unit}`;
  console.log(
    `  ${name.padEnd(46)} min ${fmt(st.min).padStart(12)}   median ${fmt(st.median).padStart(12)}`
    + `   max ${fmt(st.max).padStart(12)}   n=${st.n}${note ? `   ${note}` : ''}`,
  );
}
async function timeIt(n, fn) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fn(i);
    out.push(performance.now() - t0);
  }
  return stats(out);
}

// ── the cold-probe child ───────────────────────────────────────────────────────────────────────
// `activeRun` is not one round trip: it awaits `ensureRunsTable()`, which on a COLD invocation
// issues a CREATE TABLE and two CREATE INDEX before the SELECT — four statements — and one on every
// later call (kickoff line 102). `ensured` is module state, so cold can only be observed once per
// process, and a fresh process is exactly what a cold serverless invocation is.
async function coldProbe() {
  const db = installDbStub();
  db.on(/CREATE TABLE IF NOT EXISTS backfill_runs/, []);
  db.on(/CREATE (UNIQUE )?INDEX IF NOT EXISTS backfill_runs/, []);
  db.on(/FROM backfill_runs/, []);
  const { activeRun } = await import('../lib/backfill-runs.ts');
  const t0 = performance.now();
  await activeRun('opd');
  const dt = performance.now() - t0;
  process.stdout.write(`COLD_SAMPLE ${dt}\n`);
  process.stdout.write(`COLD_STATEMENTS ${db.calls.length}\n`);
}

async function main() {
  if (process.argv.includes('--cold-probe')) return coldProbe();

  const scriptStart = performance.now();
  console.log('CDMSS rerank telemetry — step 21 overhead measurement');
  console.log('ALL NUMBERS SYNTHETIC. Stubbed database, loopback provider. A floor, not a prediction.\n');

  const judge = await startJudgeServer();
  const db = installDbStub();

  // Case C's fixture, reused verbatim so numbers 4 and 5 are measured on the production-shaped
  // retrieval the invariance test already pins (addendum v3 §8).
  const VEC = Array.from({ length: 26 }, (_, i) => ({ id: 301 + i, rank: i + 1 }));
  const BM = [{ id: 301, rank: 1 }, { id: 303, rank: 2 }, { id: 305, rank: 3 }];
  const FUSED = [301, 303, 305, 302, 304, 306, 307, 308, 309, 310, 311, 312,
    313, 314, 315, 316, 317, 318, 319, 320, 321, 322, 323, 324];
  const PROFILES = [
    { book: 'MKSAP 19', source: 'mksap-19', chunk_type: 'explanation', token_count: 500 },
    { book: 'StatPearls', source: 'statpearls', chunk_type: 'narrative', token_count: 500 },
    { book: 'Journal of Minor Findings', source: 'pubmed', chunk_type: null, token_count: 30 },
  ];
  const HYD = VEC.map(({ id }) => {
    const p = PROFILES[Math.max(0, FUSED.indexOf(id)) % 3];
    return {
      id, source: p.source, book: p.book, chapter: `Chapter ${id}`, section: `Section ${id}`,
      page_start: id, page_end: id + 1, item_number: `IT-${id}`, chunk_type: p.chunk_type,
      text: `MRK${id} a clinical passage used only by this measurement, numbered ${id}.`,
      token_count: p.token_count, similarity: 0.9 - id / 1000, source_quality_weight: 1.0,
    };
  });
  judge.setScores(Object.fromEntries(FUSED.map((id, k) => [`MRK${id}`, Number((10 - k * 0.35).toFixed(4))])));

  const S4 = /ROW_NUMBER\(\) OVER \(ORDER BY embedding <=> \$1::vector\)[\s\S]*NOT LIKE 'labq:%'/;
  const S5A = /ts_rank_cd\(text_tsv, plainto_tsquery/;
  const S7 = /COALESCE\(source_quality_weight/;
  const INSERT_RUNS = /INSERT INTO opd_audit_retrieval_telemetry/;
  const UPDATE_TERMINAL = /SET persistence_state = 'retrieval_complete'/;
  const SELECT_ROW = /SELECT persistence_state, row_revision, audit_id/;
  const UPDATE_SETTLE = /SET persistence_state = \$3, audit_id = \$4/;
  const INSERT_INVOCATION = /INSERT INTO opd_retrieval_invocations/;

  db.on(S4, VEC);
  db.on(S5A, BM);
  db.on(S7, HYD);
  db.on(INSERT_RUNS, (c) => {
    const cols = 14;
    const out = [];
    for (let i = 0; i < c.params.length / cols; i++) out.push({ retrieval_run_id: String(c.params[i * cols]) });
    return out;
  });
  db.on(UPDATE_TERMINAL, [{ row_revision: 1 }]);
  db.on(SELECT_ROW, [{ persistence_state: 'retrieval_complete', row_revision: 1, audit_id: null }]);
  db.on(UPDATE_SETTLE, (c) => [{ row_revision: Number(c.params[1]) + 1 }]);
  db.on(INSERT_INVOCATION, []);
  db.on(/CREATE TABLE IF NOT EXISTS backfill_runs/, []);
  db.on(/CREATE (UNIQUE )?INDEX IF NOT EXISTS backfill_runs/, []);
  db.on(/FROM backfill_runs/, []);

  const store = await import('../lib/retrieval-telemetry-store.ts');
  const settlement = await import('../lib/retrieval-settlement.ts');
  const capture = await import('../lib/retrieval-capture.ts');
  const core = await import('../lib/retrieval-telemetry-core.ts');
  const { retrieve } = await import('../lib/retrieve.ts');
  const { opdRetrieveOpts } = await import('../lib/opd-note-audit.ts');
  const { activeRun } = await import('../lib/backfill-runs.ts');

  const OPTS = Object.freeze(opdRetrieveOpts(false, {}));
  const QUERY = 'what is the management of acute pericarditis';

  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log('THE FIVE (PRD §6.5, D18)\n');

  // 1 ── START-WRITE LATENCY. The worker declares one `primary` run per note in ONE statement for
  // the whole day's batch (`declareNoteRuns`), so the per-note figure is the batch divided by its
  // size and both are reported: the batch is what a request waits on, the per-note is what scales.
  const BATCH = 50;
  const noteRows = Array.from({ length: BATCH }, (_, i) => ({ uid: `uid-${i}` }));
  const batchStats = await timeIt(N_CHEAP, () => store.declareNoteRuns(ctx, noteRows, '0.81.21'));
  report('five', `1. start-write latency, batch of ${BATCH}`, 'ms', batchStats);
  report('five', '1. start-write latency, per note', 'ms', {
    n: batchStats.n, min: batchStats.min / BATCH, median: batchStats.median / BATCH, max: batchStats.max / BATCH,
  }, '(derived: batch ÷ 50, one statement)');

  // 2 ── TERMINAL-WRITE LATENCY, PER ROLE. Built on a real case C capture so the payload is the
  // size production would write, not an empty one.
  const liveCapture = capture.createTelemetryCapture('primary');
  await retrieve(QUERY, OPTS, liveCapture);
  const primaryPayload = capture.buildRetrievalPayload(liveCapture, { hmacKey: 'measurement-key', scorerContext: '' });
  const normCapture = capture.createTelemetryCapture('normative_channel');
  await retrieve(QUERY, OPTS, normCapture);
  const normPayload = capture.buildRetrievalPayload(normCapture, { hmacKey: 'measurement-key', scorerContext: null });

  const handleFor = (role) => ({
    invocationId: ctx.invocationId, persistenceIntent: 'will_persist',
    runs: [{ role, runId: randomUUID(), expectedRevision: 0 }],
  });
  for (const [role, payload] of [['primary', primaryPayload], ['normative_channel', normPayload]]) {
    const st = await timeIt(N_CHEAP, () => store.writeRetrievalTerminal(handleFor(role), role, {
      payload, operational: operational(role), traceId: null, completedAt: AT,
    }));
    report('five', `2. terminal-write latency, ${role}`, 'ms', st);
  }

  // 3 ── MANIFEST SIZE, PER ROLE. The serialized bytes actually bound to the jsonb column, which is
  // `canonicalJson(manifest)` at `lib/retrieval-telemetry-store.ts:318`, not JSON.stringify of the
  // payload alone. Measured once per role — it is a size, not a timing, so its "distribution" is a
  // single value and is reported as one rather than dressed up as three.
  for (const [role, payload] of [['primary', primaryPayload], ['normative_channel', normPayload]]) {
    const bytes = Buffer.byteLength(core.canonicalJson({ ...payload, operational: operational(role) }), 'utf8');
    report('five', `3. manifest size, ${role}`, 'bytes', { n: 1, min: bytes, median: bytes, max: bytes },
      '(24 hydrated candidates, 5 batches)');
  }

  // 4 ── RETRIEVAL WALL TIME, INSTRUMENTATION ON VERSUS OFF. Identical environment on both sides:
  // the same stub, the same judge server, the same frozen opts object — addendum v1 decision 9's
  // amended wording, and the same comparison test 60 case C makes.
  //
  // ⚠️ WARMED UP AND INTERLEAVED, BECAUSE THE FIRST VERSION OF THIS MEASUREMENT WAS WRONG. Timing
  // all the OFF samples and then all the ON samples reported instrumentation as FASTER than no
  // instrumentation — the OFF arm paid the JIT warm-up for both. The arms are now alternated within
  // one loop and the differences are PAIRED by iteration, so warm-up, GC and any drift hit both
  // arms equally instead of landing on whichever ran first.
  for (let i = 0; i < 10; i++) { await retrieve(QUERY, OPTS); await retrieve(QUERY, OPTS, capture.createTelemetryCapture('primary')); }
  const offSamples = []; const onSamples = []; const deltas = [];
  for (let i = 0; i < N_RETRIEVAL; i++) {
    // The capture is built OUTSIDE the timed region: `retrieve` never allocates one, its caller
    // does, so what is compared is the cost of the retrieval itself under each condition.
    const cap = capture.createTelemetryCapture('primary');
    const a0 = performance.now(); await retrieve(QUERY, OPTS); const off = performance.now() - a0;
    const b0 = performance.now(); await retrieve(QUERY, OPTS, cap); const on = performance.now() - b0;
    offSamples.push(off); onSamples.push(on); deltas.push(on - off);
  }
  const offStats = stats(offSamples);
  const onStats = stats(onSamples);
  report('five', '4. retrieval wall time, instrumentation OFF', 'ms', offStats);
  report('five', '4. retrieval wall time, instrumentation ON', 'ms', onStats);
  report('five', '4. retrieval wall time, ON − OFF, PAIRED', 'ms', stats(deltas),
    '(same iteration, interleaved; negative = noise exceeds the effect)');

  // 5 ── AUDIT COMPLETION RATE, ON VERSUS OFF. Counted, not timed.
  // ⚠️ ITS LIMIT, STATED. Against a stub that never fails, both arms complete every time, so this
  // number can only ever falsify the claim, never confirm it. A rate below 100% here would mean
  // instrumentation broke a retrieval outright; 100% on both arms means it did not, and says
  // nothing about production failure modes the stub cannot produce.
  let okOff = 0; let okOn = 0;
  for (let i = 0; i < N_RETRIEVAL; i++) {
    try { const r = await retrieve(QUERY, OPTS); if (r.hits.length > 0) okOff++; } catch { /* counted as incomplete */ }
    try {
      const r = await retrieve(QUERY, OPTS, capture.createTelemetryCapture('primary'));
      if (r.hits.length > 0) okOn++;
    } catch { /* counted as incomplete */ }
  }
  const pct = (k) => (100 * k) / N_RETRIEVAL;
  report('five', '5. audit completion rate, OFF', '%', { n: N_RETRIEVAL, min: pct(okOff), median: pct(okOff), max: pct(okOff) });
  report('five', '5. audit completion rate, ON', '%', { n: N_RETRIEVAL, min: pct(okOn), median: pct(okOn), max: pct(okOn) });

  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\nTHE THREE EXTRAS (reported separately, not part of the five)\n');

  // 6 ── SETTLEMENT WRITE LATENCY, PER ROLE.
  for (const role of ['primary', 'normative_channel']) {
    const st = await timeIt(N_CHEAP, () => settlement.settleRetrievalTelemetry(
      { invocationId: ctx.invocationId, persistenceIntent: 'will_persist',
        runs: [{ role, runId: randomUUID(), expectedRevision: 1 }] },
      { outcome: 'persisted_clean', auditId: AUDIT_ID, settledAt: AT },
    ));
    report('extra', `6. settlement write latency, ${role}`, 'ms', st);
  }

  // 7 ── activeRun('opd'), COLD AND WARM.
  const coldSamples = [];
  let coldStatements = null;
  for (let i = 0; i < N_COLD; i++) {
    const r = spawnSync(process.execPath, ['--import', 'tsx', process.argv[1], '--cold-probe'], { encoding: 'utf8' });
    const m = /COLD_SAMPLE ([\d.]+)/.exec(r.stdout ?? '');
    const s = /COLD_STATEMENTS (\d+)/.exec(r.stdout ?? '');
    if (m) coldSamples.push(Number(m[1]));
    if (s) coldStatements = Number(s[1]);
  }
  if (coldSamples.length) {
    report('extra', '7. activeRun(\'opd\') COLD, fresh process', 'ms', stats(coldSamples),
      `(${coldStatements} statements: CREATE TABLE + 2 CREATE INDEX + SELECT)`);
  } else {
    console.log('  7. activeRun COLD — no samples collected; see Part X');
  }
  const warmStats = await timeIt(N_CHEAP, () => activeRun('opd'));
  report('extra', '7. activeRun(\'opd\') WARM, same process', 'ms', warmStats, '(1 statement: SELECT)');

  // 8 ── THE SUM OF ALL ADDED WRITES PER AUDITED NOTE. Counted from the stub, not reasoned about:
  // one instrumented note's whole telemetry path, start to settled.
  db.reset();
  db.on(S4, VEC); db.on(S5A, BM); db.on(S7, HYD);
  db.on(INSERT_RUNS, (c) => [{ retrieval_run_id: String(c.params[0]) }]);
  db.on(UPDATE_TERMINAL, [{ row_revision: 1 }]);
  db.on(SELECT_ROW, [{ persistence_state: 'retrieval_complete', row_revision: 1, audit_id: null }]);
  db.on(UPDATE_SETTLE, (c) => [{ row_revision: Number(c.params[1]) + 1 }]);
  db.on(INSERT_INVOCATION, []);
  const before = db.calls.length;
  const inv = { ...ctx, invocationId: randomUUID() };
  const oneCapture = capture.createTelemetryCapture('primary');
  const h0 = await store.declareRetrievals(inv, [{ role: 'primary', runId: randomUUID(), uid: 'u', engineVersion: 'e' }], 'will_persist');
  await retrieve(QUERY, OPTS, oneCapture);
  const h1 = await store.writeRetrievalTerminal(h0, 'primary', {
    payload: capture.buildRetrievalPayload(oneCapture, { hmacKey: 'measurement-key', scorerContext: '' }),
    operational: operational('primary'), traceId: null, completedAt: AT,
  });
  await settlement.settleRetrievalTelemetry(h1, { outcome: 'persisted_clean', auditId: AUDIT_ID, settledAt: AT });
  const added = db.calls.slice(before).filter((c) => !S4.test(c.query) && !S5A.test(c.query) && !S7.test(c.query));
  console.log(`  8. added writes per audited note: ${added.length} statements`);
  for (const c of added) console.log(`       ${c.query.trim().split('\n')[0].slice(0, 74)}`);
  console.log('       (the three retrieval SELECTs are excluded — they are not added by telemetry)');
  rows.push({ group: 'extra', name: '8. added writes per audited note', unit: 'statements', n: 1, min: added.length, median: added.length, max: added.length, note: '' });

  await judge.close();
  console.log(`\nscript wall clock: ${((performance.now() - scriptStart) / 1000).toFixed(2)} s`);
  console.log('EVERY NUMBER ABOVE IS SYNTHETIC AND IS A FLOOR. No thresholds are proposed.');
}

main().catch((e) => { console.error(e); process.exit(1); });
