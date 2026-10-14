/**
 * lib/readmission/narrative-backfill.ts — the readmission-NARRATIVE run type on the Bedrock
 * backfill rails (CDMSS-READMISSIONS-R4-PRD v1.0 R4-8 / R4-11; rails: lib/backfill-runs*.ts,
 * production-verified 8 Aug 2026 — CDMSS-BEDROCK-S2-VERIFICATION-8-AUG-2026).
 *
 * REUSES, DOES NOT FORK: the `backfill_runs` ledger row (worker 'readmission'), planTick /
 * advanceAfterTick / accumulate / statusAfterTickWrite (§C4 stop race — every status write here
 * is a TICK write with onlyIfActive), the per-run token + cost accounting, `mini_backfill_ticks`
 * for the progress surface (rollingPace / estimateRunEta / isStalled), the reachability
 * re-check on EVERY tick, and the carried S2 rules:
 *   · Opus paced at n_per_tick ≤ 2 (NARRATIVE_MAX_PER_TICK) — clamped here whatever the row says;
 *   · runs > 5 findings need the live progress surface (this module's status payload);
 *   · stop → wait one tick → confirm (the §C4 fix is in the rails already).
 *
 * WHAT DIFFERS FROM THE OPD RUNNER. The unit is a FINDING, not a note; the "day" the cursor
 * marches over is the finding's audited_at UTC calendar day (the whole R2 backlog was audited on
 * a handful of days, so a run over its span is a handful of days — a readmit-date cursor would
 * spend hundreds of empty ticks); the tick RE-ASSEMBLES the evidence from db13 (assembleForRow,
 * no recon legs) to build the ledger the narrative cites, then runs the ONE narrative leg via
 * lib/readmission/narrative.ts. Idempotent: the predicate is "audited AND no caseNarrative on the
 * blob", so a re-run never re-writes a stored narrative (an INVALID stored one is left for review,
 * not retried — that is R4-4's contract; a manual `run_one` can force it).
 *
 * MODEL: NARRATIVE_MODEL exactly (R4-11). A run naming any other Bedrock id is refused at creation
 * and at every tick — never downgraded, never substituted. The Vertex worker box is untouched.
 *
 * SCHEDULING (§4 untouched list: vercel.json): there is no new cron entry. The tick is driven by
 * the existing every-2-minutes OPD backfill cron (/api/admin/opd-audit-mini-backfill?auto=1)
 * WHEN THE OPD WORKER IS IDLE (no active OPD run), and by /api/admin/readmission-narrative-
 * backfill?auto=1 (manual / secret / cron header) — the two share one soft lock so they never
 * overlap. Empty audited_at days are marched past inside one tick (bounded) so a wide range costs
 * seconds, not hours. NEVER auto-started on deploy: a run exists only when an operator starts it.
 */
import { startTrace, finishTrace } from '../trace';
import { modelsAgree } from '../llm';
import { probeReachable } from '../lab-override';
import { getSettings, setSetting, lockHeld, logTick, getTicks } from '../mini-backfill';
import {
  planTick, advanceAfterTick, rollingPace, estimateRunEta, isStalled, canStartRun, planRunCreate, planStatusChange,
  clampNPerTick, isDay, type BackfillRun, type RunCreatePlan,
} from '../backfill-runs-core';
import { activeRun, currentRun, createRun, recentRuns, setRunCursor, setRunStatus, addRunProgress } from '../backfill-runs';
import { NARRATIVE_MODEL, NARRATIVE_MODEL_ID, NARRATIVE_MAX_PER_TICK, type CaseArtefacts } from '../readmission-narrative-core';
import type { ReadmissionFinding } from '../readmission-reconcile-core';
import { assembleForRow } from './run';
import { composeCaseArtefacts } from './narrative';
import { auditedRowsNeedingNarrative, auditedRowForNarrative, narrativePendingCountForDay, narrativeBacklog, READMIT_ENGINE_VERSION, type NarrativeRow } from './store';
import { asJson } from './surface-row';

export const NARRATIVE_WORKER = 'readmission' as const;
/** Own soft lock (app_settings key) — the OPD runner's lock guards ITS ticks; this one guards ours,
 *  and the two entry points (the OPD cron hook, this module's route) both take it. */
export const NARRATIVE_LOCK_KEY = 'readmit_narrative_lock';
/** Empty audited_at days marched past inside one tick (cheap count queries) — bounded so a
 *  mis-sized range cannot pin a tick. */
export const NARRATIVE_MAX_EMPTY_DAYS_PER_TICK = 40;
/** Wall budget for one tick — sits inside the hosting route's 300 s box with margin: two Opus
 *  legs (≤ 80 s each) run in PARALLEL beside their re-assembly (~60 s worst) ≈ 150 s. */
export const NARRATIVE_TICK_BUDGET_MS = 230_000;

/** PURE: the run's per-tick n, clamped to the Opus pace (carried S2 rule). */
export function narrativeNPerTick(n: unknown): number {
  return Math.min(NARRATIVE_MAX_PER_TICK, clampNPerTick(n));
}

/** PURE: the ONE model this run type may name (R4-11). Typed error, never a substitution. */
export function resolveNarrativeRunModel(model: string): { ok: true; modelId: string } | { ok: false; error: string } {
  const m = String(model ?? '').trim();
  const id = m.toLowerCase().startsWith('bedrock:') ? m.slice('bedrock:'.length).trim() : '';
  if (!id) return { ok: false, error: `narrative run model must be '${NARRATIVE_MODEL}' — got '${m}' (R4-11: Bedrock only)` };
  if (!modelsAgree(id, NARRATIVE_MODEL_ID)) {
    return { ok: false, error: `narrative run model must be '${NARRATIVE_MODEL}' exactly (R4-11: Opus 4.6 on Bedrock everywhere the narrative is written) — '${m}' refused, never downgraded` };
  }
  return { ok: true, modelId: NARRATIVE_MODEL_ID };
}

/** Plan a readmission-narrative run: the rails' validation + this type's two extra rules. */
export function planNarrativeRun(body: Record<string, unknown>): RunCreatePlan {
  const plan = planRunCreate({ ...body, worker: NARRATIVE_WORKER });
  if (!plan.ok) return plan;
  const m = resolveNarrativeRunModel(plan.model);
  if (!m.ok) return { ok: false, error: m.error };
  return { ...plan, nPerTick: narrativeNPerTick(plan.nPerTick) };
}

// ── one finding ─────────────────────────────────────────────────────────────────────────

export interface NarrativeOne {
  dedupKey: string;
  ok: boolean;
  valid?: boolean;
  reason?: string;
  ms: number;
  tokensIn: number;
  tokensOut: number;
  usd: number;
  traceId: string | null;
  relatedState?: string | null;
}

/** Re-assemble + narrate ONE audited finding (the backfill unit). Never throws. */
export async function narrateOne(row: NarrativeRow, opts: { force?: boolean } = {}): Promise<NarrativeOne> {
  const t0 = Date.now();
  const base = { dedupKey: row.dedup_key, tokensIn: 0, tokensOut: 0, usd: 0, traceId: null as string | null };
  const blob = asJson<ReadmissionFinding & CaseArtefacts>(row.finding);
  if (!blob) return { ...base, ok: false, reason: 'no finding blob on the audited row', ms: Date.now() - t0 };
  if (blob.caseNarrative && !opts.force) return { ...base, ok: false, reason: 'already has a caseNarrative (use force to rewrite)', ms: Date.now() - t0 };
  let traceId: string | null = null;
  try {
    const assembled = await assembleForRow(row);
    if ('notAuditable' in assembled) return { ...base, ok: false, reason: `evidence could not be re-assembled: ${assembled.notAuditable}`, ms: Date.now() - t0 };
    traceId = await startTrace('readmit_narrative_backfill', { dedupKey: row.dedup_key, engine: READMIT_ENGINE_VERSION, model: NARRATIVE_MODEL });
    const r = await composeCaseArtefacts({
      row, finding: blob, catalog: assembled.inputs.catalog, identity: assembled.identity,
      ledgerSource: 'reassembled', narrativeSource: 'backfill', traceId,
    });
    await finishTrace(traceId, r.ok ? 'success' : 'error', r.ok ? undefined : r.reason);
    return {
      ...base, ok: r.ok, valid: r.valid, reason: r.reason, ms: Date.now() - t0,
      tokensIn: r.tokensIn, tokensOut: r.tokensOut, usd: r.costUsd, traceId,
      relatedState: r.artefacts?.relatedLvc?.state ?? null,
    };
  } catch (e) {
    const msg = String((e as Error).message).slice(0, 400);
    if (traceId) await finishTrace(traceId, 'error', msg).catch(() => {});
    return { ...base, ok: false, reason: msg, ms: Date.now() - t0, traceId };
  }
}

// ── the tick ─────────────────────────────────────────────────────────────────────────────

export interface NarrativeTickResult extends Record<string, unknown> { worker: 'readmission' }

/**
 * Work the ACTIVE readmission run: at most `n` (≤ 2) findings on the cursor day, IN PARALLEL;
 * empty days are marched past inside the tick. Mirrors autoTick in the OPD runner statement for
 * statement where the rails are concerned (lock, plan, reachability, accounting, §C4 writes).
 */
export async function narrativeTick(): Promise<NarrativeTickResult> {
  const run = await activeRun(NARRATIVE_WORKER);
  const plan = planTick(run);
  if (plan.action === 'idle') return { worker: NARRATIVE_WORKER, idle: true, note: plan.reason };
  if (plan.action === 'skip') {
    await logTick({ status: plan.status === 'done' ? 'finished' : 'paused', note: plan.reason, run_id: run!.id });
    if (plan.status === 'done') await setRunStatus(run!.id, 'done', null, { onlyIfActive: true });
    return { worker: NARRATIVE_WORKER, skipped: plan.reason, run_id: run!.id, status: plan.status };
  }
  const active = run as BackfillRun;
  const lock = (await getSettings([NARRATIVE_LOCK_KEY]))[NARRATIVE_LOCK_KEY] || null;
  if (lockHeld(lock)) {
    await logTick({ status: 'locked', note: 'previous narrative tick still running', run_id: active.id });
    return { worker: NARRATIVE_WORKER, skipped: 'previous tick still running (soft lock)', run_id: active.id };
  }
  const resolved = resolveNarrativeRunModel(active.model);
  if (!resolved.ok) {
    await setRunStatus(active.id, 'error', resolved.error, { onlyIfActive: true });
    await logTick({ status: 'error', note: resolved.error.slice(0, 200), run_id: active.id });
    return { worker: NARRATIVE_WORKER, run_id: active.id, status: 'error', error: resolved.error };
  }
  if (!probeReachable('bedrock')) {
    const msg = 'bedrock is not reachable in this deployment (BEDROCK_REGION / BEDROCK_ROLE_ARN / BEDROCK_OIDC_AUDIENCE / GCP_SA_KEY) — run set to error, resumable once configured';
    await setRunStatus(active.id, 'error', msg, { onlyIfActive: true });
    await logTick({ status: 'error', note: msg, run_id: active.id });
    return { worker: NARRATIVE_WORKER, run_id: active.id, status: 'error', error: msg };
  }

  await setSetting(NARRATIVE_LOCK_KEY, new Date().toISOString());
  const t0 = Date.now();
  try {
    let day = plan.day;
    const n = narrativeNPerTick(plan.n);
    let processed = 0, failed = 0, invalid = 0, tokensIn = 0, tokensOut = 0, cost = 0;
    let lastError: string | null = null;
    const results: NarrativeOne[] = [];
    let emptyDays = 0;
    let cursor = day, status = active.status, finished = false;

    // The cursor loop: work the day; if it is empty (or now complete with nothing to do) march to
    // the previous day inside this tick, bounded by count and by wall time.
    for (;;) {
      const rows = await auditedRowsNeedingNarrative({ day, limit: n });
      if (rows.length) {
        const batch = await Promise.all(rows.map((r) => narrateOne(r)));
        for (const b of batch) {
          results.push(b);
          tokensIn += b.tokensIn; tokensOut += b.tokensOut; cost += b.usd;
          if (b.ok) { processed++; if (b.valid === false) invalid++; }
          else { failed++; lastError = (b.reason ?? 'unknown').slice(0, 500); }
        }
      }
      const remaining = await narrativePendingCountForDay(day);
      // A null count (fault) is NOT a complete day — the cursor stays; the next tick re-asks.
      // A day whose remaining rows all just FAILED is also not complete: the sweep IS the retry.
      const dayComplete = remaining === 0;
      const adv = advanceAfterTick(active, day, { processed, failed, dayComplete });
      cursor = adv.cursor; status = adv.status; finished = adv.finished;
      await setRunCursor(active.id, adv.cursor, adv.status);
      const worked = rows.length > 0;
      if (worked || !dayComplete || finished) break;
      emptyDays++;
      if (emptyDays >= NARRATIVE_MAX_EMPTY_DAYS_PER_TICK || Date.now() - t0 > NARRATIVE_TICK_BUDGET_MS) break;
      day = adv.cursor;
      if (!isDay(day)) break;
    }

    await addRunProgress(active.id, { processed, failed, tokensIn, tokensOut, costUsd: cost, lastError });
    const okRuns = results.filter((r) => r.ok);
    const avgMs = okRuns.length ? Math.round(okRuns.reduce((s, r) => s + r.ms, 0) / okRuns.length) : null;
    await logTick({
      status: finished ? 'finished' : (failed > 0 && processed === 0 && results.length > 0 ? 'error' : 'running'),
      processed, day: plan.day, avg_ms: avgMs, run_id: active.id,
      note: [failed ? `${failed} finding error(s)` : null, invalid ? `${invalid} narrative(s) stored invalid (withheld)` : null, emptyDays ? `${emptyDays} empty day(s) skipped` : null].filter(Boolean).join(' · ') || null,
    });
    return {
      worker: NARRATIVE_WORKER, run_id: active.id, model: active.model, provider: 'bedrock', engine: READMIT_ENGINE_VERSION,
      day: plan.day, cursor, status, finished, n_per_tick: n,
      processed, failed, invalid, empty_days_skipped: emptyDays,
      tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: Number(cost.toFixed(4)),
      throughput: avgMs ? { avg_ms_per_finding: avgMs } : null,
      results,
    };
  } catch (e) {
    const msg = String((e as Error).message).slice(0, 500);
    await setRunStatus(active.id, 'error', msg, { onlyIfActive: true });
    await logTick({ status: 'error', note: msg.slice(0, 200), run_id: active.id });
    return { worker: NARRATIVE_WORKER, run_id: active.id, status: 'error', error: msg };
  } finally {
    await setSetting(NARRATIVE_LOCK_KEY, '').catch(() => {});
  }
}

// ── status (the live progress surface — carried S2 rule for runs > 5) ───────────────────

export async function narrativeStatus(nowMs: number = Date.now()): Promise<Record<string, unknown>> {
  const [active, recent, backlog, ticks] = await Promise.all([
    activeRun(NARRATIVE_WORKER).catch(() => null),
    recentRuns(NARRATIVE_WORKER, 20).catch(() => []),
    narrativeBacklog(),
    getTicks(48).catch(() => []),
  ]);
  const pace = active ? rollingPace(ticks, active.id) : null;
  const eta = active && pace ? estimateRunEta(active, pace) : null;
  const stalled = active ? isStalled({ active: active.status === 'active', lastProgressMs: active.updated_at ? Date.parse(active.updated_at) : null }, nowMs) : false;
  return {
    worker: NARRATIVE_WORKER, engine: READMIT_ENGINE_VERSION, model: NARRATIVE_MODEL, max_per_tick: NARRATIVE_MAX_PER_TICK,
    bedrock_reachable: probeReachable('bedrock'),
    /** What an operator needs to size the run: pending findings and the audited_at day span. */
    backlog,
    active_run: active, recent_runs: recent,
    pace, eta, stalled,
    /** Exact ETA basis for THIS run type: the denominator is KNOWN (backlog.pending), not estimated. */
    eta_from_backlog_seconds: pace?.avgMsPerNote && backlog.pending > 0 ? Math.round((backlog.pending * pace.avgMsPerNote) / 1000 / Math.max(1, active ? narrativeNPerTick(active.n_per_tick) : 1)) : null,
  };
}

// ── control (start / pause / resume / stop / run_one) ─────────────────────────────────────

export async function startNarrativeRun(body: Record<string, unknown>): Promise<{ ok: true; run: BackfillRun } | { ok: false; status: number; error: string }> {
  const plan = planNarrativeRun(body);
  if (!plan.ok) return { ok: false, status: 400, error: plan.error };
  const gate = canStartRun(await activeRun(NARRATIVE_WORKER));
  if (!gate.ok) return { ok: false, status: 409, error: gate.error };
  if (!probeReachable('bedrock')) return { ok: false, status: 400, error: 'bedrock is not reachable in this deployment (BEDROCK_REGION / BEDROCK_ROLE_ARN / BEDROCK_OIDC_AUDIENCE / GCP_SA_KEY) — refusing to create a run that cannot run' };
  const created = await createRun(plan);
  return { ok: true, run: created };
}

export async function controlNarrativeRun(action: 'pause' | 'resume' | 'stop'): Promise<{ ok: true; run_id: number; status: string } | { ok: false; status: number; error: string }> {
  const target = await currentRun(NARRATIVE_WORKER);
  if (!target) return { ok: false, status: 404, error: 'no readmission-narrative run to act on' };
  const change = planStatusChange(target.status, action);
  if (!change.ok) return { ok: false, status: 409, error: change.error };
  await setRunStatus(target.id, change.status);   // operator action: unconditional (§C4)
  return { ok: true, run_id: target.id, status: change.status };
}

/** Manual single-finding narrative (spends one Opus call) — for the post-ship live check. Not on
 *  the run ledger; the trace carries its cost. `force` rewrites an existing (e.g. invalid) one. */
export async function narrateOneByKey(dedupKey: string, force = false): Promise<NarrativeOne | { ok: false; reason: string }> {
  if (!probeReachable('bedrock')) return { ok: false, reason: 'bedrock is not reachable in this deployment' };
  const row = await auditedRowForNarrative(dedupKey);
  if (!row) return { ok: false, reason: `no audited finding '${dedupKey}' at ${READMIT_ENGINE_VERSION}` };
  return narrateOne(row, { force });
}
