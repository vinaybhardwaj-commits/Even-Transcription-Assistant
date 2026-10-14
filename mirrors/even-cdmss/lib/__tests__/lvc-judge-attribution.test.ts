/**
 * lib/__tests__/lvc-judge-attribution.test.ts
 * CDMSS-LVC-JUDGE-GUARD-FIX-PRD-v3.0-10-AUG-2026 §3.6 — all ten required tests.
 *
 *   node --test --import tsx lib/__tests__/lvc-judge-attribution.test.ts
 *
 * WHAT THIS SUITE IS DEFENDING. Commit 8655823 shipped a two-state guard: the reply body's model
 * either matched the intended Gemini slug or the call was "wrong". An empty model string — which
 * only means the provider did not echo a name — took the wrong branch, so EVERY unlabeled call was
 * retried. Measured: 106/118 calls finished at ~140s before; 0/24 finished inside the 300s
 * platform ceiling after. D-6 splits that into three states and stops retrying `unknown`.
 *
 * Numbering below follows §3.6 exactly, so the document and the suite can be read side by side.
 * Tests 1-7 drive the REAL `defaultJudge` through the injected provider seam; test 8 goes one
 * level lower, through the real llmCall, because an injected call cannot prove what llmCall sends;
 * tests 9-10 assert the pure builders and the pure resolver.
 */
import './gemini-env-fixture';   // ⚠️ MUST BE FIRST — module-load env capture (see the fixture)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultJudge, matchLowValueCare, resolveJudgeAttribution,
  buildJudgeAttemptPayload, buildJudgeInvocationPayload,
  setLvcChatTransportForTest,
  LVC_JUDGE_ATTEMPT_EVENT, LVC_JUDGE_INVOCATION_EVENT, LVC_JUDGE_REFUSED_EVENT,
  type JudgeAttemptRecord,
} from '../lvc';
import { attachTransportAttribution, readTransportAttribution, TRANSPORT_ATTRIBUTION_FIELD, type CdmssTransportAttribution } from '../trace';
import { GEMINI_MODEL, GEMINI_FLASH_MODEL } from '../llm';
import { assembleFlags, type LvcRecommendation } from '../lvc-core';

/** The judge resolves Pro for the opt-in surface (geminiModelFor honours GEMINI_ALL). */
const INTENDED = GEMINI_MODEL;
const LOCAL = 'llama3.1:8b';

const rec = (id: string): LvcRecommendation => ({
  id, region: 'IN', society: 'Test Society', specialty: null,
  statement: `do not order ${id}`, precondition: 'when nothing is documented',
  action_type: 'lab', consider_instead: null, rationale: null, keywords: [],
  citation_doi: null, citation_pmid: null, citation_url: null, source_release_year: 2024,
}) as unknown as LvcRecommendation;

const RECS = [rec('r1'), rec('r2'), rec('r3')];
const REC_IDS = RECS.map((r) => r.id);
const CTX = { scenario: 'adult with fatigue; vitamin D level ordered' };

/** Valid judge content: every rec answered `applies` above the flag-firing floor. */
const CONTENT = JSON.stringify(RECS.map((r) => ({
  id: r.id, verdict: 'applies', confidence: 0.95, why: 'test', consider_instead: null,
})));

const cloud = (provider: CdmssTransportAttribution['dispatched_provider'], model: string): CdmssTransportAttribution =>
  ({ dispatched_provider: provider, dispatched_model: model, cloud_response_received: true });
const localTransport = (): CdmssTransportAttribution =>
  ({ dispatched_provider: 'ollama', dispatched_model: LOCAL, cloud_response_received: false });

/**
 * A completion as the transport really returns one: the body's own `model` (which some providers
 * leave empty) plus, when the transport recorded it, dispatch evidence attached through the REAL
 * writer from lib/trace.ts. Nothing here simulates the attribution mechanism — it uses it.
 */
function completion(bodyModel: string | null, transport?: CdmssTransportAttribution) {
  const c: Record<string, unknown> = { choices: [{ message: { content: CONTENT } }] };
  if (bodyModel !== null) c.model = bodyModel;
  return transport ? attachTransportAttribution(c, transport) : c;
}

// ── §3.6 TEST 1 ───────────────────────────────────────────────────────────────────────────────
test('1: empty body model + no transport evidence + valid content → verdict served, ONE call, unknown', async () => {
  let calls = 0;
  const events: Array<{ kind: string; payload: unknown }> = [];
  const judged = await defaultJudge(CTX, RECS, 'surface', undefined, false, {
    call: async () => { calls++; return completion(''); },
    recordEvent: (kind, payload) => { events.push({ kind, payload }); },
  });

  assert.equal(calls, 1, 'THE DEFECT: this was 2. An unlabeled answer is never retried.');
  assert.equal(judged.length, RECS.length);
  assert.ok(judged.every((j) => j.verdict === 'applies'), 'the verdict is SERVED, not refused');
  assert.ok(assembleFlags(judged, 'surface', {}).length > 0, 'and it can still raise a flag');

  const attempt = events.find((e) => e.kind === LVC_JUDGE_ATTEMPT_EVENT)?.payload as JudgeAttemptRecord;
  assert.equal(attempt.attribution_state, 'unknown');
  assert.equal(attempt.attribution_reason, 'no_model_reported');
  assert.ok(!events.some((e) => e.kind === LVC_JUDGE_REFUSED_EVENT), 'nothing refused');
});

// ── §3.6 TEST 2 ───────────────────────────────────────────────────────────────────────────────
test('2: transport names the intended Gemini model → ONE call, verified', async () => {
  for (const [provider, slug] of [['vertex', INTENDED], ['openrouter', `google/${INTENDED}`]] as const) {
    let calls = 0;
    const events: Array<{ kind: string; payload: unknown }> = [];
    const judged = await defaultJudge(CTX, RECS, 'surface', undefined, false, {
      // Body reports nothing — the transport is the only evidence, which is D-8's whole point.
      call: async () => { calls++; return completion('', cloud(provider, slug)); },
      recordEvent: (kind, payload) => { events.push({ kind, payload }); },
    });
    assert.equal(calls, 1, `${provider}: one call`);
    assert.ok(judged.every((j) => j.verdict === 'applies'), `${provider}: verdict served`);
    const attempt = events.find((e) => e.kind === LVC_JUDGE_ATTEMPT_EVENT)?.payload as JudgeAttemptRecord;
    // D-15 Option B: EITHER approved cloud route is acceptable while the MODEL is the intended one.
    assert.equal(attempt.attribution_state, 'verified', `${provider}: verified`);
    assert.equal(attempt.dispatched_provider, provider);
  }
});

// ── §3.6 TEST 3 ───────────────────────────────────────────────────────────────────────────────
test('3: body names a DIFFERENT model → two calls, refusal, every rec insufficient_info, wrong_model', async () => {
  let calls = 0;
  const events: Array<{ kind: string; payload: unknown }> = [];
  const judged = await defaultJudge(CTX, RECS, 'surface', undefined, false, {
    // The measured incident: something answering as qwen2.5:14b through the Ollama bridge.
    call: async () => { calls++; return completion('qwen2.5:14b'); },
    recordEvent: (kind, payload) => { events.push({ kind, payload }); },
  });

  assert.equal(calls, 2, 'exactly one retry — never a third attempt');
  assert.ok(judged.every((j) => j.verdict === 'insufficient_info'));
  assert.ok(judged.every((j) => j.confidence === 0));
  // The clinical property, asserted through the real assembler on both surfaces: NO FLAG FIRES.
  assert.deepEqual(assembleFlags(judged, 'surface', {}), []);
  assert.deepEqual(assembleFlags(judged, 'autoflag', {}), []);

  const attempts = events.filter((e) => e.kind === LVC_JUDGE_ATTEMPT_EVENT).map((e) => e.payload as JudgeAttemptRecord);
  assert.equal(attempts.length, 2);
  assert.ok(attempts.every((a) => a.attribution_state === 'wrong_model'));
  assert.equal(attempts[0].attribution_reason, 'body_names_other_model');
  assert.ok(events.some((e) => e.kind === LVC_JUDGE_REFUSED_EVENT), 'the pre-existing refusal event still fires');
});

// ── §3.6 TEST 4 ───────────────────────────────────────────────────────────────────────────────
test('4: transport names the LOCAL model → wrong_model, the verdict is never accepted', async () => {
  let calls = 0;
  const judged = await defaultJudge(CTX, RECS, 'surface', undefined, false, {
    // A local answer that says nothing in its body would be `unknown` — and unknown is ACCEPTED.
    // The transport marking itself is what makes this reachable at all (trace.ts branch 4/5).
    call: async () => { calls++; return completion('', localTransport()); },
  });
  assert.equal(calls, 2);
  assert.ok(judged.every((j) => j.verdict === 'insufficient_info'), 'no local verdict is ever served');
  assert.deepEqual(assembleFlags(judged, 'surface', {}), []);
});

// ── §3.6 TEST 5 ───────────────────────────────────────────────────────────────────────────────
test('5: a CONFLICT between the two sources is wrong_model — in BOTH directions', async () => {
  const cases = [
    { name: 'transport Gemini, body local', transport: cloud('vertex', INTENDED), body: LOCAL },
    { name: 'transport local, body Gemini', transport: localTransport(), body: INTENDED },
  ];
  for (const c of cases) {
    let calls = 0;
    const events: Array<{ kind: string; payload: unknown }> = [];
    const judged = await defaultJudge(CTX, RECS, 'surface', undefined, false, {
      call: async () => { calls++; return completion(c.body, c.transport); },
      recordEvent: (kind, payload) => { events.push({ kind, payload }); },
    });
    assert.equal(calls, 2, `${c.name}: retried once`);
    assert.ok(judged.every((j) => j.verdict === 'insufficient_info'), `${c.name}: refused`);
    const attempt = events.find((e) => e.kind === LVC_JUDGE_ATTEMPT_EVENT)?.payload as JudgeAttemptRecord;
    assert.equal(attempt.attribution_state, 'wrong_model', `${c.name}: wrong_model`);
    assert.equal(attempt.attribution_reason, 'transport_body_conflict', `${c.name}: named as a conflict`);
  }
});

// ── §3.6 TEST 6 ───────────────────────────────────────────────────────────────────────────────
test('6: body-only verified — no transport evidence, body names the intended Gemini → verified, ONE call', async () => {
  for (const bodySlug of [INTENDED, `google/${INTENDED}`]) {
    let calls = 0;
    const events: Array<{ kind: string; payload: unknown }> = [];
    const judged = await defaultJudge(CTX, RECS, 'surface', undefined, false, {
      call: async () => { calls++; return completion(bodySlug); },
      recordEvent: (kind, payload) => { events.push({ kind, payload }); },
    });
    assert.equal(calls, 1, `${bodySlug}: one call`);
    assert.ok(judged.every((j) => j.verdict === 'applies'));
    const attempt = events.find((e) => e.kind === LVC_JUDGE_ATTEMPT_EVENT)?.payload as JudgeAttemptRecord;
    assert.equal(attempt.attribution_state, 'verified');
    assert.equal(attempt.attribution_reason, 'body_agrees');
    assert.equal(attempt.dispatched_model, null, 'transport said nothing, and that is recorded as null');
  }
});

// ── §3.6 TEST 7 ───────────────────────────────────────────────────────────────────────────────
test('7: a provider THROW retries once then refuses — and stays distinct from unknown', async () => {
  let calls = 0;
  const events: Array<{ kind: string; payload: unknown }> = [];
  const judged = await defaultJudge(CTX, RECS, 'surface', undefined, false, {
    call: async () => { calls++; throw new Error('vertex 403'); },
    recordEvent: (kind, payload) => { events.push({ kind, payload }); },
  });
  assert.equal(calls, 2, 'provider failure keeps its retry — D-6 changed only attribution');
  assert.ok(judged.every((j) => j.verdict === 'insufficient_info'));

  const attempts = events.filter((e) => e.kind === LVC_JUDGE_ATTEMPT_EVENT).map((e) => e.payload as JudgeAttemptRecord);
  assert.equal(attempts.length, 2);
  // The distinction D-6 insists on: a failure is `status: error` with NO attribution state, not
  // `unknown`. Provider failure and unlabeled attribution must remain separately countable.
  assert.ok(attempts.every((a) => a.status === 'error'));
  assert.ok(attempts.every((a) => a.attribution_state === null));
  assert.ok(attempts.every((a) => (a.error ?? '').includes('vertex 403')), 'the error travels with the record');
  const inv = events.find((e) => e.kind === LVC_JUDGE_INVOCATION_EVENT)?.payload as ReturnType<typeof buildJudgeInvocationPayload>;
  assert.equal(inv.outcome, 'refusal');
  assert.equal(inv.refuse_reason, 'call_failed');
});

test('7b: a first-attempt throw followed by a verified answer is served — the retry still recovers', async () => {
  let calls = 0;
  const judged = await defaultJudge(CTX, RECS, 'surface', undefined, false, {
    call: async () => {
      calls++;
      if (calls === 1) throw new Error('transient 429');
      return completion('', cloud('vertex', INTENDED));
    },
  });
  assert.equal(calls, 2);
  assert.ok(judged.every((j) => j.verdict === 'applies'));
});

// ── §3.6 TEST 8 — MECHANICAL PROOF, NOT A CLAIM ───────────────────────────────────────────────
/**
 * §3.6 is explicit that a source comment or a build-report sentence is not acceptable evidence
 * that production passes `noLocalFallback: true`, because `deps.call` bypasses llmCall entirely.
 * So this test replaces the TRANSPORT llmCall dispatches through, runs the REAL judge call site
 * with no injected call, and reads the options object that site actually built.
 */
test('8: the REAL judge call passes noLocalFallback: true — mechanically, through llmCall', async () => {
  const seen: Array<{ label: string; opts: Record<string, unknown> | undefined }> = [];
  setLvcChatTransportForTest(async (_traceId, label, _params, opts) => {
    seen.push({ label, opts: opts as Record<string, unknown> | undefined });
    return completion(INTENDED);
  });
  try {
    const judged = await defaultJudge(CTX, RECS, 'surface');   // ← no deps: the production path
    assert.ok(judged.every((j) => j.verdict === 'applies'), 'the real call site still serves a verdict');
  } finally {
    setLvcChatTransportForTest(null);
  }

  assert.equal(seen.length, 1);
  assert.equal(seen[0].label, 'lvc_judge');
  assert.equal(seen[0].opts?.noLocalFallback, true, 'D-7: the judge may not reach the local model');
  assert.equal(seen[0].opts?.gemini, INTENDED, 'and it still asks for the intended Gemini slug');
  assert.equal(seen[0].opts?.promptRef, 'lvc-core/JUDGE_SYSTEM');
});

test('8b: candidate extraction does NOT pass noLocalFallback — its options object is byte-identical', async () => {
  const seen: Array<{ label: string; opts: Record<string, unknown> | undefined }> = [];
  setLvcChatTransportForTest(async (_traceId, label, _params, opts) => {
    seen.push({ label, opts: opts as Record<string, unknown> | undefined });
    return { model: GEMINI_FLASH_MODEL, choices: [{ message: { content: '[]' } }] };
  });
  try {
    // trace:false keeps this off the database; recall is stubbed so nothing past extraction runs.
    await matchLowValueCare({ scenario: 'adult with fatigue', trace: false }, { recall: async () => [] });
  } finally {
    setLvcChatTransportForTest(null);
  }

  const extract = seen.find((s) => s.label === 'lvc_extract');
  assert.ok(extract, 'candidate extraction ran through the real llmCall');
  // deepEqual, not a key check: this is the proof that the ADDITIVE trailing parameter left every
  // pre-existing caller sending exactly the object it sent before (`{...undefined}` is `{}`).
  assert.deepEqual(extract!.opts, { gemini: GEMINI_FLASH_MODEL, promptRef: 'lvc-core/CANDIDATE_SYSTEM' });
  assert.ok(!('noLocalFallback' in (extract!.opts as object)), 'extraction keeps its local soft-fall');
});

// ── §3.6 TEST 9 — THE EVENT PAYLOADS ──────────────────────────────────────────────────────────
test('9: attempt + invocation payloads — absent stays null, both sources stay separately visible', async () => {
  // A wrong-model first attempt followed by a verified retry: the exact case §3.4 says must not
  // disappear from the counts.
  let calls = 0;
  const events: Array<{ kind: string; payload: unknown }> = [];
  await defaultJudge(CTX, RECS, 'surface', undefined, false, {
    call: async () => {
      calls++;
      return calls === 1
        ? completion(LOCAL, cloud('vertex', INTENDED))          // conflict
        : completion(INTENDED, cloud('vertex', INTENDED));      // clean
    },
    recordEvent: (kind, payload) => { events.push({ kind, payload }); },
  });

  const attempts = events.filter((e) => e.kind === LVC_JUDGE_ATTEMPT_EVENT).map((e) => e.payload as JudgeAttemptRecord);
  assert.equal(attempts.length, 2, 'ONE EVENT PER PROVIDER ATTEMPT');
  assert.deepEqual(attempts.map((a) => a.attempt), [1, 2], 'the attempt NUMBER is recorded');
  assert.equal(attempts[0].attribution_state, 'wrong_model');
  assert.equal(attempts[1].attribution_state, 'verified');
  // Conflicting sources remain separately readable after the fact — neither overwrites the other.
  assert.equal(attempts[0].dispatched_model, INTENDED);
  assert.equal(attempts[0].body_model, LOCAL);
  assert.equal(attempts[0].dispatched_provider, 'vertex');
  assert.equal(attempts[0].intended_model, INTENDED);

  const invs = events.filter((e) => e.kind === LVC_JUDGE_INVOCATION_EVENT);
  assert.equal(invs.length, 1, 'ONE EVENT PER LOGICAL INVOCATION, whatever the attempts');
  const inv = invs[0].payload as ReturnType<typeof buildJudgeInvocationPayload>;
  assert.equal(inv.retry_count, 1, 'RETRIES, not the attempt number');
  assert.equal(inv.outcome, 'verdict');
  assert.equal(inv.final_attribution_state, 'verified');
  assert.equal(inv.surface, 'surface');
  assert.equal(inv.n_recs, RECS.length);
  assert.deepEqual(inv.rec_ids, REC_IDS);
  assert.equal(inv.attempts.length, 2, 'the invocation carries its attempts');
});

test('9b: the pure builders — nothing absent is invented, retry_count is 0 on a single attempt', () => {
  const bare = buildJudgeAttemptPayload({ attempt: 1, status: 'ok', intendedModel: INTENDED });
  assert.deepEqual(bare, {
    attempt: 1, status: 'ok', intended_model: INTENDED,
    dispatched_provider: null, dispatched_model: null, body_model: null,
    attribution_state: null, attribution_reason: null, error: null,
  });
  // '' and '   ' are ABSENT, not empty-string values — a provider that echoed nothing must not
  // look like one that echoed a blank name.
  assert.equal(buildJudgeAttemptPayload({ attempt: 1, status: 'ok', intendedModel: INTENDED, bodyModel: '   ' }).body_model, null);

  const one = buildJudgeInvocationPayload({
    intendedModel: INTENDED, attempts: [bare], outcome: 'verdict', surface: 'autoflag', recIds: ['a'],
  });
  assert.equal(one.retry_count, 0, 'one attempt = zero retries');
  assert.equal(one.refuse_reason, null);
  assert.equal(buildJudgeInvocationPayload({
    intendedModel: INTENDED, attempts: [], outcome: 'refusal', refuseReason: 'force_ollama_requested',
    surface: 'surface', recIds: REC_IDS,
  }).retry_count, 0, 'a refusal with NO attempt is still zero retries, never -1');

  const err = buildJudgeAttemptPayload({ attempt: 2, status: 'error', intendedModel: INTENDED, error: new Error('boom') });
  assert.equal(err.error, 'boom');
  assert.equal(err.attribution_state, null);
});

test('9c: a throwing recorder can never cost a verdict', async () => {
  const judged = await defaultJudge(CTX, RECS, 'surface', undefined, false, {
    call: async () => completion(INTENDED),
    recordEvent: () => { throw new Error('trace_events is down'); },
  });
  assert.ok(judged.every((j) => j.verdict === 'applies'));
});

// ── §3.6 TEST 10 — EVERY ROW OF THE §3.2 TABLE ────────────────────────────────────────────────
test('10: resolveJudgeAttribution — every row of the table, exhaustively', () => {
  const R = (transportModel: string | null | undefined, bodyModel: string | null | undefined) =>
    resolveJudgeAttribution({ intendedModel: INTENDED, transportModel, bodyModel });

  // absent + absent → unknown  (the row the shipped defect got wrong)
  assert.deepEqual(R(null, null), { state: 'unknown', reason: 'no_model_reported' });
  assert.deepEqual(R(undefined, undefined), { state: 'unknown', reason: 'no_model_reported' });
  assert.deepEqual(R('', ''), { state: 'unknown', reason: 'no_model_reported' });
  assert.deepEqual(R('   ', '  '), { state: 'unknown', reason: 'no_model_reported' }, 'whitespace is absence');

  // agrees + absent → verified
  assert.deepEqual(R(INTENDED, null), { state: 'verified', reason: 'transport_agrees' });
  // absent + agrees → verified
  assert.deepEqual(R(null, INTENDED), { state: 'verified', reason: 'body_agrees' });
  // agrees + agrees → verified
  assert.deepEqual(R(INTENDED, INTENDED), { state: 'verified', reason: 'transport_and_body_agree' });

  // D-15: the publisher prefix is a pipe detail, not a different model — either side, either route.
  assert.equal(R(`google/${INTENDED}`, null).state, 'verified');
  assert.equal(R(null, `google/${INTENDED}`).state, 'verified');
  assert.equal(R(`google/${INTENDED}`, INTENDED).state, 'verified');

  // either source names a different model → wrong_model
  assert.deepEqual(R(LOCAL, null), { state: 'wrong_model', reason: 'transport_names_other_model' });
  assert.deepEqual(R(null, LOCAL), { state: 'wrong_model', reason: 'body_names_other_model' });
  assert.deepEqual(R(LOCAL, LOCAL), { state: 'wrong_model', reason: 'transport_names_other_model' });
  assert.equal(R('qwen2.5:14b', null).state, 'wrong_model');
  assert.equal(R(null, 'qwen2.5:14b').state, 'wrong_model');
  // A different CLOUD model is just as wrong as a local one — the ruling names one model.
  assert.equal(R('claude-sonnet-4', null).state, 'wrong_model');
  assert.equal(R(null, GEMINI_FLASH_MODEL).state, 'wrong_model', 'Flash is not Pro when Pro was intended');

  // the two sources conflict → wrong_model, both directions
  assert.deepEqual(R(INTENDED, LOCAL), { state: 'wrong_model', reason: 'transport_body_conflict' });
  assert.deepEqual(R(LOCAL, INTENDED), { state: 'wrong_model', reason: 'transport_body_conflict' });

  // The autoflag surface intends Flash; the same table holds with a different intended model.
  const F = (t: string | null, b: string | null) => resolveJudgeAttribution({ intendedModel: GEMINI_FLASH_MODEL, transportModel: t, bodyModel: b });
  assert.equal(F(GEMINI_FLASH_MODEL, null).state, 'verified');
  assert.equal(F(null, null).state, 'unknown');
  assert.equal(F(LOCAL, null).state, 'wrong_model');
});

// ── The trace.ts primitive itself: additive, and provably invisible to existing consumers ──────
test('transport attribution is a NON-ENUMERABLE property — no existing consumer can see it', () => {
  const c: Record<string, unknown> = { model: INTENDED, choices: [], usage: { total_tokens: 5 } };
  const before = JSON.stringify(c);
  attachTransportAttribution(c, cloud('vertex', INTENDED));

  assert.equal(JSON.stringify(c), before, 'JSON.stringify is byte-identical');
  assert.deepEqual(Object.keys(c), ['model', 'choices', 'usage'], 'Object.keys is unchanged');
  assert.deepEqual({ ...c }, JSON.parse(before), 'object spread is unchanged');
  assert.deepEqual(readTransportAttribution(c), cloud('vertex', INTENDED), 'and the evidence is still readable');
  assert.equal(TRANSPORT_ATTRIBUTION_FIELD, 'cdmss_transport_attribution');
});

test('attaching to a frozen or non-object result never throws — evidence must not cost a call', () => {
  const frozen = Object.freeze({ model: INTENDED });
  assert.doesNotThrow(() => attachTransportAttribution(frozen, cloud('vertex', INTENDED)));
  assert.equal(readTransportAttribution(frozen), undefined, 'and it reports honestly that there is none');
  assert.equal(readTransportAttribution(null), undefined);
  assert.equal(readTransportAttribution('a string'), undefined);
  assert.equal(attachTransportAttribution(undefined, cloud('vertex', INTENDED)), undefined);
});
