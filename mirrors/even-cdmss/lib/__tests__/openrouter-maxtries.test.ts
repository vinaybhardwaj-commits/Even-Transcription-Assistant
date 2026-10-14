/**
 *   node --test --import tsx lib/__tests__/openrouter-maxtries.test.ts
 *
 * PROVIDER-SWITCH Unit D (Addendum B, 3 Aug 2026) — a caller may shorten the retry ladder.
 *
 * WHY. `openrouterCreateWithRetry` took its try count from a module constant, so a caller could not
 * lower it. That is the same shape of defect as the hard-coded 110 s ceiling: A RETRY COUNT IS A
 * PROPERTY OF THE CALL, NOT OF THE MODULE. Three rungs is right for a utility call measured in
 * seconds; against an audit leg it is multiplicative — 3 tries × 380 s × 2 legs is 2,280 s inside
 * an 800 s route box, so the route cannot hold its own retry policy and dies mid-batch.
 *
 * The retry does not disappear when a caller asks for one try. It moves: both audit workers sweep
 * for un-audited work every tick, so the sweep is the retry with a whole window of budget.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openrouterCreateWithRetry, OPENROUTER_MAX_TRIES, OPENROUTER_TIMEOUT_MS, type OpenrouterAttemptOpts } from '../openrouter-retry';

const GOOD = { choices: [{ message: { content: 'ok' } }] };
const noSleep = async () => {};
const transient = Object.assign(new Error('rate limited'), { status: 429 });

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · A caller's maxTries is honoured
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('maxTries: 1 makes exactly ONE attempt — no retry at all', async () => {
  let calls = 0;
  await assert.rejects(
    () => openrouterCreateWithRetry(async () => { calls++; throw transient; }, { maxTries: 1, sleepFn: noSleep }),
    /rate limited/,
  );
  assert.equal(calls, 1, 'a retryable status must NOT be retried when the caller asked for one try');
});

test('maxTries: 2 makes exactly TWO attempts', async () => {
  let calls = 0;
  await assert.rejects(
    () => openrouterCreateWithRetry(async () => { calls++; throw transient; }, { maxTries: 2, sleepFn: noSleep, rand: () => 0.5 }),
    /rate limited/,
  );
  assert.equal(calls, 2);
});

test('a shortened ladder still SUCCEEDS on a later attempt within it', async () => {
  let calls = 0;
  const res = await openrouterCreateWithRetry(async () => {
    calls++;
    if (calls < 2) throw transient;
    return GOOD;
  }, { maxTries: 2, sleepFn: noSleep, rand: () => 0.5 });
  assert.deepEqual(res, GOOD);
  assert.equal(calls, 2, 'shortening the ladder must not disable trying');
});

test('the empty-200 class respects the shortened budget too', async () => {
  let calls = 0;
  await assert.rejects(
    () => openrouterCreateWithRetry(async () => { calls++; return { choices: [] }; }, { maxTries: 1, sleepFn: noSleep }),
  );
  assert.equal(calls, 1, 'a 200-that-is-not-a-completion must not get extra tries the caller did not buy');
});

test('the terminal timeout message reports the ladder ACTUALLY used, not the constant', async () => {
  // Reject when the helper's own timer aborts, so the attempt actually ends (repo idiom — mirrors
  // openrouter-timeout.test.ts). A promise that never settles hangs the runner instead of failing.
  const hang = (o: OpenrouterAttemptOpts) => new Promise((_res, rej) => {
    o.signal.addEventListener('abort', () => rej(new Error('The user aborted a request.')));
  });
  await assert.rejects(
    () => openrouterCreateWithRetry(hang, { timeoutMs: 5, maxTries: 1, sleepFn: noSleep }),
    (e: Error) => {
      assert.match(e.message, /attempt 1\/1/, 'a 1/3 here would misreport what was tried');
      assert.match(e.message, /TIMEOUT after 5ms/);
      return true;
    },
  );
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · Junk degrades to the DEFAULT. It never disables trying.
// ═════════════════════════════════════════════════════════════════════════════════════════════

for (const [label, bad] of [
  ['absent', undefined], ['zero', 0], ['negative', -1], ['NaN', NaN], ['Infinity', Infinity],
  ['a fraction below one', 0.5], ['a string', '2' as unknown as number],
] as Array<[string, number | undefined]>) {
  test(`maxTries ${label} ⇒ ${OPENROUTER_MAX_TRIES} attempts, unchanged from today`, async () => {
    let calls = 0;
    await assert.rejects(
      () => openrouterCreateWithRetry(async () => { calls++; throw transient; },
        { maxTries: bad, sleepFn: noSleep, rand: () => 0.5 }),
    );
    assert.equal(calls, OPENROUTER_MAX_TRIES,
      'a bad number must fall back to the module default — a budget that could be switched off by ' +
      'junk would turn "retry fewer times" into "never call at all"');
  });
}

test('a fractional maxTries above one TRUNCATES rather than rounding up', async () => {
  let calls = 0;
  await assert.rejects(
    () => openrouterCreateWithRetry(async () => { calls++; throw transient; }, { maxTries: 2.9, sleepFn: noSleep, rand: () => 0.5 }),
  );
  assert.equal(calls, 2, 'a budget a route is checked against must never round UP');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · The exported defaults did not move
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('OPENROUTER_MAX_TRIES still exports 3 and stays the default', () => {
  assert.equal(OPENROUTER_MAX_TRIES, 3);
  assert.equal(OPENROUTER_TIMEOUT_MS, 110_000);
  const src = readFileSync('lib/openrouter-retry.ts', 'utf8');
  assert.ok(src.includes('export const OPENROUTER_MAX_TRIES = 3;'));
  // The resolution discipline mirrors timeoutMs exactly — one shape, learned once.
  assert.ok(src.includes('Number.isFinite(cfg.maxTries) && (cfg.maxTries as number) >= 1'));
  assert.ok(src.includes(': OPENROUTER_MAX_TRIES;'), 'junk degrades to the constant');
});

test('the loop body reads the LOCAL maxTries, never the constant', () => {
  const src = readFileSync('lib/openrouter-retry.ts', 'utf8');
  const body = src.slice(src.indexOf('for (let attempt = 1;'));
  assert.ok(!body.includes('OPENROUTER_MAX_TRIES'),
    'a surviving reference in the loop would silently ignore the caller on that path');
  assert.ok(body.includes('attempt <= maxTries'), 'the for bound');
  assert.equal((body.match(/attempt < maxTries/g) ?? []).length, 2, 'both willRetry computations');
  assert.equal((body.match(/attempt, maxTries, willRetry,/g) ?? []).length, 2, 'both report() fields');
  assert.ok(body.includes('(attempt ${attempt}/${maxTries})'), 'the timeout message');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · maxTries reaches every branch that OWNS A RETRY LOOP, and no other
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('chatWithFallback takes maxTries fifth and uses it only where a retry loop exists', () => {
  const src = readFileSync('lib/llm.ts', 'utf8');
  // V-a2 (4 Aug 2026): noLocalFallback rides sixth — maxTries is still the fifth argument.
  assert.ok(src.includes('export async function chatWithFallback(params: any, geminiModel?: string, openrouterModel?: string, timeoutMs?: number, maxTries?: number, noLocalFallback?: boolean)'),
    'fifth argument, after timeoutMs');
  const orBranch = src.slice(src.indexOf('await openrouterCreateWithRetry'), src.indexOf("endProviderCall('openrouter');"));
  assert.ok(/\bmaxTries,/.test(orBranch), 'the OpenRouter branch forwards it');
  // ⚠️ NARROWED IN UNIT V-a1 (3 Aug 2026). This used to assert "the Vertex and Ollama branches must
  // not read it", which was right when OpenRouter owned the only retry loop. Vertex now runs the
  // same shared loop and legitimately consumes maxTries. THE PROPERTY THAT STILL HOLDS, and the one
  // that mattered all along, is about OLLAMA: it has no loop of its own, so a try count there would
  // be a number with nothing to spend it on. (V-a2: the Vertex arm lives inside the ladder loop
  // now, so slice from its beginProviderCall.)
  const gem = src.slice(src.indexOf("beginProviderCall('gemini');"));
  assert.ok(gem.includes('maxTries,'), 'the Vertex branch now forwards it too');
  // The Ollama default/fallback calls take reqOpts and nothing else — no try count, no loop.
  for (const m of src.matchAll(/return llm\.chat\.completions\.create\(params, ([^)]*)\);/g)) {
    assert.equal(m[1], 'reqOpts', 'an Ollama call site must take reqOpts alone');
  }
  assert.ok(src.includes('const reqOpts = timeoutMs ? { timeout: timeoutMs } : undefined;'), 'reqOpts unchanged');
});

test('governedChat threads maxTries down BOTH arms', () => {
  const src = readFileSync('lib/trace.ts', 'utf8');
  // V-a2: noLocalFallback joins the traceless delegation as the sixth positional argument.
  assert.ok(src.includes('return chatWithFallback(params, opts?.gemini, opts?.openrouter, opts?.timeoutMs, opts?.maxTries, opts?.noLocalFallback);'),
    'the traceless arm');
  assert.ok(src.includes('if (traceId) return tracedChat(traceId, label, params, opts);'),
    'the traced arm passes the whole opts object, so it carries maxTries with it');
  // Both signatures accept it.
  assert.equal((src.match(/promptRef\?: string; timeoutMs\?: number; maxTries\?: number; noLocalFallback\?: boolean/g) ?? []).length, 2,
    'tracedChat AND governedChat');
});
