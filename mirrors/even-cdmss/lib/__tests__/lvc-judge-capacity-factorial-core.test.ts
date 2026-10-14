// lib/__tests__/lvc-judge-capacity-factorial-core.test.ts
// CDMSS-LVC-JUDGE-CAPACITY-FACTORIAL-PRD-v3.0-11-AUG-2026 §5.
//
// WHY THIS EXISTS. PRD v2.0 specified `reasoning: { max_tokens }` for the capped arms — the
// OpenRouter dialect, which direct Vertex ignores. Arms B and D would have been silent duplicates
// of A and C, and the thinking factor would have returned a clean null that meant nothing. The
// existing lib/__tests__/thinking-budget.test.ts exists for exactly this class of defect ("a cap
// that silently does nothing would make every arm secretly Arm A and the study would report a free
// lunch that does not exist"), and these tests follow its pattern: assert the honoured wire form
// is present in the CODE, and that the three known-inert forms can never be reintroduced.
//
// SYNTHETIC ONLY. Every fixture id here is `synthetic-rec-*`. No clinical text, no real
// identifier, no credential appears in this file or in anything it prints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as core from '../lvc-judge-capacity-factorial-core';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
/** Assertions below are about CODE, not commentary — both files name the rejected forms in prose. */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const CORE_SRC = 'lib/lvc-judge-capacity-factorial-core.ts';
const RUNNER_SRC = 'scripts/lvc-judge-capacity-factorial.mjs';

const MESSAGES: core.FrozenMessage[] = [
  { role: 'system', content: 'SYNTHETIC SYSTEM' },
  { role: 'user', content: 'SYNTHETIC USER' },
];
const ARM_INPUT: core.ArmRequestInput = { wireModel: 'google/gemini-2.5-pro', messages: MESSAGES, seed: 42 };
const build = (arm: core.ArmId) => core.buildArmRequest(arm, ARM_INPUT);

const ids = (n: number) => Array.from({ length: n }, (_, i) => `synthetic-rec-${String(i + 1).padStart(3, '0')}`);
const okEntry = (id: string) => ({ id, verdict: 'applies', confidence: 0.8, why: 'synthetic reason', consider_instead: null });
const okBody = (n: number) => JSON.stringify(ids(n).map(okEntry));

// ════════════════════════════════════════════════════════════════════════════════════════════════
// ARM CONSTRUCTION (§5 "Arm construction")
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('A and C carry no own `google` key and no own `reasoning` key', () => {
  for (const arm of ['A', 'C'] as const) {
    const body = build(arm);
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'google'), false, `arm ${arm} must omit google`);
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'reasoning'), false, `arm ${arm} must omit reasoning`);
    assert.deepEqual(core.assertArmRequest(arm, body), []);
  }
});

test('B and D carry exactly one top-level google.thinking_config.thinking_budget = 2048, and nothing else', () => {
  for (const arm of ['B', 'D'] as const) {
    const body = build(arm) as Record<string, unknown>;
    assert.deepEqual(body.google, { thinking_config: { thinking_budget: 2048 } }, `arm ${arm} wire format`);
    for (const forbidden of ['reasoning', 'reasoning_effort', 'generationConfig', 'extra_body', 'thinking_config']) {
      assert.equal(forbidden in body, false, `arm ${arm} must not carry ${forbidden}`);
    }
    assert.deepEqual(core.assertArmRequest(arm, body), []);
  }
});

test('wire max_tokens is exactly 9092 or 16384, and nothing adds 8192 to it', () => {
  assert.equal(core.WIRE_MAX_TOKENS_CONTROL, 9092);
  assert.equal(core.WIRE_MAX_TOKENS_HIGH, 16384);
  assert.equal(core.REFERENCE_CALLER_MAX_TOKENS + core.VERTEX_THINKING_HEADROOM, 9092);
  assert.equal(build('A').max_tokens, 9092);
  assert.equal(build('B').max_tokens, 9092);
  assert.equal(build('C').max_tokens, 16384);
  assert.equal(build('D').max_tokens, 16384);
  for (const bad of [900, 9092 + 8192, 16384 + 8192, 0, -1, null, undefined, '9092']) {
    assert.throws(() => core.assertWireMaxTokens(bad));
  }
});

test('the ONLY properties that vary between arms are max_tokens and the presence of google', () => {
  const pairs: Array<[core.ArmId, core.ArmId]> = [['A', 'B'], ['A', 'C'], ['A', 'D'], ['B', 'C'], ['B', 'D'], ['C', 'D']];
  for (const [x, y] of pairs) {
    const diff = core.armBodyDifferences(build(x), build(y));
    for (const key of diff) {
      assert.ok(key === 'max_tokens' || key === 'google', `arms ${x}/${y} differ on ${key}, which is not a factor`);
    }
  }
  // and every non-factor value is identical, not merely "not compared"
  for (const key of ['model', 'messages', 'temperature', 'seed', 'top_p']) {
    const vals = new Set(core.ARM_IDS.map((a) => JSON.stringify((build(a) as Record<string, unknown>)[key])));
    assert.equal(vals.size, 1, `${key} must be held constant across arms`);
  }
});

test('serialization preserves the google field exactly — the v2.0 defect class', () => {
  for (const arm of ['B', 'D'] as const) {
    const serialized = JSON.stringify(build(arm));
    assert.ok(serialized.includes('"google":{"thinking_config":{"thinking_budget":2048}}'), `arm ${arm} on the wire`);
    assert.equal(serialized.includes('"reasoning"'), false, 'the OpenRouter dialect must never be serialized');
    assert.deepEqual(JSON.parse(serialized).google, { thinking_config: { thinking_budget: 2048 } });
  }
});

test('the realized arm is classified from the SERIALIZED body, and violations refuse to classify', () => {
  for (const arm of core.ARM_IDS) {
    const r = core.realizedArmFromSerializedBody(JSON.stringify(build(arm)));
    assert.equal(r.arm, arm);
    assert.deepEqual(r.violations, []);
    assert.equal(r.maxTokens, core.armSpec(arm).maxTokens);
    assert.equal(r.thinkingBudget, core.armSpec(arm).thinkingBudget);
  }
  // A body that LOOKS capped in config but sends the OpenRouter dialect is not an arm at all.
  const smuggled = { ...build('A'), reasoning: { max_tokens: 2048 } };
  const bad = core.realizedArmFromSerializedBody(JSON.stringify(smuggled));
  assert.equal(bad.arm, null);
  assert.ok(bad.violations.includes('forbidden_key:reasoning'));

  for (const inert of ['generationConfig', 'extra_body']) {
    const b = core.realizedArmFromSerializedBody(JSON.stringify({ ...build('A'), [inert]: { thinkingConfig: { thinkingBudget: 2048 } } }));
    assert.equal(b.arm, null, `${inert} is a silent no-op on this endpoint and must invalidate the run`);
  }
  // zero, negative and off-literal budgets never realize as an arm
  for (const budget of [0, -1, 4096, 1509]) {
    const b = core.realizedArmFromSerializedBody(JSON.stringify({ ...build('A'), google: { thinking_config: { thinking_budget: budget } } }));
    assert.equal(b.arm, null, `budget ${budget} is not the preregistered literal`);
  }
  assert.equal(core.realizedArmFromSerializedBody('not json').arm, null);
  assert.equal(core.realizedArmFromSerializedBody('[]').arm, null);
});

test('environment variables cannot change arm construction (D-37)', () => {
  const keys = ['LLM_THINKING_BUDGET', 'AUDIT_EVAL_THINKING_BUDGET', 'GEMINI_MODEL', 'AUDIT_LLM_SEED'];
  const saved = keys.map((k) => [k, process.env[k]] as const);
  const before = core.ARM_IDS.map((a) => JSON.stringify(build(a)));
  try {
    for (const k of keys) process.env[k] = '999999';
    const after = core.ARM_IDS.map((a) => JSON.stringify(build(a)));
    assert.deepEqual(after, before, 'a budget read from the environment is not a preregistered arm');
    assert.equal(core.THINKING_BUDGET, 2048);
  } finally {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('the wire format is locked in the CODE, and the three inert forms cannot be reintroduced', () => {
  const src = code(CORE_SRC);
  // The SL0-verified honoured form (lib/trace.ts:152-165 and :528) — top level, under `google`.
  assert.ok(/google = \{ thinking_config: \{ thinking_budget: spec\.thinkingBudget \} \}/.test(src),
    'the honoured form is a TOP-LEVEL google.thinking_config.thinking_budget');
  // The dialect that made v2.0's arms B and D silent duplicates must not be constructible here.
  assert.equal(/body\.reasoning\s*=/.test(src), false, 'reasoning is the OpenRouter dialect and is never built');
  assert.equal(/gParams\.generationConfig|body\.generationConfig\s*=/.test(src), false, 'generationConfig is a silent no-op');
  assert.equal(/body\.extra_body\s*=/.test(src), false, 'extra_body is a python-SDK concept, not this endpoint contract');
  // The budget is a literal, never an environment read.
  assert.ok(/export const THINKING_BUDGET = 2_048;/.test(src));
  assert.equal(/process\.env/.test(src), false, 'the pure core must not read the environment at all');
});

test('the runner sends the honoured form and never the OpenRouter dialect', () => {
  const src = code(RUNNER_SRC);
  assert.ok(/google: \{ thinking_config: \{ thinking_budget: PROBE_THINKING_BUDGET \} \}/.test(src),
    'the probe must exercise the same honoured form the arms use');
  assert.equal(/reasoning:\s*\{/.test(src), false, 'the runner must never construct a reasoning block');
  assert.equal(/extra_body|generationConfig/.test(src), false);
  // maxRetries zero, one timeout, and an instrumented fetch are the transport contract (§4.4).
  assert.ok(/maxRetries: 0,/.test(src));
  assert.ok(/fetch: instrumentedFetch,/.test(src));
  assert.ok(/ACTIVE\.dispatches \+= 1;/.test(src) && /if \(ACTIVE\.dispatches > 1\) throw/.test(src),
    'exactly one dispatch per scheduled call, enforced at the fetch boundary');
  // The arm is read off the bytes, before the network call.
  const boundary = src.slice(src.indexOf('async function instrumentedFetch'), src.indexOf('const t0 = performance.now();'));
  assert.ok(boundary.includes('realizedArmFromSerializedBody'), 'the realized arm is derived from the serialized outbound body');
});

test('the runner may add ONLY the three files PRD §4.1 permits', () => {
  // Preflight diffs HEAD against the reference commit and fails on any change that is not an
  // addition of one of these three paths — that is what makes "edit no existing file" a machine
  // check rather than a claim in a build report. The list is the check's one hand-maintained part,
  // so it is locked here: a fourth entry can only appear by editing this test too.
  const src = read(RUNNER_SRC);
  const start = src.indexOf('const ALLOWED_NEW_FILES = [');
  assert.notEqual(start, -1, 'preflight must carry an explicit permitted-additions list');
  const block = src.slice(start, src.indexOf('];', start));
  const paths = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(paths, [
    'lib/__tests__/lvc-judge-capacity-factorial-core.test.ts',
    'lib/lvc-judge-capacity-factorial-core.ts',
    'scripts/lvc-judge-capacity-factorial.mjs',
  ]);
  // and every one of them is a real file, so the list cannot pass by naming paths that do not exist
  for (const p of paths) assert.ok(read(p).length > 0, `${p} must exist`);
});

test("V's production ruling on LLM_THINKING_BUDGET is a preregistered literal, with its date", () => {
  // §3.3's one open item, confirmed 11 Aug 2026: never set in production, at any point. It decides
  // whether arm A reproduces an UNCAPPED deployed judge, so it must not be a command-line argument
  // and a re-freeze must not be able to regress it to "unconfirmed".
  assert.equal(core.REFERENCE_ENV_GLOBAL_THINKING_BUDGET, 'confirmed_absent');
  assert.equal(core.REFERENCE_ENV_CONFIRMED_ON, '2026-08-11');
  const src = code(RUNNER_SRC);
  assert.equal(/'unconfirmed_pending_v'/.test(src), false, 'the pending placeholder must be gone, not merely overridden');
  assert.ok(/reference_env_global_thinking_budget: core\.REFERENCE_ENV_GLOBAL_THINKING_BUDGET/.test(src));
});

test('the runner imports no production retry, fallback, classifier or parser', () => {
  const importLines = read(RUNNER_SRC).split('\n').filter((l) => /^\s*(import\b|.*\bawait import\()/.test(l));
  for (const banned of ['defaultJudge', 'governedChat', 'tracedChat', 'chatWithFallback', 'buildOpenrouterParams',
    'createWithRetry', 'classifyProviderResponse', 'parseJudgeResponse', 'geminiThinkingBudget']) {
    assert.equal(importLines.some((l) => l.includes(banned)), false, `${banned} must not be imported`);
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// COMPLETENESS (§3.5, §5 "Completeness")
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('a fully valid response is raw_complete', () => {
  const r = core.evaluateCompleteness(okBody(49), ids(49));
  assert.equal(r.raw_complete, true, r.violation_codes.join(','));
  assert.equal(r.array_length, 49);
  assert.equal(r.missing_id_count, 0);
  assert.deepEqual(r.violation_codes, []);
});

test('missing, duplicate, unknown, malformed, out-of-range, absent consider_instead and empty why are each incomplete', () => {
  const E = ids(3);
  const base = E.map(okEntry);

  const missing = core.evaluateCompleteness(JSON.stringify(base.slice(0, 2)), E);
  assert.equal(missing.raw_complete, false);
  assert.equal(missing.missing_id_count, 1);
  assert.ok(missing.violation_codes.includes('missing_id'));

  const dup = core.evaluateCompleteness(JSON.stringify([base[0], base[0], base[1]]), E);
  assert.equal(dup.raw_complete, false);
  assert.equal(dup.duplicate_id_count, 1);
  assert.ok(dup.violation_codes.includes('duplicate_id'));

  const unknown = core.evaluateCompleteness(JSON.stringify([base[0], base[1], okEntry('synthetic-rec-999')]), E);
  assert.equal(unknown.raw_complete, false);
  assert.equal(unknown.unknown_id_count, 1);

  const malformed = core.evaluateCompleteness(JSON.stringify([base[0], base[1], { ...base[2], verdict: 'APPLIES' }]), E);
  assert.equal(malformed.raw_complete, false);
  assert.equal(malformed.invalid_verdict_count, 1, 'the contract is exact-match, not case-tolerant');

  for (const c of [1.5, -0.1, Number.NaN, 'high', null]) {
    const r = core.evaluateCompleteness(JSON.stringify([base[0], base[1], { ...base[2], confidence: c }]), E);
    assert.equal(r.raw_complete, false, `confidence ${String(c)} must fail`);
    assert.equal(r.invalid_confidence_count, 1);
  }
  // the boundary values are IN range
  assert.equal(core.evaluateCompleteness(JSON.stringify([{ ...base[0], confidence: 0 }, { ...base[1], confidence: 1 }, base[2]]), E).raw_complete, true);

  const noCi = core.evaluateCompleteness(JSON.stringify([base[0], base[1], { id: E[2], verdict: 'applies', confidence: 0.5, why: 'x' }]), E);
  assert.equal(noCi.raw_complete, false);
  assert.equal(noCi.missing_consider_instead_count, 1, 'consider_instead must be PRESENT as a key');
  // present with a string value is fine; present with a non-string, non-null value is not
  assert.equal(core.evaluateCompleteness(JSON.stringify([base[0], base[1], { ...base[2], consider_instead: 'other test' }]), E).raw_complete, true);
  assert.equal(core.evaluateCompleteness(JSON.stringify([base[0], base[1], { ...base[2], consider_instead: 7 }]), E).raw_complete, false);

  for (const why of ['', '   ', 42, null]) {
    const r = core.evaluateCompleteness(JSON.stringify([base[0], base[1], { ...base[2], why }]), E);
    assert.equal(r.raw_complete, false, `why=${JSON.stringify(why)} must fail`);
    assert.equal(r.empty_why_count, 1);
  }

  const nonObject = core.evaluateCompleteness(JSON.stringify([base[0], base[1], 'oops']), E);
  assert.equal(nonObject.raw_complete, false);
  assert.equal(nonObject.non_object_entry_count, 1);
});

test('the completeness endpoint is STRICTER than the production parser, deliberately', () => {
  // Everything below is what lib/lvc-core.ts parseJudgeResponse would rescue: it normalizes the
  // invalid verdict, clamps the confidence, drops the unknown id and backfills the missing rec —
  // which is exactly why the 9 August results looked complete.
  const E = ids(3);
  const rescued = JSON.stringify([
    { id: E[0], verdict: 'maybe', confidence: 5, why: '', consider_instead: null },
    { id: 'synthetic-rec-999', verdict: 'applies', confidence: 0.9, why: 'x', consider_instead: null },
  ]);
  const r = core.evaluateCompleteness(rescued, E);
  assert.equal(r.raw_complete, false);
  assert.ok(r.violation_codes.length >= 4);
});

test('strict_json_array and production_extractable_array are distinct indicators', () => {
  const E = ids(2);
  const bare = JSON.stringify(E.map(okEntry));
  const strict = core.evaluateCompleteness(bare, E);
  assert.equal(strict.strict_json_array, true);
  assert.equal(strict.production_extractable_array, true);

  const fenced = core.evaluateCompleteness(`Here you go:\n\`\`\`json\n${bare}\n\`\`\`\n`, E);
  assert.equal(fenced.strict_json_array, false, 'prose + a fence is not a strict array');
  assert.equal(fenced.production_extractable_array, true, 'but the frozen production rule still extracts it');
  assert.equal(fenced.raw_complete, true, 'raw_complete builds on the extraction rule, not the strict one');

  const truncated = core.evaluateCompleteness(`[{"id":"${E[0]}","verdict":"applies","confid`, E);
  assert.equal(truncated.production_extractable_array, false);
  assert.equal(truncated.raw_complete, false);
  assert.ok(truncated.violation_codes.includes('not_an_extractable_array'));
  assert.equal(truncated.missing_id_count, 2, 'nothing extracted ⇒ everything missing, never "unknown"');
});

test('the frozen extraction rule matches the production rule it was copied from', () => {
  // Behavioural equivalence with lib/lvc-core.ts extractJsonArray, pinned on the cases that matter.
  assert.deepEqual(core.extractJsonArrayFrozen('[1,2]'), [1, 2]);
  assert.deepEqual(core.extractJsonArrayFrozen('```json\n[1,2]\n```'), [1, 2]);
  assert.deepEqual(core.extractJsonArrayFrozen('prose [1,2] more'), [1, 2]);
  assert.equal(core.extractJsonArrayFrozen(''), null);
  assert.equal(core.extractJsonArrayFrozen('{"a":1}'), null);
  assert.equal(core.extractJsonArrayFrozen('[1,'), null);
});

test('a structurally complete body with finish_reason=length is raw_complete but NOT provider_usable', () => {
  const r = core.evaluateCompleteness(okBody(49), ids(49));
  assert.equal(r.raw_complete, true);
  assert.equal(core.isProviderUsable(r, 'length'), false, 'production rejects length BEFORE parsing');
  assert.equal(core.isProviderUsable(r, 'stop'), true);
  assert.equal(core.isProviderUsable(r, 'STOP'), true);
  assert.equal(core.isProviderUsable(r, null), true, 'an absent finish_reason is not a defect when content is present');
  assert.equal(core.isProviderUsable(r, 'content_filter'), false);
  // and an incomplete body is never provider_usable, whatever the finish reason says
  const bad = core.evaluateCompleteness(okBody(48), ids(49));
  assert.equal(core.isProviderUsable(bad, 'stop'), false);
});

test('the accepted finish-reason set is the frozen copy of the production set', () => {
  const prod = read('lib/provider-error-core.ts');
  assert.ok(prod.includes("new Set(['stop', 'tool_calls', 'function_call'])"),
    'if production changes USABLE_FINISH_REASONS, the frozen copy must be re-ratified, not silently followed');
  assert.deepEqual([...core.PRODUCTION_ACCEPTED_FINISH_REASONS], ['stop', 'tool_calls', 'function_call']);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// TELEMETRY (§3.6, §5 "Telemetry")
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('absent usage fields stay null — never zero', () => {
  for (const usage of [null, undefined, {}, { prompt_tokens: 10 }]) {
    const t = core.deriveTokenAccounting(usage as core.RawUsage, { inferredSemanticEstablished: true });
    assert.equal(t.reasoning_tokens_reported, null);
    assert.equal(t.unaccounted_output_tokens, null);
    assert.equal(t.reasoning_tokens_inferred, null);
    assert.equal(t.reasoning_token_source, 'unavailable');
  }
});

test('a reported reasoning field is read flat or from completion details, and wins', () => {
  const flat = core.deriveTokenAccounting({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 100, reasoning_tokens: 60 }, { inferredSemanticEstablished: true });
  assert.equal(flat.reasoning_tokens_reported, 60);
  assert.equal(flat.reasoning_token_source, 'reported');
  assert.equal(flat.unaccounted_output_tokens, 85, 'unaccounted is still reported SEPARATELY, never merged');

  const nested = core.deriveTokenAccounting({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 100, completion_tokens_details: { reasoning_tokens: 60 } }, { inferredSemanticEstablished: false });
  assert.equal(nested.reasoning_tokens_reported, 60);
  assert.equal(nested.reasoning_token_source, 'reported');
});

test('a negative subtraction becomes null, never zero and never negative', () => {
  const t = core.deriveTokenAccounting({ prompt_tokens: 100, completion_tokens: 100, total_tokens: 50 }, { inferredSemanticEstablished: true });
  assert.equal(t.unaccounted_output_tokens, null);
  assert.equal(t.reasoning_tokens_inferred, null);
  assert.equal(t.reasoning_token_source, 'unavailable');
  // an exact zero is a real observation and is kept
  const zero = core.deriveTokenAccounting({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, { inferredSemanticEstablished: true });
  assert.equal(zero.unaccounted_output_tokens, 0);
  assert.equal(zero.reasoning_tokens_inferred, 0);
  assert.equal(zero.reasoning_token_source, 'inferred');
});

test('reasoning_tokens_inferred stays null unless the probe established the semantic', () => {
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 100 };
  const notEstablished = core.deriveTokenAccounting(usage, { inferredSemanticEstablished: false });
  assert.equal(notEstablished.unaccounted_output_tokens, 85);
  assert.equal(notEstablished.reasoning_tokens_inferred, null, 'unaccounted tokens are NEVER renamed as reasoning tokens');
  assert.equal(notEstablished.reasoning_token_source, 'unavailable');

  const established = core.deriveTokenAccounting(usage, { inferredSemanticEstablished: true });
  assert.equal(established.reasoning_tokens_inferred, 85);
  assert.equal(established.reasoning_token_source, 'inferred');
});

test('the cap-never-bound case reports UNTESTED, not a null result (§3.7)', () => {
  const mk = (arm: core.ArmId, reasoning: number | null): core.CallRecord => ({
    arm, responded: true, raw_complete: true, provider_usable: true, finish_reason: 'stop',
    strict_json_array: true, production_extractable_array: true, missing_id_count: 0,
    completion_tokens: 100, reasoning_tokens_reported: reasoning, unaccounted_output_tokens: null,
    total_ms: 1000, ttfb_ms: 100,
  });
  const scheduled = { A: 8, B: 8, C: 8, D: 8 } as Record<core.ArmId, number>;

  const noTelemetry = core.thinkingFactorBound(core.aggregateByArm([mk('A', null), mk('C', null)], scheduled));
  assert.equal(noTelemetry.bound, null, 'no telemetry ⇒ untested');

  const neverBound = core.thinkingFactorBound(core.aggregateByArm([mk('A', 500), mk('C', 900)], scheduled));
  assert.equal(neverBound.bound, false, 'uncapped arms below 2048 ⇒ the cap never bound ⇒ B/D duplicate A/C');

  const bound = core.thinkingFactorBound(core.aggregateByArm([mk('A', 500), mk('C', 3000)], scheduled));
  assert.equal(bound.bound, true);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// SCHEDULE AND INTEGRITY (§3.2, §3.4, §4.2, §4.5)
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('every arm appears once per block and once in every position, in both cycles', () => {
  const s = core.buildSchedule('exp-test');
  assert.equal(s.length, 32);
  assert.deepEqual(core.validateSchedule(s), []);
  for (const cycle of [1, 2]) {
    for (const b of [1, 2, 3, 4]) {
      assert.deepEqual(s.filter((c) => c.cycle === cycle && c.block === b).map((c) => c.arm).sort(), ['A', 'B', 'C', 'D']);
    }
    for (const p of [1, 2, 3, 4]) {
      assert.deepEqual(s.filter((c) => c.cycle === cycle && c.position === p).map((c) => c.arm).sort(), ['A', 'B', 'C', 'D']);
    }
    assert.equal(s.filter((c) => c.cycle === cycle).length, 16);
  }
  for (const arm of core.ARM_IDS) assert.equal(s.filter((c) => c.arm === arm).length, 8);
  assert.equal(new Set(s.map((c) => c.runId)).size, 32, 'run ids are unique');
  // cycle 1 alone yields exactly the first sixteen, with identical run ids
  const c1 = core.buildSchedule('exp-test', 1);
  assert.deepEqual(c1.map((c) => c.runId), s.slice(0, 16).map((c) => c.runId));
  assert.deepEqual(core.validateSchedule(c1), []);
});

test('an unbalanced schedule is REJECTED rather than quietly accepted', () => {
  const s = core.buildSchedule('exp-test', 1);
  s[0] = { ...s[0], arm: 'B' };
  assert.ok(core.validateSchedule(s).length > 0);
});

test('canonical hashes are stable across key insertion order', () => {
  assert.equal(
    core.hashCanonicalJson({ z: 1, a: { d: [3, 2, 1], c: 2 } }),
    core.hashCanonicalJson({ a: { c: 2, d: [3, 2, 1] }, z: 1 }),
  );
  // array ORDER is preserved — reordering an array is a different input, not the same one
  assert.notEqual(core.hashCanonicalJson([1, 2, 3]), core.hashCanonicalJson([3, 2, 1]));
  assert.equal(core.canonicalJsonString({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(core.canonicalJsonString({ a: 1 }).endsWith('\n'), false, 'no trailing newline');
  assert.equal(core.sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('the four frozen hashes are computed from the frozen bytes and validate as a set', () => {
  const snapshot = [{ id: 'synthetic-rec-001', statement: 'synthetic' }];
  const h = core.frozenInputHashes(MESSAGES, snapshot);
  assert.equal(h.system_message, core.sha256Hex('SYNTHETIC SYSTEM'));
  assert.equal(h.user_message, core.sha256Hex('SYNTHETIC USER'));
  assert.equal(h.message_array, core.hashCanonicalJson(MESSAGES));
  assert.equal(h.recommendation_snapshot, core.hashCanonicalJson(snapshot));

  const frozen: core.FrozenInput = {
    protocol: core.PROTOCOL_ID, reference_sha: core.REFERENCE_SHA, case_ref: 'synthetic-case',
    model: core.JUDGE_MODEL, messages: MESSAGES, expected_ids: ids(2), expected_count: 2, hashes: h,
  };
  assert.deepEqual(core.validateFrozenInput(frozen), []);
  assert.ok(core.validateFrozenInput({ ...frozen, expected_count: 3 }).includes('frozen_expected_count_mismatch'));
  assert.ok(core.validateFrozenInput({ ...frozen, expected_ids: ['x', 'x'], expected_count: 2 }).includes('frozen_expected_ids_duplicated'));
  assert.ok(core.validateFrozenInput({ ...frozen, messages: [{ role: 'system', content: 'DRIFTED' }, MESSAGES[1]] }).includes('frozen_system_hash_mismatch'));
});

test('journal validation rejects a duplicate dispatch', () => {
  const ok = core.validateJournal([
    { run_id: 'r1', event: 'scheduled' }, { run_id: 'r1', event: 'dispatching' }, { run_id: 'r1', event: 'completed', dispatch_count: 1 },
  ]);
  assert.equal(ok.valid, true);

  const twice = core.validateJournal([
    { run_id: 'r1', event: 'scheduled' }, { run_id: 'r1', event: 'dispatching' }, { run_id: 'r1', event: 'dispatching' },
  ]);
  assert.equal(twice.valid, false);
  assert.ok(twice.problems.some((p) => p.includes('duplicate_dispatch')));

  const counted = core.validateJournal([
    { run_id: 'r1', event: 'scheduled' }, { run_id: 'r1', event: 'dispatching' }, { run_id: 'r1', event: 'completed', dispatch_count: 2 },
  ]);
  assert.equal(counted.valid, false);
  assert.ok(counted.problems.some((p) => p.includes('dispatch_count_not_one')));

  assert.equal(core.validateJournal([{ run_id: 'r1', event: 'scheduled' }, { run_id: 'r1', event: 'not_a_real_event' }]).valid, false);
  assert.equal(core.validateJournal([{ run_id: '', event: 'scheduled' }]).valid, false);
});

test('an uncertain call is never replayed — it becomes outcome_unknown and stays in the denominator', () => {
  const uncertain = [{ run_id: 'r1', event: 'scheduled' }, { run_id: 'r1', event: 'dispatching' }];
  assert.equal(core.nextJournalAction(uncertain, 'r1'), 'mark_unknown');
  assert.equal(core.validateJournal(uncertain).runs[0].uncertain, true);

  assert.equal(core.nextJournalAction([], 'r1'), 'dispatch');
  assert.equal(core.nextJournalAction([{ run_id: 'r1', event: 'scheduled' }], 'r1'), 'dispatch');
  for (const t of core.JOURNAL_TERMINAL_EVENTS) {
    assert.equal(core.nextJournalAction([{ run_id: 'r1', event: 'scheduled' }, { run_id: 'r1', event: 'dispatching' }, { run_id: 'r1', event: t, dispatch_count: 1 }], 'r1'), 'skip_done');
  }
});

test('redaction removes credential-like fields, and message content never survives as text', () => {
  const red = core.redactValue({
    Authorization: 'Bearer abc.def', apiKey: 'k', nested: { client_secret: 's', private_key: 'p', keep: 'visible' },
    list: [{ access_token: 't' }], plain: 'Bearer xyz',
  }) as Record<string, unknown>;
  assert.equal(red.Authorization, core.REDACTED);
  assert.equal(red.apiKey, core.REDACTED);
  assert.equal((red.nested as Record<string, unknown>).client_secret, core.REDACTED);
  assert.equal((red.nested as Record<string, unknown>).private_key, core.REDACTED);
  assert.equal((red.nested as Record<string, unknown>).keep, 'visible');
  assert.equal(((red.list as unknown[])[0] as Record<string, unknown>).access_token, core.REDACTED);
  assert.equal(red.plain, core.REDACTED, 'a bare bearer string is a credential wherever it appears');
  assert.equal(JSON.stringify(red).includes('abc.def'), false);

  const { redacted, error } = core.redactSerializedBody(JSON.stringify(build('B')));
  assert.equal(error, null);
  const text = JSON.stringify(redacted);
  assert.equal(text.includes('SYNTHETIC USER'), false, 'message content is replaced by a digest');
  assert.ok(text.includes('content_sha256'));
  assert.deepEqual((redacted as Record<string, unknown>).google, { thinking_config: { thinking_budget: 2048 } },
    'the arm-defining field must SURVIVE redaction — otherwise the wire check is blind');
  assert.equal(core.redactSerializedBody('nope').error, 'serialized_body_unparseable');
});

test('only allowlisted response headers are kept, and the rest are counted not named', () => {
  const { kept, dropped_count } = core.filterResponseHeaders({
    'Content-Type': 'application/json', 'set-cookie': 'a=b', 'x-goog-quota-user': 'q', authorization: 'Bearer x', Date: 'now',
  });
  assert.deepEqual(Object.keys(kept).sort(), ['content-type', 'date']);
  assert.equal(dropped_count, 3);
});

test('paths inside the private root pass and paths outside fail', () => {
  const root = '/repo/.corpus-eval/lvc-judge-capacity-factorial/v1';
  assert.equal(core.isInsidePrivateRoot(root, root), true);
  assert.equal(core.isInsidePrivateRoot(root, `${root}/runs/e1/journal.private.jsonl`), true);
  assert.equal(core.isInsidePrivateRoot(root, '/repo/lib/lvc.ts'), false);
  assert.equal(core.isInsidePrivateRoot(root, `${root}/../escape.json`), false);
  assert.equal(core.isInsidePrivateRoot(root, `${root}/a/../../escape.json`), false);
  assert.equal(core.isInsidePrivateRoot(root, `${root}EVIL/x.json`), false, 'a sibling sharing the prefix is outside');
  assert.equal(core.isInsidePrivateRoot(root, 'relative/path.json'), false);
  assert.equal(core.isInsidePrivateRoot(root, `${root}/./runs/./x`), true);
});

test('the private root is the ignored one, and the timeout floor holds', () => {
  assert.equal(core.PRIVATE_ROOT, '.corpus-eval/lvc-judge-capacity-factorial/v1');
  assert.ok(read('.gitignore').includes('.corpus-eval/'), 'the private root must stay gitignored');
  assert.ok(core.TIMEOUT_MS >= core.MIN_TIMEOUT_MS && core.MIN_TIMEOUT_MS === 240_000);
  assert.equal(core.REFERENCE_SHA, '81b7c93a8e5e0323a47a3f893fd4b0e96aaa421a');
});

test('the core declares no *_VERSION const, so it cannot silently enter the architecture registry', () => {
  // lib/architecture/manifests.ts is a tracked production file this build may not edit (§4.1).
  // A top-level lib/*.ts becomes a coverage-rule subsystem the moment it exports one of these.
  const src = read(CORE_SRC);
  assert.equal(/^export const ([A-Z0-9_]*_VERSIONS?(?:_[A-Z0-9_]+)?)(?:\s*:[^=]*)?\s*=\s*(.+?);/m.test(src), false);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// AGGREGATION (§6)
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('every scheduled call stays in the denominator (D-35)', () => {
  const rec = (arm: core.ArmId, complete: boolean, responded = true): core.CallRecord => ({
    arm, responded, raw_complete: complete, provider_usable: complete, finish_reason: complete ? 'stop' : 'length',
    strict_json_array: complete, production_extractable_array: complete, missing_id_count: complete ? 0 : 12,
    completion_tokens: 100, reasoning_tokens_reported: null, unaccounted_output_tokens: null,
    total_ms: 1000, ttfb_ms: 50,
  });
  // Arm A: 8 scheduled, only 2 produced a response, 1 of those complete.
  const records = [rec('A', true), rec('A', false)];
  const agg = core.aggregateByArm(records, { A: 8, B: 8, C: 8, D: 8 } as Record<core.ArmId, number>);
  const a = agg.find((x) => x.arm === 'A')!;
  assert.equal(a.scheduled, 8, 'the six infrastructure failures are NOT dropped');
  assert.equal(a.raw_complete, 1);
  assert.ok(a.raw_complete_wilson.hi < 0.6, 'the interval reflects 1/8, not 1/2');
  assert.equal(a.finish_length, 1);
  const empty = agg.find((x) => x.arm === 'B')!;
  assert.equal(empty.scheduled, 8);
  assert.equal(empty.raw_complete, 0);
});

test('Wilson intervals and continuous summaries behave at the edges', () => {
  assert.deepEqual(core.wilson(0, 0), { lo: 0, hi: 0 });
  const all = core.wilson(8, 8);
  assert.ok(all.hi === 1 && all.lo > 0.6 && all.lo < 1);
  const none = core.wilson(0, 8);
  assert.ok(none.lo === 0 && none.hi > 0 && none.hi < 0.4);

  assert.deepEqual(core.summarizeContinuous([]), { n: 0, median: null, min: null, max: null });
  assert.deepEqual(core.summarizeContinuous([null, undefined, Number.NaN]), { n: 0, median: null, min: null, max: null });
  assert.deepEqual(core.summarizeContinuous([3, 1, 2]), { n: 3, median: 2, min: 1, max: 3 });
  assert.deepEqual(core.summarizeContinuous([4, 1, 3, 2]), { n: 4, median: 2.5, min: 1, max: 4 });
  assert.deepEqual(core.summarizeContinuous([5, null, 1]), { n: 2, median: 3, min: 1, max: 5 }, 'absent values are excluded, not zeroed');
});
