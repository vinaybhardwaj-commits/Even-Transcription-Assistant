/**
 * lib/__tests__/intended-attribution.test.ts — addendum v7 sections 5, 6, 7 and 10.
 *
 * The manifest-affecting corrections of pass 0. Every one of these changes a measured artifact, so
 * they land before any baseline is taken; a baseline taken before them would be a baseline of the
 * wrong object.
 *
 * ⚠️ THE DEFECT THESE PIN. Three of the four intended-attribution sites wrote
 * `intendedProvider: 'vertex'` beside `intendedModel: JUDGE_MODEL`, and `JUDGE_MODEL` is the LOCAL
 * model (`llama3.1:8b`). Vertex never serves it. Every judge batch of every reranked retrieval
 * carried that pair, so any C0 query comparing intended against served read as a permanent mismatch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const RERANK_SRC_RAW = readFileSync('lib/rerank.ts', 'utf8');
/**
 * ⚠️ COMMENTS STRIPPED BEFORE ANY SOURCE PIN. The route's own comments QUOTE the defect they warn
 * against — `intendedProvider: 'vertex'` appears in the explanation of why it must never appear in
 * code. A raw-text pin reads that explanation as the defect. This is the fourth time in this
 * workstream a text-level check has had to decide whether comments are in scope: the import scanner
 * in pass 1, the call-form pin in pass 2, the admin-cookie pin in pass 5, and this.
 */
const RERANK_SRC = RERANK_SRC_RAW
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

/** The environment knobs the resolver reads. Saved and restored around every case. */
const KEYS = [
  'GEMINI_ALL', 'GEMINI_UTILITY', 'GEMINI_VIA_OPENROUTER', 'LLM_PIPELINE',
  'GCP_PROJECT', 'GCP_SA_KEY', 'OPENROUTER_API_KEY', 'RERANK_JUDGE_MODEL', 'RERANK_API_MODEL',
] as const;

function withEnv<T>(over: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of KEYS) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(over)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

/** Imported lazily inside each case, because the resolver reads env at CALL time by design. */
async function rerank() { return import('../rerank.ts'); }

// ════════════════════════════════════════════════════════════════════════════════════════════════
// v7 §5 — the resolver
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * ⚠️ THE CLOUD CASES RUN IN A CHILD PROCESS, AND THE REASON IS A REAL PROPERTY OF THE CODE.
 * `geminiConfigured()` reads `GCP_PROJECT` through a MODULE-LOAD constant (`lib/llm.ts:52`), so
 * setting `process.env.GCP_PROJECT` after import cannot reach it. That is not a limitation of the
 * resolver — `chatWithFallback` resolves its own first tier through the same `geminiConfigured()`,
 * so the resolver is exactly as dynamic as the thing it must mirror, and no more. A fresh process
 * is the only way to observe a different provider configuration.
 */
function resolveInChild(env: Record<string, string | undefined>): { provider: string; model: string } {
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env })) {
    if (v !== undefined) childEnv[k] = String(v);
  }
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete childEnv[k];
  // ⚠️ `(m.default ?? m)` — tsx compiles to CJS, so a dynamic import from `node -e` lands the named
  // exports under `default`. Reading `m.resolveJudgeIntendedTarget` directly returns undefined.
  const code = "import('./lib/rerank.ts').then(m => { const r = (m.default ?? m); "
    + "process.stdout.write('TARGET ' + JSON.stringify(r.resolveJudgeIntendedTarget())); })";
  const r = spawnSync(process.execPath, ['--import', 'tsx', '-e', code], {
    encoding: 'utf8', env: childEnv as unknown as NodeJS.ProcessEnv,
  });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('TARGET '));
  assert.ok(line, `child produced no TARGET.\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  return JSON.parse(line.slice('TARGET '.length));
}

test('v7 §5 — Vertex is the first target when Gemini is on and the bridge flag is off', () => {
  const t = resolveInChild({
    LLM_PIPELINE: undefined, GEMINI_ALL: '1', GEMINI_VIA_OPENROUTER: '0',
    GCP_PROJECT: 'test-project', GCP_SA_KEY: 'not-json', OPENROUTER_API_KEY: undefined,
  });
  assert.equal(t.provider, 'vertex');
  assert.match(t.model, /gemini/i, 'a Vertex target is a Gemini model, never the local judge model');
  assert.notEqual(t.model, 'llama3.1:8b', 'THE defect: Vertex never serves the local judge model');
});

test('v7 §5 — OpenRouter is the first target when the bridge flag produces a slug', () => {
  // `cloudLadder({ orFirst: useOpenRouter, … })[0]` is OpenRouter when the flag produced a slug.
  const t = resolveInChild({
    LLM_PIPELINE: undefined, GEMINI_ALL: '1', GEMINI_VIA_OPENROUTER: '1',
    GCP_PROJECT: 'test-project', GCP_SA_KEY: 'not-json', OPENROUTER_API_KEY: 'or-key',
  });
  assert.equal(t.provider, 'openrouter');
  assert.match(t.model, /gemini/i);
});

test('v7 §5 — Ollama with JUDGE_MODEL when no cloud tier is available, and that pair IS sanctioned', async () => {
  const { resolveJudgeIntendedTarget } = await rerank();
  const t = withEnv({
    LLM_PIPELINE: undefined, GEMINI_ALL: undefined, GEMINI_UTILITY: undefined,
    GEMINI_VIA_OPENROUTER: '0', GCP_PROJECT: undefined, GCP_SA_KEY: undefined,
    OPENROUTER_API_KEY: undefined, RERANK_JUDGE_MODEL: undefined,
  }, resolveJudgeIntendedTarget);
  // This is the ONE place JUDGE_MODEL is a correct intended model: it is the real dispatch target.
  assert.deepEqual(t, { provider: 'ollama', model: 'llama3.1:8b' });
});

test('v7 §5 — LLM_PIPELINE=mini forces local, whatever the Gemini flags say', async () => {
  const { resolveJudgeIntendedTarget } = await rerank();
  const t = withEnv({
    LLM_PIPELINE: 'mini', GEMINI_ALL: '1', GCP_PROJECT: 'p', GCP_SA_KEY: 'k',
    GEMINI_VIA_OPENROUTER: '1', OPENROUTER_API_KEY: 'or-key', RERANK_JUDGE_MODEL: undefined,
  }, resolveJudgeIntendedTarget);
  assert.equal(t.provider, 'ollama', 'mini is the escape hatch and it wins');
});

test('v7 §5 — Gemini flags with NO provider configuration still resolve local, not Vertex', async () => {
  // The failure this catches: reading the flag without checking `geminiConfigured()` would name a
  // provider that cannot be reached.
  const { resolveJudgeIntendedTarget } = await rerank();
  const t = withEnv({
    LLM_PIPELINE: undefined, GEMINI_ALL: '1', GEMINI_VIA_OPENROUTER: '0',
    GCP_PROJECT: undefined, GCP_SA_KEY: undefined, RERANK_JUDGE_MODEL: undefined,
  }, resolveJudgeIntendedTarget);
  assert.equal(t.provider, 'ollama');
});

test('v7 §5 — Cohere resolves to OpenRouter with the effective Cohere model', async () => {
  const { resolveCohereIntendedTarget } = await rerank();
  const t = withEnv({ RERANK_API_MODEL: undefined }, resolveCohereIntendedTarget);
  assert.deepEqual(t, { provider: 'openrouter', model: 'cohere/rerank-v3.5' });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// v7 §5 — THE GUARD. An impossible pairing fails HERE rather than serializing.
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('v7 §5 — the guard rejects the exact pair that reached the manifest, and accepts all four sanctioned ones', async () => {
  const { isSanctionedIntendedPairing } = await rerank();

  // ⚠️ THE DEFECT ITSELF. This is what three sites wrote on every judge batch.
  assert.equal(
    isSanctionedIntendedPairing('vertex', 'llama3.1:8b'), false,
    'vertex + the LOCAL judge model is the impossible pair this whole section exists to stop',
  );

  // The four sanctioned pairings.
  assert.equal(isSanctionedIntendedPairing('vertex', 'gemini-2.5-flash'), true);
  assert.equal(isSanctionedIntendedPairing('openrouter', 'google/gemini-2.5-flash'), true);
  assert.equal(isSanctionedIntendedPairing('ollama', 'llama3.1:8b'), true);
  assert.equal(isSanctionedIntendedPairing('openrouter', 'cohere/rerank-v3.5'), true);

  // …and a spread of things that are not.
  assert.equal(isSanctionedIntendedPairing('ollama', 'gemini-2.5-flash'), false, 'Ollama does not serve Gemini');
  assert.equal(isSanctionedIntendedPairing('vertex', 'cohere/rerank-v3.5'), false, 'Vertex does not serve Cohere');
  assert.equal(isSanctionedIntendedPairing('openrouter', 'llama3.1:8b'), false);
  assert.equal(isSanctionedIntendedPairing('bedrock', 'gemini-2.5-flash'), false, 'bedrock cannot serve the judge');
  assert.equal(isSanctionedIntendedPairing('', 'gemini-2.5-flash'), false);
  assert.equal(isSanctionedIntendedPairing('vertex', ''), false);
});

test('v7 §5 — EVERY target the resolver can produce is a sanctioned pairing, across the matrix', async () => {
  // The resolver is the only producer of these fields now, so this is the property that matters:
  // no reachable configuration can emit a pair the guard would reject.
  const { resolveJudgeIntendedTarget, resolveCohereIntendedTarget, isSanctionedIntendedPairing } = await rerank();
  const bools = [undefined, '1'] as const;
  for (const all of bools) {
    for (const util of bools) {
      for (const bridge of ['0', '1'] as const) {
        for (const gcp of [undefined, 'p'] as const) {
          for (const orKey of [undefined, 'or-key'] as const) {
            for (const mini of [undefined, 'mini'] as const) {
              const t = withEnv({
                GEMINI_ALL: all, GEMINI_UTILITY: util, GEMINI_VIA_OPENROUTER: bridge,
                GCP_PROJECT: gcp, GCP_SA_KEY: gcp ? 'k' : undefined,
                OPENROUTER_API_KEY: orKey, LLM_PIPELINE: mini, RERANK_JUDGE_MODEL: undefined,
              }, resolveJudgeIntendedTarget);
              assert.equal(
                isSanctionedIntendedPairing(t.provider, t.model), true,
                `unsanctioned pair ${t.provider} + ${t.model} from all=${all} util=${util} bridge=${bridge} gcp=${gcp} or=${orKey} mini=${mini}`,
              );
            }
          }
        }
      }
    }
  }
  const c = resolveCohereIntendedTarget();
  assert.equal(isSanctionedIntendedPairing(c.provider, c.model), true);
});

test('v7 §5 — no site hardcodes the impossible pair any more, and the correct Cohere site is pinned', () => {
  // A source pin alongside the behavioural cases: the literal that was wrong is gone from all three
  // sites, and the one site that was already correct still is.
  assert.equal(
    /intendedProvider: 'vertex'/.test(RERANK_SRC), false,
    "no site may hardcode 'vertex' as an intended provider — it must be resolved",
  );
  assert.equal(
    /intendedModel: JUDGE_MODEL/.test(RERANK_SRC), false,
    'JUDGE_MODEL may only reach an intended model through the resolver',
  );
  // Site 1 (`rerankCohere`) was correct before this pass and is unchanged.
  assert.match(RERANK_SRC, /intendedProvider: 'openrouter', intendedModel: RERANK_API_MODEL,/);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// v7 §6 — the Cohere soft failure records `unattributed`, never an inferred `not_served`
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('v7 §6 — a generic Cohere failure records unattributed, because the proof rule governs', async () => {
  const { rerank: rerankFn } = await rerank();
  const { createTelemetryCapture, servedClassOf } = await import('../retrieval-capture.ts');
  const capture = createTelemetryCapture('primary');

  // An explicit 'cohere' request whose health probe passes and whose call throws GENERICALLY — the
  // only path that reaches the soft-failure branch.
  const out = await rerankFn('q', [{ id: 1, text: 'a' }, { id: 2, text: 'b' }], 'cohere', {
    checkHealthy: (async () => undefined) as never,
    cohereFn: (async () => { throw new Error('generic, untyped'); }) as never,
  }, capture);

  assert.equal(out.length, 2, 'soft failure returns input order — retrieval is never blocked');
  assert.equal(capture.rerankSoftFailed, true);
  assert.equal(capture.batches.length, 1, 'one planned Cohere boundary');
  const ev = capture.batches[0].evidence;
  assert.equal(ev?.provenNotServed, false, 'no transport proof exists, so none is claimed');
  assert.equal(
    servedClassOf(ev), 'unattributed',
    'D16 proof rule: without failure attribution the answer is unattributed, never an inferred not_served',
  );
});

test('v7 §6 — the resolved intended pairing survives on the soft-failure record too', async () => {
  const { rerank: rerankFn, isSanctionedIntendedPairing } = await rerank();
  const { createTelemetryCapture } = await import('../retrieval-capture.ts');
  const capture = createTelemetryCapture('primary');
  await rerankFn('q', [{ id: 1, text: 'a' }, { id: 2, text: 'b' }], 'cohere', {
    checkHealthy: (async () => undefined) as never,
    cohereFn: (async () => { throw new Error('generic'); }) as never,
  }, capture);
  const b = capture.batches[0];
  assert.equal(b.intendedProvider, 'openrouter');
  assert.equal(isSanctionedIntendedPairing(b.intendedProvider as string, b.intendedModel as string), true);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// v7 §10 — reranker temperature and seed STATUS
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('v7 §10 — a fresh capture carries the no-rerank values, not zeros', async () => {
  const { createTelemetryCapture, buildRetrievalPayload } = await import('../retrieval-capture.ts');
  const c = createTelemetryCapture('primary');
  assert.equal(c.rerankTemperature, null, 'null means no rerank decode ran — 0 would be a claim');
  assert.equal(c.rerankSeedStatus, 'not_applicable');
  // Emitted UNCONDITIONALLY: a field present only when a reranker ran cannot distinguish
  // "no rerank" from "not implemented yet".
  const payload = buildRetrievalPayload(c, { hmacKey: 'k', scorerContext: null });
  assert.equal(payload.retrieval_config.rerank_temperature, null);
  assert.equal(payload.retrieval_config.rerank_seed_status, 'not_applicable');
});

test('v7 §10 — Cohere records neither a temperature nor a seed, because it takes neither', async () => {
  const { rerankCohere } = await rerank();
  const { createTelemetryCapture } = await import('../retrieval-capture.ts');
  const capture = createTelemetryCapture('primary');
  process.env.OPENROUTER_API_KEY = 'test-only-never-sent';
  const fetchImpl = (async () => ({
    status: 200, ok: true,
    json: async () => ({ results: [{ index: 0, relevance_score: 0.9 }, { index: 1, relevance_score: 0.4 }] }),
  })) as unknown as typeof fetch;
  await rerankCohere('q', [{ id: 1, text: 'a' }, { id: 2, text: 'b' }], fetchImpl, async () => undefined, capture);
  delete process.env.OPENROUTER_API_KEY;
  assert.equal(capture.rerankTemperature, null);
  assert.equal(capture.rerankSeedStatus, 'not_applicable');
});

test('v7 §10 — the judge records its real temperature and `unseeded`, and the call uses the same constant', () => {
  // Today the judge sets temperature 0.0 and NO seed: its options bag carries only `num_ctx`.
  // `unseeded` is therefore the honest status on every tier, cloud or local.
  assert.match(RERANK_SRC, /const JUDGE_TEMPERATURE = 0\.0;/);
  assert.match(RERANK_SRC, /temperature: JUDGE_TEMPERATURE,/, 'the call and the manifest read one constant');
  assert.equal(
    /temperature: 0\.0,/.test(RERANK_SRC), false,
    'no literal temperature may remain — that is how the manifest and the call drift apart',
  );
  assert.match(RERANK_SRC, /capture\.rerankTemperature = JUDGE_TEMPERATURE;/);
  assert.equal(/seed:/.test(RERANK_SRC), false, 'the judge sets no seed, so `unseeded` is the true status');
});

test('v7 §10 — the seed status vocabulary distinguishes a stripped seed from an applied one', async () => {
  // The distinction that matters: a seed set in the Ollama options bag is STRIPPED before every
  // cloud call (lib/llm.ts:404, :474, lib/trace.ts:440, :516), so a seed set in code does not reach
  // a cloud provider. `lib/expand.ts:33` is a live example of a seed living in that bag.
  const { RERANK_SEED_STATUSES } = await import('../retrieval-capture.ts');
  assert.deepEqual([...RERANK_SEED_STATUSES], ['not_applicable', 'unseeded', 'applied_local', 'stripped_cloud']);
  const llm = readFileSync('lib/llm.ts', 'utf8');
  const trace = readFileSync('lib/trace.ts', 'utf8');
  const strips = (src: string) => (src.match(/const \{ options: _o, keep_alive: _k, \.\.\.rest \}/g) || []).length;
  assert.equal(strips(llm), 2, 'lib/llm.ts strips the options bag on both cloud tiers');
  assert.equal(strips(trace), 2, 'lib/trace.ts strips it on both of its cloud tiers');
});
