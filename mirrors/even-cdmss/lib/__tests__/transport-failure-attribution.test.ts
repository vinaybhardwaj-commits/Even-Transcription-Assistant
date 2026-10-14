// lib/__tests__/transport-failure-attribution.test.ts
// CDMSS-RERANK-TELEMETRY-ONPATH-CC-KICKOFF-v11 D14, and PRD v2.1 §4.4 / §6.2.
//
// WHAT THIS GATES. Success attribution answers "which provider served this completion". When every
// route fails there IS no completion, and §4.4 says the record must then say so rather than naming
// the last provider attempted. That is the fact that licenses `not_served` — and `not_served` and
// `unattributed` are different facts the PRD forbids merging, so the proof has to be a real
// artefact rather than an inference from an absent success attribution.
//
// Two holes this closes, both of them in the tree at fc28e0f:
//   · the intended-local arm reported `attempts: []` WHILE MAKING A REAL REQUEST;
//   · a thrown dispatch carried no evidence at all, so a call that exhausted a whole cloud ladder
//     and then failed locally was indistinguishable from a call that was never made.
//
// NO CLINICAL TEXT, NO NETWORK, NO DB. Synthetic fixtures and source-text pins only (§6.4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TRANSPORT_FAILURE_ATTRIBUTION_FIELD, TRANSPORT_TERMINAL_PHASES,
  attachTransportFailureAttribution, readTransportFailureAttribution,
  classifyLocalAttempt, localAttemptSuccess,
  TRANSPORT_ATTRIBUTION_FIELD, readTransportAttribution, attachTransportAttribution,
  type CdmssTransportFailureAttribution, type TransportAttempt,
} from '../transport-attribution-core';
import {
  attachTransportFailureAttribution as viaTraceAttachFailure,
  readTransportFailureAttribution as viaTraceReadFailure,
  TRANSPORT_FAILURE_ATTRIBUTION_FIELD as VIA_TRACE_FAILURE_FIELD,
} from '../trace';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const LLM = 'lib/llm.ts';
const CORE = 'lib/transport-attribution-core.ts';

const failure = (over: Partial<CdmssTransportFailureAttribution> = {}): CdmssTransportFailureAttribution => ({
  outcome: 'failed', servedProvider: null, servedModel: null,
  attempts: [{ tier: 'vertex', attempt: 1, outcome: 'http_429', status: 429 }],
  terminalPhase: 'cloud_ladder_exhausted_no_local_fallback',
  ...over,
});

/** The body of `chatWithFallback` alone, bounded by the next top-level declaration. */
function chatWithFallbackBody(src: string): string {
  const start = src.indexOf('export async function chatWithFallback');
  assert.notEqual(start, -1, 'chatWithFallback must exist');
  const rest = src.slice(start + 1);
  const nextDecl = rest.search(/\nexport (async )?(function|const) /);
  return nextDecl === -1 ? rest : rest.slice(0, nextDecl);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// THE FACT ITSELF — a total failure records that NOBODY served (§6.2)
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('a total transport failure records no served provider, and says so explicitly', () => {
  const err = new Error('vertex 429');
  const thrown = attachTransportFailureAttribution(err, failure());

  assert.equal(thrown, err, 'the SAME error object is returned — nothing is re-wrapped');
  const ev = readTransportFailureAttribution(err);
  assert.equal(ev?.outcome, 'failed');
  assert.equal(ev?.servedProvider, null, 'never the last provider ATTEMPTED (§4.4, §10)');
  assert.equal(ev?.servedModel, null, 'and never the requested model (§10)');
  assert.equal(ev?.attempts?.length, 1, 'the ladder history survives the failure');
  assert.equal(ev?.terminalPhase, 'cloud_ladder_exhausted_no_local_fallback');
});

test('a null attempt list means NOT COLLECTED, and is distinguishable from an empty one', () => {
  const notCollected = attachTransportFailureAttribution(new Error('x'), failure({ attempts: null }));
  const noneMade = attachTransportFailureAttribution(new Error('y'), failure({ attempts: [] }));
  assert.equal(readTransportFailureAttribution(notCollected)?.attempts, null,
    'null = the transport collected none; §4.4 forbids reconstructing a sequence');
  assert.deepEqual(readTransportFailureAttribution(noneMade)?.attempts, [],
    '[] = the transport collected, and there were none. A different fact.');
});

test('every terminal phase is a stable NAME — never a message, never an interpolated value', () => {
  for (const phase of TRANSPORT_TERMINAL_PHASES) {
    assert.match(phase, /^[a-z0-9_]+$/, `${phase} must be a class-style name`);
  }
  assert.equal(new Set(TRANSPORT_TERMINAL_PHASES).size, TRANSPORT_TERMINAL_PHASES.length, 'no duplicates');
  // and the code emits exactly these, no others
  const body = chatWithFallbackBody(code(LLM));
  const emitted = (body.match(/terminalPhase: '([a-z0-9_]+)'/g) || [])
    .map((s) => s.replace(/terminalPhase: '|'/g, ''));
  const inline = (body.match(/^\s*\? '([a-z0-9_]+)'$|^\s*: '([a-z0-9_]+)'$/gm) || [])
    .map((s) => s.trim().replace(/^[?:] '|'$/g, ''));
  for (const p of [...emitted, ...inline]) {
    assert.ok((TRANSPORT_TERMINAL_PHASES as readonly string[]).includes(p),
      `${p} is emitted by chatWithFallback but is not a declared phase`);
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// D14 — THE LOCAL CALL IS AN ATTEMPT (kickoff test 38)
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('the intended-local path records ONE attempt rather than an empty list', () => {
  const body = chatWithFallbackBody(code(LLM));
  const intendedLocal = body.slice(0, body.indexOf('THE CLOUD LADDER') === -1 ? body.indexOf('const ladder') : body.indexOf('const ladder'));
  assert.equal(/attempts: \[\]/.test(intendedLocal), false,
    'the by-design local arm no longer claims that no provider was attempted while calling one');
  assert.ok(/attempts: \[\.\.\.attempts, localAttemptSuccess\(\)\]/.test(intendedLocal),
    'it records the local call as the attempt it is');
});

test('both local arms record their attempt — the by-design one and the substitution', () => {
  const body = chatWithFallbackBody(code(LLM));
  assert.equal((body.match(/attempts: \[\.\.\.attempts, localAttemptSuccess\(\)\]/g) || []).length, 2,
    'success on both local arms');
  assert.equal((body.match(/attempts\.push\(\{ tier: 'ollama', attempt: 1, outcome, status \}\)/g) || []).length, 2,
    'failure on both local arms, classified from what the SDK error declared');
  assert.equal((body.match(/terminalPhase: 'intended_local_failed'/g) || []).length, 1);
  assert.equal((body.match(/terminalPhase: 'local_substitution_failed'/g) || []).length, 1);
});

test('the local success attempt is well-formed, and is at most one per invocation', () => {
  const a = localAttemptSuccess();
  assert.deepEqual(a, { tier: 'ollama', attempt: 1, outcome: 'success', status: 200 });
  assert.notEqual(localAttemptSuccess(), a, 'a fresh object each call — never a shared mutable const');
  // `attempt: 1` is correct BY CONSTRUCTION: the intended-local arm returns before the ladder
  // exists, and the substitution arm runs only after it is over. Pin that they are exclusive.
  const body = chatWithFallbackBody(code(LLM));
  const guard = body.indexOf('if (!useOpenRouter && !useGemini)');
  const substitution = body.lastIndexOf('localAttemptSuccess()');
  assert.ok(guard !== -1 && guard < substitution, 'the by-design arm returns before the ladder is built');
});

test('classifyLocalAttempt reads what the SDK declared, and guesses nothing', () => {
  assert.deepEqual(classifyLocalAttempt(Object.assign(new Error('e'), { status: 429 })),
    { outcome: 'http_429', status: 429 });
  assert.deepEqual(classifyLocalAttempt(Object.assign(new Error('e'), { status: 503 })),
    { outcome: 'http_other', status: 503 });
  assert.deepEqual(classifyLocalAttempt(Object.assign(new Error('e'), { name: 'APIConnectionTimeoutError' })),
    { outcome: 'timeout', status: null }, "the SDK's own error name, not elapsed time (§4.4 forbids timing inference)");
  // no status and no declared timeout: the honest "it failed and did not say more"
  assert.deepEqual(classifyLocalAttempt(new Error('socket hang up')), { outcome: 'transport_error', status: null });
  for (const junk of [null, undefined, 'a string', 42]) {
    assert.deepEqual(classifyLocalAttempt(junk), { outcome: 'transport_error', status: null });
  }
});

test('the 429 rule has exactly one home — classifyLocalAttempt delegates, never duplicates', () => {
  const src = code(CORE);
  assert.equal((src.match(/status === 429 \? 'http_429' : 'http_other'/g) || []).length, 1,
    'a second copy is how a 429 becomes classifier-dependent');
  assert.ok(/return \{ outcome: classifyAttemptOutcome\(kind, status\), status \};/.test(src));
  // and the two-call pin on the ladder classifier is untouched by the local one
  assert.equal((code(LLM).match(/classifyAttemptOutcome\(f\.kind, f\.status\)/g) || []).length, 2);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §4.4 conditions 2 and 3 — PROVIDER SELECTION, FALLBACK ORDER AND RETRY BEHAVIOUR UNCHANGED
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('the two terminal throws are BYTE-IDENTICAL to before this build', () => {
  const src = code(LLM);
  assert.ok(/if \(noLocalFallback\) throw lastErr;/.test(src),
    'evidence attaches BEFORE the disposition, so the disposition itself never moved');
  assert.ok(/if \(lastTier === 'openrouter' && isProviderResponseError\(lastErr\)\) throw lastErr;/.test(src));
  // no throw was rewritten into a wrapper form
  assert.equal(/throw attachTransportFailureAttribution\(lastErr/.test(src), false,
    'lastErr is attributed in place and thrown unchanged');
});

test('the phase selector cannot drift from the throws it describes', () => {
  const body = chatWithFallbackBody(code(LLM));
  // The selector duplicates the two throw conditions deliberately, because preserving the pinned
  // throw literals requires those conditions to stay inline AT the throws. Pin the copies against
  // each other, so changing one without the other fails here rather than mislabelling a phase in
  // production. Scoped to the terminal region: `noLocalFallback` also appears in the two ladder
  // catches' `fellBackTo` expressions, which are a different question and are not this build's.
  const terminal = body.slice(body.indexOf('attachTransportFailureAttribution(lastErr'));
  assert.notEqual(terminal, '', 'the terminal region must exist');
  assert.ok(/terminalPhase: noLocalFallback$/m.test(terminal), 'branch 1 selects on the same flag the throw tests');
  assert.ok(/: lastTier === 'openrouter' && isProviderResponseError\(lastErr\)$/m.test(terminal),
    'branch 2 selects on the same expression the second throw tests');
  assert.ok(terminal.includes('if (noLocalFallback) throw lastErr;'));
  assert.ok(terminal.includes("if (lastTier === 'openrouter' && isProviderResponseError(lastErr)) throw lastErr;"));
  assert.equal((terminal.match(/lastTier === 'openrouter' && isProviderResponseError\(lastErr\)/g) || []).length, 2,
    'exactly two copies in the terminal region — the selector and the throw');
});

test('the failure attach is a statement, not a control-flow change', () => {
  const body = chatWithFallbackBody(code(LLM));
  // Called for effect on the terminal path. If this ever becomes `return` or `throw` at that site
  // the ladder's terminal behaviour has moved, which §3 constraint 1 forbids.
  assert.ok(/^\s{2}attachTransportFailureAttribution\(lastErr, \{$/m.test(body),
    'attached for effect, at statement position');
  const idx = body.indexOf('attachTransportFailureAttribution(lastErr');
  const beforeIt = body.slice(Math.max(0, idx - 40), idx);
  assert.equal(/(return|throw|await)\s*$/.test(beforeIt.trim()), false);
});

test('nothing in the failure path touches the outbound request object', () => {
  const src = code(LLM);
  assert.equal(/attachTransportFailureAttribution\(\s*params/.test(src), false, 'params are never attributed');
  // the four return sites and their attributions are still exactly four
  const body = chatWithFallbackBody(src);
  assert.equal((body.match(/^\s*return /gm) || []).length, 4, 'still four return sites');
  assert.equal((body.match(/attachTransportAttribution\(/g) || []).length, 4, 'each still attributed');
});

test('the local calls are wrapped, and the SDK call expression itself is unchanged', () => {
  const body = chatWithFallbackBody(code(LLM));
  // The committed pins in gemini-openrouter-bridge / provider-error-core / openrouter-timeout /
  // vertex-retry-parity all match this exact expression. D14 wraps it in try/catch WITHOUT
  // rewriting it, which is why none of those four needed an authorized change.
  assert.equal((body.match(/return attachTransportAttribution\(await llm\.chat\.completions\.create\(params, reqOpts\), \{/g) || []).length, 2);
  assert.equal(/llm\.chat\.completions\.create\(params\)(?!,)/.test(body), false, 'reqOpts is never dropped');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §4.4 condition 4 — EXISTING CALLERS REMAIN BEHAVIOURALLY COMPATIBLE (kickoff test 37)
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('failure evidence is a SEPARATE property, invisible to every success-attribution reader', () => {
  const err = new Error('everything failed');
  attachTransportFailureAttribution(err, failure());
  assert.notEqual(TRANSPORT_FAILURE_ATTRIBUTION_FIELD, TRANSPORT_ATTRIBUTION_FIELD, 'two names, two facts');
  assert.equal(readTransportAttribution(err), undefined,
    'a failed dispatch can never be read as a successful one — that is what keeps `unattributed` and `not_served` apart');
  assert.equal(Object.prototype.propertyIsEnumerable.call(err, TRANSPORT_FAILURE_ATTRIBUTION_FIELD), false);
  assert.deepEqual(Object.keys(err), [], 'no enumerable key is added to the error');
  assert.equal(JSON.stringify({ ...err }), '{}', 'a spread cannot observe it');
});

test('the low-value-care judge reader is untouched — it reads two fields of the success shape', () => {
  // lib/lvc.ts's resolveJudgeAttribution branches on dispatched_provider / dispatched_model. The
  // failure shape has neither name, so it cannot reach that reader even by accident.
  const shape = failure();
  assert.equal('dispatched_provider' in shape, false);
  assert.equal('dispatched_model' in shape, false);
  assert.ok(read('lib/lvc.ts').includes("readTransportAttribution } from './trace'"),
    'and lib/lvc.ts still imports the SUCCESS reader, unchanged');
  assert.equal(read('lib/lvc.ts').includes('readTransportFailureAttribution'), false,
    'this build does not wire failure evidence into the low-value-care path');
});

test('tracedChat is not touched — D14 is scoped to the traceless arm', () => {
  const traceSrc = code('lib/trace.ts');
  const tracedChatStart = traceSrc.indexOf('export async function tracedChat');
  assert.notEqual(tracedChatStart, -1);
  assert.equal(traceSrc.slice(tracedChatStart).includes('attachTransportFailureAttribution'), false,
    'the traced arm attaches no failure evidence; the retrieval path never reaches it, and widening it is a transport change');
  // the four success attach sites in trace.ts are unchanged
  for (const p of ["dispatched_provider: 'bedrock'", "dispatched_provider: 'openrouter'",
    "dispatched_provider: 'vertex'", "dispatched_provider: 'ollama'"]) {
    assert.ok(traceSrc.includes(p), `tracedChat still records ${p}`);
  }
});

test('every new name also resolves through lib/trace.ts, so no importer has to know the core path', () => {
  assert.equal(VIA_TRACE_FAILURE_FIELD, TRANSPORT_FAILURE_ATTRIBUTION_FIELD);
  assert.equal(viaTraceAttachFailure, attachTransportFailureAttribution, 're-export, not re-implementation');
  assert.equal(viaTraceReadFailure, readTransportFailureAttribution);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// IMMUTABILITY AND HOSTILE INPUT
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('failure evidence is IMMUTABLE — a later frame cannot rewrite what failed', () => {
  const err = new Error('vertex 429');
  attachTransportFailureAttribution(err, failure({ terminalPhase: 'cloud_ladder_exhausted_no_local_fallback' }));
  // a second attach, e.g. from an outer catch, must not overwrite the innermost record
  attachTransportFailureAttribution(err, failure({ terminalPhase: 'local_substitution_failed' }));
  assert.equal(readTransportFailureAttribution(err)?.terminalPhase, 'cloud_ladder_exhausted_no_local_fallback',
    'first writer wins — the frame closest to the failure knows most about it');
  const d = Object.getOwnPropertyDescriptor(err, TRANSPORT_FAILURE_ATTRIBUTION_FIELD);
  assert.equal(d?.writable, false);
  assert.equal(d?.configurable, false);
  assert.equal(d?.enumerable, false);
  // the SUCCESS attribution keeps its own, deliberately different descriptor
  const ok = { choices: [] };
  attachTransportAttribution(ok, { dispatched_provider: 'vertex', dispatched_model: 'm', cloud_response_received: true });
  const okDesc = Object.getOwnPropertyDescriptor(ok, TRANSPORT_ATTRIBUTION_FIELD);
  assert.equal(okDesc?.writable, true, 'the success shape is unchanged by this build');
  assert.equal(okDesc?.configurable, true);
});

test('a hostile or exotic error cannot break the transport', () => {
  const frozen = Object.freeze(new Error('frozen'));
  assert.doesNotThrow(() => attachTransportFailureAttribution(frozen, failure()));
  assert.equal(readTransportFailureAttribution(frozen), undefined, 'and it reports honestly that there is none');
  for (const v of [null, undefined, 'a string', 42, Symbol('s')]) {
    assert.equal(readTransportFailureAttribution(v), undefined);
    assert.equal(attachTransportFailureAttribution(v, failure()), v, 'returned unchanged, never thrown on');
  }
  // a thrown non-Error (some SDKs reject with a plain object) still carries evidence
  const plain: Record<string, unknown> = { message: 'nope' };
  attachTransportFailureAttribution(plain, failure());
  assert.equal(readTransportFailureAttribution(plain)?.outcome, 'failed');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §6.4 — PRIVACY
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('failure evidence carries enums and counts only — no message, no body, no identifier', () => {
  const shape = failure();
  assert.deepEqual(Object.keys(shape).sort(),
    ['attempts', 'outcome', 'servedModel', 'servedProvider', 'terminalPhase']);
  const serialized = JSON.stringify(shape);
  assert.equal(/[A-Za-z]{40,}/.test(serialized), false, 'nothing free-text-shaped survives');
  // the error MESSAGE is never copied into the record — that is where a passage or a query would leak
  const err = new Error('some upstream body with clinical detail in it');
  attachTransportFailureAttribution(err, failure());
  assert.equal(JSON.stringify(readTransportFailureAttribution(err)).includes('clinical detail'), false);
});

test('the attempt shape admits the local provider, and nothing else new', () => {
  const local: TransportAttempt = { tier: 'ollama', attempt: 1, outcome: 'transport_error', status: null };
  assert.equal(local.tier, 'ollama');
  const coreSrc = read(CORE);
  assert.ok(/tier: 'vertex' \| 'openrouter' \| 'ollama';/.test(coreSrc), 'widened to three, not to string');
  for (const banned of ['messages', 'content', 'passage', 'query', 'prompt', 'text']) {
    assert.equal(new RegExp(`\\b${banned}\\s*[:?]`).test(coreSrc), false, `${banned} must not be a field of the evidence`);
  }
});
