#!/usr/bin/env node
// Platform B2 — ClinicalState extraction-quality harness (OFFLINE, measurement-only).
// Runs the extractor LIBS directly (no HTTP, no /api/ddx) over the 60 ratified bank stems,
// deterministic vs LLM path head-to-head, applies the H2 guards + H3 LLM-judge, and emits
// the H5 scorecard + raw per-case outputs. H4 calibration runs iff the gold seed is present.
//
//   node --env-file=.env.local --import tsx scripts/clinical-state-extraction-eval.mjs
// Env knobs:
//   ONLY=D01,D42                 run a subset (smoke)
//   EXTRACTION_CONCURRENCY=4     parallel cases (each = 1 llm extract + up to 2 judge calls)
//   NO_JUDGE=1                   guards + extraction only (skip the LLM-judge — the trusted tier)
//   NO_LLM=1                     deterministic path only (no model calls at all)
//
// MEASUREMENT ONLY: imports the extractor + llm libs to CONSUME them; never mutates engine,
// prompt, route, or retrieval. The one referee module is extraction-eval-core.ts.

import { readFile, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { buildDdxClinicalState } from '../lib/clinical-state/from-primitives.ts';
import { normalizeWithLlm, mergeLlmFindings } from '../lib/clinical-state/extract.ts';
import { chatWithFallback, geminiConfigured, GEMINI_MODEL, vertexModelName } from '../lib/llm.ts';
import {
  runGuards, buildJudgeUser, JUDGE_SYSTEM, parseJudgeResponse,
  summarizePath, headToHead, proposePromotionThreshold,
  scoreExtractorVsGold, calibrateJudge, adaptGoldSeed,
  EXTRACTION_EVAL_VERSION, EXTRACTION_BANK,
} from '../lib/clinical-state/extraction-eval-core.ts';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dir, '..');
const BANK = resolve(REPO, 'data/ddx-case-bank.json');
const GOLD_SEED = resolve(REPO, 'data/ddx-eval/ddx-extraction-gold-seed-v1.json');
const SCORECARD_OUT = resolve(REPO, 'data/ddx-eval/extraction-scorecard-v1.json');
const RAW_OUT = resolve(REPO, 'data/ddx-eval/extraction-raw-outputs-v1.json');

const DDX_MODEL = 'llama3.1:8b'; // ollama fallback model, mirrors the /api/ddx clinical_state_normalise pass
const ONLY = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const CONCURRENCY = Math.max(1, parseInt(process.env.EXTRACTION_CONCURRENCY || '4', 10) || 1);
const NO_JUDGE = process.env.NO_JUDGE === '1';
const NO_LLM = process.env.NO_LLM === '1';
const CALL_TIMEOUT_MS = 120_000;

// Gemini routing mirrors the route: LLM extract path uses Gemini when GEMINI_DDX/ALL is set
// and Vertex is configured; the judge always prefers the strong model (Gemini pro) when available.
const wantGemini = process.env.GEMINI_DDX === '1' || process.env.GEMINI_ALL === '1';
const EXTRACT_G = wantGemini && geminiConfigured() ? GEMINI_MODEL : undefined;
const JUDGE_G = geminiConfigured() ? GEMINI_MODEL : undefined;
const EXTRACT_MODEL_LABEL = EXTRACT_G ? vertexModelName(EXTRACT_G) : DDX_MODEL;
const JUDGE_MODEL_LABEL = JUDGE_G ? vertexModelName(JUDGE_G) : DDX_MODEL;

const withTimeout = (p, ms, tag) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${tag} timeout ${ms}ms`)), ms)),
]);

/** One retry on a transient model error (timeout / 5xx / stream hiccup). */
async function retry(fn, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) { last = e; if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1500 * (i + 1) ** 2)); } // backoff: 1.5s, 6s
  }
  throw last;
}

async function chat(system, user, geminiModel, { temperature, maxTokens }) {
  const params = {
    model: DDX_MODEL,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature, max_tokens: maxTokens,
    options: { num_ctx: 8192 }, keep_alive: '15m',
  };
  const res = await retry(() => withTimeout(chatWithFallback(params, geminiModel), CALL_TIMEOUT_MS, 'chat'));
  return res.choices?.[0]?.message?.content ?? '';
}

/** LLM extraction (stage-2), mirroring the /api/ddx clinical_state_normalise wiring. */
async function llmExtract(input) {
  return normalizeWithLlm(input, (system, user) => chat(system, user, EXTRACT_G, { temperature: 0.1, maxTokens: 900 }));
}

/** H3 — grade one extracted state against the source presentation. */
async function judge(fields, state) {
  const raw = await chat(JUDGE_SYSTEM, buildJudgeUser(fields, state), JUDGE_G, { temperature: 0, maxTokens: 1500 });
  return parseJudgeResponse(raw);
}

async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await worker(items[i], i); }
  }));
  return out;
}

const pct = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const sgn = (x) => (x == null ? 'n/a' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}pp`);

async function fileExists(p) { try { await access(p); return true; } catch { return false; } }

const main = async () => {
  const raw = JSON.parse(await readFile(BANK, 'utf8'));
  let cases = Array.isArray(raw) ? raw : raw.cases;
  if (ONLY.length) cases = cases.filter((c) => ONLY.includes(c.id));
  if (!cases.length) { console.error('No cases to run.'); process.exit(1); }

  console.log(`B2 extraction-quality — ${cases.length} stems, bank ${EXTRACTION_BANK}, concurrency ${CONCURRENCY}`);
  console.log(`  extract LLM path: ${NO_LLM ? 'SKIPPED (NO_LLM)' : EXTRACT_MODEL_LABEL}`);
  console.log(`  judge:            ${NO_JUDGE ? 'SKIPPED (NO_JUDGE)' : JUDGE_MODEL_LABEL}\n`);

  // Re-score modes (H1 "persist raw outputs for offline re-score"):
  //   RESCORE=1  → recompute guards + aggregate from persisted raw outputs, NO model calls.
  //   MERGE=1    → run ONLY=<ids>, splice those fresh rows into the persisted set, re-aggregate.
  const RESCORE = process.env.RESCORE === '1';
  const MERGE = process.env.MERGE === '1';
  const allCases = Array.isArray(raw) ? raw : raw.cases;
  const fieldsById = new Map(allCases.map((c) => [c.id, { complaint: c.presentation.complaint, history: c.presentation.history, exam: c.presentation.exam, vitals: c.presentation.vitals }]));
  const bankOrder = allCases.map((c) => c.id);

  let rows;
  if (RESCORE) {
    const prev = JSON.parse(await readFile(RAW_OUT, 'utf8'));
    rows = prev.rows.map((r) => {
      const f = fieldsById.get(r.id) || {};
      const det = { ...r.det, guard: runGuards(r.id, 'deterministic', f, r.det.state, 0) };
      const llm = r.llm && r.llm.state ? { ...r.llm, guard: runGuards(r.id, 'llm', f, r.llm.state, r.llm.rejectedSpans || 0) } : r.llm;
      return { ...r, det, llm };
    });
    console.log(`RESCORE: recomputed guards for ${rows.length} persisted rows (no model calls).\n`);
  } else {
  const computedRows = await pool(cases, CONCURRENCY, async (c) => {
    const p = c.presentation;
    const body = { age: p.age, sex: p.sex, cc: p.complaint, history: p.history, exam: p.exam, vitals: p.vitals };
    const fields = { complaint: p.complaint, history: p.history, exam: p.exam, vitals: p.vitals };
    const input = { surface: 'ddx', age: p.age, sex: p.sex, fields };

    // Deterministic path (instant, always).
    const detState = buildDdxClinicalState(body, null);
    const detGuard = runGuards(c.id, 'deterministic', fields, detState, 0);

    // LLM path.
    let llmState = null, llmGuard = null, rejectedSpans = 0, llmErr = null;
    if (!NO_LLM) {
      try {
        const pass = await llmExtract(input);
        llmState = mergeLlmFindings(detState, pass);
        rejectedSpans = pass.rejected.length;
        llmGuard = runGuards(c.id, 'llm', fields, llmState, rejectedSpans);
      } catch (e) { llmErr = String(e.message || e); console.error(`[${c.id}] llm-extract error:`, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)); }
    }

    // Judge both paths.
    let detJudge = null, llmJudge = null, judgeErr = null;
    if (!NO_JUDGE) {
      try { detJudge = await judge(fields, detState); } catch (e) { judgeErr = `det: ${String(e.message || e)}`; }
      if (llmState) { try { llmJudge = await judge(fields, llmState); } catch (e) { judgeErr = `${judgeErr ? judgeErr + '; ' : ''}llm: ${String(e.message || e)}`; } }
    }

    const flag = [
      detGuard.fabricated.length ? `det-fab:${detGuard.fabricated.length}` : '',
      llmGuard?.fabricated.length ? `llm-fab:${llmGuard.fabricated.length}` : '',
      rejectedSpans ? `rej:${rejectedSpans}` : '',
      llmErr ? 'LLM-ERR' : '', judgeErr ? 'JUDGE-ERR' : '',
    ].filter(Boolean).join(' ');
    const dR = detJudge ? detJudge.dimensions.recall.toFixed(2) : '–';
    const lR = llmJudge ? llmJudge.dimensions.recall.toFixed(2) : '–';
    console.log(`${c.id.padEnd(4)} det[a=${detGuard.nAsserted} u=${detGuard.nUnknowns} nofab=${detGuard.noFabRate.toFixed(2)} jR=${dR}]  llm[a=${llmGuard?.nAsserted ?? '–'} nofab=${llmGuard ? llmGuard.noFabRate.toFixed(2) : '–'} jR=${lR}] ${flag}`);

    return {
      id: c.id, category: c.category,
      det: { state: detState, guard: detGuard, judge: detJudge },
      llm: { state: llmState, guard: llmGuard, judge: llmJudge, rejectedSpans, error: llmErr },
      judgeError: judgeErr,
    };
  });
  if (MERGE) {
    const prev = JSON.parse(await readFile(RAW_OUT, 'utf8'));
    const byId = new Map(prev.rows.map((r) => [r.id, r]));
    for (const r of computedRows) byId.set(r.id, r);
    rows = bankOrder.map((id) => byId.get(id)).filter(Boolean);
    console.log(`\nMERGE: spliced ${computedRows.length} fresh row(s) into ${prev.rows.length} persisted → ${rows.length} total.`);
  } else {
    rows = computedRows;
  }
  }

  // ── Aggregate ──
  const detGuards = rows.map((r) => r.det.guard);
  const detJudges = rows.map((r) => r.det.judge).filter(Boolean);
  const llmGuards = rows.map((r) => r.llm.guard).filter(Boolean);
  const llmJudges = rows.map((r) => r.llm.judge).filter(Boolean);

  const detCard = summarizePath('deterministic', detGuards, NO_JUDGE ? undefined : detJudges);
  const llmCard = summarizePath('llm', llmGuards, NO_JUDGE ? undefined : llmJudges);
  const h2h = headToHead(detCard, llmCard);
  const promotion = proposePromotionThreshold(detCard, llmCard);

  // ── H4 calibration (iff the gold seed has landed) ──
  const haveGold = await fileExists(GOLD_SEED);
  const calibration = { status: 'pending-gold-seed', goldSeedPath: 'data/ddx-eval/ddx-extraction-gold-seed-v1.json' };
  if (haveGold) {
    const gold = adaptGoldSeed(JSON.parse(await readFile(GOLD_SEED, 'utf8')));
    const detStates = new Map(rows.map((r) => [r.id, r.det.state]));
    const llmStates = new Map(rows.filter((r) => r.llm.state).map((r) => [r.id, r.llm.state]));
    calibration.status = 'complete';
    calibration.extractorVsGold = [
      scoreExtractorVsGold('deterministic', detStates, gold),
      ...(llmStates.size ? [scoreExtractorVsGold('llm', llmStates, gold)] : []),
    ];
    if (!NO_JUDGE) {
      // gold-derived per-case truth for the LLM path (fallback to det when no llm state):
      const truth = new Map(), judged = new Map();
      for (const gc of gold.cases) {
        const r = rows.find((x) => x.id === gc.caseId);
        if (!r) continue;
        const usingLlm = !!(r.llm && r.llm.state);   // fall back to det when the LLM path is missing
        const slot = usingLlm ? r.llm : r.det;
        const one = scoreExtractorVsGold(usingLlm ? 'llm' : 'deterministic', new Map([[gc.caseId, slot.state]]), { version: gold.version, cases: [gc] });
        truth.set(gc.caseId, {
          recall: one.recall, statusAccuracy: one.statusAccuracy,
          noFabrication: slot.guard ? slot.guard.noFabRate : 1, provenanceAccuracy: slot.guard ? slot.guard.provenanceValidRate : 1,
        });
        if (slot.judge) judged.set(gc.caseId, slot.judge);
      }
      calibration.judgeVsGold = calibrateJudge(judged, truth);
    }
  }

  // Reconcile the judge trust flag from the calibration outcome: summarizePath sets
  // calibrated:false (the safe default); H4 flips it to true only when the judge cleared
  // the agreement floor vs the gold seed (verdict 'trustworthy').
  const judgeTrusted = calibration.status === 'complete' && calibration.judgeVsGold?.verdict === 'trustworthy';
  if (detCard.judge) detCard.judge.calibrated = judgeTrusted;
  if (llmCard.judge) llmCard.judge.calibrated = judgeTrusted;

  const scorecard = {
    version: EXTRACTION_EVAL_VERSION,
    bank: EXTRACTION_BANK,
    generated: new Date().toISOString(),
    judgeModel: NO_JUDGE ? null : JUDGE_MODEL_LABEL,
    extractModel: NO_LLM ? null : EXTRACT_MODEL_LABEL,
    n: rows.length,
    paths: { deterministic: detCard, llm: llmCard },
    headToHead: h2h,
    contradictionPreservation: 'N/A — corpus contains no contradiction cases',
    promotion,
    calibration,
    notes: [
      `GUARD metrics (noFab/provenance/status) are deterministic and trusted. JUDGE dimensions are ${judgeTrusted ? 'CALIBRATED vs the gold seed (agreement cleared the floor — trustworthy)' : 'PROVISIONAL — calibrated:false until the gold seed lands (H4)'}.`,
      `LLM extract path = ${EXTRACT_MODEL_LABEL}; judge = ${JUDGE_MODEL_LABEL}. Judge and extractor share a model family — calibration vs gold is the trust anchor.`,
      'data/ddx-eval/** is answer-bearing and kept OUT of the retrieval corpus (imported only by the scorer + admin dashboard).',
    ],
  };

  await writeFile(RAW_OUT, JSON.stringify({ meta: { version: EXTRACTION_EVAL_VERSION, bank: EXTRACTION_BANK, generated: scorecard.generated, extractModel: scorecard.extractModel, judgeModel: scorecard.judgeModel }, rows }, null, 2));
  await writeFile(SCORECARD_OUT, JSON.stringify(scorecard, null, 2));

  // ── Print ──
  const line = (label, d, l, delta) => console.log(`${label.padEnd(22)} det ${String(d).padStart(8)}   llm ${String(l).padStart(8)}   Δ ${delta}`);
  console.log(`\n── B2 extraction scorecard (${rows.length} stems, bank ${EXTRACTION_BANK}) ──`);
  console.log('GUARDS (trusted, deterministic):');
  line('  no-fabrication rate', pct(detCard.guard.noFabRate), pct(llmCard.guard.noFabRate), sgn(h2h.deltaGuardNoFabRate));
  line('  provenance-valid', pct(detCard.guard.provenanceValidRate), pct(llmCard.guard.provenanceValidRate), '');
  line('  status-valid', pct(detCard.guard.statusValidRate), pct(llmCard.guard.statusValidRate), '');
  line('  mean asserted/case', detCard.meanAsserted.toFixed(2), llmCard.meanAsserted.toFixed(2), `${h2h.deltaMeanAsserted >= 0 ? '+' : ''}${h2h.deltaMeanAsserted.toFixed(2)}`);
  console.log(`  total fabricated       det ${detCard.guard.totalFabricated}   llm ${llmCard.guard.totalFabricated}   (mean rejected spans/case: llm ${llmCard.guard.meanRejectedSpans.toFixed(2)})`);
  if (!NO_JUDGE) {
    console.log(judgeTrusted ? 'JUDGE (calibrated vs gold — trustworthy):' : 'JUDGE (provisional — calibrated:false until gold seed):');
    line('  recall', pct(detCard.judge?.recall), pct(llmCard.judge?.recall), sgn(h2h.deltaJudgeRecall));
    line('  status-accuracy', pct(detCard.judge?.statusAccuracy), pct(llmCard.judge?.statusAccuracy), sgn(h2h.deltaJudgeStatusAccuracy));
    line('  no-fabrication', pct(detCard.judge?.noFabrication), pct(llmCard.judge?.noFabrication), sgn(h2h.deltaJudgeNoFabrication));
    line('  provenance-accuracy', pct(detCard.judge?.provenanceAccuracy), pct(llmCard.judge?.provenanceAccuracy), sgn(h2h.deltaJudgeProvenance));
  }
  console.log(`contradiction-preservation: ${scorecard.contradictionPreservation}`);
  console.log(`promotion (NOT armed): floor=${promotion.proposedFloor ?? 'n/a'} on ${promotion.gateMetric} — ${promotion.rationale}`);
  console.log(`calibration: ${calibration.status}${calibration.judgeVsGold ? ` (judge agreement ${pct(calibration.judgeVsGold.agreement)}, ${calibration.judgeVsGold.verdict})` : ''}`);
  console.log(`\nWrote ${SCORECARD_OUT}\nWrote ${RAW_OUT}`);
};

main().catch((e) => { console.error(e); process.exit(1); });
