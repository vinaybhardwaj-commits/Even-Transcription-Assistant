// scripts/right-care-ground-ab.mjs — Right Care × ClinicalState Slice 2: the golden A/B.
// For every case in the FROZEN right-care-eval/1.0 bank, runs each mode UNGROUNDED (OFF —
// exactly prod) vs GROUNDED (ON — PATIENT PICTURE injected via the Part-A optional params;
// no env flag is flipped: the runner passes clinicalStateText explicitly, which is precisely
// what the flag gates in the routes). An LLM pair-judge classifies every change; OFF-vs-OFF
// repeat pairs on a subset give the noise floor. Writes the scorecard JSON + prints the
// per-mode delta report for V's ratification.
//
// Run (pairwise, legacy): node --env-file=.env.local --import tsx scripts/right-care-ground-ab.mjs [outfile]
// Run (GOLD, Order check): … right-care-ground-ab.mjs --gold baseline|ab [--repeats K] [--out path]
//   --gold baseline → ungrounded only, 36×K runs → Order check's precision/recall/F1 vs the
//     ratified right-care-check-gold/1.0 (deterministic scoring, NO judge).
//   --gold ab       → both arms (grounded = the PATIENT PICTURE passed explicitly — exactly
//     what RIGHT_CARE_CLINICAL_STATE_GROUND gates in the route), 36×K×2 runs; the K-repeat
//     variance of each arm is the noise floor a grounding delta must clear.
//   --gold 2.0      → the DISCRIMINATING real-case gold (right-care-check-gold/2.0,
//     15-Jul-2026 kickoff): P/N/C scored floor runs BOTH arms ×K (D3 headline = the
//     grounded-vs-ungrounded delta vs the K-repeat noise floor); L annex runs NOTE-ONLY ×K
//     (D4 — no member-history injection exists; its mustFire recs are EXPECTED to miss; the
//     annex reports the sanity check + the missed-repeat headroom count, never folded into
//     the floor). Unbound positives score as guaranteed recall misses tagged catalog_gap.
//     Writes data/right-care-eval/check-gold-2.0-scorecard.json.
// Cost: pairwise ~49 arms + ~31 judge calls; gold ab at K=5 = 360 pipeline runs; gold 2.0 at
// K=5 = 19×5×2 + 4×5 = 210 pipeline runs. Manual, credentialed — never in CI.

import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { matchLowValueCare } from '../lib/lvc.ts';
import { traceSkeleton, enrichPathway } from '../lib/pathway.ts';
import { analyzeCase } from '../lib/doc-audit.ts';
import { buildRightCareState, rightCareExtractInput, patientPictureBlock } from '../lib/right-care-state.ts';
import { extractedCaseToState } from '../lib/clinical-state/to-audit-family.ts';
import { chatWithFallback, geminiModelFor, geminiUtilityModel, TEXT_MODEL } from '../lib/llm.ts';
import {
  GROUND_BANK, RIGHT_CARE_EVAL_BANK, RIGHT_CARE_GROUND_EVAL_VERSION,
  checkView, pathwayView, auditView, diffCheckFlags,
  PAIR_JUDGE_SYSTEM, buildPairJudgeUser, parsePairJudgeResponse, summarizeMode,
  RIGHT_CARE_CHECK_GOLD_VERSION, loadCheckGold, scoreCheckAgainstGold, aggregateCheckGold,
  RIGHT_CARE_CHECK_GOLD_2_VERSION, loadCheckGold2, splitCheckGold2, checkGold2CatalogGaps,
} from '../lib/right-care-ground-eval-core.ts';

const argv = process.argv.slice(2);
const argOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const GOLD_MODE = argOf('--gold');                       // 'baseline' | 'ab' | undefined (legacy pairwise)
const REPEATS = Math.max(1, Number(argOf('--repeats') ?? 5) | 0);
const OUT = argOf('--out') || (GOLD_MODE === '2.0'
  ? 'data/right-care-eval/check-gold-2.0-scorecard.json'
  : GOLD_MODE
    ? 'data/right-care-eval/check-gold-scorecard-v1.json'
    : (argv.find((a) => !a.startsWith('--')) || 'data/right-care-eval/ground-ab-scorecard-v1.json'));
// OFF-vs-OFF noise subset (13 repeat arms) — includes both safety sentinels.
const NOISE_IDS = new Set(['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'P01', 'P03', 'P06', 'A01', 'A03']);

async function judgeChat(system, user) {
  const gemini = geminiModelFor('appropriateness') ?? geminiUtilityModel();
  const r = await chatWithFallback({
    model: TEXT_MODEL,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0.1,
    max_tokens: 1200,
    ...( { options: { num_ctx: 8192 }, keep_alive: '15m' } ),
  }, gemini);
  return r.choices?.[0]?.message?.content ?? '';
}

async function judgePair(c, offV, onV, label) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await judgeChat(PAIR_JUDGE_SYSTEM, buildPairJudgeUser(c, offV, onV));
      return parsePairJudgeResponse(raw);
    } catch (e) {
      if (attempt === 2) {
        console.warn(`[judge] ${label} unparseable twice: ${e.message}`);
        return { overall: 'neutral', changes: [], safety: [], note: 'judge-unparseable (excluded-as-neutral)' };
      }
    }
  }
}

function pictureFor(c) {
  if (c.mode === 'audit') return patientPictureBlock(extractedCaseToState(c.extracted));
  return null; // check/pathway build async below
}

async function runCheck(c, grounded) {
  const input = {
    scenario: c.scenario, proposedActions: c.proposedActions, patient: c.patient,
    surface: 'surface', trace: false,
  };
  if (grounded) {
    const built = await buildRightCareState(rightCareExtractInput('check', {
      scenario: c.scenario, proposedActions: c.proposedActions, age: c.patient?.age, sex: c.patient?.sex,
    }));
    if (built) input.clinicalStateText = patientPictureBlock(built.state);
  }
  const r = await matchLowValueCare(input);
  return checkView(r);
}

async function runPathway(c, grounded) {
  let clinicalStateText;
  if (grounded) {
    const built = await buildRightCareState(rightCareExtractInput('pathway', {
      scenario: c.scenario, age: c.patient?.age, sex: c.patient?.sex,
    }));
    if (built) clinicalStateText = patientPictureBlock(built.state);
  }
  const base = { scenario: c.scenario, patient: c.patient, trace: false, ...(clinicalStateText ? { clinicalStateText } : {}) };
  const { skeleton } = await traceSkeleton(base);
  if (!skeleton) return pathwayView(null, null);
  const { enrichment } = await enrichPathway({ ...base, stages: skeleton.stages, workingDiagnosis: skeleton.workingDiagnosis });
  return pathwayView(skeleton, enrichment);
}

async function runAudit(c, grounded) {
  const opts = { trace: false, ...(grounded ? { clinicalStateText: pictureFor(c) } : {}) };
  const { report } = await analyzeCase(c.extracted, {}, opts);
  return auditView(report);
}

const RUNNERS = { check: runCheck, pathway: runPathway, audit: runAudit };

// Small concurrency pool — kind to Vertex + the local mini.
async function pool(items, width, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
}

// ── GOLD MODE (Order check, deterministic score-against-gold; no judge) ─────────────────────
if (GOLD_MODE) {
  if (!['baseline', 'ab', '2.0'].includes(GOLD_MODE)) { console.error(`--gold must be baseline|ab|2.0, got ${GOLD_MODE}`); process.exit(2); }
  const IS_2 = GOLD_MODE === '2.0';
  const GOLD_VERSION = IS_2 ? RIGHT_CARE_CHECK_GOLD_2_VERSION : RIGHT_CARE_CHECK_GOLD_VERSION;
  const gold = IS_2
    ? loadCheckGold2(JSON.parse(readFileSync('data/right-care-eval/check-gold-2.0.json', 'utf8')))
    : loadCheckGold(JSON.parse(readFileSync('data/right-care-eval/check-gold-1.0.json', 'utf8')));
  // 2.0: P/N/C = the scored floor; L = the note-only annex, scored separately (D4).
  const { floor: floorCases, annex: annexCases } = IS_2 ? splitCheckGold2(gold.cases) : { floor: gold.cases, annex: [] };
  const catalogGaps = IS_2 ? checkGold2CatalogGaps(gold.cases) : [];
  const gapIds = new Set(catalogGaps.map((g) => g.id));
  const gapPositives = new Set(catalogGaps.filter((g) => g.polarity === 'positive').map((g) => g.id));
  // D3: the 2.0 floor always runs BOTH arms — the headline IS the grounded-vs-ungrounded delta.
  const arms = (GOLD_MODE === 'ab' || IS_2) ? ['off', 'on'] : ['off'];
  console.log(`right-care check gold · ${GOLD_VERSION} · floor ${floorCases.length}${annexCases.length ? ` + annex ${annexCases.length}` : ''} cases · K=${REPEATS} · arms=[${arms.join(',')}] · ${floorCases.length * REPEATS * arms.length + annexCases.length * REPEATS} pipeline runs`);
  if (catalogGaps.length) console.log(`catalog gaps (unbound targets): ${catalogGaps.map((g) => `${g.id}(${g.polarity})`).join(', ')}`);

  const jobs = [];
  for (const c of floorCases) for (const arm of arms) for (let k = 1; k <= REPEATS; k++) jobs.push({ c, arm, k });
  // D4: the L annex runs NOTE-ONLY — Order-check has no member-history injection today, so its
  // grounded arm would be a lie; the annex measures what note-only CANNOT see.
  for (const c of annexCases) for (let k = 1; k <= REPEATS; k++) jobs.push({ c, arm: 'note_only', k });
  const tg = Date.now();
  const runs = await pool(jobs, 4, async ({ c, arm, k }) => {
    try {
      const view = await runCheck(c, arm === 'on');
      const fired = view.flags.map((f) => f.id);
      const score = scoreCheckAgainstGold(fired, c.gold);
      return { id: c.id, arm, k, fired, score };
    } catch (e) {
      console.warn(`  ${c.id} ${arm} k${k} FAILED: ${e.message}`);
      return { id: c.id, arm, k, error: String(e.message) };
    }
  });
  console.log(`runs done in ${((Date.now() - tg) / 60000).toFixed(1)} min · failures: ${runs.filter((r) => r.error).length}`);

  const byCase = Object.fromEntries(gold.cases.map((c) => [c.id, c]));
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const std = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) * (x - m)))); };

  // Per-arm metrics: one CheckGoldMetrics per repeat, then mean ± std across the K repeats —
  // the std IS the properly-measured noise floor.
  const armStats = {};
  for (const arm of arms) {
    const perRepeat = [];
    for (let k = 1; k <= REPEATS; k++) {
      const rows = runs.filter((r) => r.arm === arm && r.k === k && !r.error)
        .map((r) => ({
          // §6 (2.0): an UNBOUND positive is a guaranteed recall miss attributed to catalog
          // coverage — fed to the UNCHANGED aggregator as a synthetic always-missed target.
          score: gapPositives.has(r.id) ? { recallHits: [], recallMisses: [`unbound:${r.id}`], falsePositives: [] } : r.score,
          mustNotFireTargets: byCase[r.id].gold.mustNotFire.length,
        }));
      perRepeat.push(aggregateCheckGold(rows));
    }
    const stat = (f) => { const xs = perRepeat.map((m) => f(m) ?? 0); return { mean: mean(xs), std: std(xs), perRepeat: xs }; };
    armStats[arm] = {
      recall: stat((m) => m.recall),
      specificity: stat((m) => m.specificity),
      precision: stat((m) => m.precision),
      f1: stat((m) => m.f1),
      perRepeat,
    };
  }

  // Per-case table: how often the TARGET decision was right/wrong across the K repeats.
  const caseTable = floorCases.map((c) => {
    const row = {
      id: c.id, polarity: c.polarity, target: c.sourceRec ?? c.sourceRecHint ?? null, domain: c.domain ?? null,
      ...(IS_2 ? { family: c.family, catalog_gap: gapIds.has(c.id) } : {}),
    };
    for (const arm of arms) {
      const rs = runs.filter((r) => r.arm === arm && r.id === c.id && !r.error);
      const targetFired = rs.filter((r) => (c.polarity === 'positive' ? r.score.recallHits.length > 0 : r.score.falsePositives.length > 0)).length;
      // positive: targetFired = hits (want K/K) · near_miss: targetFired = violations (want 0/K)
      row[arm] = { n: rs.length, targetFired };
    }
    return row;
  });
  const offMisses = caseTable.filter((r) => r.polarity === 'positive' && r.off.targetFired === 0);
  const offFlaky = caseTable.filter((r) => r.polarity === 'positive' && r.off.targetFired > 0 && r.off.targetFired < r.off.n);
  const offFps = caseTable.filter((r) => r.polarity === 'near_miss' && r.off.targetFired > 0);

  // 2.0 L-annex mini-scorecard (D4) — note-only, NEVER folded into the floor metrics.
  // (a) sanity: an L positive's member-history rec must NOT fire from the note alone;
  // (b) headroom: missed low-value repeats = bound-and-never-fired + unbound-by-construction.
  let annexReport = null;
  if (IS_2 && annexCases.length) {
    const annexTable = annexCases.map((c) => {
      const rs = runs.filter((r) => r.arm === 'note_only' && r.id === c.id && !r.error);
      const bound = c.polarity === 'positive' ? c.gold.mustFire.length > 0 : c.gold.mustNotFire.length > 0;
      const targetFired = rs.filter((r) => (c.polarity === 'positive' ? r.score.recallHits.length > 0 : r.score.falsePositives.length > 0)).length;
      return { id: c.id, polarity: c.polarity, bound, catalog_gap: !bound, n: rs.length, targetFired, fired: rs.map((r) => r.fired) };
    });
    const sanityViolations = annexTable.filter((r) => r.polarity === 'positive' && r.bound && r.targetFired > 0)
      .map((r) => ({ id: r.id, fired: `${r.targetFired}/${r.n}` }));
    const missedRepeats = annexTable.filter((r) => r.polarity === 'positive' && (r.catalog_gap || r.targetFired === 0));
    annexReport = {
      n: annexTable.length,
      table: annexTable,
      missedRepeatCount: missedRepeats.length,
      missedRepeatIds: missedRepeats.map((r) => r.id),
      sanityViolations,
      nearMissClean: annexTable.filter((r) => r.polarity === 'near_miss' && r.targetFired === 0).map((r) => r.id),
    };
  }

  const artifact = {
    version: IS_2 ? 'right-care-check-gold-scorecard/2' : 'right-care-check-gold-scorecard/1',
    gold: GOLD_VERSION,
    mode: GOLD_MODE,
    repeats: REPEATS,
    generated: new Date().toISOString(),
    armStats,
    caseTable,
    missList: offMisses.map((r) => r.id),
    flakyList: offFlaky.map((r) => ({ id: r.id, fired: `${r.off.targetFired}/${r.off.n}` })),
    falsePositiveList: offFps.map((r) => ({ id: r.id, violations: `${r.off.targetFired}/${r.off.n}` })),
    ...(IS_2 ? { catalogGaps, annex: annexReport } : {}),
    runs: runs.map((r) => ({ id: r.id, arm: r.arm, k: r.k, ...(r.error ? { error: r.error } : { fired: r.fired }) })),
  };
  mkdirSync(OUT.split('/').slice(0, -1).join('/'), { recursive: true });
  writeFileSync(OUT, JSON.stringify(artifact, null, 2));

  const fmt = (s) => `${(s.mean * 100).toFixed(1)}% ±${(s.std * 100).toFixed(1)}`;
  console.log(`\n== ORDER CHECK vs GOLD (${GOLD_VERSION}, K=${REPEATS}${IS_2 ? ', P/N/C floor' : ''}) ==`);
  for (const arm of arms) {
    const s = armStats[arm];
    console.log(`${arm === 'off' ? 'ungrounded' : 'grounded  '}: recall ${fmt(s.recall)} · specificity ${fmt(s.specificity)} · precision ${fmt(s.precision)} · F1 ${fmt(s.f1)}`);
  }
  if (arms.length === 2) {
    for (const m of ['recall', 'specificity', 'precision', 'f1']) {
      const d = armStats.on[m].mean - armStats.off[m].mean;
      const floor = Math.max(armStats.off[m].std, armStats.on[m].std);
      console.log(`Δ ${m}: ${(d * 100).toFixed(1)}pp (floor ±${(floor * 100).toFixed(1)}pp) → ${Math.abs(d) > floor ? 'CLEARS' : 'within noise'}`);
    }
  }
  console.log(`\nMISSES (positive, never fired, ungrounded): ${offMisses.map((r) => r.id).join(', ') || 'none'}`);
  console.log(`FLAKY (positive, fired some repeats): ${offFlaky.map((r) => `${r.id}(${r.off.targetFired}/${r.off.n})`).join(', ') || 'none'}`);
  console.log(`FALSE-POSITIVES (near-miss over-fired): ${offFps.map((r) => `${r.id}(${r.off.targetFired}/${r.off.n})`).join(', ') || 'none'}`);
  if (annexReport) {
    console.log(`\n== L ANNEX (note-only, K=${REPEATS}) — separate from the floor ==`);
    for (const r of annexReport.table) {
      console.log(`  ${r.id} ${r.polarity}${r.catalog_gap ? ' [catalog gap]' : ''}: target fired ${r.targetFired}/${r.n}${r.polarity === 'positive' ? ' (expected 0 — invisible note-only)' : ' (expected 0 — appropriate)'}`);
    }
    console.log(`missed low-value repeats (headroom count): ${annexReport.missedRepeatCount} — ${annexReport.missedRepeatIds.join(', ') || 'none'}`);
    console.log(`sanity violations (note-alone fired a member-history rec): ${annexReport.sanityViolations.map((s) => `${s.id}(${s.fired})`).join(', ') || 'none'}`);
  }
  console.log(`\nwrote ${OUT}`);
  process.exit(0);
}

const t0 = Date.now();
console.log(`right-care ground A/B · bank ${RIGHT_CARE_EVAL_BANK} · ${GROUND_BANK.length} cases`);

// Phase 1 — all arms (OFF, ON, and OFF2 for the noise subset), 3-wide.
const arms = [];
for (const c of GROUND_BANK) {
  arms.push({ c, arm: 'off' }, { c, arm: 'on' });
  if (NOISE_IDS.has(c.id)) arms.push({ c, arm: 'off2' });
}
const armResults = await pool(arms, 3, async ({ c, arm }) => {
  const t = Date.now();
  try {
    const view = await RUNNERS[c.mode](c, arm === 'on');
    console.log(`  ${c.id} ${arm.padEnd(4)} done ${((Date.now() - t) / 1000).toFixed(0)}s`);
    return { id: c.id, arm, view };
  } catch (e) {
    console.warn(`  ${c.id} ${arm} FAILED: ${e.message}`);
    return { id: c.id, arm, error: String(e.message) };
  }
});
const byIdArm = new Map(armResults.map((r) => [`${r.id}:${r.arm}`, r]));

// Phase 2 — judge ON-vs-OFF pairs + OFF2-vs-OFF noise pairs, 4-wide.
const judgeJobs = [];
for (const c of GROUND_BANK) {
  const off = byIdArm.get(`${c.id}:off`);
  const on = byIdArm.get(`${c.id}:on`);
  if (off?.view && on?.view) judgeJobs.push({ c, kind: 'ab', a: off.view, b: on.view });
  const off2 = byIdArm.get(`${c.id}:off2`);
  if (off?.view && off2?.view) judgeJobs.push({ c, kind: 'noise', a: off.view, b: off2.view });
}
const judged = await pool(judgeJobs, 4, async ({ c, kind, a, b }) => {
  const verdict = await judgePair(c, a, b, `${c.id}:${kind}`);
  console.log(`  judge ${c.id} ${kind}: ${verdict.overall}${verdict.safety.length ? ` · SAFETY ${verdict.safety.map((s) => s.class).join(',')}` : ''}`);
  return { caseId: c.id, mode: c.mode, kind, verdict };
});

// Phase 3 — scorecards + artifact.
const scorecards = {};
for (const mode of ['check', 'pathway', 'audit']) {
  const pairs = judged.filter((j) => j.mode === mode && j.kind === 'ab').map(({ caseId, verdict }) => ({ caseId, verdict }));
  const noise = judged.filter((j) => j.mode === mode && j.kind === 'noise').map(({ caseId, verdict }) => ({ caseId, verdict }));
  scorecards[mode] = summarizeMode(mode, pairs, noise.length ? noise : null);
}
const checkDiffs = GROUND_BANK.filter((c) => c.mode === 'check').map((c) => {
  const off = byIdArm.get(`${c.id}:off`)?.view;
  const on = byIdArm.get(`${c.id}:on`)?.view;
  return off && on ? { caseId: c.id, ...diffCheckFlags(off, on), offN: off.flags.length, onN: on.flags.length } : { caseId: c.id, error: 'arm missing' };
});

const artifact = {
  version: RIGHT_CARE_GROUND_EVAL_VERSION,
  bank: RIGHT_CARE_EVAL_BANK,
  generated: new Date().toISOString(),
  judgeModel: geminiModelFor('appropriateness') ?? geminiUtilityModel() ?? TEXT_MODEL,
  scorecards,
  checkFlagDiffs: checkDiffs,
  pairs: judged,
  arms: armResults.map((r) => ({ id: r.id, arm: r.arm, ...(r.error ? { error: r.error } : { view: r.view }) })),
  bankNotes: Object.fromEntries(GROUND_BANK.map((c) => [c.id, c.note])),
};
mkdirSync(OUT.split('/').slice(0, -1).join('/'), { recursive: true });
writeFileSync(OUT, JSON.stringify(artifact, null, 2));

console.log(`\n== DELTA REPORT (bank ${RIGHT_CARE_EVAL_BANK}) ==`);
for (const [mode, sc] of Object.entries(scorecards)) {
  console.log(`${mode}: n=${sc.n} · +${sc.improvements} improvement / ${sc.neutrals} neutral / -${sc.regressions} regression · changedRate ${(sc.changedRate * 100).toFixed(0)}% (noise ${sc.noise ? (sc.noise.changedRate * 100).toFixed(0) + '%' : 'n/a'}) · safety ${sc.safetyViolations.length} · GATE ${sc.gate}`);
  for (const v of sc.safetyViolations) console.log(`   SAFETY ${v.class}: ${v.item} — ${v.note ?? ''}`);
}
console.log(`\nwrote ${OUT} · total ${((Date.now() - t0) / 60000).toFixed(1)} min`);
