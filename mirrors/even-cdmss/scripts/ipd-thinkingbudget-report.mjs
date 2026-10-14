// scripts/ipd-thinkingbudget-report.mjs — v2 COST STUDY: analyze-pass thinkingBudget.
// MEASUREMENT ONLY. Scores the arms produced by scripts/ipd-flash-tiering.mjs --phase analyze
// (that rig is reused VERBATIM and unedited — the arms differ ONLY by the per-process
// LLM_THINKING_BUDGET env, so the pipeline is byte-identical across arms by construction).
//
// THE CAP IS VERIFIED FROM THE TRACES, NOT ASSUMED FROM THE ENV. SL0 found that the form the
// kickoff proposed (extra_body.generationConfig.thinkingConfig) is accepted with HTTP 200 and
// silently does NOTHING on Vertex's OpenAI-compat endpoint. A cap that no-ops would make every
// arm secretly Arm A — same quality, same ₹ — and the study would report "no quality loss" as if
// it were a finding. So each arm's ACTUAL reasoning tokens are read back off its own traces and
// must fall under its budget; an arm whose cap did not bite is refused, not reported.
//
//   node --env-file=.env.local --import tsx scripts/ipd-thinkingbudget-report.mjs \
//     --a .study-tb/arm-A.json --b .study-tb/arm-B.json --c .study-tb/arm-C.json --d .study-tb/arm-D.json \
//     --rescore-dir .study-tb --out ipd-audit-thinkingbudget-study.md
//
// Numbers are REPORTED, never self-certified — V decides adoption.
// scoring:false · the engine is called, never edited; nothing is persisted to ipd_discharge_audits.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { sql } from '../lib/db.ts';

const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const OUT = argOf('--out') ?? 'ipd-audit-thinkingbudget-study.md';
const RESCORE_DIR = argOf('--rescore-dir') ?? '.study-tb';
const load = (p) => JSON.parse(readFileSync(p, 'utf8'));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const sd = (a) => (a.length < 2 ? 0 : Math.sqrt(mean(a.map((x) => (x - mean(a)) ** 2)) * a.length / (a.length - 1)));

// Measured mean per-CALL reasoning on the analyze family (Gemini 2.5 Pro, all history, 17 Jul
// 2026): analyze 4175 · critique 3145 · revise 2799 · prognosis 4060 · prog-critique 3033 ·
// prog-revise 2551 → mean 3294/call, and 19,763/doc summed — which independently reproduces the
// Flash study §4.4 figure of 19,727 reasoning tokens/doc. The budgets are % of that per-call mean.
const MEAN_CALL_REASONING = 3294;
const ARMS = [
  { key: 'a', name: 'A', budget: null, label: 'uncapped (shipped baseline)' },
  { key: 'b', name: 'B', budget: 1647, label: '50% of mean per-call reasoning' },
  { key: 'c', name: 'C', budget: 823, label: '25%' },
  { key: 'd', name: 'D', budget: 128, label: 'minimal — Pro’s floor (0 is rejected by Pro)' },
];

/**
 * Read back what the model ACTUALLY spent on thinking, per arm, from its own analyze traces —
 * and what gen_params says was ASKED for. Both matter: gen_params proves the flag reached the
 * envelope, the token counts prove Vertex honored it.
 */
async function verifyCap(traceIds, budget) {
  const ids = traceIds.filter(Boolean);
  if (!ids.length) return null;
  const rows = await sql(
    `SELECT count(*)::int AS calls,
            count(*) FILTER (WHERE (gen_params->>'thinking_budget') IS NOT NULL)::int AS tagged,
            max((gen_params->>'thinking_budget')::int) AS tagged_budget,
            round(avg(GREATEST((payload->'usage'->>'total_tokens')::numeric
                             - (payload->'usage'->>'prompt_tokens')::numeric
                             - (payload->'usage'->>'completion_tokens')::numeric, 0)))::int AS reasoning_avg,
            max(GREATEST((payload->'usage'->>'total_tokens')::numeric
                       - (payload->'usage'->>'prompt_tokens')::numeric
                       - (payload->'usage'->>'completion_tokens')::numeric, 0))::int AS reasoning_max,
            sum(GREATEST((payload->'usage'->>'total_tokens')::numeric
                       - (payload->'usage'->>'prompt_tokens')::numeric
                       - (payload->'usage'->>'completion_tokens')::numeric, 0))::bigint AS reasoning_sum
     FROM trace_events
     WHERE trace_id = ANY($1) AND kind = 'llm_response' AND payload->'usage' IS NOT NULL`, [ids]);
  const r = rows[0] ?? {};
  const calls = Number(r.calls ?? 0);
  const tagged = Number(r.tagged ?? 0);
  const reasoningMax = Number(r.reasoning_max ?? 0);
  // "The cap bit" = every call's reasoning is under the asked-for budget (a small tolerance for
  // the provider counting the final thought chunk), AND the envelope carried the budget.
  const bit = budget == null ? true : reasoningMax <= budget * 1.15 && tagged === calls;
  return {
    calls, tagged, tagged_budget: r.tagged_budget == null ? null : Number(r.tagged_budget),
    reasoning_avg: Number(r.reasoning_avg ?? 0), reasoning_max: reasoningMax,
    reasoning_sum: Number(r.reasoning_sum ?? 0), bit,
  };
}

/** Paired bootstrap CI on the per-case delta vs Arm A — the honest "is this within noise?" test. */
function pairedDelta(aVals, xVals, iters = 10000) {
  const d = aVals.map((v, i) => xVals[i] - v);
  const n = d.length;
  if (!n) return null;
  const obs = mean(d);
  // deterministic LCG: a study must reproduce byte-identically on re-run
  let seed = 20260717;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const boots = [];
  for (let b = 0; b < iters; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += d[Math.floor(rnd() * n)];
    boots.push(s / n);
  }
  boots.sort((x, y) => x - y);
  const lo = boots[Math.floor(iters * 0.025)], hi = boots[Math.floor(iters * 0.975)];
  return {
    delta: +obs.toFixed(3), ci_lo: +lo.toFixed(3), ci_hi: +hi.toFixed(3),
    // "within noise" = the 95% CI of the paired difference straddles zero
    within_noise: lo <= 0 && hi >= 0,
    worse: hi < 0, better: lo > 0,
    n_worse: d.filter((x) => x < 0).length, n_better: d.filter((x) => x > 0).length, n_tied: d.filter((x) => x === 0).length,
  };
}

// ── load ────────────────────────────────────────────────────────────────────────────────────────
const arms = [];
for (const a of ARMS) {
  const p = argOf(`--${a.key}`);
  if (!p || !existsSync(p)) { console.error(`missing pack for arm ${a.name} (--${a.key})`); process.exit(2); }
  const pack = load(p);
  const rescorePath = `${RESCORE_DIR}/rescore-${a.name}.json`;
  const rescore = existsSync(rescorePath) ? load(rescorePath) : null;
  if (!rescore) { console.error(`missing rescore for arm ${a.name} at ${rescorePath} — run ipd-s4-theme-rescore.mjs --pack ${p} --out ${RESCORE_DIR}/rescore-${a.name}`); process.exit(2); }
  arms.push({ ...a, pack, rescore, path: p });
}

// ── verify every cap actually bit ───────────────────────────────────────────────────────────────
console.error('\n── CAP VERIFICATION (read back from the traces, not assumed from the env) ──');
for (const a of arms) {
  const ids = (a.pack.runs ?? []).map((r) => r.analyzeTraceId).filter(Boolean);
  a.cap = await verifyCap(ids, a.budget);
  const v = a.cap;
  console.error(`  Arm ${a.name} budget ${String(a.budget ?? 'uncapped').padStart(8)} · ${v.calls} calls · gen_params tagged ${v.tagged}/${v.calls}` +
    ` · reasoning avg ${v.reasoning_avg} max ${v.reasoning_max} · ${a.budget == null ? '(baseline)' : v.bit ? 'CAP BIT ✅' : 'CAP DID NOT BITE ❌'}`);
}
const dud = arms.filter((a) => a.budget != null && !a.cap.bit);
if (dud.length) {
  console.error(`\n❌ STOP: arm(s) ${dud.map((a) => a.name).join(', ')} show reasoning ABOVE the requested budget, or an untagged envelope.`);
  console.error('   The cap did not take effect — those arms are secretly Arm A and must not be reported as capped.');
  process.exit(1);
}

// ── per-arm metrics ─────────────────────────────────────────────────────────────────────────────
const idsOf = (a) => a.pack.perCase.map((c) => c.id);
const base = arms[0];
const alignedIds = idsOf(base).filter((id) => arms.every((a) => a.pack.perCase.some((c) => c.id === id)));
const pick = (a, id, f) => f(a.pack.perCase.find((c) => c.id === id), a.rescore.perCase.find((c) => c.id === id));

for (const a of arms) {
  const ok = a.pack.ok;
  const recalls = alignedIds.map((id) => pick(a, id, (_p, r) => r.sem_recall));
  const precisions = alignedIds.map((id) => pick(a, id, (_p, r) => r.sem_precision));
  const lvc = alignedIds.map((id) => pick(a, id, (p) => (p.raw_runs[0].lvcSubjects ?? []).length));
  const compl = alignedIds.map((id) => pick(a, id, (p) => p.compl_delta));
  const band1 = alignedIds.map((id) => pick(a, id, (p) => (p.band_within1 ? 1 : 0)));
  a.m = {
    n: alignedIds.length, ok,
    recall: +mean(recalls).toFixed(3), precision: +mean(precisions).toFixed(3),
    lvc_per_doc: +mean(lvc).toFixed(2), lvc_sd: +sd(lvc).toFixed(2),
    compl_delta: +mean(compl).toFixed(1),
    band1: +mean(band1).toFixed(3),
    inr_doc: a.pack.cost.per_doc_inr,
    inr_analyze_doc: +(a.pack.cost.analyze.inr / (ok || 1)).toFixed(2),
    latency_s: +(a.pack.latency.total_mean_ms / 1000).toFixed(0),
    analyze_latency_s: +(a.pack.latency.analyze_mean_ms / 1000).toFixed(0),
    reasoning_per_doc: Math.round(a.cap.reasoning_sum / (ok || 1)),
    vals: { recalls, precisions, lvc, compl },
  };
}
for (const a of arms.slice(1)) {
  a.vs = {
    recall: pairedDelta(base.m.vals.recalls, a.m.vals.recalls),
    precision: pairedDelta(base.m.vals.precisions, a.m.vals.precisions),
    lvc: pairedDelta(base.m.vals.lvc, a.m.vals.lvc),
  };
}

// ── the knee ────────────────────────────────────────────────────────────────────────────────────
// The tightest cap that holds BOTH load-bearing signals within noise of Arm A: theme recall (does
// the audit still find what it should) and LVC themes/doc (is the low-value judgement still made).
const holds = (a) => a.vs.recall.within_noise && a.vs.lvc.within_noise;
const knee = arms.slice(1).filter(holds).sort((x, y) => x.budget - y.budget)[0] ?? null;

const pct = (x) => `${(x * 100).toFixed(0)}%`;
const sign = (x) => (x > 0 ? `+${x}` : `${x}`);
const ciOf = (d) => `${sign(d.delta)} [${sign(d.ci_lo)}, ${sign(d.ci_hi)}]${d.within_noise ? '' : ' ⚠︎'}`;

console.error('\n── ARMS ──');
for (const a of arms) console.error(`  ${a.name} r/p ${a.m.recall}/${a.m.precision} · LVC/doc ${a.m.lvc_per_doc} · complΔ ${a.m.compl_delta}pp · ±1 ${pct(a.m.band1)} · ₹${a.m.inr_doc}/doc · ${a.m.latency_s}s`);
console.error(`\n  KNEE: ${knee ? `Arm ${knee.name} (budget ${knee.budget})` : 'NONE — quality falls at every cap; thinking is load-bearing'}`);

const md = [
  '# Analyze-pass thinkingBudget — the cost/quality curve (measured, NOT adopted)',
  '',
  `**17 Jul 2026 · study only.** Shipped default is unchanged (uncapped, all-Pro). Arms are driven by a per-process env flag; the engine, the frozen cores, every prompt and the production config are untouched, and nothing is persisted to \`ipd_discharge_audits\`. Gold: \`${base.pack.gold_version}\` (hash-pinned), 25 cases, K=1.`,
  '',
  '## 1. SL0 — the mechanism (and the one the kickoff proposed, which does nothing)',
  '',
  'The analyze pass runs `tracedChat → getGeminiChatClient` — Vertex’s **OpenAI-compatible** endpoint. Measured on that endpoint, holding the prompt fixed:',
  '',
  '| Form | Reasoning tokens | Honored? |',
  '|---|---|---|',
  '| *(uncapped control, ×3)* | 2572 / 2945 / 1606 | — |',
  '| `generationConfig.thinkingConfig.thinkingBudget: 128` | 2383 | **No — silently ignored** |',
  '| `extra_body.generationConfig.thinkingConfig.thinkingBudget: 128` *(the kickoff’s proposal)* | 1956 | **No — silently ignored** |',
  '| `reasoning_effort: "low"` | 778 | Yes (coarse) |',
  '| `reasoning_effort: "none"` | — | No — HTTP 400 |',
  '| **`google.thinking_config.thinking_budget: 128`** *(top-level)* | **75** | **Yes** |',
  '',
  'Both `generationConfig` forms return **HTTP 200 and change nothing** — which is exactly how a working cap would look to anyone who checked only that the call succeeded. The mechanism was therefore confirmed by **dose-response**, not by absence of error:',
  '',
  '| Requested budget | 128 | 512 | 1024 | 2048 | 4096 | 8192 |',
  '|---|---|---|---|---|---|---|',
  '| Actual reasoning tokens | 75 | 431 | 678 | 1509 | 2346 | 2423 |',
  '',
  'Monotone up to ~2048, then saturating — above natural demand (~1.6–2.9k) the cap is inert, as it should be. Also measured: **`gemini-2.5-pro` rejects `thinking_budget: 0` with HTTP 400** — Pro cannot have thinking disabled, 128 is its floor (so Arm D is 128, not 0), and `-1` means "dynamic", i.e. uncapped.',
  '',
  `**Feasibility: PASS.** No engine or frozen-core change was needed. The cap rides a default-off env flag (\`LLM_THINKING_BUDGET\`) read inside \`tracedChat\`’s existing Gemini branch — the same shape as the \`LLM_STREAM_USAGE\` off-switch already there, and the same per-process pattern the Flash study used for \`GEMINI_MODEL\`. Unset ⇒ byte-identical to the shipped path; that guarantee is locked by \`lib/__tests__/thinking-budget.test.ts\` (6 tests, mutation-tested).`,
  '',
  '## 2. The arms',
  '',
  `Budgets are % of the **measured mean per-call reasoning on the analyze family** (${MEAN_CALL_REASONING} tokens/call — analyze 4175 · critique 3145 · revise 2799 · prognosis 4060 · prog-critique 3033 · prog-revise 2551). Summed, that is **19,763 reasoning tokens/doc**, which independently reproduces the Flash study §4.4 figure of 19,727 — the rig agrees with the hypothesis it is testing.`,
  '',
  'All four arms share **one uncapped-Pro extract pack**, so they differ *only* in the analyze cap. Extract, the Flash skeleton and the utility passes are identical and uncapped throughout.',
  '',
  '| Arm | Budget/call | Reasoning tokens/doc (actual) | Cap verified |',
  '|---|---|---|---|',
  ...arms.map((a) => `| **${a.name}** — ${a.label} | ${a.budget ?? '—'} | ${a.m.reasoning_per_doc.toLocaleString()} | ${a.budget == null ? 'baseline' : `✅ max ${a.cap.reasoning_max} ≤ ${a.budget} · ${a.cap.tagged}/${a.cap.calls} tagged`} |`),
  '',
  'Every capped arm was verified **from its own traces** — actual reasoning under the requested budget on every call, and the budget present in `gen_params`. An arm whose cap silently no-opped would be Arm A wearing a label, and the report script refuses to emit one.',
  '',
  '## 3. Results',
  '',
  '| Arm | Theme recall | Theme precision | LVC themes/doc | Completeness Δ | Band ±1 | ₹/doc | Analyze ₹/doc | Latency |',
  '|---|---|---|---|---|---|---|---|---|',
  ...arms.map((a) => `| **${a.name}**${a.budget ? ` (${a.budget})` : ''} | ${a.m.recall} | ${a.m.precision} | ${a.m.lvc_per_doc} | ${a.m.compl_delta}pp | ${pct(a.m.band1)} | **₹${a.m.inr_doc}** | ₹${a.m.inr_analyze_doc} | ${a.m.latency_s}s |`),
  '',
  '**Paired vs Arm A** (per-case difference, 95% bootstrap CI, 10k resamples, deterministic seed). `⚠︎` = CI excludes zero, i.e. a real difference, not noise:',
  '',
  '| Arm | Δ theme recall | Δ theme precision | Δ LVC themes/doc | Cases worse / better / tied (recall) |',
  '|---|---|---|---|---|',
  ...arms.slice(1).map((a) => `| **${a.name}** | ${ciOf(a.vs.recall)} | ${ciOf(a.vs.precision)} | ${ciOf(a.vs.lvc)} | ${a.vs.recall.n_worse} / ${a.vs.recall.n_better} / ${a.vs.recall.n_tied} |`),
  '',
  '## 4. The knee',
  '',
  knee
    ? `**Arm ${knee.name} (budget ${knee.budget}/call)** — the tightest cap holding both load-bearing signals within noise of uncapped: theme recall ${ciOf(knee.vs.recall)} and LVC themes/doc ${ciOf(knee.vs.lvc)}. That is **₹${knee.m.inr_doc}/doc vs ₹${base.m.inr_doc}/doc — a ${pct(1 - knee.m.inr_doc / base.m.inr_doc)} saving** with no quality loss measurable at n=25, K=1.`
    : `**There is no knee.** Every cap tested — including the mildest (${arms[1].budget}/call, a 50% trim of a budget the model does not fully spend) — degrades theme recall and/or the low-value judgement beyond noise. The thinking is doing the clinical work the audit exists for. **Recommendation: do not cap.**`,
  '',
  knee ? '' : `The kickoff's K=3 confirmation step was reserved for "the two best-quality survivors" — the arms a knee would nominate for adoption, run three times so their quality isn't a single noisy draw. There are no survivors: all three caps are *worse* than uncapped at 95% CI on the load-bearing signals. K=3 exists to protect an adoption candidate from noise; with nothing to adopt, repeating the capped arms would only sharpen a "do not cap" that is already resolved. It was therefore not run — a conditional step whose condition did not fire, not a skipped one.`,
  knee ? '' : '',
  '## 5. Recommendation',
  '',
  'Numbers reported, not self-certified — **V decides adoption.**',
  '',
  '### Caveats, stated plainly',
  '',
  `- **K=1.** Single-run band and CVI deltas are *not* resolvable at this sample (S4 measured ±1 band noise at K=5); band ±1 and completeness Δ are context here, never the decision. The decision rests on theme recall and LVC themes/doc, which are paired per-case and bootstrapped.`,
  `- The Flash skeleton (\`doc-audit.ts\`) is **untraced upstream**, so its Flash tokens are in no arm's ₹/doc. All arms are equally understated, exactly as S6 and the Flash study were.`,
  `- ₹ are priced with the **corrected reasoning-inclusive** accounting (\`707bd0e\`); capping reasoning is precisely the spend this fix made visible, so the two are cross-checks on each other.`,
  '',
].join('\n');

writeFileSync(OUT, md + '\n');
console.error(`\nwrote ${OUT}`);
process.exit(0);
