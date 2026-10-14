/**
 *   node --test --import tsx lib/__tests__/backfill-runs-core.test.ts
 *
 * BEDROCK S2 — the backfill experiment runner (PRD §4.3).
 *
 * The autopilot this replaces kept its state as `app_settings` strings and made its decisions inline
 * in a cron route, where they could only be exercised by running the cron. A RUN is bounded,
 * attributed and accounted, and its decisions — which run a tick works, where the cursor goes, what
 * may be started, what a failure costs — are worth stating where a table of cases can hit them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  accumulate, advanceAfterTick, canStartRun, clampNPerTick, isDay, isTerminal, planRunCreate,
  planStatusChange, planTick, prevDay, statusAfterTickFailure, statusAfterTickWrite,
  daysInclusive, estimateRunEta, etaSeconds, isStalled, rollingPace,
  RUN_MODEL_PREFIXES, STALL_AFTER_MS, type BackfillRun,
} from '../backfill-runs-core';
import { BACKFILL_RUNS_DDL } from '../backfill-runs';
import { resolveBatchModel, LB_MODEL_KEY } from '../lab-batch';
import { normaliseProvider } from '../lab-attribution-core';
import { isLocalGrader, isReferenceModel, canonicalByUid, CANONICAL_RANK_SQL } from '../audit-canonical';
import { BEDROCK_MODELS } from '../bedrock-core';
import { costUsd, costInr, type Pricing } from '../llm-cost-core';
import PRICING_JSON from '../../data/llm-pricing.json' with { type: 'json' };

const src = (p: string) => readFileSync(p, 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const ROUTE = src('app/api/admin/opd-audit-mini-backfill/route.ts');
const PRICING = PRICING_JSON as unknown as Pricing;

const HAIKU = 'global.anthropic.claude-haiku-4-5-20251001-v1:0';
const RUN = (over: Partial<BackfillRun> = {}): BackfillRun => ({
  id: 1, worker: 'opd', model: `bedrock:${HAIKU}`, day_from: '2026-01-01', day_to: '2026-01-10',
  cursor: '2026-01-10', n_per_tick: 4, status: 'active', source: 'admin',
  notes_done: 0, notes_failed: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0, last_error: null, ...over,
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · Creating a run
// ═════════════════════════════════════════════════════════════════════════════════════════════

// ⚠️ WIDENED 8 Aug 2026 (S2b C2, BAKEOFF-DESIGN §6 gap 2). This test read "a run is bedrock-only"
// and pinned `vertex:gemini-2.5-pro` as REFUSED. Vertex is now accepted so the bake-off's Gemini arm
// can be an ordinary run with counters, cost and a progress surface instead of 150 hand-driven
// golden A/B calls. The PROPERTY the test defends is unchanged and is the one that matters: qwen and
// the OpenRouter backup tier cannot back a backfill run, and the refusal explains itself.
test('a run names bedrock or vertex — qwen is retired from backfill, and the refusal says so', () => {
  const bad = planRunCreate({ model: 'ollama:qwen2.5:14b', dayFrom: '2026-01-01', dayTo: '2026-01-02' });
  assert.equal(bad.ok, false);
  assert.match((bad as { error: string }).error, /names no accepted provider/);
  assert.match((bad as { error: string }).error, /qwen is retired from backfill/);
  assert.match((bad as { error: string }).error, /Never falls back/);
  for (const m of ['openrouter:google/gemini-2.5-pro', 'qwen2.5:14b', 'bedrock:', 'vertex:', '']) {
    assert.equal(planRunCreate({ model: m, dayFrom: '2026-01-01', dayTo: '2026-01-02' }).ok, false, `${m} must be refused`);
  }
  for (const m of [`bedrock:${HAIKU}`, 'vertex:gemini-2.5-pro']) {
    assert.equal(planRunCreate({ model: m, dayFrom: '2026-01-01', dayTo: '2026-01-10' }).ok, true, `${m} must be accepted`);
  }
  assert.deepEqual([...RUN_MODEL_PREFIXES], ['bedrock:', 'vertex:'], 'the accepted set is two, and it is stated once');
});

test('the cursor STARTS at day_to and the range is validated', () => {
  const p = planRunCreate({ model: `bedrock:${HAIKU}`, dayFrom: '2026-01-01', dayTo: '2026-01-10', nPerTick: 3 });
  assert.equal(p.ok && p.cursor, '2026-01-10', 'a run begins at the NEWEST day and marches backwards');
  assert.equal(p.ok && p.nPerTick, 3);
  assert.equal(p.ok && p.source, 'admin');
  // A reversed range is a mistake, not something to silently swap.
  const rev = planRunCreate({ model: `bedrock:${HAIKU}`, dayFrom: '2026-01-10', dayTo: '2026-01-01' });
  assert.equal(rev.ok, false);
  assert.match((rev as { error: string }).error, /is after/);
  // Junk days are refused rather than coerced to today.
  for (const d of ['', 'yesterday', '2026-1-1', '2026-02-30', '20260101']) {
    assert.equal(planRunCreate({ model: `bedrock:${HAIKU}`, dayFrom: d, dayTo: '2026-01-10' }).ok, false, `dayFrom '${d}'`);
  }
  assert.equal(isDay('2026-02-30'), false, 'a calendar check, not just a regex');
  assert.equal(isDay('2026-02-28'), true);
});

test('n_per_tick clamps to 1..8 and junk becomes the default, never 0', () => {
  assert.equal(clampNPerTick(undefined), 4);
  assert.equal(clampNPerTick('nonsense'), 4);
  assert.equal(clampNPerTick(0), 4, 'a run that processes 0 notes per tick is indistinguishable from a stuck one');
  assert.equal(clampNPerTick(-3), 4);
  assert.equal(clampNPerTick(1), 1);
  assert.equal(clampNPerTick(8), 8);
  assert.equal(clampNPerTick(99), 8);
  assert.equal(clampNPerTick(3.7), 3);
});

test('§4.3.1 — one active run per worker, and it is a typed refusal not a queue', () => {
  assert.deepEqual(canStartRun(null), { ok: true });
  const r = canStartRun({ id: 7, model: `bedrock:${HAIKU}`, status: 'active' });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /already active/);
  assert.match((r as { error: string }).error, /run 7/, 'names the run in the way');
  assert.match((r as { error: string }).error, /not a queue/);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · The tick
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('no active run ⇒ IDLE, which is a normal state and not an error', () => {
  const p = planTick(null);
  assert.equal(p.action, 'idle');
  assert.match((p as { reason: string }).reason, /no active run/);
});

test('a non-active run is skipped, and a spent cursor reads as done', () => {
  for (const status of ['paused', 'stopped', 'error', 'done'] as const) {
    const p = planTick(RUN({ status }));
    assert.equal(p.action, 'skip', status);
    assert.equal((p as { status: string }).status, status);
  }
  const spent = planTick(RUN({ cursor: '2025-12-31' }));   // below day_from
  assert.equal(spent.action, 'skip');
  assert.equal((spent as { status: string }).status, 'done');
});

test('a run whose cursor was lost resumes at day_to instead of stalling', () => {
  const p = planTick(RUN({ cursor: null }));
  assert.equal(p.action, 'work');
  assert.equal((p as { day: string }).day, '2026-01-10');
});

test('⚠️ THE CURSOR ONLY MOVES ON A COMPLETE DAY', () => {
  const run = RUN();
  // Partial day: the cursor stays, so the next tick finishes it. Marching here would silently skip
  // the remainder — the note is never revisited, because the cursor never comes back.
  const partial = advanceAfterTick(run, '2026-01-10', { processed: 4, failed: 0, dayComplete: false });
  assert.deepEqual(partial, { cursor: '2026-01-10', status: 'active', finished: false });
  // Complete day: march backwards.
  const marched = advanceAfterTick(run, '2026-01-10', { processed: 2, failed: 0, dayComplete: true });
  assert.deepEqual(marched, { cursor: '2026-01-09', status: 'active', finished: false });
  // A day with zero notes still counts as complete, so an empty stretch does not wedge the run.
  assert.equal(advanceAfterTick(run, '2026-01-10', { processed: 0, failed: 0, dayComplete: true }).cursor, '2026-01-09');
});

test('the run is DONE when the cursor passes below day_from — inclusive at both ends', () => {
  const run = RUN({ day_from: '2026-01-08', day_to: '2026-01-10' });
  assert.equal(advanceAfterTick(run, '2026-01-09', { processed: 1, failed: 0, dayComplete: true }).finished, false);
  const last = advanceAfterTick(run, '2026-01-08', { processed: 1, failed: 0, dayComplete: true });
  assert.deepEqual(last, { cursor: '2026-01-07', status: 'done', finished: true }, 'day_from itself is worked, THEN the run ends');
  // A single-day run completes in one tick.
  const oneDay = RUN({ day_from: '2026-01-10', day_to: '2026-01-10' });
  assert.equal(advanceAfterTick(oneDay, '2026-01-10', { processed: 1, failed: 0, dayComplete: true }).finished, true);
});

test('prevDay is UTC date arithmetic — no timezone drift across a month or year boundary', () => {
  assert.equal(prevDay('2026-01-01'), '2025-12-31');
  assert.equal(prevDay('2026-03-01'), '2026-02-28');
  assert.equal(prevDay('2024-03-01'), '2024-02-29', 'leap year');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · Failure semantics — a note is data, a tick is infrastructure
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('a failed NOTE is counted and the run continues; a failed TICK errors the run', () => {
  const after = accumulate(RUN({ notes_done: 10, notes_failed: 1 }), { processed: 3, failed: 1 });
  assert.equal(after.notes_done, 13);
  assert.equal(after.notes_failed, 2, 'counted…');
  // …and the run's own status is untouched by a note failure: only advanceAfterTick moves it.
  assert.equal(advanceAfterTick(RUN(), '2026-01-10', { processed: 3, failed: 1, dayComplete: false }).status, 'active');
  // A tick-level failure is different in kind: every note in this run would fail the same way.
  assert.equal(statusAfterTickFailure(), 'error');
});

test('accounting never poisons a total with NaN, and never runs backwards', () => {
  const base = RUN({ notes_done: 5, tokens_in: 100, tokens_out: 50, cost_usd: 0.25 });
  const a = accumulate(base, { tokensIn: Number('x'), tokensOut: undefined, costUsd: NaN, processed: 1 });
  assert.deepEqual(a, { notes_done: 6, notes_failed: 0, tokens_in: 100, tokens_out: 50, cost_usd: 0.25 });
  const b = accumulate(base, { processed: -5, tokensIn: -1000 });
  assert.equal(b.notes_done, 5, 'a negative delta cannot reduce a counter');
  assert.equal(b.tokens_in, 100);
});

test('an errored run is RESUMABLE — the whole point of erroring rather than stopping', () => {
  assert.deepEqual(planStatusChange('error', 'resume'), { ok: true, status: 'active' });
  assert.deepEqual(planStatusChange('paused', 'resume'), { ok: true, status: 'active' });
  assert.deepEqual(planStatusChange('active', 'pause'), { ok: true, status: 'paused' });
  assert.deepEqual(planStatusChange('active', 'stop'), { ok: true, status: 'stopped' });
  assert.equal(planStatusChange('done', 'resume').ok, false);
  assert.equal(planStatusChange('stopped', 'stop').ok, false);
  assert.equal(planStatusChange('paused', 'pause').ok, false);
  assert.equal(isTerminal('done'), true);
  assert.equal(isTerminal('stopped'), true);
  assert.equal(isTerminal('error'), false, 'error is a pause with a reason, not a grave');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · The table
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the DDL is the PRD’s, idempotent, with a partial unique index behind the one-run rule', () => {
  assert.match(BACKFILL_RUNS_DDL, /CREATE TABLE IF NOT EXISTS backfill_runs/);
  for (const col of ['worker', 'model', 'day_from', 'day_to', 'cursor', 'n_per_tick', 'status',
    'source', 'notes_done', 'notes_failed', 'tokens_in', 'tokens_out', 'cost_usd', 'last_error']) {
    assert.match(BACKFILL_RUNS_DDL, new RegExp(`\\b${col}\\b`), `column ${col}`);
  }
  assert.match(BACKFILL_RUNS_DDL, /cost_usd\s+NUMERIC\(12,4\)/);
  assert.match(BACKFILL_RUNS_DDL, /n_per_tick\s+INT NOT NULL DEFAULT 4/);
  // The code rule (canStartRun) is enforced at the database too, so a concurrent double-start loses
  // there rather than producing two runs writing the same range.
  const store = src('lib/backfill-runs.ts');
  assert.match(store, /CREATE UNIQUE INDEX IF NOT EXISTS backfill_runs_one_active_idx[\s\S]*?WHERE status = 'active'/);
});

test('run accounting is an in-SQL increment, so overlapping ticks cannot lose counts', () => {
  const store = src('lib/backfill-runs.ts');
  const fn = store.slice(store.indexOf('export async function addRunProgress'), store.indexOf('export async function usageForTrace'));
  assert.match(fn, /notes_done\s+=\s+notes_done\s+\+/);
  assert.match(fn, /tokens_in\s+=\s+tokens_in\s+\+/);
  assert.ok(!/SELECT/.test(fn), 'never read-modify-write: the increment is the statement');
  // Usage comes off the ENVELOPE COLUMNS, never the PHI-bearing payload. (Stripped of comments —
  // the function's own note explains WHY payload is excluded, and must be allowed to say the word.)
  const usage = code(store.slice(store.indexOf('export async function usageForTrace')));
  assert.match(usage, /SUM\(tokens_in\)/);
  assert.ok(!/payload/.test(usage), 'no SQL in this file may read a trace payload');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5 · The runner route
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('⚠️ FILL-ONLY: the skip rule is unchanged, and it is what makes a prod-line label safe', () => {
  const c = code(ROUTE);
  assert.ok(c.includes('const already = await auditedUidsForDayInLine(day);'), 'current engine LINE, not the exact version');
  assert.ok(c.includes('const cloudDone = await cloudAuditedUidsForDay(day);'));
  assert.ok(c.includes('const skip = [...new Set([...already, ...cloudDone])];'));
  assert.ok(c.includes('await fetchOpdNotesForDay(day, skip, run.n_per_tick)'), 'the skip list reaches the fetch');
  // …and ON CONFLICT DO NOTHING is still the last line of defence, in the store.
  assert.match(src('lib/opd-audit-store.ts'), /ON CONFLICT[\s\S]{0,80}DO NOTHING/);
});

// ⚠️ RESHAPED 8 Aug 2026 (S2b C2). The stamp is no longer the resolved id but WHAT SERVED, read off
// the note's own trace, because a `vertex:` run has a ladder behind it and its request is therefore
// not the same event as its answer. Both original properties are preserved and asserted below: the
// row is PROD-LINE (no pipeline:'mini', no engineTag), and it is never stamped with the local model.
test('the row is PROD-LINE and stamped with WHAT SERVED, never MINI_MODEL', () => {
  const c = code(ROUTE);
  assert.ok(c.includes("await auditOpdNote(row, provider === 'bedrock' ? { bedrockModel: modelId } : {})"), 'no pipeline:mini, no engineTag ⇒ plain prod engine');
  assert.ok(!/pipeline:\s*'mini'/.test(c) && !/engineTag/.test(c), 'a prod-line run never tags its engine');
  assert.ok(c.includes('const served = await servedCallForAudit(audit.traceId);'), 'the stamp is read back, not assumed');
  assert.ok(c.includes('model: served.model ?? modelId, provider: served.provider ?? provider'), 'and it is what answered');
  assert.ok(/if \(served\.model && !modelsAgree\(served\.model, modelId\)\)/.test(c), 'a disagreement is a refusal — DEC-2');
  assert.ok(!/saveOpdAudit\([\s\S]{0,200}MINI_MODEL/.test(c), 'the autopilot stamp is gone — it would be a lie here');
  // The model reaches the LLM leg the way an F11 override does, with no ladder behind it.
  const audit = src('lib/opd-note-audit.ts');
  assert.ok(audit.includes('bedrock: bedrockModel'), 'governedChat receives the target');
  assert.ok(audit.includes('const onBedrock = !!bedrockModel;'));
  assert.ok(audit.includes('const geminiModel = (mini || onBedrock) ? undefined :'), 'gemini is cleared, as labRoutingOpts does');
  assert.ok(audit.includes("opdAuditBudget(onBedrock ? 'bedrock' : 'openrouter')"), 'the budget is read from the serving provider’s row');
});

test('scheduling: the night window and the lab-batch yield are gone, the soft lock stays', () => {
  const c = code(ROUTE);
  assert.ok(!/windowOpen/.test(c), 'no night window — bedrock has no single-box constraint');
  assert.ok(!/LB_KEYS/.test(c), 'the yield protected the Mac-mini, which bedrock does not touch');
  assert.ok(c.includes('lockHeld(lock)'), 'the soft lock guards overlapping ticks — that hazard is unchanged');
  assert.ok(c.includes('MB_KEYS.lock'), 'and it is the SAME lock key, so a rollback finds it where it was');
  // The other autopilot keys are read by nothing.
  for (const k of ['MB_KEYS.enabled', 'MB_KEYS.window', 'MB_KEYS.cursor', 'MB_KEYS.floor', 'MB_KEYS.tag', 'MB_KEYS.last']) {
    assert.ok(!c.includes(k), `${k} must no longer be read — it is the rollback, not state`);
  }
});

// ⚠️ RESHAPED 8 Aug 2026 (S2b C2): the probe was hardcoded to 'bedrock' at BOTH sites, which for a
// vertex run asks an unrelated question — a deployment with the BEDROCK_* vars unset would error a
// perfectly healthy Gemini run, and one with Vertex unconfigured would sail past and fail note by
// note. It now probes the RUN'S OWN provider. The re-check-every-tick property is unchanged.
test('reachability is re-checked EVERY tick, for the RUN’S provider, so unsetting a var is a clean rollback', () => {
  const c = code(ROUTE);
  const tick = c.slice(c.indexOf('async function autoTick'), c.indexOf('async function statusPayload'));
  assert.ok(tick.includes('probeReachable(resolved.provider)'), 'the run’s provider, not a constant');
  assert.ok(!/probeReachable\('bedrock'\)/.test(tick), 'a hardcoded provider here would mis-gate a vertex run');
  assert.ok(tick.includes("await setRunStatus(active.id, 'error'"), 'one visible errored run, not a wall of failed notes');
  // Creation checks it too — a run that could never have worked should not enter the history.
  const post = c.slice(c.indexOf('export async function POST'));
  assert.ok(post.includes('probeReachable(resolved.provider)'));
  assert.ok(post.includes('canStartRun(await activeRun(WORKER))'));
});

test('the control endpoint speaks the five actions, on this route', () => {
  assert.ok(ROUTE.includes('export async function POST(req: NextRequest)'));
  for (const a of ['start_run', 'pause', 'resume', 'stop', 'status']) {
    assert.ok(ROUTE.includes(`'${a}'`), `action ${a}`);
  }
  assert.ok(ROUTE.includes('{ status: 409 }'), 'a second start refuses typed, not 500');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 6 · Grader tier (§C4) and cost
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('a bedrock row is a CLOUD grader and a CANDIDATE model — for EVERY id the transport accepts', () => {
  // ⚠️ THIS TEST IS THE ANTI-DRIFT MECHANISM. lib/audit-canonical.ts is dependency-free by
  // construction (its own purity test enforces that), so it cannot import the model catalogue. The
  // cross-file invariant is pinned HERE instead, where imports are free: adding a fourth model to
  // lib/bedrock-core.ts puts it under these assertions automatically.
  assert.ok(Object.keys(BEDROCK_MODELS).length >= 3);
  for (const m of Object.keys(BEDROCK_MODELS)) {
    assert.equal(isLocalGrader(m), false, 'cloud: it outranks a qwen row regardless of version');
    assert.equal(isReferenceModel(m), false, 'candidate: it loses a same-version tie to Gemini');
  }
  // The SQL twin agrees: 'global.anthropic…' is not LIKE 'qwen%' and is not in REFERENCE_MODELS.
  assert.match(CANONICAL_RANK_SQL, /model LIKE 'qwen%'/);
  assert.ok(!/anthropic/.test(CANONICAL_RANK_SQL), 'no bedrock-specific SQL was needed — the existing keys classify it');
});

test('a bedrock row beats a qwen row, and loses to Gemini at the same version', () => {
  const at = (h: number) => `2026-08-07T0${h}:00:00Z`;
  const pick = (rows: Record<string, unknown>[]) => canonicalByUid(rows as never)[0] as Record<string, unknown>;
  // vs local: cloud wins even though qwen is NEWER and later.
  assert.equal(pick([
    { uid: 'u1', engine_version: 'opd-note-audit/0.81.20', model: HAIKU, audited_at: at(1) },
    { uid: 'u1', engine_version: 'opd-note-audit/0.81.20', model: 'qwen2.5:14b', audited_at: at(9) },
  ]).model, HAIKU);
  // vs reference, same version: Gemini wins the tie.
  assert.equal(pick([
    { uid: 'u1', engine_version: 'opd-note-audit/0.81.20', model: HAIKU, audited_at: at(9) },
    { uid: 'u1', engine_version: 'opd-note-audit/0.81.20', model: 'gemini-2.5-pro', audited_at: at(1) },
  ]).model, 'gemini-2.5-pro');
});

test('cost_usd is real dollars, and costInr composes from it', () => {
  // Haiku 4.5: $1/M in, $5/M out. 10k in + 2k out = $0.01 + $0.01 = $0.02.
  const usd = costUsd(HAIKU, 10_000, 2_000, false, PRICING);
  assert.ok(Math.abs(usd - 0.02) < 1e-12, `$${usd}`);
  assert.ok(Math.abs(costInr(HAIKU, 10_000, 2_000, false, PRICING) - usd * PRICING.fxUsdInr) < 1e-12,
    'one arithmetic, two currencies — they cannot disagree except on the rate');
  // The route prices what SERVED (S2b C2) — the same reason the row is stamped with it.
  assert.ok(ROUTE.includes('costUsd(served.model ?? modelId, usage.tokensIn, usage.tokensOut, false, PRICING)'));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 7 · S2b — the vertex arm, the stop race, and the monitor's ETA + stall
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('C2: a vertex run is refused unless it names the Gemini this deployment will actually use', () => {
  const c = code(ROUTE);
  // There is no per-call Gemini override on the audit leg, so the ONLY way a vertex run's stamp can
  // be honest is for the run to name the model the deployment already resolves to.
  assert.ok(c.includes("return geminiModelFor('doc_audit') ?? geminiUtilityModel();"),
    'the check reads the same expression defaultGenerate uses — one fact, not two');
  assert.ok(c.includes('if (!modelsAgree(deployed, r.model))'), 'and a disagreement is refused');
  assert.match(ROUTE, /refused rather than graded by one model and stamped with another/);
  // Bedrock keeps its by-id threading: that branch has no ladder, so ask and answer are one event.
  assert.ok(c.includes("return { ok: true, provider: 'bedrock', modelId: r.model };"));
});

test('C2: cost accrues on a vertex run through the SAME pricing path as a bedrock one', () => {
  // Gemini 2.5 Pro: $1.25/M in, $10/M out. 10k in + 2k out = $0.0125 + $0.02 = $0.0325.
  const usd = costUsd('gemini-2.5-pro', 10_000, 2_000, false, PRICING);
  assert.ok(Math.abs(usd - 0.0325) < 1e-12, `$${usd}`);
  // Whatever the ladder answered with, the row's model is what the route prices — including the
  // OpenRouter slug for the same model, which must not fall through to the unpriced default.
  assert.ok(costUsd('google/gemini-2.5-pro', 10_000, 2_000, false, PRICING) > 0);
  assert.ok(costUsd(HAIKU, 10_000, 2_000, false, PRICING) > 0);
});

test('C4: a STOP issued mid-tick survives the tick’s completion write', () => {
  // The pure semantic: a tick may only move a run that is still active.
  assert.equal(statusAfterTickWrite('active', 'done'), 'done', 'an untouched run finishes normally');
  assert.equal(statusAfterTickWrite('active', 'active'), 'active');
  for (const stopped of ['stopped', 'paused', 'done', 'error'] as const) {
    assert.equal(statusAfterTickWrite(stopped, 'active'), stopped,
      `a tick landing after ${stopped} must not resurrect the run — this is the live defect`);
    assert.equal(statusAfterTickWrite(stopped, 'done'), stopped,
      'not even a tick that would have FINISHED the run may overwrite an operator’s instruction');
  }
  // …and the same rule restated in the SQL, because the decision and the write are a round-trip apart.
  const store = src('lib/backfill-runs.ts');
  const cursor = store.slice(store.indexOf('export async function setRunCursor'), store.indexOf('export async function addRunProgress'));
  assert.match(cursor, /status\s+=\s+CASE WHEN status = 'active' THEN \$3 ELSE status END/);
  assert.match(cursor, /cursor\s+=\s+\$2::date/, 'the CURSOR still marches — the work happened');
  const status = store.slice(store.indexOf('export async function setRunStatus'), store.indexOf('export async function setRunCursor'));
  assert.match(status, /CASE WHEN \$4::boolean AND status <> 'active' THEN status ELSE \$2 END/);
  assert.match(status, /last_error = COALESCE\(\$3, last_error\)/, 'the error is recorded either way');
  // Every TICK-originated status write carries the guard; the operator’s own actions must not.
  const c = code(ROUTE);
  const tick = c.slice(c.indexOf('async function autoTick'), c.indexOf('async function statusPayload'));
  const tickWrites = tick.match(/setRunStatus\([^;]*\)/g) ?? [];
  assert.ok(tickWrites.length >= 3, `expected the tick’s status writes, found ${tickWrites.length}`);
  for (const w of tickWrites) assert.match(w, /onlyIfActive: true/, w);
  const post = c.slice(c.indexOf('export async function POST'));
  assert.ok(post.includes('await setRunStatus(target.id, change.status);'),
    'pause/resume/stop are unconditional — a guard here would make RESUME a no-op');
});

test('C3: pace is weighted by notes, and only this run’s productive ticks count', () => {
  const ticks = [
    { run_id: 9, processed: 4, avg_ms: 1_000 },   // another run — ignored
    { run_id: 1, processed: 0, avg_ms: null },    // idle/locked tick — contributes nothing, not a 0
    { run_id: 1, processed: 1, avg_ms: 90_000 },
    { run_id: 1, processed: 4, avg_ms: 40_000 },
  ];
  const p = rollingPace(ticks, 1);
  assert.equal(p.notes, 5);
  assert.equal(p.ticks, 2);
  assert.equal(p.avgMsPerNote, Math.round((1 * 90_000 + 4 * 40_000) / 5), 'the 4-note tick outweighs the 1-note one');
  assert.deepEqual(rollingPace([], 1), { avgMsPerNote: null, notes: 0, ticks: 0 }, 'no data ⇒ no pace, never zero');
});

test('C3: the ETA says what it is BASED on, and stays null rather than guessing', () => {
  const pace = { avgMsPerNote: 45_000, notes: 8, ticks: 2 };
  // Nothing finished yet ⇒ no notes-per-day denominator exists, so there is no honest ETA.
  assert.equal(estimateRunEta(RUN({ cursor: '2026-01-10', notes_done: 3 }), pace).basis, 'no_completed_day_yet');
  assert.equal(estimateRunEta(RUN({ cursor: '2026-01-08', notes_done: 60 }), { avgMsPerNote: null, notes: 0, ticks: 0 }).basis, 'no_pace_yet');
  assert.equal(estimateRunEta(RUN({ status: 'paused' }), pace).basis, 'not_active');
  // Two days done (10th, 9th), 60 notes ⇒ 30/day; 8 days left (8th…1st) ⇒ 240 notes × 45 s.
  const eta = estimateRunEta(RUN({ cursor: '2026-01-08', notes_done: 60 }), pace);
  assert.equal(eta.basis, 'estimated_from_completed_days');
  assert.equal(eta.notesPerDay, 30);
  assert.equal(eta.daysRemaining, 8);
  assert.equal(eta.notesRemaining, 240);
  assert.equal(eta.seconds, Math.round((240 * 45_000) / 1000));
  assert.equal(etaSeconds(10, null), null, 'no pace ⇒ no number');
  assert.equal(etaSeconds(0, 45_000), 0, 'nothing left is zero, which is a real answer');
  assert.equal(daysInclusive('2026-01-01', '2026-01-01'), 1);
  assert.equal(daysInclusive('2026-01-10', '2026-01-01'), 0, 'a backwards range is 0, never negative');
});

test('C3: a stall is 300s of silence on an ACTIVE worker — never on a paused or idle one', () => {
  const now = Date.parse('2026-08-08T12:00:00Z');
  const ago = (s: number) => now - s * 1000;
  assert.equal(STALL_AFTER_MS, 300_000, 'the settled default (V, 8 Aug)');
  assert.equal(isStalled({ active: true, lastProgressMs: ago(301) }, now), true);
  assert.equal(isStalled({ active: true, lastProgressMs: ago(299) }, now), false);
  // Deliberate idleness is not a stall: a paused/stopped run, or a batch outside its night window.
  assert.equal(isStalled({ active: false, lastProgressMs: ago(86_400) }, now), false);
  // Unknown idleness is not a stall either — an alarm on every freshly created run gets ignored.
  assert.equal(isStalled({ active: true, lastProgressMs: null }, now), false);
});

test('C3: the monitor exposes ETA + stall for BOTH arms of the bake-off', () => {
  const m = code(src('app/api/admin/mini-backfill-monitor/route.ts'));
  // The Gemini arm is a RUN…
  assert.ok(m.includes('const runPace = runActive ? rollingPace(ticks, runActive.id) : null;'), 'pace from ticks already fetched — no new query');
  assert.ok(m.includes('runEta,') && m.includes('runStalled,'));
  // …and the three Bedrock arms are lab BATCHES. A rule that watched only one would leave
  // three-quarters of the experiment unwatched (standing rule §7, V, 8 Aug).
  assert.ok(m.includes('etaSec: etaSeconds(lbProg.remaining, lbAvgMs)'), 'the cohort’s remaining is EXACT, so no estimate is needed');
  assert.ok(m.includes('stalled: lbStalled'));
  assert.ok(m.includes('const lbActive = !!(lb.experiment && lb.enabled && windowOpen(lb.window));'),
    'a closed night window is deliberate idleness, not a stall');
  assert.ok(m.includes('model: lbModel || null'), 'the monitor says WHO is grading — i.e. whether this batch spends');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 8 · S2b C1 — the lab batch gains a model (BAKEOFF-DESIGN §6 gap 1)
// ═════════════════════════════════════════════════════════════════════════════════════════════

const BATCH = src('lib/lab-batch.ts');
const MCP = src('lib/mcp-tools.ts');

test('C1: the batch accepts bedrock, refuses every other provider, and no model ⇒ the mini path', () => {
  const good = resolveBatchModel(`bedrock:${HAIKU}`);
  assert.deepEqual(good, { ok: true, modelId: HAIKU });
  // ABSENT is not an error — it is today's free-mini batch, and it must stay that way.
  for (const empty of ['', '   ', null, undefined]) {
    assert.deepEqual(resolveBatchModel(empty), { ok: true, modelId: null }, `${JSON.stringify(empty)} ⇒ mini`);
  }
  for (const m of ['ollama:qwen2.5:14b', 'vertex:gemini-2.5-pro', 'openrouter:google/gemini-2.5-pro']) {
    const r = resolveBatchModel(m);
    assert.equal(r.ok, false, `${m} must be refused`);
    assert.match((r as { error: string }).error, /Never falls back|unknown provider/);
  }
  // An unresolvable string is the resolver's own typed error, not a silent mini run.
  assert.equal(resolveBatchModel('gpt5:foo').ok, false);
  assert.equal(resolveBatchModel('bedrock:').ok, false, 'a prefix with no id names nothing');
});

test('C1: a bedrock batch is TRACED and verified against that trace — a paid claim must be provable', () => {
  const b = code(BATCH);
  // The mini keeps trace:false; the paid arm cannot, because an untraced call proves neither who
  // served it nor what it cost — and both are conditions on this build.
  assert.ok(b.includes('trace: onBedrock,'), 'the bedrock arm traces; every other path stays false');
  assert.ok(b.includes('bedrockModel: onBedrock ? bedrockModel : undefined,'), 'threaded exactly as the S2 runner threads it');
  assert.ok(b.includes('const served = await servedCallForAudit(audit.traceId);'));
  assert.ok(b.includes("const verdict = checkAttribution({ provider: 'bedrock', model: bedrockModel }, calls, modelsAgree);"),
    'the SAME pure comparison the probe path uses — not a second copy of the rule');
  // REFUSAL MEANS NO ROW: the throw precedes saveLabAnalysis, so a mismatched note is never stored.
  const throwAt = b.indexOf('if (!verdict.ok) throw new Error');
  assert.ok(throwAt > 0, 'a refused attribution throws');
  assert.ok(throwAt < b.indexOf('const id = await saveLabAnalysis('), 'and it throws BEFORE anything is written');
});

test('C1: the row carries who SERVED, and that is what makes the paid ceiling count it', () => {
  const b = code(BATCH);
  assert.ok(b.includes('model: attribution ? attribution.model : (evalCfg.evalModel || MINI_MODEL),'));
  assert.ok(b.includes('...(attribution ? { provider: attribution.provider } : {}),'),
    'provider is written ONLY on the bedrock arm — the mini/eval rows stay byte-identical');
  // countPaidRuns counts provider, not model, so a bedrock row registers as paid and a mini one
  // never can. This is the assertion the kickoff asks for.
  const lab = src('lib/lab.ts');
  const fn = lab.slice(lab.indexOf('export async function countPaidRuns'), lab.indexOf('export async function listLabAnalyses'));
  assert.match(fn, /provider IS NOT NULL AND provider <> 'ollama'/);
  assert.ok(!/model/.test(fn.replace(/[\s\S]*?\{/, '')), 'the ceiling counts provider, never model');
  // The value the row will actually carry is `checkAttribution`'s verdict provider, which for a
  // bedrock leg is the normalised transport name — non-null and not 'ollama', i.e. counted.
  const stored = normaliseProvider('bedrock');
  assert.equal(stored, 'bedrock');
  assert.notEqual(stored, 'ollama', 'a bedrock arm consumes paid budget; the free mini never does');
});

test('C1: the bedrock arm does not yield to the Mac-mini it never touches', () => {
  const b = code(BATCH);
  assert.ok(b.includes('if (plan.useMiniYield && !bedrockModel) {'),
    'a paid arm waiting on the prod worker’s lock would wedge behind a resource it does not use');
  // …and it stays SERIAL: the eval fan-out is an OpenRouter concurrency story, not this one.
  assert.ok(b.includes(`      results = [];
      for (const uid of slice) results.push(await drainOne(uid));`), 'the serial drain is unchanged');
});

test('C1: the poison-note budget covers the PAID arm, or a bad note retries for ever at a price', () => {
  const b = code(BATCH);
  assert.ok(b.includes('const attempts: AttemptsState | null = (plan.evalMode || !!bedrockModel)'),
    'D3’s unbounded-retry defect is worse on a paid arm than it was on the free one');
  assert.ok(b.includes('model: bedrockModel || st.evalModel || MINI_MODEL, latencyMs: Date.now() - t0,'),
    'a tombstone names the model that FAILED');
  assert.ok(!/kind: 'eval_failed'[\s\S]{0,300}provider:/.test(b), 'and carries no provider — nothing served it, so it is not a paid run');
});

test('C1: lab_batch_start writes the model key on EVERY start, so a paid arm cannot leak forward', () => {
  const m = code(MCP);
  assert.equal(LB_MODEL_KEY, 'lab_batch_model');
  assert.ok(m.includes("await setSetting(LB_MODEL_KEY, batchModel ? `bedrock:${batchModel}` : '');"),
    'the empty write is the point: a stale key would make the NEXT free batch a paid one');
  // Both paid doors at once is a mistake, and defaultGenerate would silently pick evalModel.
  assert.ok(m.includes('if (batchModel && evalModel) {'));
  assert.match(MCP, /mutually exclusive — one batch, one grader/);
  // Reachability at the door, so a batch that could never run does not sit looking queued.
  assert.ok(m.includes("if (batchModel && !probeReachable('bedrock')) {"));
  // The tick re-checks it, for the same reason the runner does: unsetting a var is the rollback.
  const b = code(BATCH);
  assert.ok(b.includes('if (bedrockModel && !bedrockConfigured()) {'));
  assert.ok(b.includes('const resolvedModel = resolveBatchModel(await readBatchModel());'));
  // The schema advertises it, or no caller can use it.
  assert.ok(/model: \{ type: 'string', description: "S2b/.test(MCP), 'lab_batch_start exposes `model`');
  assert.match(MCP, /bedrock:global\.anthropic\.claude-haiku-4-5-20251001-v1:0/, 'with a real id in the description');
});
