/**
 *   node --test --import tsx lib/__tests__/route-budget-guard.test.ts
 *
 * PROVIDER-SWITCH Unit D (Addendum B §5, 3 Aug 2026) — THE GUARD.
 *
 * WHY THIS FILE EXISTS. Nothing in this system related a call's time budget to the box it runs in.
 * Both of 2 August's outages were instances of that one missing relationship:
 *   · a 110 s per-attempt ceiling sat in front of an audit leg that needs minutes, and
 *   · an IPD batch was sized against no budget at all and 504'd on every run.
 * And when the budgets were first written down, on 3 August, they were STILL wrong — because they
 * counted one LLM call per audit when the IPD analyze fires up to three and the OPD audit up to
 * two. The arithmetic proved a route fitted a box it was 2.3× over.
 *
 * So the guard has two halves, and the second is the one that would have caught the error:
 *   1. Σ over call classes ( totalBudgetMs × legCount ) × ceil(max / conc)  ≤  maxDuration
 *   2. THE LEG COUNTS MUST MATCH THE SOURCE. Adding a leg fails this file.
 *
 * Everything is read FROM SOURCE — maxDuration, max, conc, and the call sites themselves. Numbers
 * restated in a test cannot catch a number changing in a route. `59ee012` set that precedent here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LAB_PROVIDERS, PROVIDER_BUDGETS, totalBudgetMs, canServe, backoffAllowanceMs,
  type LabProvider, type CallClass,
} from '../lab-provider-core';
import { IPD_ANALYZE_LEGS } from '../doc-audit';
import { OPD_AUDIT_LEGS } from '../opd-note-audit';
import { OPENROUTER_TIMEOUT_MS, OPENROUTER_MAX_TRIES } from '../openrouter-retry';
import { LLM_AUDIT_TIMEOUT_MS } from '../llm';

const OPD_WORKER_PATH = 'app/api/opd-audit/worker/route.ts';
const IPD_WORKER_PATH = 'app/api/ipd-audit/worker/route.ts';
const IPD_NOW_PATH = 'app/api/admin/ipd-audit-now/route.ts';

const src = (p: string) => readFileSync(p, 'utf8');
/** Comments carry example arithmetic that must never be mistaken for the code's real numbers. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 0 · Read the route's real numbers out of its source
// ═════════════════════════════════════════════════════════════════════════════════════════════

function maxDurationOf(path: string): number {
  const m = code(src(path)).match(/export const maxDuration = (\d+);/);
  assert.ok(m, `${path}: no maxDuration — a route with no box cannot be checked against one`);
  return Number(m![1]);
}
/** ⚠️ maxDuration is SECONDS; every budget in this file is MILLISECONDS. Comparing them raw makes
 *  an 800 s box look like 800 ms and fails everything — convert once, here. */
function boxMs(path: string): number { return maxDurationOf(path) * 1000; }
/** The DEFAULT applied when the cron sends nothing: `Number(p.get('max') || N)`. */
function defaultOf(path: string, param: 'max' | 'conc'): number {
  const m = code(src(path)).match(new RegExp(`Number\\(p\\.get\\('${param}'\\) \\|\\| (\\d+)\\)`));
  assert.ok(m, `${path}: no default for ?${param}=`);
  return Number(m![1]);
}

test('the routes still declare the numbers this guard reads', () => {
  assert.equal(maxDurationOf(OPD_WORKER_PATH), 800);
  assert.equal(maxDurationOf(IPD_WORKER_PATH), 800);
  // DEC-B5 — the same work as one IPD document, so the same box. It was 300 and could never fit.
  assert.equal(maxDurationOf(IPD_NOW_PATH), 800);
  assert.equal(defaultOf(OPD_WORKER_PATH, 'max'), 8);
  assert.equal(defaultOf(OPD_WORKER_PATH, 'conc'), 8);
  assert.equal(defaultOf(IPD_WORKER_PATH, 'max'), 3);
  assert.equal(defaultOf(IPD_WORKER_PATH, 'conc'), 3);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · THE LEG COUNTS MUST MATCH THE SOURCE
//     This is the half that would have caught the wrong budgets. It is not a formality.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The body of one top-level function, by brace balance.
 *
 * ⚠️ The opening brace is NOT simply the first `{` after the signature: these signatures carry
 * default parameter values like `deps: Partial<AnalyzeDeps> = {}`, and taking that one balances
 * instantly and reports a body of zero legs — which would make the leg guard silently vacuous,
 * the exact failure mode it exists to prevent. So walk the parameter list by PAREN depth first,
 * and only then take the next brace.
 */
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `signature not found: ${signature}`);
  let paren = 0;
  let i = source.indexOf('(', start);
  for (; i < source.length; i++) {
    if (source[i] === '(') paren++;
    else if (source[i] === ')') { paren--; if (paren === 0) break; }
  }
  const open = source.indexOf('{', i);
  assert.ok(open > 0, `no body brace after ${signature}`);
  let depth = 0;
  for (let j = open; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}') { depth--; if (depth === 0) return source.slice(open, j + 1); }
  }
  assert.fail(`unbalanced braces after ${signature}`);
}

test('the body extractor is not vacuous — it finds real code, not an empty default param', () => {
  const b = functionBody(src('lib/doc-audit.ts'), 'export async function analyzeCase(');
  assert.ok(b.length > 2000, `analyzeCase body reads ${b.length} chars — a near-empty body means the extractor slipped`);
  assert.ok(functionBody(src('lib/opd-note-audit.ts'), 'export async function auditOpdNote(').length > 2000);
});

test('IPD_ANALYZE_LEGS equals the analyze call sites in lib/doc-audit.ts — a FOURTH leg fails here', () => {
  const body = code(functionBody(src('lib/doc-audit.ts'), 'export async function analyzeCase('));
  const sites = body.match(/await generate\(/g) ?? [];
  assert.equal(sites.length, IPD_ANALYZE_LEGS,
    `analyzeCase fires ${sites.length} LLM legs but IPD_ANALYZE_LEGS says ${IPD_ANALYZE_LEGS}. ` +
    'A route budget multiplies by this number, so a mismatch silently puts the IPD worker over its box. ' +
    'If a leg was added deliberately, redo the arithmetic in lib/lab-provider-core.ts and both IPD route headers.');
  // …and they are the three the budget was derived from, by stage label.
  for (const stage of ['doc_audit_analyze', 'doc_audit_critique_llm', 'doc_audit_revise']) {
    assert.ok(body.includes(`'${stage}'`), `the ${stage} leg is no longer where the budget expects it`);
  }
  // The prognosis legs are NOT counted here: they live in runPrognosisPass, dark behind
  // PROGNOSIS_AUDIT === '1', and `pxPromise` fires them CONCURRENTLY with this chain.
  assert.ok(!body.includes('doc_audit_prognosis'),
    'prognosis legs must stay outside analyzeCase. ⚠️ IF PROGNOSIS_AUDIT IS EVER TURNED ON, EVERY ' +
    'BUDGET IN THIS UNIT IS VOID: three more legs run concurrently with the analyze chain, so the ' +
    'guard must be re-derived BEFORE the flag is set, not after.');
});

test('OPD_AUDIT_LEGS equals the EXECUTABLE legs in auditOpdNote — a third fails here', () => {
  const body = code(functionBody(src('lib/opd-note-audit.ts'), 'export async function auditOpdNote('));
  const sites = body.match(/await generateLeg\(\)/g) ?? [];
  // THREE call sites, TWO possible executions. The first two are mutually exclusive arms of one
  // try/catch (normal call, then the retry taken only if it THREW); the third is the parse-failure
  // retry, guarded by `legRetried` so it cannot run when the throw-retry already did. So the worst
  // case is two model calls, not three, and the budget multiplies by two.
  assert.equal(sites.length, 3, 'the S0 retry block changed shape — re-derive the executable leg count');
  assert.ok(/legRetried/.test(body), 'the cap that makes this two rather than three is gone');
  assert.equal(sites.length - 1, OPD_AUDIT_LEGS,
    `auditOpdNote can execute ${sites.length - 1} LLM legs but OPD_AUDIT_LEGS says ${OPD_AUDIT_LEGS}. ` +
    'A route budget multiplies by this number.');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · THE GUARD ITSELF
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Σ over call classes ( totalBudgetMs × legCount ) × waves ≤ maxDuration. */
function routeWorstCaseMs(provider: LabProvider, classes: Array<[CallClass, number]>, max: number, conc: number): number {
  let perItem = 0;
  for (const [cls, legs] of classes) {
    const b = totalBudgetMs(provider, cls);
    assert.ok(b !== null, `${provider} cannot serve ${cls} — the route must refuse it, not be budgeted for it`);
    perItem += (b as number) * legs;
  }
  return perItem * Math.ceil(max / conc);
}

test('THE IPD WORKER FITS ITS BOX, for every provider that can serve it', () => {
  const box = boxMs(IPD_WORKER_PATH);
  const max = defaultOf(IPD_WORKER_PATH, 'max');
  const conc = defaultOf(IPD_WORKER_PATH, 'conc');
  for (const p of LAB_PROVIDERS) {
    // Every IPD document begins with a multimodal read, even on the mini path (the extract stays
    // Gemini by construction). A provider that cannot do that cannot serve this route at all.
    if (!canServe(p, 'doc_read')) continue;
    const worst = routeWorstCaseMs(p, [['doc_read', 1], ['audit_ipd', IPD_ANALYZE_LEGS]], max, conc);
    assert.ok(worst <= box, `${p}: ${worst} ms worst case in a ${box} ms box (max=${max}, conc=${conc}, legs=${IPD_ANALYZE_LEGS})`);
  }
  // The published arithmetic, pinned: 180,000 + 3 × 200,000 = 780,000 in 800,000.
  assert.equal(routeWorstCaseMs('openrouter', [['doc_read', 1], ['audit_ipd', IPD_ANALYZE_LEGS]], max, conc), 780_000);
  assert.equal(box - 780_000, 20_000, 'the margin is 20 s — thin, and deliberately visible');
});

test('ipd-audit-now fits the same box on the same basis (DEC-B5)', () => {
  const box = boxMs(IPD_NOW_PATH);
  // One document, no batching — so one wave by construction.
  const worst = routeWorstCaseMs('openrouter', [['doc_read', 1], ['audit_ipd', IPD_ANALYZE_LEGS]], 1, 1);
  assert.ok(worst <= box, `ipd-audit-now: ${worst} ms in a ${box} ms box`);
  assert.equal(worst, 780_000);
});

test('THE OPD WORKER FITS ITS BOX, for every provider that can serve it', () => {
  const box = boxMs(OPD_WORKER_PATH);
  const max = defaultOf(OPD_WORKER_PATH, 'max');
  const conc = defaultOf(OPD_WORKER_PATH, 'conc');
  // The OPD worker reads a STORED note, so it makes no doc_read call — only audit legs.
  for (const p of LAB_PROVIDERS) {
    if (!canServe(p, 'audit')) continue;
    const worst = routeWorstCaseMs(p, [['audit', OPD_AUDIT_LEGS]], max, conc);
    assert.ok(worst <= box, `${p}: ${worst} ms worst case in a ${box} ms box (max=${max}, conc=${conc}, legs=${OPD_AUDIT_LEGS})`);
  }
  assert.equal(routeWorstCaseMs('openrouter', [['audit', OPD_AUDIT_LEGS]], max, conc), 760_000);
  assert.equal(box - 760_000, 40_000, 'the margin is 40 s');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2.1 · ⚠️ THE GUARD MEASURES WHAT THE CALL SITE ACTUALLY SENDS, NOT WHAT THE TABLE SAYS
//
// This is the assertion that keeps the guard honest, and it caught a live conflict.
//
// Before Unit D, `LLM_AUDIT_TIMEOUT_MS` (600,000) and `PROVIDER_BUDGETS.<p>.audit.perAttemptMs`
// lived at different layers: the former was an SDK per-request { timeout }, the latter a number in
// a table nothing read. After the lib/trace.ts fix they occupy THE SAME SLOT — governedChat's
// `timeoutMs` becomes openrouterCreateWithRetry's per-attempt ceiling, which is exactly what
// perAttemptMs means. They disagreed: 600,000 vs 380,000, and the larger put the OPD worker at
// 2 × 600,000 = 1,200,000 ms in an 800,000 ms box while a table-reading guard reported 760,000
// and passed. That gap is the failure that produced every wrong number in this unit's history.
//
// DEC-B9 (V, 3 Aug 2026, 13:00 IST) ruled option (a): the call site sends the BUDGET. 600,000 was
// set on 31 July against a "p50 267 s" figure this unit measured and disproved, and before anyone
// had counted OPD's two legs. `LLM_AUDIT_TIMEOUT_MS` is unchanged and still exported — it remains
// the env-overridable default for audit-class callers with no budget-table entry.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the OPD call site sends a per-attempt ceiling that matches its budget (DEC-B9)', () => {
  const body = code(functionBody(src('lib/opd-note-audit.ts'), 'async function defaultGenerate('));
  const budget = PROVIDER_BUDGETS.openrouter.audit;
  assert.ok(budget);
  // Read the EFFECTIVE ceiling out of the call site, never out of the table this guard is checking.
  // Bedrock S2: `opdAuditBudget(<provider>)` resolved into `budget` one line earlier. The guard's
  // arithmetic does NOT move — PROVIDER_BUDGETS.bedrock.audit is the same 380,000 × 1 as
  // openrouter's, so OPD still computes 2 × 380,000 = 760,000 in its 800,000 ms box.
  assert.ok(/const budget = opdAuditBudget\(/.test(body) && /timeoutMs:\s*budget\.perAttemptMs/.test(body),
    'the ceiling must come from the budget, or the guard below is measuring a number the route does not use');
  assert.ok(/maxTries:\s*budget\.maxTries/.test(body), 'and so must the try count');
  assert.ok(!/timeoutMs:\s*LLM_AUDIT_TIMEOUT_MS/.test(body), 'the legacy 600,000 source is off this path');

  const box = boxMs(OPD_WORKER_PATH);
  const realWorst = (budget!.perAttemptMs * budget!.maxTries + backoffAllowanceMs(budget!.maxTries)) * OPD_AUDIT_LEGS;
  assert.equal(realWorst, 760_000, 'the effective worst case, from the call site');
  assert.ok(realWorst <= box, `${realWorst} ms must fit the ${box} ms box`);

  // …and LLM_AUDIT_TIMEOUT_MS is NOT dead: still exported, still 600,000, still the default for
  // any audit-class caller with no entry in the budget table. Deleting it was never the ruling.
  assert.equal(LLM_AUDIT_TIMEOUT_MS, 600_000, 'unchanged in value');
  assert.ok(readFileSync('lib/llm.ts', 'utf8').includes('export const LLM_AUDIT_TIMEOUT_MS ='), 'still exported');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · The guard must BITE
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('raising max, lowering the box, or adding a retry FAILS the guard', () => {
  const box = boxMs(IPD_WORKER_PATH);
  const legs = IPD_ANALYZE_LEGS;
  const cls: Array<[CallClass, number]> = [['doc_read', 1], ['audit_ipd', legs]];
  // a second wave
  assert.ok(routeWorstCaseMs('openrouter', cls, 6, 3) > box, 'two waves must not fit');
  // one more leg
  assert.ok(routeWorstCaseMs('openrouter', [['doc_read', 1], ['audit_ipd', legs + 1]], 3, 3) > box, 'a fourth leg must not fit');
  // a lower box
  assert.ok(routeWorstCaseMs('openrouter', cls, 3, 3) > 700_000, 'a 700 s box must not hold this route');
  // a retry, via the real formula rather than a restated number
  const withRetry = (200_000 * 2 + backoffAllowanceMs(2)) * legs + 180_000;
  assert.ok(withRetry > box, `a second try per leg is ${withRetry} ms and must not fit ${box}`);
});

test('a null budget means REFUSE, never substitute a default', () => {
  assert.equal(PROVIDER_BUDGETS.ollama.doc_read, null, 'the mini is not multimodal — that call is impossible, not slow');
  assert.equal(totalBudgetMs('ollama', 'doc_read'), null);
  assert.equal(canServe('ollama', 'doc_read'), false);
  // …and the routes ask before running, rather than falling back to a module constant.
  for (const p of [IPD_WORKER_PATH, OPD_WORKER_PATH]) {
    assert.ok(code(src(p)).includes('canServe('), `${p} must check the class before spending on it`);
    assert.ok(/Refusing rather than substituting a default/.test(src(p)), `${p} must say so out loud`);
  }
  // The one class the mini genuinely serves is not null.
  assert.notEqual(PROVIDER_BUDGETS.ollama.audit_ipd, null, 'the mini serves the analyze leg of the Qwen backfill');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · The cron interval, IPD only (DEC-A6)
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the IPD cron interval clears the IPD box — and this is NOT extended to OPD', () => {
  const cfg = JSON.parse(src('vercel.json')) as { crons: { path: string; schedule: string }[] };
  const ipd = cfg.crons.find((c) => c.path.startsWith('/api/ipd-audit/worker'));
  assert.ok(ipd, 'the IPD cron exists');
  const everyMin = Number((ipd!.schedule.match(/^\*\/(\d+)/) ?? [])[1]);
  const boxSec = maxDurationOf(IPD_WORKER_PATH);
  assert.ok(everyMin * 60 > boxSec,
    `*/${everyMin} is ${everyMin * 60}s and must exceed the ${boxSec}s box, or invocations overlap — ` +
    'that is how one slow IPD run became a continuous request storm holding 3 concurrent Gemini calls');

  // ⚠️ DELIBERATELY NOT ASSERTED FOR OPD (DEC-A6). OPD runs */4 — 240 s into an 800 s box — so its
  // invocations DO overlap, and that is intended: the skip rule shipped in d541299 makes
  // overlapping OPD invocations pick DIFFERENT notes, so overlap raises throughput instead of
  // duplicating work. IPD has no equivalent protection, which is why one slow run there became a
  // request storm and 59ee012 moved it to */15. Widening this assertion to OPD would fail
  // correctly and for entirely the wrong reason. This is a recorded exemption, not a skip.
  const opd = cfg.crons.find((c) => c.path.startsWith('/api/opd-audit/worker'));
  assert.ok(opd, 'the OPD cron exists');
  assert.equal(opd!.schedule, '*/4 18-23,0-2 * * *', 'the OPD window and its deliberate overlap are unchanged');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5 · The module defaults are untouched — this build made them overridable, not different
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('OPENROUTER_TIMEOUT_MS and OPENROUTER_MAX_TRIES still read 110,000 and 3', () => {
  assert.equal(OPENROUTER_TIMEOUT_MS, 110_000, 'still right for the short calls it was written for');
  assert.equal(OPENROUTER_MAX_TRIES, 3);
});
