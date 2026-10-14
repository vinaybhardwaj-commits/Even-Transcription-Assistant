/**
 *   node --experimental-strip-types --test lib/__tests__/lab-batch-core.test.ts
 * Pure core for the cohort-scoped Lab eval batch runner.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  clampN, sanitizeUids, remainingUids, parseBatchState, batchGate, LB_KEYS, LB_MAX_N, LB_MAX_COHORT,
  LB_LOCK_TTL_MS, labLockHeld, ttlBreach, ttlBreachMessage,
} from '../lab-batch-core.ts';

test('clampN clamps to 1..LB_MAX_N and floors garbage to 1', () => {
  assert.equal(clampN(2), 2);
  assert.equal(clampN(99), LB_MAX_N);
  assert.equal(clampN(0), 1);
  assert.equal(clampN(-4), 1);
  assert.equal(clampN('abc'), 1);
  assert.equal(clampN(1.9), 1);
});

test('sanitizeUids: id-safe, de-duped, capped', () => {
  assert.deepEqual(sanitizeUids(['aB1', 'aB1', 'c-D_2']), ['aB1', 'c-D_2']);
  assert.deepEqual(sanitizeUids(['bad id!', 'ok', '', null, 3, 'ok']), ['ok', '3']);
  assert.deepEqual(sanitizeUids('nope'), []);
  const big = Array.from({ length: LB_MAX_COHORT + 50 }, (_, i) => 'u' + i);
  assert.equal(sanitizeUids(big).length, LB_MAX_COHORT);
});

test('remainingUids removes the done-set, order preserved', () => {
  assert.deepEqual(remainingUids(['a', 'b', 'c', 'd'], new Set(['b', 'd'])), ['a', 'c']);
  assert.deepEqual(remainingUids(['a', 'b'], ['a', 'b']), []);
});

test('parseBatchState parses settings map', () => {
  const s = {
    [LB_KEYS.enabled]: '1',
    [LB_KEYS.experiment]: 'exp1',
    [LB_KEYS.kind]: 'opd',
    [LB_KEYS.uids]: JSON.stringify(['a', 'a', 'bad!', 'b']),
    [LB_KEYS.n]: '5',
    [LB_KEYS.window]: 'always',
    [LB_KEYS.last]: JSON.stringify({ done: 3 }),
    [LB_KEYS.error]: 'boom',
  } as Record<string, string>;
  const st = parseBatchState(s);
  assert.equal(st.enabled, true);
  assert.equal(st.experiment, 'exp1');
  assert.deepEqual(st.uids, ['a', 'b']);
  assert.equal(st.n, LB_MAX_N);            // 5 clamped
  assert.equal(st.window, 'always');
  assert.deepEqual(st.last, { done: 3 });
  assert.equal(st.lastError, 'boom');
});

test('parseBatchState defaults', () => {
  const st = parseBatchState({});
  assert.equal(st.enabled, false);
  assert.equal(st.experiment, null);
  assert.equal(st.kind, 'opd');
  assert.deepEqual(st.uids, []);
  assert.equal(st.n, 2);                    // default
  assert.equal(st.window, 'night');
  assert.equal(st.evalRerankBackend, null); // absent ⇒ today's retrieval path exactly
});

test('evalRerankBackend (Addendum C): exact match only — judge/cohere parse, everything else is null', () => {
  const k = LB_KEYS.evalRerankBackend;
  assert.equal(parseBatchState({ [k]: 'judge' }).evalRerankBackend, 'judge');
  assert.equal(parseBatchState({ [k]: 'cohere' }).evalRerankBackend, 'cohere');
  // The live-defect value and every non-exact variant resolve to null (today's path), never guessed:
  for (const bad of ['Cohere', 'COHERE', ' cohere ', 'cohre', '', '1']) {
    assert.equal(parseBatchState({ [k]: bad }).evalRerankBackend, null, `${JSON.stringify(bad)} must not select a backend`);
  }
});

test('evalRerankBackend threads batch state → evalCfg → runMiniOpdToLab (source-pinned)', () => {
  // The tick's evalCfg construction is inline in batchTick; pin the thread at the source so a
  // refactor cannot silently drop the arm parameter (same pattern as the §5.6 audit-path pins).
  const lab = readFileSync('lib/lab-batch.ts', 'utf8');
  assert.ok(lab.includes('rerankBackend: st.evalRerankBackend ?? undefined'),
    'batchTick must thread the parsed backend into evalCfg');
  assert.ok(lab.includes('rerankBackend: evalCfg.rerankBackend'),
    'runMiniOpdToLab must pass it into auditOpdNote');
  assert.ok(lab.includes('rerank: evalCfg.rerankBackend ?? null'),
    'the lab row eval provenance must stamp the arm');
  // And the MCP surface: schema enum + strict write-side rejection + the settings write.
  const mcp = readFileSync('lib/mcp-tools.ts', 'utf8');
  assert.ok(mcp.includes("evalRerankBackend: { type: 'string', enum: ['judge', 'cohere']"),
    'lab_batch_start must expose evalRerankBackend with the exact enum');
  assert.ok(mcp.includes("evalRerankBackend must be exactly 'judge' or 'cohere'"),
    'an unrecognised value must ERROR at the tool boundary, not be stored or dropped');
  assert.ok(mcp.includes('setSetting(LB_KEYS.evalRerankBackend, evalRerankBackend)'),
    'the accepted value must be persisted under the LB_KEYS key');
});

test('batchGate precedence', () => {
  const base = { enabled: true, hasJob: true, windowOpen: true, lockHeld: false, miniBusy: false };
  assert.equal(batchGate(base), null);
  assert.equal(batchGate({ ...base, enabled: false }), 'disabled');
  assert.equal(batchGate({ ...base, hasJob: false }), 'no_job');
  assert.equal(batchGate({ ...base, windowOpen: false }), 'outside_window');
  assert.equal(batchGate({ ...base, lockHeld: true }), 'locked');
  assert.equal(batchGate({ ...base, miniBusy: true }), 'mini_busy');
});

// ── lock TTL fix (CDMSS-LAB-BATCH-LOCK-PRD, 27 Jul 2026) ──────────────────────
//
// NOTE ON PURITY: these tests deliberately do NOT import lib/mini-backfill.ts to compare against the
// real lockHeld. That module imports ./db, which breaks the --experimental-strip-types contract this
// file is required to keep (verified: it fails with ERR_MODULE_NOT_FOUND on lib/db). MB_LOCK_TTL_MS
// is therefore asserted as the documented literal 210_000 and lockHeld's semantics are re-stated
// locally. If the prod TTL ever changes, this comparison goes stale silently — that is the tradeoff,
// and it is why MB_LOCK_TTL_MS is on the PRD's untouched hard list.
const MB_LOCK_TTL_MS_DOCUMENTED = 210 * 1000;
/** mini-backfill.lockHeld's semantics, re-stated locally so the mirroring can be asserted without
 *  importing a db-bound module. Kept byte-for-byte identical to that function's body. */
const prodLockHeld = (lockTs: string | null, now: Date): boolean => {
  if (!lockTs) return false;
  const t = Date.parse(lockTs);
  return Number.isFinite(t) && now.getTime() - t < MB_LOCK_TTL_MS_DOCUMENTED;
};
test('LB_LOCK_TTL_MS is 900s and is NOT the prod worker\'s TTL (D1)', () => {
  assert.equal(LB_LOCK_TTL_MS, 900 * 1000);
  // The whole point of D1: the two workers no longer share one constant. 210s expired before the
  // MEASURED average note (212.8s) finished, which is how concurrent ticks became possible.
  assert.notEqual(LB_LOCK_TTL_MS, MB_LOCK_TTL_MS_DOCUMENTED);
  assert.ok(LB_LOCK_TTL_MS > 513_700, 'must cover the measured 513.7s max');
});

test('labLockHeld mirrors mini-backfill.lockHeld exactly, differing ONLY in the TTL', () => {
  const now = new Date('2026-07-27T04:00:00.000Z');
  const at = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();
  // absent / empty / unparseable ⇒ false, identically in both
  for (const bad of [null, '', 'not-a-date']) {
    assert.equal(labLockHeld(bad as string | null, now), false, String(bad));
    assert.equal(prodLockHeld(bad as string | null, now), false, String(bad));
  }
  // fresh ⇒ held in both
  assert.equal(labLockHeld(at(1000), now), true);
  assert.equal(prodLockHeld(at(1000), now), true);
  // the ONLY divergence: between the two TTLs the lab lock is still held, the prod one is not
  const between = at(300 * 1000);
  assert.equal(labLockHeld(between, now), true, 'still held at 300s under a 900s TTL');
  assert.equal(prodLockHeld(between, now), false, 'expired at 300s under the 210s TTL');
  // boundary is strict `<` in both
  assert.equal(labLockHeld(at(LB_LOCK_TTL_MS), now), false);
  assert.equal(labLockHeld(at(LB_LOCK_TTL_MS - 1), now), true);
});

test('THE DEFECT, reproduced: the average note outlived the old TTL', () => {
  const now = new Date('2026-07-27T04:00:00.000Z');
  const avgNoteMs = 212_800;   // MEASURED, 38 runs of det_model_independence_mini
  const lockSetAt = new Date(now.getTime() - avgNoteMs).toISOString();
  // under the OLD behaviour the batch's lock had already expired mid-note ⇒ a second tick could start
  assert.equal(prodLockHeld(lockSetAt, now), false, 'MB_LOCK_TTL_MS=210s expires before an average note');
  // under the fix it is still held
  assert.equal(labLockHeld(lockSetAt, now), true);
});

test('ttlBreach reports the max observed ms and whether it reached the TTL', () => {
  assert.deepEqual(ttlBreach([{ ms: 100 }, { ms: 900 }, { ms: 50 }], 1000), { breach: false, maxMs: 900 });
  assert.deepEqual(ttlBreach([{ ms: 1000 }], 1000), { breach: true, maxMs: 1000 }, 'boundary is >=');
  assert.deepEqual(ttlBreach([{ ms: 1500 }], 1000), { breach: true, maxMs: 1500 });
  // defaults to LB_LOCK_TTL_MS
  assert.equal(ttlBreach([{ ms: 513_700 }]).breach, false, '513.7s is inside the 900s TTL');
  assert.equal(ttlBreach([{ ms: 900_000 }]).breach, true);
});

test('ttlBreach is pure observation: never throws, ignores non-numeric ms, empty ⇒ 0', () => {
  assert.deepEqual(ttlBreach([], 1000), { breach: false, maxMs: 0 });
  assert.deepEqual(ttlBreach([{}], 1000), { breach: false, maxMs: 0 });
  // a per-note error row carries ms too, and a malformed one must not poison the max
  assert.deepEqual(ttlBreach([{ ms: undefined }, { ms: 5 }] as { ms?: number }[], 1000), { breach: false, maxMs: 5 });
  assert.doesNotThrow(() => ttlBreach(null as unknown as { ms?: number }[], 1000));
  assert.doesNotThrow(() => ttlBreach([{ ms: 'abc' }, { ms: NaN }, { ms: Infinity }] as unknown as { ms?: number }[], 1000));
  assert.deepEqual(ttlBreach([{ ms: 'abc' }, { ms: NaN }] as unknown as { ms?: number }[], 1000), { breach: false, maxMs: 0 });
});

test('the breach message is verbatim per PRD §5, with both numbers interpolated', () => {
  const msg = ttlBreachMessage(513700, 900000);
  assert.equal(msg,
    'LOCK TTL BREACH: a note took 513700ms against LB_LOCK_TTL_MS=900000ms.\n' +
    'Concurrent ticks are now possible and duplicate rows will follow.\n' +
    'Raise LB_LOCK_TTL_MS above observed latency.');
});

test('batchGate ordering is UNCHANGED by this build', () => {
  const g = (o: Partial<Parameters<typeof batchGate>[0]>) =>
    batchGate({ enabled: true, hasJob: true, windowOpen: true, lockHeld: false, miniBusy: false, ...o });
  assert.equal(g({ enabled: false, hasJob: false, windowOpen: false, lockHeld: true, miniBusy: true }), 'disabled');
  assert.equal(g({ hasJob: false, windowOpen: false, lockHeld: true, miniBusy: true }), 'no_job');
  assert.equal(g({ windowOpen: false, lockHeld: true, miniBusy: true }), 'outside_window');
  assert.equal(g({ lockHeld: true, miniBusy: true }), 'locked');
  assert.equal(g({ miniBusy: true }), 'mini_busy');
  assert.equal(g({}), null);
});
