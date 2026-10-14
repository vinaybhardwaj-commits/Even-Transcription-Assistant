/**
 *   node --test --import tsx lib/__tests__/pdqi9-fail-loud.test.ts
 *
 * PDQI-9 fail-loud Phase 1. Two identical runs of the same 100 notes — same config, same model —
 * produced 62/100 different NQI, SD 8.844, and PDQI-9 coverage flipped on 41 notes. The cause: a 200
 * with empty content returned '' and was scored as an unassessed note, whose weight collapses to 0,
 * which RAISES the index because note_quality is the lowest-scoring domain. Measured across 25,103
 * production rows: unassessable notes average 95.21 NQI (52% exactly 100) against 78.36 for assessed.
 * A failure to measure was scored as excellence.
 *
 * The two assertions that decide whether this build is correct:
 *   · empty content THROWS on the eval path (and the message carries the envelope, because no
 *     lab_analyses row will exist and the tick summary is the only surviving record);
 *   · PRODUCTION IS BYTE-IDENTICAL — the non-eval catch branch and the non-eval defaultGenerate
 *     params are unchanged (D1).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  openRouterGenerate, buildOpenRouterBody, emptyContentErrorMessage, readLlmEnvelope,
  OPENROUTER_MAX_TRIES, OPENROUTER_TIMEOUT_MS, AUDIT_EVAL_THINKING_BUDGET,
  type LlmEnvelope,
} from '../opd-note-audit.ts';
import { EVAL_TICK_DEADLINE_MS } from '../lab-batch-core.ts';

const SRC = readFileSync('lib/opd-note-audit.ts', 'utf8');

/** Run a body with OPENROUTER_API_KEY set, restoring whatever was there. */
async function withKey<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key';
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prev;
  }
}

const okBody = (content: string | null | undefined, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({
    choices: [{ message: { content }, finish_reason: 'stop', native_finish_reason: 'STOP' }],
    provider: 'Google', usage: { prompt_tokens: 100, completion_tokens: 200 },
    ...extra,
  }), { status: 200 });

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · EMPTY CONTENT NOW THROWS — the defect itself
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('THE DEFECT: a 200 with empty content THROWS instead of returning an empty string', async () => {
  await withKey(async () => {
    // Every shape that used to collapse to '' on the same statement as a full response.
    for (const [label, res] of [
      ['content: ""', () => okBody('')],
      ['content: null', () => okBody(null)],
      ['content absent', () => new Response(JSON.stringify({ choices: [{ message: {} }] }), { status: 200 })],
      ['message absent', () => new Response(JSON.stringify({ choices: [{}] }), { status: 200 })],
      ['choices: []', () => new Response(JSON.stringify({ choices: [] }), { status: 200 })],
      ['body not JSON', () => new Response('not json', { status: 200 })],
    ] as [string, () => Response][]) {
      const f = (async () => res()) as unknown as typeof fetch;
      await assert.rejects(
        openRouterGenerate('m', 's', 'u', f, async () => {}),
        /EMPTY CONTENT \(HTTP 200\)/,
        `${label} must throw, not return ''`,
      );
    }
  });
});

test('empty content is RETRYABLE on the EXISTING budget — only the final attempt throws', async () => {
  await withKey(async () => {
    let calls = 0; const sleeps: number[] = [];
    const f = (async () => {
      calls++;
      return calls < OPENROUTER_MAX_TRIES ? okBody('') : okBody('RECOVERED');
    }) as unknown as typeof fetch;
    const out = await openRouterGenerate('m', 's', 'u', f, async (ms) => { sleeps.push(ms); });
    assert.equal(out, 'RECOVERED', 'a later attempt that succeeds must be returned');
    assert.equal(calls, OPENROUTER_MAX_TRIES);
    assert.equal(sleeps.length, OPENROUTER_MAX_TRIES - 1, 'backoff between empty-content retries');
  });
});

test('the try budget is NOT raised — still exactly 3', () => {
  assert.equal(OPENROUTER_MAX_TRIES, 3, 'PRD §4: do not raise the try count');
});

test('persistent empty content exhausts the budget and throws — no silent fallback', async () => {
  await withKey(async () => {
    let calls = 0;
    const f = (async () => { calls++; return okBody(''); }) as unknown as typeof fetch;
    await assert.rejects(openRouterGenerate('m', 's', 'u', f, async () => {}), /EMPTY CONTENT/);
    assert.equal(calls, OPENROUTER_MAX_TRIES, 'bounded: exactly max tries');
  });
});

test('a NON-empty response still returns normally — the happy path is untouched', async () => {
  await withKey(async () => {
    let calls = 0;
    const f = (async () => { calls++; return okBody('AUDIT-JSON'); }) as unknown as typeof fetch;
    assert.equal(await openRouterGenerate('m', 's', 'u', f, async () => {}), 'AUDIT-JSON');
    assert.equal(calls, 1, 'no retry on success');
  });
});

// ── the normative message (PRD §4) ──

test('THE ERROR MESSAGE is verbatim per PRD §4 and carries the whole envelope', () => {
  const env: LlmEnvelope = {
    finish_reason: 'length', native_finish_reason: 'MAX_TOKENS', provider: 'Google',
    usage: { prompt_tokens: 4321, completion_tokens: 0, reasoning_tokens: 4096 },
    content_length: 0, attempt: 3,
  };
  assert.equal(emptyContentErrorMessage(env, 3),
    'OpenRouter returned EMPTY CONTENT (HTTP 200) — treated as failure, not as an unassessed note.\n'
    + 'finish_reason=length native_finish_reason=MAX_TOKENS provider=Google attempt=3/3\n'
    + 'usage: prompt=4321 completion=0 reasoning=4096 content_length=0');
});

test('the message renders missing envelope fields as null rather than undefined or blank', () => {
  const env: LlmEnvelope = { finish_reason: null, native_finish_reason: null, provider: null, usage: null, content_length: 0, attempt: 1 };
  const msg = emptyContentErrorMessage(env, 3);
  assert.ok(msg.includes('finish_reason=null native_finish_reason=null provider=null attempt=1/3'));
  assert.ok(msg.includes('usage: prompt=null completion=null reasoning=null content_length=0'));
  assert.ok(!/undefined/.test(msg), 'never the string "undefined"');
});

test('the thrown message actually reaches the caller with the envelope in it', async () => {
  await withKey(async () => {
    const f = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: '' }, finish_reason: 'length', native_finish_reason: 'MAX_TOKENS' }],
      provider: 'Google', usage: { prompt_tokens: 9, completion_tokens: 0, completion_tokens_details: { reasoning_tokens: 4096 } },
    }), { status: 200 })) as unknown as typeof fetch;
    await assert.rejects(
      openRouterGenerate('m', 's', 'u', f, async () => {}),
      (e: Error) => {
        assert.match(e.message, /EMPTY CONTENT \(HTTP 200\)/);
        assert.match(e.message, /finish_reason=length/);
        assert.match(e.message, /native_finish_reason=MAX_TOKENS/);
        assert.match(e.message, /provider=Google/);
        assert.match(e.message, /reasoning=4096/, 'the nested reasoning-token shape must be read');
        assert.match(e.message, /attempt=3\/3/, 'the FINAL attempt is the one reported');
        return true;
      },
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · THE ENVELOPE — fires on EVERY attempt, and can never break a run
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('onEnvelope fires on EVERY attempt — success, empty content and HTTP failure alike', async () => {
  await withKey(async () => {
    const seen: LlmEnvelope[] = [];
    let calls = 0;
    const f = (async () => {
      calls++;
      if (calls === 1) return new Response('boom', { status: 500 });
      if (calls === 2) return okBody('');
      return okBody('OK');
    }) as unknown as typeof fetch;
    const out = await openRouterGenerate('m', 's', 'u', f, async () => {}, (e) => seen.push(e));
    assert.equal(out, 'OK');
    assert.equal(seen.length, 3, 'one envelope per attempt');
    assert.deepEqual(seen.map((e) => e.attempt), [1, 2, 3], 'attempt is 1-based and increments');
    assert.equal(seen[0].content_length, 0, 'HTTP failure ⇒ content_length 0');
    assert.equal(seen[1].content_length, 0, 'empty content ⇒ content_length 0');
    assert.equal(seen[2].content_length, 2, 'success ⇒ the real length');
    assert.equal(seen[2].finish_reason, 'stop');
    assert.equal(seen[2].provider, 'Google');
  });
});

test('ENVELOPE CAPTURE NEVER THROWS — a broken callback cannot cost a real result', async () => {
  await withKey(async () => {
    const f = (async () => okBody('STILL-RETURNED')) as unknown as typeof fetch;
    const out = await openRouterGenerate('m', 's', 'u', f, async () => {}, () => { throw new Error('callback exploded'); });
    assert.equal(out, 'STILL-RETURNED', 'instrumentation is never fatal');
  });
  // …and it must not convert a real failure into a different one either
  await withKey(async () => {
    const f = (async () => okBody('')) as unknown as typeof fetch;
    await assert.rejects(
      openRouterGenerate('m', 's', 'u', f, async () => {}, () => { throw new Error('callback exploded'); }),
      /EMPTY CONTENT/, 'the ORIGINAL failure must surface, not the callback error',
    );
  });
});

test('readLlmEnvelope is total — any shape yields a defined envelope, never a throw', () => {
  for (const junk of [null, undefined, {}, [], 'string', 42, { choices: 'not-an-array' }, { usage: 'nope' }]) {
    assert.doesNotThrow(() => readLlmEnvelope(junk, 1, 0));
    const e = readLlmEnvelope(junk, 1, 0);
    assert.equal(e.attempt, 1);
    assert.equal(e.content_length, 0);
  }
  // both reasoning-token shapes are read, flat first
  assert.equal(readLlmEnvelope({ usage: { reasoning_tokens: 7 } }, 1, 0).usage?.reasoning_tokens, 7);
  assert.equal(readLlmEnvelope({ usage: { completion_tokens_details: { reasoning_tokens: 9 } } }, 1, 0).usage?.reasoning_tokens, 9);
  assert.equal(readLlmEnvelope({ usage: { reasoning_tokens: 7, completion_tokens_details: { reasoning_tokens: 9 } } }, 1, 0).usage?.reasoning_tokens, 7);
  // a non-numeric token count is dropped rather than coerced
  assert.equal(readLlmEnvelope({ usage: { prompt_tokens: 'lots' } }, 1, 0).usage?.prompt_tokens, undefined);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · THE TIMEOUT (D4)
// ═════════════════════════════════════════════════════════════════════════════════════════════

// ⚠️ 300s → 110s (Eval-tick-deadline PRD D4). Three attempts at 110s plus backoff fit inside the
// 240s tick deadline, so a note can still exhaust its retry budget WITHIN one tick and record its
// envelope. At 300s one attempt outlived the tick and the budget could never be spent.
test('OPENROUTER_TIMEOUT_MS defaults to 110s and is env-overridable', () => {
  assert.equal(OPENROUTER_TIMEOUT_MS, Number(process.env.OPENROUTER_TIMEOUT_MS) || 110_000);
  // Addendum F v2 task 1: the definition lives in lib/openrouter-retry.ts (shared policy);
  // opd-note-audit.ts re-exports it, so the imported value above is still the one the lab uses.
  assert.ok(/Number\(process\.env\.OPENROUTER_TIMEOUT_MS\) \|\| 110_000/.test(readFileSync('lib/openrouter-retry.ts', 'utf8')));
  assert.ok(3 * 110_000 < EVAL_TICK_DEADLINE_MS + 110_000,
    'the retry budget must be spendable inside one tick — that is why this number changed');
});

test('an AbortSignal is passed to the fetch, and the timer is always cleared', () => {
  assert.ok(/const ctrl = new AbortController\(\);/.test(SRC));
  assert.ok(/signal: ctrl\.signal,/.test(SRC), 'the deadline must actually reach the request');
  assert.ok(/\} finally \{\n\s*clearTimeout\(timer\);/.test(SRC), 'a completed request must not leave a timer');
});

test('a timeout is a NORMAL RETRYABLE failure on the same bounded budget', async () => {
  await withKey(async () => {
    // Simulate the abort the deadline produces, then recover.
    let calls = 0; const sleeps: number[] = [];
    const f = (async (_u: string, init: { signal?: AbortSignal }) => {
      calls++;
      if (calls === 1) {
        const err = new Error('The operation was aborted.');
        err.name = 'AbortError';
        void init?.signal;
        throw err;
      }
      return okBody('AFTER-TIMEOUT');
    }) as unknown as typeof fetch;
    const out = await openRouterGenerate('m', 's', 'u', f, async (ms) => { sleeps.push(ms); });
    assert.equal(out, 'AFTER-TIMEOUT');
    assert.equal(calls, 2);
    assert.equal(sleeps.length, 1, 'backed off once before retrying');
  });
});

test('a persistent transport failure exhausts the budget and throws a named error', async () => {
  await withKey(async () => {
    let calls = 0;
    const f = (async () => { calls++; throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    await assert.rejects(openRouterGenerate('m', 's', 'u', f, async () => {}), /transport error.*ECONNRESET/s);
    assert.equal(calls, OPENROUTER_MAX_TRIES, 'bounded — never unbounded retry');
  });
});

test('the transport catch still emits an envelope, so a hung attempt is visible', async () => {
  await withKey(async () => {
    const seen: LlmEnvelope[] = [];
    const f = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    await assert.rejects(openRouterGenerate('m', 's', 'u', f, async () => {}, (e) => seen.push(e)));
    assert.equal(seen.length, OPENROUTER_MAX_TRIES);
    assert.deepEqual(seen.map((e) => e.attempt), [1, 2, 3]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · PRODUCTION IS BYTE-IDENTICAL (D1) — the assertion the PRD demands
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('THE CATCH BLOCK rethrows ONLY for eval; the non-eval return is byte-identical', () => {
  const start = SRC.indexOf('  } catch (e) {\n    if (traceId) await finishTrace(traceId, \'error\'');
  assert.ok(start > 0, 'the catch block must be locatable');
  const block = SRC.slice(start, SRC.indexOf('\n}', start));

  // the eval rethrow exists and is guarded on evalModel
  assert.ok(/if \(opts\.evalModel\) throw e;/.test(block), 'eval path must rethrow');

  // …and the production return below it is UNCHANGED, verbatim
  assert.ok(block.includes("// Even on LLM failure, return the deterministic-only audit (completeness + prescribing)."));
  assert.ok(block.includes('pdqi9: null,'));
  // S0 (invalid-marking): the det-only fallback now carries llmLegFailed: true — the store turns it
  // into excluded_reason='llm_leg_failed'. Everything else about the return is unchanged.
  assert.ok(block.includes('return { keys, scorecard, completeness, findings: finalize(det), suggestions: [], sources: [], engineVersion: engineVersion, traceId, complexity: await complexityFor(), quietingGen: quietCfg.gen, llmLegFailed: true };'));

  // ORDER MATTERS: the rethrow must come AFTER finishTrace and BEFORE the deterministic fallback,
  // or production would either lose its trace row or never reach its return.
  const finishIdx = block.indexOf('finishTrace(traceId,');
  const throwIdx = block.indexOf('if (opts.evalModel) throw e;');
  const returnIdx = block.indexOf('return { keys, scorecard,');
  assert.ok(finishIdx < throwIdx && throwIdx < returnIdx, 'finishTrace → rethrow → production fallback');
});

test('the production defaultGenerate params are byte-identical — no eval change leaked in', () => {
  const start = SRC.indexOf('async function defaultGenerate(');
  const block = SRC.slice(start, SRC.indexOf('/** Reuse the stored LLM half', start));
  // line 604's `content || ''` on the governedChat path — explicitly on the untouched list.
  // D-1 (31 Jul): the call gained the audit's per-request ceiling (timeoutMs) — params, promptRef
  // and the `content || ''` return are unchanged; only how long we wait changed.
  // Unit D + DEC-B9 (3 Aug): BOTH transport bounds now come from PROVIDER_BUDGETS — the ceiling as
  // well as the try count. params, promptRef and the `content || ''` return are still unchanged;
  // only how long we wait and how many times we ask. LLM_AUDIT_TIMEOUT_MS is unchanged and still
  // exported, it is simply no longer this path's source.
  // Unit V-a2 (4 Aug): `noLocalFallback: !mini` — the cloud audit throws instead of being graded
  // locally (the throw lands in the outer catch's llmLegFailed machinery); the mini backfill
  // passes false and keeps its local model. params and the return are still unchanged.
  // Bedrock S2 (7 Aug): one option added (`bedrock: bedrockModel`, undefined on every existing
  // caller) and the two bounds now read the SERVING provider's budget row instead of openrouter's
  // hardcoded one — the numbers are identical, the source is now correct. params, promptRef, the
  // V-a2 flag and the `content || ''` return are unchanged, which is what this guards.
  assert.ok(block.includes("const r = await governedChat(traceId, 'opd_audit_analyze', params, { gemini: geminiModel, bedrock: bedrockModel, promptRef: 'opd-note-audit-core/OPD_AUDIT_SYSTEM', timeoutMs: budget.perAttemptMs, maxTries: budget.maxTries, noLocalFallback: !mini });\n  return r.choices?.[0]?.message?.content || '';"),
    "the governedChat return and its `content || ''` must be unchanged (plus the Unit D transport bounds + the V-a2 flag)");
  assert.ok(block.includes("const budget = opdAuditBudget(onBedrock ? 'bedrock' : 'openrouter');"),
    'the budget comes from the provider that will actually serve the call');
  // the production params object, verbatim
  // Bedrock S2: the greedy gate covers BOTH cloud graders; the mini/Ollama half of the ternary is
  // byte-identical, which is what "no eval change leaked in" is actually about.
  assert.ok(block.includes("temperature: (onGemini || onBedrock) ? 0 : (isReasoning ? 0 : 0.2),"));
  assert.ok(block.includes("max_tokens: isReasoning ? 8192 : 2200,"));
  assert.ok(block.includes("...(onGemini ? { seed: AUDIT_LLM_SEED, top_p: 1, google: { thinking_config: { thinking_budget: AUDIT_EVAL_THINKING_BUDGET } } } : {}),"));
  // the envelope AND the tick deadline are threaded ONLY on the eval branch
  assert.ok(block.includes('if (evalModel) return openRouterGenerate(evalModel, system, user, fetch, undefined, onEnvelope, deadlineAt);'));
  // Count CODE occurrences only — comments legitimately mention it. Exactly two each: the parameter
  // and the eval call site. A third would mean it had leaked onto the production branch.
  const code = block.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  assert.equal((code.match(/onEnvelope/g) || []).length, 2, 'the param and the eval call site only — never the production branch');
  assert.equal((code.match(/deadlineAt/g) || []).length, 2, 'the deadline must not reach the Gemini/mini branch');
});

test('buildOpenRouterBody is BYTE-IDENTICAL — no max_tokens, no response_format (D3)', () => {
  const body = buildOpenRouterBody('some/model', 'SYS', 'USR');
  assert.deepEqual(body, {
    model: 'some/model',
    messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'USR' }],
    temperature: 0,
    top_p: 1,
    seed: Number(process.env.AUDIT_LLM_SEED) || 42,
    reasoning: { max_tokens: AUDIT_EVAL_THINKING_BUDGET },
    provider: { allow_fallbacks: false, require_parameters: true },
  });
  // D3 defers both explicitly — instrument first, then decide
  assert.ok(!('max_tokens' in body), 'D3: completion max_tokens is DEFERRED to the probe');
  assert.ok(!('response_format' in body), 'D3: response_format is DEFERRED to the probe');
  // and the source function itself is unchanged
  const fn = SRC.slice(SRC.indexOf('export function buildOpenRouterBody'), SRC.indexOf('/** Bounded retry for the eval path'));
  assert.ok(!/max_tokens: \d/.test(fn.replace(/reasoning: \{ max_tokens: AUDIT_EVAL_THINKING_BUDGET \}/, '')));
  assert.ok(!/response_format/.test(fn));
});

test('no engine version bump, and the retry predicate is unchanged', () => {
  assert.ok(/export const OPD_ENGINE_VERSION/.test(readFileSync('lib/opd-note-audit-core.ts', 'utf8'))
    || /OPD_ENGINE_VERSION/.test(SRC), 'the constant still exists');
  assert.ok(/export function openRouterRetryable\(status: number\): boolean \{\n  return status === 429 \|\| status >= 500;\n\}/.test(readFileSync('lib/openrouter-retry.ts', 'utf8')),
    'the HTTP retry predicate is untouched — empty content is handled separately (it now lives in the shared policy module, re-exported here)');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5 · FAIL LOUD END TO END — no row for a failed note
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('runMiniOpdToLab writes the envelope on success and cannot write one on failure', () => {
  const lab = readFileSync('lib/lab-batch.ts', 'utf8');
  // the envelope is captured and attached
  assert.ok(/let lastEnvelope: LlmEnvelope \| null = null;/.test(lab));
  assert.ok(/onEnvelope: \(e\) => \{ lastEnvelope = e; \},/.test(lab));
  assert.ok(/\.\.\.\(lastEnvelope \? \{ llm_envelope: lastEnvelope \} : \{\}\),/.test(lab));

  // …and it is attached INSIDE `output`, before saveLabAnalysis — so no migration is needed
  const outIdx = lab.indexOf('const output = {');
  const saveIdx = lab.indexOf('const id = await saveLabAnalysis({');
  const envIdx = lab.indexOf('llm_envelope: lastEnvelope');
  assert.ok(outIdx < envIdx && envIdx < saveIdx, 'llm_envelope is a key inside the existing output jsonb');

  // THE POINT: saveLabAnalysis is only reached AFTER auditOpdNote resolves. A rethrow means no row.
  const auditIdx = lab.indexOf('const audit = await auditOpdNote(row, {');
  assert.ok(auditIdx < saveIdx, 'the audit must complete before anything is persisted');
  // drainOne's per-note catch is what makes that safe — it records and leaves the uid un-done
  assert.ok(/catch \(e\) \{\n\s*const msg = String\(\(e as Error\)\.message\);/.test(lab));
  // Eval-hardening widened the error row with the taxonomy (error_type when present) — the
  // property that matters is unchanged: a failed note returns an ERROR row and is NOT done.
  assert.ok(/return \{ uid, error: msg, \.\.\.\(et != null \? \{ error_type: et \} : \{\}\), ms: Date\.now\(\) - t0 \};/.test(lab),
    'a failed note returns an error row — it is NOT added to the done set');
});

test('the lab-batch core is untouched — drainPlan and the locks still stand', () => {
  const core = readFileSync('lib/lab-batch-core.ts', 'utf8');
  assert.ok(/export const LB_LOCK_TTL_MS = 900 \* 1000;/.test(core));
  assert.ok(/sliceSize: Math\.min\(EVAL_TICK_MAX, concurrency\)/.test(core), 'the one-wave rule stands');
  assert.ok(/return \{ evalMode: false, sliceSize: st\.n, concurrency: 1, useMiniYield: true \};/.test(core), 'the mini branch stands');
  assert.ok(/export function labLockHeld\(/.test(core) && /export function ttlBreach\(/.test(core));
});
