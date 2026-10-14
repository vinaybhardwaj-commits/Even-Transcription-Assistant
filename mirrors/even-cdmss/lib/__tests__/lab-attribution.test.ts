/**
 *   node --test --import tsx lib/__tests__/lab-attribution.test.ts
 *
 * F11 DEC-2 — a lab row may not claim a model that did not answer (7 Aug 2026).
 *
 * ⚠️ THE RUN THIS FILE EXISTS FOR. lab_analyses 50da0b39-f939-41f1-b2a5-5e6db46c1264, experiment
 * bedrock_s1_verification, stored `provider='bedrock'`, `model='global.anthropic.claude-haiku-4-5-
 * 20251001-v1:0'`, status done. Trace ba35cf03-80ec-43d5-98af-5204c23cc36d — the same run — recorded
 * draft on qwen2.5:14b and critique + revision on qwen2.5:7b. No bedrock event, no error, no
 * exception: the route's A12 override gate had REFUSED the override (silently, as it is designed
 * to) and the route ran its production default, while the MCP stamped the row from the model it had
 * RESOLVED. Both halves behaved exactly as written. The row was still a lie.
 *
 * The first test below is that run, reproduced from its real values.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ANSWER_LEGS, attributionErrorOutput, checkAttribution, normaliseProvider, type ServedCall,
} from '../lab-attribution-core';
import { modelsAgree } from '../llm';

const src = (p: string) => readFileSync(p, 'utf8');
const MCP = src('lib/mcp-tools.ts');
const ASK = src('app/api/ask/route.ts');
const DDX = src('app/api/ddx/route.ts');

const HAIKU = 'global.anthropic.claude-haiku-4-5-20251001-v1:0';
/** The three legs exactly as v_stage_latency recorded them for trace ba35cf03. */
const THE_FAILED_RUN: ServedCall[] = [
  { stage: 'draft', provider: 'ollama', model: 'qwen2.5:14b' },
  { stage: 'critique', provider: 'ollama', model: 'qwen2.5:7b' },
  { stage: 'revision', provider: 'ollama', model: 'qwen2.5:7b' },
];

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · The failure, pinned
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('⚠️ THE 7 AUG RUN: a bedrock-target ask whose legs resolved to ollama is REFUSED, not stored', () => {
  const v = checkAttribution({ provider: 'bedrock', model: HAIKU }, THE_FAILED_RUN, modelsAgree);
  assert.equal(v.ok, false, 'this run must not be storable as a Bedrock result');
  assert.equal(v.ok === false && v.reason, 'mismatch');
  assert.ok(v.ok === false && /attribution MISMATCH/.test(v.message));
  // The message must name BOTH sides — a refusal a reader cannot act on is only half a guard.
  assert.ok(v.ok === false && v.message.includes('bedrock'));
  assert.ok(v.ok === false && v.message.includes(HAIKU));
  assert.ok(v.ok === false && v.message.includes('qwen2.5:14b'), 'and what actually answered');
  assert.ok(v.ok === false && v.message.includes('3 of 3'), 'and how much of the run was wrong');
});

test('the refused row stops asserting the model, and keeps the evidence', () => {
  const v = checkAttribution({ provider: 'bedrock', model: HAIKU }, THE_FAILED_RUN, modelsAgree);
  assert.equal(v.ok, false);
  const out = attributionErrorOutput({ answer: 'metformin should be discontinued…', ok: true },
    { provider: 'bedrock', model: HAIKU }, v as Extract<typeof v, { ok: false }>);
  assert.equal(out.status, 'error', 'a run whose attribution cannot be trusted is not a success');
  const a = out.attribution as Record<string, unknown>;
  assert.equal(a.requested_provider, 'bedrock');
  assert.equal(a.requested_model, HAIKU);
  assert.deepEqual(a.served, THE_FAILED_RUN, 'the three legs travel with the row, forever');
  assert.equal(out.answer, 'metformin should be discontinued…', 'the work is preserved — only the CLAIM is retracted');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · The verdicts that must NOT fire — a guard that cries wolf gets switched off
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('a genuinely-served run verifies, and is stored as what SERVED', () => {
  const v = checkAttribution({ provider: 'bedrock', model: HAIKU }, [
    { stage: 'draft', provider: 'bedrock', model: HAIKU },
    { stage: 'critique', provider: 'bedrock', model: HAIKU },
  ], modelsAgree);
  assert.deepEqual(v, { ok: true, verified: true, provider: 'bedrock', model: HAIKU });
});

test('vertex ≡ gemini across the seam — the two vocabularies are one provider', () => {
  assert.equal(normaliseProvider('vertex'), 'gemini');
  assert.equal(normaliseProvider('VERTEX'), 'gemini');
  assert.equal(normaliseProvider('bedrock'), 'bedrock');
  assert.equal(normaliseProvider(null), '');
  // The lab says `vertex:`; lib/trace.ts records `gemini`. Without the alias this correct run would
  // be refused — the guard would fire on every working Vertex probe and be turned off within a day.
  const v = checkAttribution({ provider: 'vertex', model: 'gemini-2.5-pro' }, [
    { stage: 'draft', provider: 'gemini', model: 'gemini-2.5-pro' },
  ], modelsAgree);
  assert.equal(v.ok, true);
});

test('a legitimate V-a2 ladder hop is not an error — but the row records who ANSWERED', () => {
  // A vertex request served by the OpenRouter tier: same model, different provider. The answer is
  // honest, so the run stands; the attribution follows the truth rather than the request.
  const v = checkAttribution({ provider: 'vertex', model: 'gemini-2.5-pro' }, [
    { stage: 'draft', provider: 'openrouter', model: 'google/gemini-2.5-pro' },
  ], modelsAgree);
  assert.equal(v.ok, true);
  assert.equal(v.ok === true && v.provider, 'openrouter', 'stored as openrouter, because openrouter answered');
  assert.equal(v.ok === true && v.model, 'google/gemini-2.5-pro');
});

test('utility legs are out of scope — only the legs an override steers are judged', () => {
  assert.deepEqual([...ANSWER_LEGS.ask], ['draft', 'answer', 'revision', 'critique']);
  assert.deepEqual([...ANSWER_LEGS.ddx], ['ddx_draft', 'ddx_revision', 'ddx_critique', 'clinical_state_normalise']);
  // The reranker judge and query expansion stay local under any override; they are not in the list,
  // so they can never be the reason a correct run is refused.
  for (const legs of Object.values(ANSWER_LEGS)) {
    assert.ok(!legs.includes('rerank_judge') && !legs.includes('expand') && !legs.includes('variant_gen'));
  }
  // …but clinical_state_normalise IS judged: it takes ...LAB straight into tracedChat, so it really
  // does follow the override. The scan below is what caught its absence from the first draft.
  assert.ok((ANSWER_LEGS.ddx as readonly string[]).includes('clinical_state_normalise'));
});

test('THE LIST MUST NOT FALL BEHIND THE ROUTES: every `...LAB` traced leg is judged', () => {
  // The guard is only as good as its leg list. If a new overridable leg is added to either route,
  // this fails — which is the point, because an unjudged leg is an unattributed one.
  const legsOf = (text: string, prefix: string) => {
    const out = new Set<string>();
    const re = /tracedChat\(traceId, '([a-z_]+)'/g;
    for (const m of text.matchAll(re)) {
      // …but only the call sites that actually receive the override.
      const at = text.indexOf(m[0]);
      const window = text.slice(at, at + 2600);
      if (/\.\.\.LAB/.test(window.split('tracedChat(traceId,')[1] ?? window)) out.add(m[1]);
    }
    void prefix;
    return out;
  };
  for (const [feature, text] of [['ask', ASK], ['ddx', DDX]] as const) {
    const found = legsOf(text, feature);
    assert.ok(found.size > 0, `${feature}: the scan found no traced legs — the scan itself is broken`);
    for (const leg of found) {
      assert.ok((ANSWER_LEGS[feature] as readonly string[]).includes(leg),
        `${feature} leg '${leg}' receives ...LAB but is not in ANSWER_LEGS — it could be overridden and never checked`);
    }
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · No evidence: the asymmetry is about which claim is dangerous
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('a PAID claim with no recorded call is refused; a free one stores unverified', () => {
  const paid = checkAttribution({ provider: 'bedrock', model: HAIKU }, [], modelsAgree);
  assert.equal(paid.ok, false);
  assert.equal(paid.ok === false && paid.reason, 'unprovable');
  assert.ok(paid.ok === false && /UNPROVABLE/.test(paid.message));

  // The mini claim is the one every fallback path also lands on, so an unprovable ollama row cannot
  // be wrong in the direction that matters — and failing it would break every free probe the day
  // telemetry hiccups.
  const free = checkAttribution({ provider: 'ollama', model: 'qwen2.5:14b' }, [], modelsAgree);
  assert.equal(free.ok, true);
  assert.equal(free.ok === true && free.verified, false, 'stored, but never claimed as verified');
  assert.ok(free.ok === true && /unverified/.test(String(free.reason)));
});

test('empty/garbage legs are treated as no evidence, never as agreement', () => {
  const junk = [{ stage: null, provider: null, model: null }];
  const v = checkAttribution({ provider: 'bedrock', model: HAIKU }, junk, modelsAgree);
  assert.equal(v.ok, false, 'a row of nulls is not proof that Bedrock answered');
  assert.equal(v.ok === false && v.reason, 'unprovable');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · The wiring — the check runs BEFORE the success store, on both wired probes
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('both F11-wired probes carry the attribution config, and the unwired ones do not', () => {
  assert.ok(MCP.includes("attribution: { feature: 'ask', traceIdOf:"), 'lab_ask');
  assert.ok(MCP.includes("attribution: { feature: 'ddx', traceIdOf:"), 'lab_ddx');
  // The three probes whose routes are not F11-wired have no `model` parameter and cannot
  // misattribute; adding a check there would assert against a trace they never steer.
  for (const probe of ['labAppropriateness', 'labPathway', 'labCaseAudit']) {
    const fn = MCP.slice(MCP.indexOf(`async function ${probe}(`), MCP.indexOf(`async function ${probe}(`) + 2000);
    assert.ok(!/attribution: \{/.test(fn), `${probe} must stay unchecked`);
  }
});

test('the refusal happens BEFORE the row is stored as done, or it is not a refusal', () => {
  const fn = MCP.slice(MCP.indexOf('async function runLabProbe('), MCP.indexOf('async function labDdx('));
  assert.ok(fn.indexOf('const verdict = checkAttribution(') < fn.indexOf("await updateLabAnalysis(runId, { status: 'done'"));
  assert.ok(fn.includes('if (!verdict.ok) {'));
  assert.ok(fn.includes('return err(`${opts.kind} probe REFUSED'), 'and the caller is told, loudly');
  // The columns a reader trusts are rewritten, not merely annotated.
  assert.ok(fn.includes('await correctLabAttribution('));
  assert.ok(src('lib/lab.ts').includes('UPDATE lab_analyses SET output = $2::jsonb, latency_ms = $3, provider = $4, model = $5'));
});

test('the probe no longer echoes the REQUESTED model into the stored output or summary', () => {
  // This is what made the row self-consistent while being wrong: output.provider/model and the
  // returned summary were both copies of the request, so every surface agreed with every other.
  const ask = MCP.slice(MCP.indexOf("kind: 'ask'"), MCP.indexOf("async function labAppropriateness"));
  assert.ok(!/output: \{ question, provider: M\.provider, model: M\.model/.test(ask));
  assert.ok(ask.includes('return { output: { question, ...probe }, summary: { ok: probe.ok } };'));
  const ddx = MCP.slice(MCP.indexOf("kind: 'ddx'"), MCP.indexOf("async function labAsk"));
  assert.ok(!/output: \{ presentation, provider: M\.provider, model: M\.model/.test(ddx));
});

test('the trace id reaches the probe: routes emit it, the reducers keep it', () => {
  for (const [name, text] of [['ask', ASK], ['ddx', DDX]] as const) {
    assert.ok(text.includes("emit({ type: 'done', ms: Date.now() - t0, trace_id: traceId });"), `${name} emits it`);
  }
  const core = src('lib/lab-clinical-core.ts');
  assert.equal((core.match(/if \(typeof e\.trace_id === 'string' && e\.trace_id\)/g) ?? []).length, 2, 'both reducers');
  // Optional on the event type, so no other emitter or consumer changes.
  assert.ok(src('lib/stream.ts').includes("| { type: 'done'; ms: number; trace_id?: string }"));
});
