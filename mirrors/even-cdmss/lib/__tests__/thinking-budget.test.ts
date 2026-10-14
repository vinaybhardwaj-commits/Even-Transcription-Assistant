// lib/__tests__/thinking-budget.test.ts — the DEFAULT-OFF lock for the thinkingBudget study flag.
//
// WHY THIS EXISTS. `LLM_THINKING_BUDGET` (17-Jul-2026 cost study) caps Gemini 2.5 reasoning
// tokens per call. The shipped production default is UNCAPPED, and the study's whole claim to
// being a study — rather than a shipped behaviour change — rests on ONE property: with the env
// var unset, tracedChat must build byte-identical request params and gen_params. These tests pin
// that property, and pin the SL0-verified mechanism so a later "cleanup" can't silently turn the
// cap into a no-op.
//
// THE SILENT-NO-OP RISK IS REAL, NOT THEORETICAL. SL0 measured Vertex's OpenAI-compat endpoint:
// `generationConfig.thinkingConfig` and `extra_body.generationConfig.thinkingConfig` (the form
// the kickoff proposed) are accepted with HTTP 200 and CHANGE NOTHING — reasoning stayed at
// ~2.0-2.4k, indistinguishable from uncapped. Only a top-level `google.thinking_config` is
// honored (dose-response: 128/512/1024/2048 → 75/431/678/1509 actual reasoning tokens). A cap
// that silently does nothing would make every arm secretly Arm A and the study would report a
// free lunch that does not exist — so the wire format is locked here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { geminiThinkingBudget } from '../trace';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
// Assertions below are about CODE, not commentary — trace.ts's own comments name the rejected
// forms (that's why they're documented). Strip comments first or the prose fails the test.
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Set/clear LLM_THINKING_BUDGET around a body, restoring whatever the runner had. */
function withEnv(v: string | undefined, fn: () => void) {
  const prev = process.env.LLM_THINKING_BUDGET;
  if (v === undefined) delete process.env.LLM_THINKING_BUDGET;
  else process.env.LLM_THINKING_BUDGET = v;
  try { fn(); } finally {
    if (prev === undefined) delete process.env.LLM_THINKING_BUDGET;
    else process.env.LLM_THINKING_BUDGET = prev;
  }
}

test('DEFAULT-OFF: unset ⇒ no cap (the shipped path is uncapped and must stay so)', () => {
  withEnv(undefined, () => assert.equal(geminiThinkingBudget(), undefined));
});

test('DEFAULT-OFF: 0, negative, junk and empty all mean "no cap", never a cap of 0', () => {
  // gemini-2.5-pro REJECTS thinking_budget=0 with HTTP 400 (Pro cannot disable thinking; 128 is
  // its floor). A typo must therefore degrade to UNCAPPED, never to a request Vertex 400s on —
  // and never to the silent fallback-to-Ollama that a 400 would trigger in tracedChat.
  for (const v of ['0', '-1', '-1647', 'abc', '', ' ']) {
    withEnv(v, () => assert.equal(geminiThinkingBudget(), undefined, `LLM_THINKING_BUDGET='${v}' must not cap`));
  }
  // -1 is Gemini's "dynamic" sentinel (= uncapped). It must not be forwarded as a cap: it would
  // read as an arm in gen_params while behaving exactly like Arm A.
  withEnv('-1', () => assert.equal(geminiThinkingBudget(), undefined));
});

test('a set budget is honored, floored to an integer (the arms: 1647 / 823 / 128)', () => {
  for (const [raw, want] of [['1647', 1647], ['823', 823], ['128', 128], ['823.9', 823]] as const) {
    withEnv(raw, () => assert.equal(geminiThinkingBudget(), want));
  }
});

test('the cap rides the SL0-verified wire format (top-level google.thinking_config)', () => {
  const src = code('lib/trace.ts');
  assert.ok(/gParams\.google = \{ thinking_config: \{ thinking_budget: thinkingBudget \} \}/.test(src),
    'the honored form is a TOP-LEVEL google.thinking_config — SL0 proved the generationConfig forms are silently ignored');
  // the two forms SL0 measured as no-ops must never be reintroduced as the mechanism
  assert.ok(!/gParams\.generationConfig/.test(src), 'generationConfig.thinkingConfig is a silent no-op on this endpoint');
  assert.ok(!/extra_body/.test(src), 'extra_body is a python-SDK concept, not this endpoint contract');
});

test('the cap is Gemini-only and cannot leak onto the Ollama fallback path', () => {
  const src = read('lib/trace.ts');
  // Ollama has no thinking_config; a budget resolved for a non-Gemini call would be meaningless
  // in gen_params and would misreport the local fallback as a capped arm.
  assert.ok(/const thinkingBudget = useGemini \? geminiThinkingBudget\(\) : undefined;/.test(src),
    'the budget is resolved only when the call actually runs on Gemini');
  // and it is applied inside the gemini tier (V-a2: the ladder arm), never to the `params`
  // handed to llm.chat
  const geminiBranch = src.slice(src.indexOf("beginProviderCall('gemini');"), src.indexOf('} catch (ge) {'));
  assert.ok(geminiBranch.includes('gParams.google'), 'the cap is applied to the Gemini params only');
});

test('gen_params records the budget ONLY when capped — an uncapped trace is unchanged', () => {
  // Observability with a zero-footprint default: a capped run must be identifiable from its own
  // trace (else a study pack cannot be told from a shipped-default one), while an uncapped run's
  // gen_params must be byte-identical to what it was before the flag existed.
  const src = read('lib/trace.ts');
  assert.ok(/\.\.\.\(thinkingBudget \? \{ thinking_budget: thinkingBudget \} : \{\}\)/.test(src),
    'thinking_budget is spread into gen_params conditionally — absent entirely when uncapped');
});
