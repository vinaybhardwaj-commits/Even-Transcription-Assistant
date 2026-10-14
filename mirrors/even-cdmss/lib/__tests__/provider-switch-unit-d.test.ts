/**
 *   node --test --import tsx lib/__tests__/provider-switch-unit-d.test.ts
 *
 * PROVIDER-SWITCH Unit D (Addendum B, 3 Aug 2026) — the budget channel, the flag, and the view.
 *
 * The guard itself lives in route-budget-guard.test.ts. This file asserts the WIRING: that the
 * budget actually reaches the leg (down BOTH arms of the closure), that the flag is genuinely
 * inert when unset, that the second IPD write path stopped lying about its model, and that the
 * measurement seam is shaped the way the SQL guard needs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PROVIDER_BUDGETS, LAB_PROVIDERS, totalBudgetMs, canServe, resolveWorkerProvider,
  providerSwitchEnabled, backoffAllowanceMs,
} from '../lab-provider-core';
import { guardReadOnlySql } from '../sql-guard-core';

const src = (p: string) => readFileSync(p, 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const DOC_AUDIT = src('lib/doc-audit.ts');
const IPD_RUN = src('lib/ipd-audit/run.ts');
const IPD_NOW = src('app/api/admin/ipd-audit-now/route.ts');
const OPD_AUDIT = src('lib/opd-note-audit.ts');
const VIEWS = src('app/api/admin/migrate-lab-views/route.ts');

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · The budget table
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('every provider has a budget for every call class, and the classes are the four', () => {
  const classes = ['audit', 'audit_ipd', 'utility', 'doc_read'] as const;
  for (const p of LAB_PROVIDERS) {
    assert.deepEqual(Object.keys(PROVIDER_BUDGETS[p]).sort(), [...classes].sort(), `${p} has exactly the four classes`);
  }
});

test('audit_ipd exists on every provider and ollama serves it', () => {
  for (const p of LAB_PROVIDERS) {
    assert.notEqual(PROVIDER_BUDGETS[p].audit_ipd, null, `${p}.audit_ipd must be a number`);
  }
  // The mini runs the ANALYZE leg of the Qwen backfill, so this class is not null for it…
  assert.deepEqual(PROVIDER_BUDGETS.ollama.audit_ipd, { perAttemptMs: 200_000, maxTries: 1 });
  // …but it is not multimodal, so doc_read stays impossible rather than slow.
  assert.equal(PROVIDER_BUDGETS.ollama.doc_read, null);
});

test('the published totals are exactly what the arithmetic in the PRD says', () => {
  // One try ⇒ zero backoff allowance, so total === perAttempt on both audit classes.
  assert.equal(backoffAllowanceMs(1), 0);
  assert.equal(totalBudgetMs('openrouter', 'audit_ipd'), 200_000);
  assert.equal(totalBudgetMs('openrouter', 'audit'), 380_000);
  assert.equal(totalBudgetMs('ollama', 'audit_ipd'), 200_000);
  assert.equal(totalBudgetMs('ollama', 'audit'), 380_000);
  assert.equal(totalBudgetMs('openrouter', 'doc_read'), 180_000);
  // utility is UNCHANGED by this unit: still three tries, still 110 s, still 2,250 ms of backoff.
  assert.equal(totalBudgetMs('openrouter', 'utility'), 110_000 * 3 + 2_250);
  assert.equal(PROVIDER_BUDGETS.openrouter.utility?.maxTries, 3);
});

test('BOTH audit classes are one try on every provider — the ladder is multiplicative', () => {
  for (const p of LAB_PROVIDERS) {
    assert.equal(PROVIDER_BUDGETS[p].audit?.maxTries, 1, `${p}.audit`);
    assert.equal(PROVIDER_BUDGETS[p].audit_ipd?.maxTries, 1, `${p}.audit_ipd`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · The budget reaches the leg — down BOTH arms
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('analyzeCase accepts a budget and passes it down BOTH arms of the generate closure', () => {
  assert.ok(DOC_AUDIT.includes('analyzeTimeoutMs?: number; analyzeMaxTries?: number'), 'the opts channel exists');
  const c = code(DOC_AUDIT);
  // ⚠️ THE TRACED ARM IS THE ONE PRODUCTION USES. A fix that reaches only the traceless arm passes
  // naive tests and changes nothing in production — that is precisely how 3039c42 missed the worker.
  // (V-a2: aNoLocal rides beside the budget down the same two arms — same channel, same lesson.)
  assert.ok(c.includes('tracedAnalyzeGenerate(traceId, label, s, u, fo, ANALYZE_PROMPT_REFS[label], aTimeout, aTries, aNoLocal)'),
    'TRACED arm — the production path');
  assert.ok(c.includes('analyzeGenerate(s, u, fo, aTimeout, aTries, aNoLocal)'), 'traceless arm');
  // …and both helpers hand them to the governed layer rather than dropping them.
  assert.ok(c.includes('{ gemini: geminiModel, timeoutMs, maxTries, noLocalFallback }'), 'analyzeGenerate → governedChat');
  assert.ok(c.includes('{ gemini: geminiModel, promptRef, timeoutMs, maxTries, noLocalFallback }'), 'tracedAnalyzeGenerate → tracedChat');
});

test('the IPD callers read the budget from the TABLE, never as literals in their own file', () => {
  assert.ok(IPD_RUN.includes("PROVIDER_BUDGETS[mini ? 'ollama' : 'openrouter'].audit_ipd"), 'one fact, one place');
  // No restated ceiling anywhere in the IPD run file.
  assert.ok(!/200_000|280_000|110_000|600_000/.test(code(IPD_RUN)), 'no budget literals in run.ts');
  assert.ok(IPD_RUN.includes('...ipdAnalyzeBudget(mini)'), 'and it reaches analyzeCase');
  // The second write path uses the SAME helper rather than its own copy.
  assert.ok(IPD_NOW.includes('analyzeCase(extracted, {}, ipdAnalyzeBudget(false))'));
  assert.ok(!/200_000|280_000/.test(code(IPD_NOW)), 'no budget literals in ipd-audit-now');
});

test('a null budget throws rather than substituting a default', () => {
  assert.ok(IPD_RUN.includes('if (!b) throw new Error('), 'refuse, never fall back to the module ceiling');
  // Bedrock S2: the helper takes the provider, so the refusal names whichever one has no row.
  assert.ok(OPD_AUDIT.includes('if (!b) throw new Error(`no audit budget for ${provider}'));
});

test('the OPD audit call site sends a maxTries taken from the budget', () => {
  // Bedrock S2 (7 Aug): the budget is resolved once, from the provider that will SERVE the call,
  // and both bounds read that object. Still not a literal and still not the module default — the
  // property this pins — and the numbers are unchanged (bedrock.audit === openrouter.audit).
  assert.ok(OPD_AUDIT.includes("const budget = opdAuditBudget(onBedrock ? 'bedrock' : 'openrouter');"));
  assert.ok(OPD_AUDIT.includes('maxTries: budget.maxTries'), 'not a literal, not the module default');
  assert.ok(OPD_AUDIT.includes('timeoutMs: budget.perAttemptMs'), 'the ceiling comes from the same object');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · The second IPD write path stopped lying
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('ipd-audit-now records what SERVED — the constant model is gone', () => {
  // Match on STRIPPED source: the route's comment names the old constant in order to record what
  // it was, and a raw match would fail on the very documentation that explains the fix.
  assert.ok(!/GEMINI_MODEL/.test(code(IPD_NOW)), 'the hardcoded model constant and its import are both gone');
  assert.ok(IPD_NOW.includes('const served = await servedCallFor(analyzeTraceId);'), 'it asks the trace');
  assert.ok(IPD_NOW.includes('model: served.model,'));
  assert.ok(IPD_NOW.includes('row.provider = served.provider;'), 'and provider, which it never set at all');
  // The helper is SHARED with the worker rather than copied — one query, one definition.
  assert.ok(IPD_NOW.includes("import { ipdAnalyzeBudget, servedCallFor } from '@/lib/ipd-audit/run';"));
  assert.ok(IPD_RUN.includes('export async function servedCallFor('));
  assert.ok(!/FROM trace_events/.test(IPD_NOW), 'it must not grow a second copy of the query');
});

test('ipd-audit-now got the box its work actually needs (DEC-B5)', () => {
  assert.ok(code(IPD_NOW).includes('export const maxDuration = 800;'), '300 could never hold 780,000 ms');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · THE FLAG. Unset ⇒ the behaviour changes are inert.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('PROVIDER_SWITCH_ENABLED defaults OFF and is read at call time', () => {
  const before = process.env.PROVIDER_SWITCH_ENABLED;
  try {
    delete process.env.PROVIDER_SWITCH_ENABLED;
    assert.equal(providerSwitchEnabled(), false, 'default off');
    process.env.PROVIDER_SWITCH_ENABLED = '0';
    assert.equal(providerSwitchEnabled(), false, 'only "1" enables it');
    process.env.PROVIDER_SWITCH_ENABLED = 'true';
    assert.equal(providerSwitchEnabled(), false);
    process.env.PROVIDER_SWITCH_ENABLED = '1';
    assert.equal(providerSwitchEnabled(), true, 'read at CALL time, so it flips without a redeploy');
  } finally {
    if (before === undefined) delete process.env.PROVIDER_SWITCH_ENABLED;
    else process.env.PROVIDER_SWITCH_ENABLED = before;
  }
});

test('both workers gate ?provider= AND errors-loud behind the flag', () => {
  for (const p of ['app/api/opd-audit/worker/route.ts', 'app/api/ipd-audit/worker/route.ts']) {
    const s = code(src(p));
    assert.ok(s.includes('if (providerSwitchEnabled())'), `${p}: ?provider= is gated`);
    assert.ok(s.includes("p.get('provider')"), `${p}: reads the parameter`);
    // The parameter is read INSIDE the gate, so with the flag off a stray ?provider= cannot alter a run.
    const i = s.indexOf('if (providerSwitchEnabled())');
    assert.ok(s.indexOf("p.get('provider')") > i, `${p}: the parameter must not be read outside the gate`);
  }
  // DEC-2 fires only under the flag, on both legs.
  assert.ok(code(src('app/api/opd-audit/worker/route.ts')).includes('if (!providerSwitchEnabled()) return false;'), 'OPD');
  assert.ok(IPD_RUN.includes("if (providerSwitchEnabled() && !mini && served.provider === 'ollama')"), 'IPD');
});

test('DEC-2 writes NO ROW rather than a laundered one, and never fires on a mini run', () => {
  const opd = code(src('app/api/opd-audit/worker/route.ts'));
  // A mini run is legitimately served by the mini — the check must not fail its own intent.
  assert.ok(opd.includes("if (intended === 'ollama') return false;"));
  // A NULL provider is unknown, not proof of a fallback.
  assert.ok(opd.includes("return served.provider === 'ollama';"));
  assert.ok(opd.includes('DEC-2:'), 'the failure names itself in the result row');
  // The refusal happens BEFORE the save, or it is not a refusal.
  assert.ok(opd.indexOf('degradedAgainstIntent(served, intended)') < opd.indexOf('await saveOpdAudit('));
  assert.ok(IPD_RUN.indexOf("served.provider === 'ollama'") < IPD_RUN.indexOf('await saveIpdAudit(row)'));
});

test('a provider that cannot serve a class is REFUSED, not defaulted', () => {
  assert.equal(canServe('ollama', 'doc_read'), false);
  assert.equal(canServe('ollama', 'audit_ipd'), true);
  const ipd = code(src('app/api/ipd-audit/worker/route.ts'));
  // Every IPD document begins with a multimodal read even on the mini path, so both classes check.
  assert.ok(ipd.includes("for (const cls of ['audit_ipd', 'doc_read'] as const)"));
  assert.ok(ipd.includes('Refusing rather than substituting a default'));
});

test('resolveWorkerProvider errors loud and never falls back', () => {
  assert.deepEqual(resolveWorkerProvider('openrouter', 'qwen'), { ok: true, provider: 'openrouter' });
  assert.deepEqual(resolveWorkerProvider('BEDROCK', 'qwen'), { ok: true, provider: 'bedrock' }, 'case-insensitive');
  assert.deepEqual(resolveWorkerProvider('', 'qwen'), { ok: true, provider: null }, 'absent ⇒ the route default');
  assert.deepEqual(resolveWorkerProvider(null, 'qwen'), { ok: true, provider: null });
  const bad = resolveWorkerProvider('gpt5', 'qwen');
  assert.equal(bad.ok, false);
  assert.match((bad as { error: string }).error, /unknown provider 'gpt5'/);
  assert.match((bad as { error: string }).error, /Never falls back/);
  // A full provider:model string delegates to resolveProvider unchanged.
  assert.deepEqual(resolveWorkerProvider('vertex:gemini-2.5-pro', 'qwen'), { ok: true, provider: 'vertex' });
  assert.equal(resolveWorkerProvider('nope:x', 'qwen').ok, false);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5 · v_stage_latency — the measurement seam
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the view is created idempotently beside the other two', () => {
  assert.ok(VIEWS.includes('CREATE OR REPLACE VIEW v_stage_latency AS'), 'same pattern as the existing two');
  assert.ok(VIEWS.includes("migrated: ['v_trace_summary', 'v_appropriateness_summary', 'v_stage_latency']"));
  assert.equal((VIEWS.match(/CREATE OR REPLACE VIEW/g) ?? []).length, 3);
});

test('⚠️ payload IS EXCLUDED — it is the only PHI-bearing column on the table', () => {
  const ddl = VIEWS.slice(VIEWS.indexOf('CREATE OR REPLACE VIEW v_stage_latency'), VIEWS.indexOf('return NextResponse.json({ ok: true, migrated'));
  assert.ok(!/payload/i.test(ddl),
    'payload carries BOTH the prompt messages and the model output text — it must never enter this view');
  const COLUMNS = ['e.trace_id', 't.feature', 'e.stage', 'e.kind', 'e.ts', 'e.latency_ms',
    'e.app_source', 'e.call_model', 'e.call_provider', 'e.tokens_out'];
  assert.equal(COLUMNS.length, 10, 'ten columns as approved — nine plus tokens_out (V, 3 Aug 13:00)');
  for (const col of COLUMNS) {
    assert.ok(ddl.includes(col), `the approved column list includes ${col}`);
  }
});

test('tokens_out is present — it is the determinism observable, not a bonus column', () => {
  const ddl = VIEWS.slice(VIEWS.indexOf('CREATE OR REPLACE VIEW v_stage_latency'), VIEWS.indexOf('return NextResponse.json({ ok: true, migrated'));
  assert.ok(ddl.includes('e.tokens_out'),
    'output is a deterministic function of thinking-token spend (24 live calls, 3 Aug, zero ' +
    'exceptions), and tokens_out is reasoning-inclusive — so its run-to-run variance on identical ' +
    'input is what predicts a band flip. Without it the view measures latency and misses the cause.');
  // The column is real, from the same migration as call_model / call_provider.
  assert.ok(readFileSync('migrations/0012_reasoning_fingerprint.sql', 'utf8')
    .includes('ALTER TABLE trace_events ADD COLUMN IF NOT EXISTS tokens_out            INTEGER;'));
});

test('call_model / call_provider are read as REAL COLUMNS, not out of payload', () => {
  const ddl = VIEWS.slice(VIEWS.indexOf('CREATE OR REPLACE VIEW v_stage_latency'));
  assert.ok(!/payload->>/.test(ddl.slice(0, ddl.indexOf('return'))),
    'reading them from the JSONB would defeat the point: without them the view averages a Gemini ' +
    'leg together with a qwen fallback leg, which is the exact error class this build corrects');
  assert.ok(ddl.includes('JOIN traces t ON t.trace_id = e.trace_id'), 'feature comes from traces');
});

test('THE NAME PASSES THE SQL GUARD WITHOUT lib/sql-guard-core.ts CHANGING', () => {
  // This is the property the name was chosen for: it contains neither `traces` nor `trace_events`
  // as a whole word. If this ever fails, the VIEW is misnamed — do not widen the block list.
  const ok = guardReadOnlySql('SELECT stage, latency_ms, call_provider FROM v_stage_latency');
  assert.equal(ok.ok, true, (ok as { error?: string }).error);
  // …and the base tables are still blocked, which is why the view had to exist at all.
  assert.equal(guardReadOnlySql('SELECT latency_ms FROM trace_events').ok, false);
  assert.equal(guardReadOnlySql('SELECT feature FROM traces').ok, false);
});

test('lib/sql-guard-core.ts was NOT edited by this build', () => {
  const guard = src('lib/sql-guard-core.ts');
  assert.ok(guard.includes('const BLOCKED_RELATIONS = /\\b(traces|trace_events|appropriateness_runs|ccb_briefs|care_track_assignments|opd_audit_feedback)\\b/i;'),
    'the block list is byte-identical — widening access is the view\'s job, never this list\'s');
  assert.ok(!/v_stage_latency/.test(guard), 'the guard does not need to know the view exists');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 6 · vercel.json — one line changed, fourteen byte-identical
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('exactly one cron entry moved, and it is the OPD worker path', () => {
  const cfg = JSON.parse(src('vercel.json')) as { crons: { path: string; schedule: string }[] };
  // 15 → 16 on 5 Aug 2026: the readmission worker cron landed (sanctioned, additive).
  // The point of this test — the OPD entry and the original fourteen — is unchanged.
  assert.equal(cfg.crons.length, 17);
  // The OPD entry drops ?conc=4 so the route's new defaults (max=8, conc=8) apply. Production was
  // running conc=4 against a default max of 15 — four waves, not the three anyone had assumed.
  assert.ok(cfg.crons.some((c) => c.path === '/api/opd-audit/worker' && c.schedule === '*/4 18-23,0-2 * * *'));
  assert.ok(!cfg.crons.some((c) => c.path.includes('opd-audit/worker?')), 'no query string left on it');
  // The other fourteen, byte for byte.
  const others = [
    ['/api/cron/harvest', '0 * * * *'], ['/api/cron/harvest-epmc', '0 3 * * *'], ['/api/cron/curator', '0 5 * * 1'],
    ['/api/ipd-audit/worker', '*/15 1-5 * * *'], ['/api/learning/mine', '0 1 * * *'],
    ['/api/admin/sync-doctor-directory', '30 4 * * *'], ['/api/admin/refresh-doctor-metrics', '0 4 * * *'],
    ['/api/admin/opd-audit-mini-backfill?auto=1', '*/2 * * * *'], ['/api/admin/lab-batch?auto=1', '*/2 * * * *'],
    ['/api/admin/complexity-backfill?auto=1', '*/2 * * * *'],
    ['/api/admin/opd-audit/longitudinal-replay?auto=1', '*/10 * * * *'],
    ['/api/care/lvc/generate?auto=1', '0 6 * * *'], ['/api/care/lvc/ground?auto=1', '*/10 * * * *'],
    ['/api/care/concept/code?auto=1', '*/2 * * * *'],
  ];
  assert.equal(others.length, 14);
  for (const [path, schedule] of others) {
    assert.ok(cfg.crons.some((c) => c.path === path && c.schedule === schedule), `${path} is unchanged`);
  }
});
