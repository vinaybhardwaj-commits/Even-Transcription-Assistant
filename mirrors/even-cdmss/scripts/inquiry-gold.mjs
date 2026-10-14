#!/usr/bin/env node
// scripts/inquiry-gold.mjs — the inquiry bench runner (Inquiry PRD §12, D13; pattern:
// right-care-ground-ab.mjs --gold). Runs the inquiry-gold bank K times per arm:
//   --baseline → the deterministic buildAskSet (ask-set/0.1) scored on the gold — the floor
//   --inquiry  → the full selection (deriveUnknowns → candidates → Gemini select → assemble)
// and prints/writes the frozen-evaluator metrics (right-first-question · family-legality
// (must be 100%) · generic rate · fallback rate). Manual, credentialed — never in CI.
//
// Run: node --env-file=.env.local --import tsx scripts/inquiry-gold.mjs --baseline [--repeats K]
//      node --env-file=.env.local --import tsx scripts/inquiry-gold.mjs --inquiry  [--repeats K] [--out path]
// Both arms may be passed together; the scorecard then carries both aggregates side by side.
//
// The model call here uses chatWithFallback directly — scripts/ are offline harnesses outside
// the governed-layer scan (same standing as right-care-ground-ab.mjs); the PRODUCTION path in
// app/api/care-call/askset/route.ts routes through governedChat with the registered promptRef.

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { buildAskSet } from '../lib/care-call-core.ts';
import { deriveUnknowns } from '../lib/inquiry/unknowns-core.ts';
import { runInquirySelection, INQUIRY_SELECT_SYSTEM, INQUIRY_VERSION } from '../lib/inquiry/inquiry-core.ts';
import { parseGold, scoreCase, aggregateScores, INQUIRY_GOLD_VERSION, INQUIRY_EVAL_VERSION } from '../lib/inquiry/inquiry-eval-core.ts';
import { chatWithFallback, GEMINI_MODEL, TEXT_MODEL } from '../lib/llm.ts';

void INQUIRY_SELECT_SYSTEM; // the prompt rides inside runInquirySelection's deps.generate

const argv = process.argv.slice(2);
const argOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const RUN_BASELINE = argv.includes('--baseline');
const RUN_INQUIRY = argv.includes('--inquiry');
const REPEATS = Math.max(1, Number(argOf('--repeats') ?? 3) | 0);
const OUT = argOf('--out') || 'data/inquiry-eval/inquiry-gold-scorecard-v1.json';
const GOLD_PATH = argOf('--gold-file') || 'data/inquiry-eval/inquiry-gold-1.0.json';

if (!RUN_BASELINE && !RUN_INQUIRY) {
  console.error('pass --baseline and/or --inquiry (plus optional --repeats K, --out path)');
  process.exit(2);
}

const bank = parseGold(JSON.parse(readFileSync(GOLD_PATH, 'utf8')));
const placeholders = bank.cases.filter((c) => c.placeholder).length;
if (placeholders) {
  console.warn(`⚠️  ${placeholders}/${bank.cases.length} cases are PLACEHOLDER fixtures — this run is a harness check, NOT floor-setting material (D13: the floor is set only on the V-ratified gold).`);
}

async function generate(system, user) {
  const r = await chatWithFallback({
    model: TEXT_MODEL,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0.2,
    max_tokens: 900,
  }, GEMINI_MODEL);
  return r?.choices?.[0]?.message?.content ?? '';
}

async function runArm(arm) {
  const scores = [];
  for (let k = 0; k < REPEATS; k++) {
    for (const c of bank.cases) {
      const episode = c.fixture.episode;
      const keys = c.fixture.keys;
      let served;
      if (arm === 'baseline') {
        const base = buildAskSet(episode, keys);
        served = { asks: base.asks, source: 'baseline' };
      } else {
        const unknowns = deriveUnknowns({ episode, snapshot: c.fixture.snapshot ?? null, now: c.fixture.now });
        const r = await runInquirySelection(episode, keys, unknowns, { generate, timeoutMs: 30_000 });
        served = { asks: r.asks, source: r.source };
      }
      const s = scoreCase(c, served);
      scores.push(s);
      console.log(`  [${arm} k=${k + 1}] ${c.id} first=${s.rightFirst ? 'RIGHT' : 'wrong'} legal=${s.familyLegal} slotOK=${s.slotAppropriate} generic=${s.genericCount}/${s.askCount}${s.fallback ? ' FALLBACK' : ''}`);
    }
  }
  return { scores, aggregate: aggregateScores(scores) };
}

const scorecard = {
  bank: INQUIRY_GOLD_VERSION,
  evaluator: INQUIRY_EVAL_VERSION,
  inquiry: INQUIRY_VERSION,
  repeats: REPEATS,
  cases: bank.cases.length,
  placeholder_cases: placeholders,
  arms: {},
};

if (RUN_BASELINE) {
  console.log(`\n── baseline arm (buildAskSet, ask-set/0.1) · ${bank.cases.length} cases × ${REPEATS} ──`);
  const r = await runArm('baseline');
  scorecard.arms.baseline = r.aggregate;
}
if (RUN_INQUIRY) {
  console.log(`\n── inquiry arm (deriveUnknowns → select → assemble) · ${bank.cases.length} cases × ${REPEATS} ──`);
  const r = await runArm('inquiry');
  scorecard.arms.inquiry = r.aggregate;
}

console.log('\n── aggregates ──');
for (const [arm, a] of Object.entries(scorecard.arms)) {
  console.log(`${arm}: right-first ${(a.rightFirstRate * 100).toFixed(1)}% · family-legality ${(a.familyLegalityRate * 100).toFixed(1)}% · slot-appropriate ${(a.slotAppropriateRate * 100).toFixed(1)}% · generic ${(a.genericRate * 100).toFixed(1)}% · fallback ${(a.fallbackRate * 100).toFixed(1)}% (${a.runs} runs)`);
  if (a.familyLegalityRate < 1) console.error(`  ⚠️ ${arm}: family-legality below 100% — gate FAIL (vocabulary safety property, A1 ruling)`);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(scorecard, null, 2) + '\n');
console.log(`\nwrote ${OUT}`);
