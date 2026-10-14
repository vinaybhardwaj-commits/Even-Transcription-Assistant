/**
 * lib/__tests__/lvc-judge-pinning.test.ts — LVC JUDGE PINNING PRD v1.0 §2 (D-1, D-2) + §4.
 *
 *   node --test --import tsx lib/__tests__/lvc-judge-pinning.test.ts
 *
 * Three obligations, each asserted against the real `defaultJudge` rather than a copy of it:
 *   D-1  the pin is on the JUDGE CALL BODY — temperature 0, seed AUDIT_LLM_SEED, top_p 1;
 *   D-2  a non-Gemini served model is retried ONCE and then REFUSED, with every rec returned as
 *        insufficient_info so no flag can fire, and one observable event carrying what served;
 *   §4   the round tag is validated, and junk falls back to the r1 baseline.
 *
 * The provider call is injected (`deps.call`), which is the only seam that lets a test read the
 * body production would have sent AND control what model came back. Nothing about resolution,
 * prompt or parse is stubbed — those are the real functions.
 */
import './gemini-env-fixture';   // ⚠️ MUST BE FIRST — see the fixture's header (module-load env capture)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultJudge, LVC_JUDGE_REFUSED_EVENT } from '../lvc';
import { AUDIT_LLM_SEED, GEMINI_MODEL, GEMINI_FLASH_MODEL } from '../llm';
import { assembleFlags, type LvcRecommendation } from '../lvc-core';
import { resolveAaExperiment, AA_EXPERIMENT_DEFAULT, AA_EXPERIMENT_RE } from '../lvc-judge-aa-core';

/** The judge resolves Pro for the opt-in surface (geminiModelFor honours GEMINI_ALL). */
const INTENDED = GEMINI_MODEL;

const rec = (id: string): LvcRecommendation => ({
  id, region: 'IN', society: 'Test Society', specialty: null,
  statement: `do not order ${id}`, precondition: 'when nothing is documented',
  action_type: 'lab', consider_instead: null, rationale: null, keywords: [],
  citation_doi: null, citation_pmid: null, citation_url: null, source_release_year: 2024,
}) as unknown as LvcRecommendation;

const RECS = [rec('r1'), rec('r2'), rec('r3')];
const CTX = { scenario: 'adult with fatigue; vitamin D level ordered' };

/** A completion the parser accepts, with every rec answered 'applies' at a flag-firing confidence. */
const applyingCompletion = (model: string) => ({
  model,
  choices: [{ message: { content: JSON.stringify(RECS.map((r) => ({
    id: r.id, verdict: 'applies', confidence: 0.95, why: 'test', consider_instead: null,
  }))) } }],
});

// ── D-1: THE PIN, ASSERTED ON THE BODY THE JUDGE ACTUALLY SENDS ───────────────────────────────
test('D-1: the judge call body carries temperature 0, the fixed seed and top_p 1', async () => {
  const bodies: Record<string, unknown>[] = [];
  const judged = await defaultJudge(CTX, RECS, 'surface', undefined, false, {
    call: async (p) => { bodies.push(p); return applyingCompletion(INTENDED); },
  });

  assert.equal(bodies.length, 1, 'exactly one provider call on the happy path');
  const body = bodies[0];
  assert.equal(body.temperature, 0, 'temperature 0 (was 0.1)');
  assert.equal(body.seed, AUDIT_LLM_SEED, 'the fixed decode seed');
  assert.equal(body.top_p, 1, 'canonical top_p');
  // Everything else the PRD said must not move.
  assert.equal(body.max_tokens, 900, 'max_tokens unchanged');
  assert.ok(Array.isArray(body.messages) && (body.messages as unknown[]).length === 2, 'system + user, unchanged');
  assert.equal(judged.length, RECS.length);
  assert.ok(judged.every((j) => j.verdict === 'applies'), 'an agreeing Gemini verdict is returned as-is');
});

test('D-1: the autoflag surface is pinned identically — one judge, one configuration', async () => {
  const bodies: Record<string, unknown>[] = [];
  await defaultJudge(CTX, RECS, 'autoflag', undefined, false, {
    call: async (p) => { bodies.push(p); return applyingCompletion(GEMINI_FLASH_MODEL); },
  });
  assert.equal(bodies[0].temperature, 0);
  assert.equal(bodies[0].seed, AUDIT_LLM_SEED);
  assert.equal(bodies[0].top_p, 1);
});

// ── D-2: THE GEMINI-ONLY GUARD ────────────────────────────────────────────────────────────────
test('D-2: a non-Gemini served model is retried ONCE, then the whole batch refuses', async () => {
  const served: string[] = [];
  const judged = await defaultJudge(CTX, RECS, 'surface', undefined, false, {
    // The measured defect: something answering as qwen2.5:14b through the still-live Ollama bridge.
    call: async () => { served.push('qwen2.5:14b'); return applyingCompletion('qwen2.5:14b'); },
  });

  assert.equal(served.length, 2, 'exactly one retry — never a third attempt');
  assert.equal(judged.length, RECS.length, 'every rec is accounted for, none dropped');
  assert.ok(judged.every((j) => j.verdict === 'insufficient_info'), 'the whole batch is insufficient_info');
  assert.ok(judged.every((j) => j.confidence === 0), 'and carries no confidence');

  // The property that matters clinically: NO FLAG FIRES. Asserted through the real assembler on
  // both surfaces, not inferred from the verdict.
  assert.deepEqual(assembleFlags(judged, 'surface', {}), [], 'no flag on the opt-in surface');
  assert.deepEqual(assembleFlags(judged, 'autoflag', {}), [], 'no flag on the autoflag surface');
});

// ⚠️ SUPERSEDED BY D-6 (GUARD FIX PRD v3.0, 10 Aug 2026). This test used to assert that an EMPTY
// served model is a failure — two calls, then refusal. THAT WAS THE DEFECT, and it passed: an
// empty string does not mean "wrong model", it means "the provider did not echo a name", and
// retrying every one of those doubled the judge's cost until no call finished inside the platform
// ceiling (0/24 at 300s, from 106/118 at ~140s). The replacement lives in
// lvc-judge-attribution.test.ts §3.6 test 1: one call, verdict accepted, attribution `unknown`.
// It is kept here as a pointer so nobody reinstates the old assertion by reading this file alone.
test('D-2 → D-6: an EMPTY served model is UNKNOWN attribution, not a failure (see lvc-judge-attribution.test.ts)', async () => {
  let calls = 0;
  const judged = await defaultJudge(CTX, RECS, 'surface', undefined, false, {
    call: async () => { calls++; return { model: '', choices: [{ message: { content: '[]' } }] }; },
  });
  assert.equal(calls, 1, 'exactly ONE call — an unlabeled answer is never retried (D-6)');
  // Content '[]' names no rec, so the parser's own doctrine returns insufficient_info for all —
  // that is the PARSER, not a refusal. Test 1 in the attribution suite proves a real verdict is
  // served on this path.
  assert.ok(judged.every((j) => j.verdict === 'insufficient_info'));
});

test('D-2: a throw is retried once and then refuses — no soft-fail to a local answer', async () => {
  let calls = 0;
  const judged = await defaultJudge(CTX, RECS, 'surface', undefined, false, {
    call: async () => { calls++; throw new Error('vertex 403'); },
  });
  assert.equal(calls, 2);
  assert.ok(judged.every((j) => j.verdict === 'insufficient_info'));
});

test('D-2: a FIRST-attempt failure followed by an agreeing Gemini answer is served normally', async () => {
  let calls = 0;
  const judged = await defaultJudge(CTX, RECS, 'surface', undefined, false, {
    call: async () => {
      calls++;
      if (calls === 1) throw new Error('transient 429');
      return applyingCompletion(INTENDED);
    },
  });
  assert.equal(calls, 2, 'the retry is what recovered it');
  assert.ok(judged.every((j) => j.verdict === 'applies'), 'the retry’s verdict is honoured');
});

test('D-2: the publisher prefix is not a disagreement — google/<slug> still serves', async () => {
  const judged = await defaultJudge(CTX, RECS, 'surface', undefined, false, {
    call: async () => applyingCompletion(`google/${INTENDED}`),
  });
  assert.ok(judged.every((j) => j.verdict === 'applies'), 'the OpenRouter bridge slug must pass modelsAgree');
});

test('D-2: forceOllama refuses BEFORE any call — no ollama call may serve a judge verdict', async () => {
  let calls = 0;
  const judged = await defaultJudge(CTX, RECS, 'surface', undefined, true, {
    call: async () => { calls++; return applyingCompletion('llama3.1:8b'); },
  });
  assert.equal(calls, 0, 'the free-mini lab probe never reaches the provider on the judge stage');
  assert.ok(judged.every((j) => j.verdict === 'insufficient_info'));
});

test('D-2: with no Gemini available there is no slug to retry against — immediate refusal', async () => {
  // LLM_PIPELINE=mini is the switch that sends every surface to the Mac-mini bridge: it is read at
  // CALL time, so it reproduces "Gemini unavailable" faithfully inside one test.
  process.env.LLM_PIPELINE = 'mini';
  try {
    let calls = 0;
    const judged = await defaultJudge(CTX, RECS, 'surface', undefined, false, {
      call: async () => { calls++; return applyingCompletion('llama3.1:8b'); },
    });
    assert.equal(calls, 0, 'the mini pipeline cannot serve a judge verdict, so nothing is asked');
    assert.ok(judged.every((j) => j.verdict === 'insufficient_info'));
  } finally {
    delete process.env.LLM_PIPELINE;
  }
});

test('D-2: the refusal event kind is the one the PRD names', () => {
  assert.equal(LVC_JUDGE_REFUSED_EVENT, 'lvc_judge_gemini_refused');
});

// ── §4: THE ROUND TAG ─────────────────────────────────────────────────────────────────────────
test('§4: valid round tags resolve to themselves', () => {
  for (const tag of ['lvc_judge_aa_r1', 'lvc_judge_aa_r2', 'lvc_judge_aa_r0', 'lvc_judge_aa_r99']) {
    assert.equal(resolveAaExperiment(tag), tag);
    assert.ok(AA_EXPERIMENT_RE.test(tag));
  }
});

test('§4: junk falls back to the r1 default — the route can never write an unfindable tag', () => {
  const junk = [
    undefined, null, '', '   ', 'lvc_judge_aa', 'lvc_judge_aa_r', 'lvc_judge_aa_r100',
    'lvc_judge_aa_r2x', 'LVC_JUDGE_AA_R2', 'lvc_judge_aa_r2; DROP TABLE lab_analyses',
    'lvc_judge_bb_r2', 'r2', 'lvc_judge_aa_r-1',
  ];
  for (const j of junk) {
    assert.equal(resolveAaExperiment(j as string | null | undefined), AA_EXPERIMENT_DEFAULT, `${JSON.stringify(j)} must fall back`);
  }
  assert.equal(AA_EXPERIMENT_DEFAULT, 'lvc_judge_aa_r1', 'the default is the tag r1 was stored under');
});

test('§4: surrounding whitespace is trimmed, not rejected', () => {
  assert.equal(resolveAaExperiment('  lvc_judge_aa_r2  '), 'lvc_judge_aa_r2');
});
