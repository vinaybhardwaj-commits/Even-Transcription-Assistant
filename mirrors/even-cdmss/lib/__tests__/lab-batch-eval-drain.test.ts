// lib/__tests__/lab-batch-eval-drain.test.ts — R-11 Phase 2 eval-drain concurrency. The mini path
// (no evalModel) must stay byte-identical (n≤2, serial, mini-yield honoured); the eval path fans out
// bounded via OpenRouter and skips the mini-yield. Pure — no DB/network (fetch/sleep injected).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  drainPlan, boundedPool, clampEvalConcurrency, parseBatchState, LB_KEYS,
  EVAL_TICK_MAX, EVAL_CONCURRENCY_DEFAULT, EVAL_CONCURRENCY_MAX,
} from '../lab-batch-core.ts';
import { openRouterGenerate, openRouterRetryable, openRouterBackoffMs, OPENROUTER_MAX_TRIES } from '../opd-note-audit.ts';

// ── Test 1 — no evalModel ⇒ the mini drain plan is EXACTLY the legacy shape (regression guard) ──
test('mini path (no evalModel): n≤2, serial (concurrency 1), mini-yield honoured', () => {
  const plan = drainPlan({ evalModel: null, n: 2 });
  assert.deepEqual(plan, { evalMode: false, sliceSize: 2, concurrency: 1, useMiniYield: true });
  assert.deepEqual(drainPlan({ evalModel: null, n: 1 }), { evalMode: false, sliceSize: 1, concurrency: 1, useMiniYield: true });
});

// ── Test 2 — evalModel set ⇒ ONE WAVE (slice == concurrency), no mini-yield ──
// AMENDED 27 Jul 2026 (D1). This test previously asserted `sliceSize: EVAL_TICK_MAX` — it locked in
// the defect: 50 audits at concurrency 10 is ~890s of work in one Vercel invocation, which was killed
// at ~200-225s so `finally` never cleared the lock. The slice is now the concurrency.
test('eval path (evalModel set): drains exactly ONE WAVE and skips the mini-yield', () => {
  const plan = drainPlan({ evalModel: 'google/gemini-3.1-flash-lite', evalConcurrency: 10, n: 2 });
  assert.deepEqual(plan, { evalMode: true, sliceSize: 10, concurrency: 10, useMiniYield: false });
  assert.equal(EVAL_TICK_MAX, 50, 'retained as a ceiling (D2), no longer the slice');
  // concurrency defaults + clamps — UNCHANGED
  assert.equal(drainPlan({ evalModel: 'm', n: 2 }).concurrency, EVAL_CONCURRENCY_DEFAULT);
  assert.equal(drainPlan({ evalModel: 'm', evalConcurrency: 999, n: 2 }).concurrency, EVAL_CONCURRENCY_MAX);
});

// ── Test 2a — THE INVARIANT: one tick is exactly one wave, at every reachable concurrency ──
test('eval sliceSize == concurrency across the whole clamped range (1..EVAL_CONCURRENCY_MAX)', () => {
  // The whole fix in one assertion: sliceSize can never exceed concurrency, so a tick dispatches one
  // wave and awaits it. Tick duration is then ONE audit's latency whatever the model does, and no
  // fan-out depth can push the invocation past the platform kill.
  for (const c of [1, 2, 5, 9, 10, 11, 24, 25]) {
    const p = drainPlan({ evalModel: 'google/gemini-2.5-pro', evalConcurrency: c, n: 2 });
    assert.equal(p.sliceSize, p.concurrency, `slice must equal concurrency at ${c}`);
    assert.equal(p.sliceSize, c);
    assert.ok(p.sliceSize <= EVAL_TICK_MAX, 'ceiling still respected');
  }
  // garbage / out-of-range concurrency still yields one wave, never 50
  for (const bad of [undefined, 0, -3, 'abc' as unknown as number, 999, NaN as unknown as number]) {
    const p = drainPlan({ evalModel: 'm', evalConcurrency: bad as number | undefined, n: 2 });
    assert.equal(p.sliceSize, p.concurrency, String(bad));
    assert.ok(p.sliceSize <= EVAL_CONCURRENCY_MAX, String(bad));
  }
});

// ── Test 2b — the defect, reproduced arithmetically from the MEASURED numbers ──
test('THE DEFECT: the old slice was ~890s of work in one invocation; the new one is one audit', () => {
  const MEAN_AUDIT_MS = 178_400;   // MEASURED 27 Jul 2026, det_08114_25pro_seed_a, google/gemini-2.5-pro
  const KILL_MS = 225_000;         // observed burst ceiling before the invocation died
  const concurrency = 10;
  const plan = drainPlan({ evalModel: 'google/gemini-2.5-pro', evalConcurrency: concurrency, n: 2 });
  // OLD: ceil(50/10) = 5 sequential waves ⇒ ~892s — far past the kill, so `finally` never ran
  const oldWaves = Math.ceil(EVAL_TICK_MAX / concurrency);
  assert.ok(oldWaves * MEAN_AUDIT_MS > KILL_MS, 'old plan could not finish inside one invocation');
  // NEW: exactly one wave ⇒ ~178s, inside the observed kill window
  const newWaves = Math.ceil(plan.sliceSize / plan.concurrency);
  assert.equal(newWaves, 1);
  assert.ok(newWaves * MEAN_AUDIT_MS < KILL_MS, 'one wave finishes, so the lock is released');
});

// ── Test 2c — EVAL_TICK_MAX still binds as a ceiling if concurrency ever exceeds it ──
test('EVAL_TICK_MAX remains a hard ceiling on the slice (D2)', () => {
  // Not reachable through clampEvalConcurrency today (max 25) — asserted on Math.min directly so the
  // ceiling is not silently lost if EVAL_CONCURRENCY_MAX is ever raised past 50.
  assert.equal(Math.min(EVAL_TICK_MAX, 80), EVAL_TICK_MAX);
  assert.ok(EVAL_CONCURRENCY_MAX <= EVAL_TICK_MAX, 'while this holds, the ceiling is slack by construction');
});

// ── Test 2d — the MINI branch is byte-identical to the pre-change shape (regression guard) ──
test('the mini branch of drainPlan is UNTOUCHED by the one-wave change', () => {
  // Literal expected objects, not derived from the implementation, so a future edit to the eval
  // branch that leaks into the mini branch fails here.
  assert.deepEqual(drainPlan({ evalModel: null, n: 2 }), { evalMode: false, sliceSize: 2, concurrency: 1, useMiniYield: true });
  assert.deepEqual(drainPlan({ evalModel: null, n: 1 }), { evalMode: false, sliceSize: 1, concurrency: 1, useMiniYield: true });
  // '' is falsy ⇒ mini, and evalConcurrency must not leak into the mini plan
  assert.deepEqual(drainPlan({ evalModel: '', evalConcurrency: 20, n: 2 }), { evalMode: false, sliceSize: 2, concurrency: 1, useMiniYield: true });
  // mini slice is st.n verbatim — NOT clamped or capped here (clampN owns that, upstream)
  assert.equal(drainPlan({ evalModel: null, n: 7 }).sliceSize, 7);
});

test('clampEvalConcurrency: default 10, clamp 1..25', () => {
  assert.equal(clampEvalConcurrency(undefined), 10);
  assert.equal(clampEvalConcurrency('abc'), 10);
  assert.equal(clampEvalConcurrency(0), 10);
  assert.equal(clampEvalConcurrency(1), 1);
  assert.equal(clampEvalConcurrency(25), 25);
  assert.equal(clampEvalConcurrency(26), 25);
});

// ── Test 3 — the pool is BOUNDED: never more than `limit` tasks in flight ──
test('boundedPool never exceeds its concurrency limit and preserves result order', async () => {
  const LIMIT = 5;
  let inFlight = 0, maxInFlight = 0;
  const items = Array.from({ length: 23 }, (_, i) => i);
  const results = await boundedPool(items, LIMIT, async (i) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 2 + (i % 3)));
    inFlight--;
    return i * 10;
  });
  assert.ok(maxInFlight <= LIMIT, `in-flight peaked at ${maxInFlight} > ${LIMIT}`);
  assert.ok(maxInFlight > 1, 'pool must actually run concurrently');
  assert.deepEqual(results, items.map((i) => i * 10), 'results index-aligned to items');
});

test('boundedPool handles limit > items and empty input', async () => {
  assert.deepEqual(await boundedPool([1, 2], 10, async (x) => x + 1), [2, 3]);
  assert.deepEqual(await boundedPool([], 10, async (x) => x), []);
});

// ── Test 4 — 429/5xx retried (bounded, backoff) then thrown; success after transient yields output ──
test('openRouterGenerate retries 429 then succeeds; sleeps between attempts', async () => {
  const prev = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'k';
  try {
    let calls = 0; const sleeps: number[] = [];
    const fetchSeq = (async () => {
      calls++;
      if (calls < 3) return new Response('rate limited', { status: 429 });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'OK-AFTER-RETRY' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await openRouterGenerate('m', 's', 'u', fetchSeq, async (ms) => { sleeps.push(ms); });
    assert.equal(out, 'OK-AFTER-RETRY');
    assert.equal(calls, 3);
    assert.equal(sleeps.length, 2, 'backoff sleep between each retry');
    assert.ok(sleeps.every((ms) => ms > 0));
  } finally {
    if (prev === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prev;
  }
});

test('openRouterGenerate throws after OPENROUTER_MAX_TRIES persistent 5xx — no silent fallback', async () => {
  const prev = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'k';
  try {
    let calls = 0;
    const fetch500 = (async () => { calls++; return new Response('boom', { status: 500 }); }) as unknown as typeof fetch;
    await assert.rejects(openRouterGenerate('m', 's', 'u', fetch500, async () => {}), /OpenRouter HTTP 500/);
    assert.equal(calls, OPENROUTER_MAX_TRIES, 'bounded: exactly max tries');
  } finally {
    if (prev === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prev;
  }
});

test('non-transient status (400) throws immediately — no retry', async () => {
  const prev = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'k';
  try {
    let calls = 0; const sleeps: number[] = [];
    const fetch400 = (async () => { calls++; return new Response('bad request', { status: 400 }); }) as unknown as typeof fetch;
    await assert.rejects(openRouterGenerate('m', 's', 'u', fetch400, async (ms) => { sleeps.push(ms); }), /OpenRouter HTTP 400/);
    assert.equal(calls, 1);
    assert.equal(sleeps.length, 0);
  } finally {
    if (prev === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prev;
  }
});

test('retryable statuses are exactly 429 + 5xx; backoff is jittered-exponential and positive', () => {
  assert.equal(openRouterRetryable(429), true);
  assert.equal(openRouterRetryable(500), true);
  assert.equal(openRouterRetryable(503), true);
  assert.equal(openRouterRetryable(400), false);
  assert.equal(openRouterRetryable(401), false);
  assert.equal(openRouterRetryable(404), false);
  // attempt 1 ~ [250,750), attempt 2 ~ [500,1500) — monotone base, bounded
  assert.equal(openRouterBackoffMs(1, () => 0), 250);
  assert.equal(openRouterBackoffMs(1, () => 0.999), 750);
  assert.equal(openRouterBackoffMs(2, () => 0), 500);
});

// ── Test 5 — eval path still writes lab_analyses only (structural, unchanged from b216d86) ──
test('the eval drain still writes lab_analyses only — never opd_note_audits', () => {
  const src = readFileSync('lib/lab-batch.ts', 'utf8');
  assert.ok(src.includes('saveLabAnalysis'));
  assert.ok(!src.includes('saveOpdAudit'));
  assert.ok(!/opd-audit-store/.test(src));
  assert.ok(!/INSERT\s+INTO\s+opd_note_audits/i.test(src));
});

// ── Test 6 — D3 tick observability. STRUCTURAL: lib/lab-batch.ts imports ./db (transitively), so it
// cannot be imported under --experimental-strip-types; this file already reads it as source for the
// lab_analyses-only guard above, and the same technique is used here.
test('the tick summary carries tick_ms / slice_planned / slice_drained (D3)', () => {
  const src = readFileSync('lib/lab-batch.ts', 'utf8');
  assert.ok(/const tickStart = Date\.now\(\);/.test(src), 'tick start stamped');
  assert.ok(/tick_ms: Date\.now\(\) - tickStart/.test(src));
  assert.ok(/slice_planned: plan\.sliceSize/.test(src));
  assert.ok(/slice_drained: results\.length/.test(src));
  // both persisted summaries carry the fields, so "finished" can never be confused with "never ran"
  assert.equal((src.match(/tick_ms:/g) || []).length, 2, 'both the finished and the drained summary');
  assert.equal((src.match(/slice_planned:/g) || []).length, 2);
});

test('the D3 fields are OBSERVATION ONLY — never branched on, never thrown from', () => {
  const src = readFileSync('lib/lab-batch.ts', 'utf8');
  // no control flow keyed on any of the three fields
  for (const f of ['tick_ms', 'slice_planned', 'slice_drained', 'tickStart']) {
    assert.ok(!new RegExp(`if\\s*\\([^)]*${f}`).test(src), `${f} must not gate a branch`);
    assert.ok(!new RegExp(`(return|throw)\\s+[^;]*\\b${f}\\b\\s*[<>=!]`).test(src), `${f} must not gate a return`);
  }
  // Date.now() and .length cannot throw, so no try/except is needed — unlike ttlBreach, which calls a
  // helper and is therefore wrapped. That asymmetry is deliberate; assert the wrap still exists.
  assert.ok(/try \{ breach = ttlBreach\(/.test(src), 'ttlBreach stays wrapped (bed1449)');
});

// ── Test 7 — bed1449's lock work is UNTOUCHED by this build (hard-list guard) ──
test('LB_LOCK_TTL_MS / labLockHeld / ttlBreach survive this build unchanged', () => {
  const core = readFileSync('lib/lab-batch-core.ts', 'utf8');
  assert.ok(/export const LB_LOCK_TTL_MS = 900 \* 1000;/.test(core), 'TTL literal unchanged at 900s');
  assert.ok(/export function labLockHeld\(/.test(core));
  assert.ok(/export function ttlBreach\(/.test(core));
  assert.ok(/export function ttlBreachMessage\(/.test(core));
  const rt = readFileSync('lib/lab-batch.ts', 'utf8');
  assert.ok(/lockHeld: labLockHeld\(st\.lock\)/.test(rt), 'the batch still uses its OWN lock');
  assert.ok(/ttl_ms: LB_LOCK_TTL_MS/.test(rt));
  // the drain still runs inside try/finally — the whole point is that `finally` now actually reaches
  assert.ok(/\} finally \{\n\s*await setSetting\(LB_KEYS\.lock, ''\)/.test(rt), 'lock cleared in finally');
});

// batch state round-trips the concurrency; absent ⇒ default
test('parseBatchState reads evalConcurrency; absent ⇒ default 10', () => {
  assert.equal(parseBatchState({}).evalConcurrency, 10);
  assert.equal(parseBatchState({ [LB_KEYS.evalConcurrency]: '25' } as Record<string, string>).evalConcurrency, 25);
  assert.equal(parseBatchState({ [LB_KEYS.evalConcurrency]: '99' } as Record<string, string>).evalConcurrency, 25);
});
