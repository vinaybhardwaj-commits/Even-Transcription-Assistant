// lib/__tests__/transport-attribution-traceless.test.ts
// CDMSS-RERANK-TELEMETRY-CC-KICKOFF-11-AUG-2026 §4.4 (served-provider attribution) and §6.
//
// WHAT THIS GATES. The rerank judge is TRACELESS by requirement (kickoff constraint 2 — passing a
// parent trace id into governedChat changes transport behaviour), so its dispatch runs through
// `chatWithFallback`, which attached no evidence. That is exactly why the 11 Aug throttle-rate
// census could count 21 local substitutions but could not say which caller they belonged to.
//
// §4.4 permits adding optional structured transport metadata to the existing return value ONLY if
// tests prove five properties: byte-equivalent request parameters, unchanged provider selection and
// fallback order, unchanged retry behaviour, behaviourally compatible existing callers, and no
// parent trace id. Those five are the sections below.
//
// NO CLINICAL TEXT, NO NETWORK, NO DB. Synthetic fixtures only (§6.4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TRANSPORT_ATTRIBUTION_FIELD, attachTransportAttribution, readTransportAttribution,
  classifyAttemptOutcome, type CdmssTransportAttribution,
} from '../transport-attribution-core';
import {
  TRANSPORT_ATTRIBUTION_FIELD as VIA_TRACE_FIELD,
  attachTransportAttribution as viaTraceAttach,
  readTransportAttribution as viaTraceRead,
} from '../trace';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
/** Assertions are about CODE, not commentary — the files name the rejected shapes in prose. */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const LLM = 'lib/llm.ts';
const CORE = 'lib/transport-attribution-core.ts';

/** The body of `chatWithFallback` alone. Bounded by the NEXT top-level declaration, not by a
 *  comment — `code()` strips comments, so a comment marker would slice to end-of-file and drag in
 *  the embedding helpers that follow. */
function chatWithFallbackBody(src: string): string {
  const start = src.indexOf('export async function chatWithFallback');
  assert.notEqual(start, -1, 'chatWithFallback must exist');
  const rest = src.slice(start + 1);
  const nextDecl = rest.search(/\nexport (async )?(function|const) /);
  return nextDecl === -1 ? rest : rest.slice(0, nextDecl);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §4.4 property 5 — NO PARENT TRACE ID IS INTRODUCED
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('the traceless route stays traceless — no trace id reaches the rerank transport', () => {
  // The rerank judge must keep passing `undefined`. If this line ever gains a trace id the call
  // moves from chatWithFallback to tracedChat, which is a transport change, not instrumentation.
  assert.ok(/governedChat\(undefined, 'rerank_judge'/.test(code('lib/rerank.ts')),
    'rerank_judge must dispatch tracelessly (kickoff constraint 2)');
  // and the attribution change must not have smuggled a trace id into the traceless transport
  const src = code(LLM);
  assert.equal(/chatWithFallback[\s\S]{0,4000}?startTrace\(/.test(src), false,
    'chatWithFallback must not start a trace');
  assert.equal(/attachTransportAttribution\([^)]*trace_id/.test(src), false);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §4.4 property 1 — REQUEST PARAMETERS ARE BYTE-EQUIVALENT
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('nothing in the change touches the outbound request object', () => {
  const src = code(LLM);
  // The attachment wraps the RESULT. It must never appear on the params path.
  assert.equal(/attachTransportAttribution\(\s*params/.test(src), false, 'params are never wrapped');
  assert.equal(/params\.\w+\s*=\s*/.test(src.slice(src.indexOf('export async function chatWithFallback'))), false,
    'chatWithFallback must not mutate params');
  // The Vertex tier's request construction is unchanged: same strip, same baseMax, same +8192.
  assert.ok(/const \{ options: _o, keep_alive: _k, \.\.\.rest \} = params as Record<string, unknown>;/.test(src));
  assert.ok(/const gParams = \{ \.\.\.rest, model: vertexModelName\(geminiModel as string\), max_tokens: baseMax \+ 8192 \};/.test(src));
});

test('attachment is non-enumerable, so a serialized request or response is byte-identical', () => {
  const completion = { id: 'cmpl_synthetic', model: 'gemini-2.5-flash', choices: [{ message: { content: '{"0":7}' } }] };
  const before = JSON.stringify(completion);
  const keysBefore = Object.keys(completion);

  attachTransportAttribution(completion, {
    dispatched_provider: 'vertex', dispatched_model: 'gemini-2.5-flash', cloud_response_received: true,
    attempts: [{ tier: 'vertex', attempt: 1, outcome: 'success', status: 200 }],
  });

  assert.equal(JSON.stringify(completion), before, 'JSON serialization is unchanged');
  assert.deepEqual(Object.keys(completion), keysBefore, 'enumerable keys are unchanged');
  assert.deepEqual({ ...completion }, JSON.parse(before), 'a spread cannot observe it');
  assert.equal(Object.prototype.propertyIsEnumerable.call(completion, TRANSPORT_ATTRIBUTION_FIELD), false);
  // and it is still readable by the code that wants it
  assert.equal(readTransportAttribution(completion)?.dispatched_provider, 'vertex');
});

test('attachment returns the SAME object — it allocates nothing the caller could miss', () => {
  const c = { choices: [] };
  assert.equal(attachTransportAttribution(c, { dispatched_provider: 'ollama', dispatched_model: 'llama3.1:8b', cloud_response_received: false }), c);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §4.4 properties 2 and 3 — PROVIDER SELECTION, FALLBACK ORDER AND RETRY BEHAVIOUR UNCHANGED
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('the ladder, its order and its terminal dispositions are untouched', () => {
  const src = code(LLM);
  assert.ok(/const orModel = openrouterModel \|\| openrouterGeminiSlug\(geminiModel\);/.test(src));
  assert.ok(/const useOpenRouter = Boolean\(orModel\) && openrouterConfigured\(\);/.test(src));
  assert.ok(/const useGemini = Boolean\(geminiModel\) && geminiConfigured\(\);/.test(src));
  assert.ok(/if \(noLocalFallback\) throw lastErr;/.test(src), 'noLocalFallback still throws');
  assert.ok(/if \(lastTier === 'openrouter' && isProviderResponseError\(lastErr\)\) throw lastErr;/.test(src),
    'the OpenRouter bad-200 never launders into the local model');
});

test('retry policy is unchanged — capture rides the existing callback and adds no try budget', () => {
  const src = code(LLM);
  // Both tiers still hand createWithRetry the caller's ceiling and try count, unchanged.
  assert.equal((src.match(/timeoutMs: tierCeilingMs\(timeoutMs, deadlineAt\)/g) || []).length, 2);
  assert.equal((src.match(/^\s*maxTries,$/gm) || []).length, 2);
  // Capture happens INSIDE onAttemptFailure, which createWithRetry already wraps in a try/catch.
  const retrySrc = code('lib/openrouter-retry.ts');
  assert.ok(/const report = \(f: RetryAttemptFailure\) => \{ try \{ cfg\.onAttemptFailure\?\.\(f\); \} catch \{[^}]*\} \};/.test(retrySrc),
    'the callback is instrumentation-safe by contract — a throwing observer cannot change control flow');
  // and the console lines the census was read from are still emitted verbatim
  assert.ok(/\[provider-retry\] openrouter \$\{slug\} attempt \$\{f\.attempt\}\/\$\{f\.maxTries\}/.test(src));
  assert.ok(/\[provider-retry\] vertex \$\{geminiModel\} attempt \$\{f\.attempt\}\/\$\{f\.maxTries\}/.test(src));
});

test('every one of the four return sites carries evidence — no silent unattributed path', () => {
  const src = code(LLM);
  const body = chatWithFallbackBody(src);
  const returns = (body.match(/^\s*return /gm) || []).length;
  const attached = (body.match(/attachTransportAttribution\(/g) || []).length;
  assert.equal(returns, 4, 'chatWithFallback has exactly four return sites');
  assert.equal(attached, 4, 'and every one attaches attribution');
  for (const p of ["dispatched_provider: 'openrouter'", "dispatched_provider: 'vertex'"]) {
    assert.ok(body.includes(p), `${p} is recorded`);
  }
  assert.equal((body.match(/dispatched_provider: 'ollama'/g) || []).length, 2,
    'both local returns record ollama — the by-design one and the substitution');
});

test('the local substitution reports the LOCAL model, never the requested cloud model (§6.2)', () => {
  const src = code(LLM);
  const terminal = src.slice(src.lastIndexOf('if (noLocalFallback) throw lastErr;'));
  assert.ok(/dispatched_model: \(params as \{ model\?: string \}\)\.model \?\? null/.test(terminal),
    'a substituted call names llama3.1:8b, not gemini-2.5-flash — §10 fails the build if requested is reported as served');
  assert.ok(/cloud_response_received: false/.test(terminal));
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §4.4 property 4 — EXISTING CALLERS REMAIN BEHAVIOURALLY COMPATIBLE
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('every name still resolves at its original path, so no existing importer moves', () => {
  // lib/lvc.ts and lib/__tests__/lvc-judge-attribution.test.ts import these from './trace'.
  // BOTH are among the four files held uncommitted on main; neither may be touched by this build.
  assert.equal(VIA_TRACE_FIELD, TRANSPORT_ATTRIBUTION_FIELD);
  assert.equal(viaTraceAttach, attachTransportAttribution, 're-export, not re-implementation');
  assert.equal(viaTraceRead, readTransportAttribution);
  const held = read('lib/__tests__/lvc-judge-attribution.test.ts');
  assert.ok(held.includes("from '../trace'"), 'the held test still imports from ../trace and must keep working');
  assert.ok(read('lib/lvc.ts').includes("readTransportAttribution } from './trace'"));
});

test('the attempts field is OPTIONAL, so tracedChat attributions stay valid unchanged', () => {
  // tracedChat attaches three fields and no attempts. The LVC judge reads only provider/model.
  const withoutAttempts: CdmssTransportAttribution = {
    dispatched_provider: 'vertex', dispatched_model: 'gemini-2.5-pro', cloud_response_received: true,
  };
  const c = attachTransportAttribution({ choices: [] }, withoutAttempts);
  assert.equal(readTransportAttribution(c)?.attempts, undefined, 'absent means not collected, never []');
  assert.equal(readTransportAttribution(c)?.dispatched_model, 'gemini-2.5-pro');
  // trace.ts still attaches at its own four sites, unchanged
  const traceSrc = code('lib/trace.ts');
  for (const p of ["dispatched_provider: 'bedrock'", "dispatched_provider: 'openrouter'", "dispatched_provider: 'vertex'", "dispatched_provider: 'ollama'"]) {
    assert.ok(traceSrc.includes(p), `tracedChat still records ${p}`);
  }
});

test('a hostile completion cannot break the transport', () => {
  const frozen = Object.freeze({ choices: [] });
  assert.doesNotThrow(() => attachTransportAttribution(frozen, { dispatched_provider: 'vertex', dispatched_model: 'x', cloud_response_received: true }));
  assert.equal(readTransportAttribution(frozen), undefined, 'and it reports honestly that there is none');
  for (const v of [null, undefined, 'a string', 42]) {
    assert.equal(readTransportAttribution(v), undefined);
    assert.equal(attachTransportAttribution(v, { dispatched_provider: 'vertex', dispatched_model: 'x', cloud_response_received: true }), v);
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §4.3 / §6.2 — ORDERED ATTEMPT OUTCOMES, CLASSIFIED IDENTICALLY ON BOTH TIERS
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('a 429 is distinguishable from every other failure class', () => {
  assert.equal(classifyAttemptOutcome('http', 429), 'http_429');
  assert.equal(classifyAttemptOutcome('http', 503), 'http_other');
  assert.equal(classifyAttemptOutcome('http', 403), 'http_other');
  assert.equal(classifyAttemptOutcome('timeout', null), 'timeout');
  assert.equal(classifyAttemptOutcome('transport', null), 'transport_error');
  assert.equal(classifyAttemptOutcome('bad_response', null), 'bad_response');
});

test('both tiers classify through the same function — a 429 cannot be tier-dependent', () => {
  const src = code(LLM);
  assert.equal((src.match(/classifyAttemptOutcome\(f\.kind, f\.status\)/g) || []).length, 2,
    'one classifier, both tiers');
  assert.ok(/tier: 'openrouter', attempt: f\.attempt/.test(src));
  assert.ok(/tier: 'vertex', attempt: f\.attempt/.test(src));
});

test('the attempt sequence is invocation-scoped, never module state (§4.1)', () => {
  const src = code(LLM);
  const body = chatWithFallbackBody(src);
  assert.ok(/const attempts: TransportAttempt\[\] = \[\];/.test(body),
    'declared inside the function — two concurrent rerank batches cannot interleave');
  // no module-level mutable collector was introduced
  assert.equal(/^let _attempts|^const _attempts/m.test(src), false);
  // The array is COPIED into every attribution, so a later push cannot mutate a returned record.
  //
  // RE-PINNED (on-path D14): the old assertion counted the single exact spelling
  // `attempts: [...attempts]` and expected 3. D14 adds two local-attempt sites that copy as
  // `[...attempts, localAttemptSuccess()]` and two failure attributions that copy plainly, so that
  // one spelling no longer enumerates the copies. The INVARIANT it stood for is unchanged and is
  // now asserted directly and more strongly: no attribution anywhere receives the live array, and
  // every one of them takes a copy.
  assert.equal((body.match(/attempts: attempts\b/g) || []).length, 0,
    'the live array is never handed to an attribution — a later push could rewrite a returned record');
  assert.equal((body.match(/attempts: \[\.\.\.attempts/g) || []).length, 7,
    'seven attributions, seven copies: 2 cloud success, 1 terminal failure, 2 local failure, 2 local success');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §6.4 — PRIVACY
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('the evidence carries identifiers and enums only — no prompt, passage or query text', () => {
  const coreSrc = read(CORE);
  for (const banned of ['messages', 'content', 'passage', 'query', 'prompt', 'text']) {
    assert.equal(new RegExp(`\\b${banned}\\s*[:?]`).test(coreSrc), false, `${banned} must not be a field of the evidence`);
  }
  const shape: CdmssTransportAttribution = {
    dispatched_provider: 'vertex', dispatched_model: 'gemini-2.5-flash', cloud_response_received: true,
    attempts: [{ tier: 'vertex', attempt: 1, outcome: 'http_429', status: 429 }],
  };
  const serialized = JSON.stringify(shape);
  assert.equal(/[A-Za-z]{40,}/.test(serialized), false, 'nothing free-text-shaped survives');
  assert.deepEqual(Object.keys(shape).sort(), ['attempts', 'cloud_response_received', 'dispatched_model', 'dispatched_provider']);
});
