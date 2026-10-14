/**
 *   node --test --import tsx lib/__tests__/preop-rails-wiring.test.ts
 *
 * The rail wiring that cannot be exercised offline (the sweep reads db13 and Neon), pinned
 * where it is written. Every assertion here is about a property that would be expensive to
 * discover on production: a rail that writes when it was only asked to measure, a budget
 * checked after the overrun rather than before the call, a rail artefact that reaches the
 * fingerprint, or — new in B8 — a mode that turns itself on by accident.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { comorbidityNames } from '../preop/db13.ts';
import {
  PREOP_EXTRACT_MAX_PER_TICK, PREOP_LLM_BUDGET_MS, preopRailsFromEnv,
} from '../preop/run.ts';
import { PREOP_SUGGEST_BUDGET_MS, PREOP_SUGGEST_READS } from '../preop/suggest.ts';
import { parseExtractMode, PROMOTED_CLASSES, scoreModeReachable } from '../preop-suggest-core.ts';
import { PREOP_NARRATIVE_BUDGET_MS, PREOP_NARRATIVE_MAX_PER_TICK } from '../preop-narrative-core.ts';

const src = (p: string) => readFileSync(p, 'utf8');

// ── the mode ships OFF, and cannot be switched on by a typo ─────────────────────

test('both rails read OFF from an environment that has never set them', () => {
  delete process.env.PREOP_EXTRACT_MODE;
  delete process.env.PREOP_NARRATIVE_ENABLED;
  assert.deepEqual(preopRailsFromEnv(), { extract: 'off', narrative: false });
});

test('anything unrecognised is OFF — including the boolean B8 replaced', () => {
  // The B5 flag was PREOP_EXTRACT_ENABLED=1. Somebody setting PREOP_EXTRACT_MODE=1 out of
  // muscle memory must NOT get a live model rail on a clinical surface.
  for (const v of ['1', 'true', 'on', 'yes', 'SUGGESTED', '', '  ', 'score ']) {
    assert.equal(parseExtractMode(v), v.trim().toLowerCase() === 'score' ? 'score' : 'off', `"${v}" must not switch the rail on`);
  }
  assert.equal(parseExtractMode(undefined), 'off');
  assert.equal(parseExtractMode(null), 'off');
  assert.equal(parseExtractMode('suggest'), 'suggest');
  assert.equal(parseExtractMode('SUGGEST'), 'suggest');
});

test('the mode is read from the environment on every call, never cached at import', () => {
  process.env.PREOP_EXTRACT_MODE = 'suggest';
  assert.equal(preopRailsFromEnv().extract, 'suggest');
  delete process.env.PREOP_EXTRACT_MODE;
  assert.equal(preopRailsFromEnv().extract, 'off');
});

test('score mode is configured and unreachable — B8d has ratified no class', () => {
  assert.deepEqual([...PROMOTED_CLASSES], []);
  assert.equal(scoreModeReachable(), false);
  // and the promotion list has no UI anywhere: it is a constant changed by pull request
  for (const f of ['components/care/PreopCasePage.tsx', 'components/care/PreopBoard.tsx',
                   'app/api/care/preop/suggestion/route.ts', 'app/api/care/preop/review/route.ts']) {
    assert.ok(!src(f).includes('PROMOTED_CLASSES'), `${f} must not touch the promotion list`);
  }
});

// ── a forced rail may never write ───────────────────────────────────────────────

test('the worker’s rails override IMPLIES dry run — enforced in code, not in the doc comment', () => {
  const w = src('app/api/preop/worker/route.ts');
  assert.match(w, /const dryRun = p\.get\('dry_run'\) === '1' \|\| !!railsOverride;/,
    'the OR must be on the dryRun line itself; a separate guard could be reordered away');
  assert.equal((w.match(/runPreopSweep\(/g) ?? []).length, 1);
  assert.match(w, /runPreopSweep\(\{ horizonDays, dryRun, rails: railsOverride,/);
  assert.match(w, /const collect = p\.get\('sample'\) === '1' && !!railsOverride;/);
});

test('the sweep guards every write behind dryRun — snapshot, suggestions, narrative and heartbeat', () => {
  const r = src('lib/preop/run.ts');
  for (const call of ['saveExtraction(', 'saveNarrative(', 'saveSnapshot(', 'recordSweep(']) {
    const i = r.indexOf(call);
    assert.ok(i > 0, `${call} missing`);
    const before = r.slice(Math.max(0, i - 400), i);
    assert.ok(/!opts\.dryRun/.test(before), `${call} is not behind a dryRun guard`);
  }
});

// ── the budget is checked BEFORE the leg, not after it overruns ─────────────────

test('a leg is only begun if its own ceiling still fits inside what is left of the box', () => {
  const r = src('lib/preop/run.ts');
  assert.match(r, /const roomFor = \(legMs: number\) => spent\(\) \+ legMs <= llmBudgetMs;/);
  assert.match(r, /extractTally\.called >= PREOP_EXTRACT_MAX_PER_TICK \|\| !roomFor\(PREOP_SUGGEST_BUDGET_MS\)/);
  assert.match(r, /narrativeTally\.called >= PREOP_NARRATIVE_MAX_PER_TICK \|\| !roomFor\(PREOP_NARRATIVE_BUDGET_MS\)/);
});

test('B8 tripled the reads, so the per-episode ceiling tripled and the per-tick cap shrank', () => {
  assert.equal(PREOP_SUGGEST_READS, 3);
  assert.equal(PREOP_SUGGEST_BUDGET_MS, 135_000, 'three reads at 45 s each');
  assert.equal(PREOP_EXTRACT_MAX_PER_TICK, 3, 'was 8 when the leg was one read');
  const capsAlone = PREOP_EXTRACT_MAX_PER_TICK * PREOP_SUGGEST_BUDGET_MS
    + PREOP_NARRATIVE_MAX_PER_TICK * PREOP_NARRATIVE_BUDGET_MS;
  assert.ok(capsAlone > PREOP_LLM_BUDGET_MS, 'the BUDGET must bind before the caps do');
  const SLOWEST_MEASURED_DETERMINISTIC_TICK_MS = 55_383;   // 26 Aug, Metabase contention
  assert.ok(PREOP_LLM_BUDGET_MS + SLOWEST_MEASURED_DETERMINISTIC_TICK_MS < 300_000);
});

test('a budget skip leaves the STORED record in place — declining to call is not a retraction', () => {
  const r = src('lib/preop/run.ts');
  const i = r.indexOf('extractTally.skippedBudget++');
  const around = r.slice(i - 700, i + 200);
  assert.match(around, /record: suggestions, changed: false/,
    'the skip path must carry the stored record forward, or a suggestion would vanish for a tick');
});

// ── the rails cannot reach the fingerprint ──────────────────────────────────────

test('neither rail is written by saveSnapshot, and neither column is read by the fingerprint', () => {
  const store = src('lib/preop/store.ts');
  const save = store.slice(store.indexOf('export async function saveSnapshot'), store.indexOf('// ── reads'));
  for (const col of ['extraction', 'narrative']) {
    assert.ok(!save.includes(`${col} =`), `saveSnapshot must not write ${col}`);
    assert.ok(!save.includes(`${col}_fingerprint`), `saveSnapshot must not write ${col}_fingerprint`);
  }
  const assemble = src('lib/preop-assemble-core.ts');
  const fpStart = assemble.indexOf('export function snapshotFingerprint');
  const fp = assemble.slice(fpStart, assemble.indexOf('\n// ──', fpStart));
  assert.ok(!fp.includes('extraction'), 'the fingerprint material must not mention the stored reading');
  assert.ok(!fp.includes('narrative'), 'nor the narrative');
  assert.ok(!fp.includes('sourceSpan'), 'nor the verbatim span');
});

test('the stored record is read BEFORE the snapshot is composed — otherwise reuse holds only within a tick', () => {
  const r = src('lib/preop/run.ts');
  assert.ok(r.indexOf('readRails(') < r.indexOf('for (const ep of episodes)'), 'the stored rails are fetched up front');
  assert.ok(r.indexOf('const extractObs') < r.indexOf('const snap: PreopSnapshot = composeSnapshot'));
});

test('decisions are read on EVERY tick, whatever the mode — turning the rail off cannot retract a confirmation', () => {
  const r = src('lib/preop/run.ts');
  const i = r.indexOf('const decisionStore = await readDecisions(');
  assert.ok(i > 0);
  // no mode guard on that line or the one before it
  const around = r.slice(i - 200, i);
  assert.ok(!/rails\.extract/.test(around), 'the decision read must not be gated by the rail mode');
});

// ── B8b: a suggestion cannot score, and the route says so ───────────────────────

test('the suggestion route appends a decision and recomputes NOTHING', () => {
  const s = src('app/api/care/preop/suggestion/route.ts');
  assert.ok(s.includes('recordDecision'), 'it writes one decision row');
  for (const forbidden of ['composeSnapshot', 'saveSnapshot', 'runPreopSweep', 'insertVersion']) {
    assert.ok(!s.includes(forbidden), `the route must never ${forbidden}`);
  }
  // and it validates against the SUGGESTION target set, not the full input space
  assert.ok(s.includes('SUGGEST_TARGET_IDS.has(inputId)'));
});

test('auto-accepted observations exist only for promoted classes, and there are none', () => {
  const r = src('lib/preop/run.ts');
  assert.match(r, /\.filter\(\(sg\) => autoAcceptable\(rails\.extract, sg\.inputId\)\)/);
});

// ── B8a: the sixth deterministic source ─────────────────────────────────────────

test('the OPD comorbidity column yields NAMES and nothing else', () => {
  assert.deepEqual(
    comorbidityNames('[{"comorbidity":{"uid":"x","name":"High BP"}},{"comorbidity":{"uid":"y","name":"Diabetes"}}]'),
    ['High BP', 'Diabetes'],
  );
});

test('an unrecognised comorbidity shape yields NOTHING — never a stringified blob', () => {
  assert.deepEqual(comorbidityNames('{"comorbidity":{"name":"x"}}'), []);
  assert.deepEqual(comorbidityNames('not json'), []);
  assert.deepEqual(comorbidityNames('[{"notes":""}]'), []);
  assert.deepEqual(comorbidityNames(null), []);
});

test('the sixth source is NOT flag-gated — it is structured data that feeds the score', () => {
  const r = src('lib/preop/run.ts');
  const i = r.indexOf('await fetchOpdComorbidities(');
  assert.ok(i > 0);
  assert.ok(!/rails\.extract[^\n]*\?\s*$/.test(r.slice(i - 120, i)), 'no mode guard on the fetch');
});

test('the OPD free-text source is gone, and why is recorded rather than deleted', () => {
  const d = src('lib/preop/db13.ts');
  assert.ok(!d.includes('fetchOpdNarrative'), 'the fetcher is gone');
  assert.ok(!/p\.doctor_notes/.test(d), 'and so is the column read — it survives only in the comment that explains why');
  assert.match(d, /`relevant_medical_history` was filled on 0 and `doctor_notes` on 1/,
    'the measurement that justified dropping it stays beside the query that replaced it');
});
