export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * OPD BACKFILL EXPERIMENT RUNNER (Bedrock PRD §4.3, S2, 7 Aug 2026).
 *
 * ══ WHAT THIS REPLACED ═══════════════════════════════════════════════════════════════════════
 * Until this build the route was the MINI AUTOPILOT: an unbounded sweep backwards through db13
 * history on the Mac-mini (qwen2.5:14b), gated by a night window, writing rows under an isolated
 * `-<tag>` engine label so a local 14B model's grades could never be mistaken for production.
 *
 * It is now a RUN QUEUE. One run = one model over a chosen day range, writing PROD-LINE rows,
 * accounted per run, failing loudly. Qwen does no more backfill (PRD decision 2).
 *
 * S2b (8 Aug 2026) — a run may name `bedrock:` OR `vertex:` (BAKEOFF-DESIGN §6 gap 2). The bake-off's
 * Gemini arm is not a special case bolted on beside the runner; it is an ordinary run whose model
 * happens to be the production grader, so it gets the same counters, cost and progress surface as
 * every other arm. Everything downstream — fill-only, the prod-line label, the model stamp — is
 * provider-agnostic and unchanged.
 *
 * ⚠️ THE ISOLATION RULE DID NOT DISAPPEAR — IT WAS SUPERSEDED BY A DIFFERENT MECHANISM, and the
 * distinction matters because the old one was written in blood. D1 (2 Aug) isolated mini rows
 * because a local model was writing PROD labels and displacing Gemini audits on doctors'
 * dashboards. Prod-line labels are safe here for a reason that did not exist then: the FILL-ONLY
 * rule (§4.3.3). A note with ANY current-line audit — mini or cloud — is skipped before it is
 * fetched, and the insert is ON CONFLICT DO NOTHING on (uid, engine_version). A Bedrock row can
 * therefore only ever land where NO row exists. It cannot displace a Gemini row, because it can
 * never be written next to one. V accepted the residual (un-bridged grader mix in the prod line)
 * in PRD decision 5 / §4.3.8; the `model` column is what keeps it attributable.
 *
 * ⚠️ THE OLD `mini_backfill_*` app_settings KEYS ARE LEFT ON DISK AND NOTHING READS THEM AFTER THIS
 * SLICE (enabled / window / cursor / floor / tag / n / lock / last). That is deliberate: reverting
 * this commit restores the qwen autopilot exactly, with its cursor where it stopped. Do not "tidy"
 * them away — they are the rollback. The soft LOCK key is the one exception: the runner still takes
 * it, because it guards overlapping ticks and that hazard is unchanged.
 *
 * Scheduling (§4.3.6): no night window — Bedrock has no single-box constraint. The soft lock stays.
 * The yield-to-lab-batch check is GONE from this path: it existed to protect the one Mac-mini, which
 * a Bedrock run does not touch.
 *
 * Auth: Vercel cron header / Bearer|?secret=CRON_SECRET / admin session — unchanged.
 *   GET  ?auto=1        → work the active run (the cron tick)
 *   GET  (no args)      → status
 *   POST {action:…}     → start_run | pause | resume | stop | status   (§C3)
 */
import { NextRequest, NextResponse } from 'next/server';
import { auditOpdNote } from '@/lib/opd-note-audit';
import { OPD_ENGINE_VERSION } from '@/lib/opd-note-audit-core';
import { countOpdNotesForDay, fetchOpdNotesForDay } from '@/lib/metabase';
import { saveOpdAudit, auditedUidsForDayInLine, cloudAuditedUidsForDay } from '@/lib/opd-audit-store';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { setSetting, lockHeld, MB_KEYS, logTick, getSettings } from '@/lib/mini-backfill';
import { resolveProvider, type LabProvider } from '@/lib/lab-provider-core';
import { probeReachable } from '@/lib/lab-override';
import { MINI_MODEL, modelsAgree, geminiModelFor, geminiUtilityModel } from '@/lib/llm';
import { PRICING } from '@/lib/llm-cost';
import { costUsd } from '@/lib/llm-cost-core';
import { telemetryContextFor, type TelemetryRequestContext } from '@/lib/retrieval-telemetry-core';
import {
  declareNoteRuns, readRetrievalTelemetry, TelemetryDeclarationError,
  type LifecycleHandle, type ManifestDefectsByRole,
} from '@/lib/retrieval-telemetry-store';
import { startInvocation } from '@/lib/retrieval-invocation-store';
import { settleOwned, outcomeForOwnedSave } from '@/lib/retrieval-settlement';
import {
  planRunCreate, planTick, canStartRun, advanceAfterTick, planStatusChange, RUN_MODEL_PREFIXES,
  type BackfillRun,
} from '@/lib/backfill-runs-core';
import {
  activeRun, currentRun, createRun, recentRuns, setRunCursor, setRunStatus, addRunProgress,
  usageForTrace, servedCallForAudit,
} from '@/lib/backfill-runs';

const WORKER = 'opd' as const;

async function authed(req: NextRequest): Promise<boolean> {
  const isCron = req.headers.get('x-vercel-cron') !== null;
  const auth = req.headers.get('authorization') || '';
  const bearerOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const secret = req.nextUrl.searchParams.get('secret');
  const secretOk = !!process.env.CRON_SECRET && !!secret && secret === process.env.CRON_SECRET;
  if (isCron || bearerOk || secretOk) return true;
  try { return await isAdminUnlocked(); } catch { return false; }
}

/** The Gemini model THIS DEPLOYMENT will hand the audit leg — mirrors the one expression in
 *  lib/opd-note-audit.ts `defaultGenerate`. Undefined when Vertex is off for this surface. */
function deploymentGeminiAuditModel(): string | undefined {
  return geminiModelFor('doc_audit') ?? geminiUtilityModel();
}

/**
 * Resolve a run's model string to the provider + modelId the audit leg will be given.
 * ERRORS LOUD: an unresolvable or out-of-scope model is a typed error, never a substitution.
 *
 * ⚠️ §C2 — VERTEX RUNS ARE CHECKED AGAINST WHAT THE DEPLOYMENT WILL ACTUALLY USE. A `bedrock:` target
 * is threaded into the audit leg by id, so asking for it and getting it are the same event. A
 * `vertex:` run has no such lever: the leg picks its own Gemini model from env, and there is no
 * per-call override to give it. If the run names a model this deployment would not use, the row's
 * stamp would be a claim nothing could keep — so the run is REFUSED here, at creation and at every
 * tick, rather than silently graded by a different Gemini than the one the experiment named.
 */
type RunModel = { ok: true; provider: LabProvider; modelId: string } | { ok: false; error: string };

function resolveRunModel(model: string): RunModel {
  const r = resolveProvider(model, MINI_MODEL);
  if (!r.ok) return { ok: false, error: r.error };
  if (r.provider !== 'bedrock' && r.provider !== 'vertex') {
    return { ok: false, error: `run model '${model}' resolves to ${r.provider}, and backfill runs accept ${RUN_MODEL_PREFIXES.join(' / ')} only (PRD decision 2 + bake-off gap 2). Never falls back.` };
  }
  if (r.provider === 'vertex') {
    const deployed = deploymentGeminiAuditModel();
    if (!deployed) {
      return { ok: false, error: `run model '${model}' is a vertex run, but this deployment routes the OPD audit leg to no Gemini model (GEMINI_ALL / GEMINI_DOC_AUDIT unset, or Vertex unconfigured). A run that cannot be served by the model it names is refused, never substituted.` };
    }
    if (!modelsAgree(deployed, r.model)) {
      return { ok: false, error: `run model '${model}' names a Gemini this deployment will not use — the audit leg resolves to '${deployed}'. The run is refused rather than graded by one model and stamped with another (F11).` };
    }
    return { ok: true, provider: 'vertex', modelId: deployed };
  }
  return { ok: true, provider: 'bedrock', modelId: r.model };
}

/**
 * Grade up to `n` un-audited notes for `day` on the run's model.
 *
 * ⚠️ THE FILL-ONLY GUARANTEE (§4.3.3) IS THIS FUNCTION'S FIRST THREE STATEMENTS, and it is
 * UNCHANGED from the autopilot it replaces: `auditedUidsForDayInLine` (anything in the current
 * engine LINE, not the exact version — an exact match reset the whole day on every bump) plus
 * `cloudAuditedUidsForDay`, both fed to the fetch as a skip list, and `ON CONFLICT DO NOTHING`
 * inside saveOpdAudit as the last line of defence. This is what makes a prod-line label safe.
 */
async function processRunBatch(run: BackfillRun, day: string, resolved: Extract<RunModel, { ok: true }>, ctx: TelemetryRequestContext) {
  const { provider, modelId } = resolved;
  const total = await countOpdNotesForDay(day);
  const already = await auditedUidsForDayInLine(day);
  const cloudDone = await cloudAuditedUidsForDay(day);
  const skip = [...new Set([...already, ...cloudDone])];
  const rows = total > skip.length ? await fetchOpdNotesForDay(day, skip, run.n_per_tick) : [];

  // The worker's declaration shape, over this tick's note set, before any provider work (D10).
  // Fail-closed here too: the caller turns a TelemetryDeclarationError into a 503 and the tick
  // grades nothing, which is the same trade the worker makes and for the same reason.
  const runIds = await declareNoteRuns(ctx, rows as Array<Record<string, unknown>>, OPD_ENGINE_VERSION);

  const results: Record<string, unknown>[] = [];
  let processed = 0, failed = 0, tokensIn = 0, tokensOut = 0, cost = 0;
  let lastError: string | null = null;

  for (const [idx, row] of rows.entries()) {
    const started = Date.now();
    let handle: LifecycleHandle = {
      invocationId: ctx.invocationId,
      runs: [{ role: 'primary', runId: runIds[idx], expectedRevision: 0 }],
      persistenceIntent: 'will_persist',
    };
    let published = false;
    /** The last map the callback delivered (v10 requirement 4), for the paths that return no audit. */
    let publishedDefects: ManifestDefectsByRole | undefined;
    try {
      // No `pipeline: 'mini'`, no `engineTag`: the row carries the PLAIN prod engine version.
      // ⚠️ ONE THREADING RULE, TWO PROVIDERS. A bedrock run hands the leg its modelId (the S2 path,
      // unchanged); a VERTEX run passes nothing, because the production audit path IS the Gemini
      // arm — that is the whole point of §C2, and inventing a second way to reach Gemini here would
      // make the arm something other than "what production does".
      const audit = await auditOpdNote(row, {
        ...(provider === 'bedrock' ? { bedrockModel: modelId } : {}),
        telemetry: { ctx, route: 'opd_audit_mini_backfill', persistenceIntent: 'will_persist' },
        predeclaredTelemetry: { primary: { runId: runIds[idx], expectedRevision: 0 } },
        // ⚠️ `if (d)` IS LOAD-BEARING. The DECLARATION publication passes no map, and letting it
        // overwrite a real one with undefined would throw away the verdict this exists to keep.
        onLifecycleHandleUpdated: (h, d) => { handle = h; published = true; if (d) publishedDefects = d; },
      });
      // ⚠️ THE MODEL STAMP IS WHAT SERVED, READ BACK OFF THIS NOTE'S OWN TRACE. The autopilot
      // stamped MINI_MODEL, which was true for it and would be a lie for this runner; S2 stamped
      // the resolved bedrock id, which was true because that branch has no ladder. Neither is safe
      // for vertex, whose ladder may answer from the OpenRouter tier. A row that names a model
      // which did not grade it is the F11 defect class.
      const served = await servedCallForAudit(audit.traceId);
      // A DISAGREEMENT IS A REFUSAL, NOT A CORRECTION. Storing "whoever answered" would quietly
      // fill an experiment's day with a different grader's rows; the note stays un-audited and the
      // sweep re-offers it, which is exactly how the fill-only runner retries.
      if (served.model && !modelsAgree(served.model, modelId)) {
        throw new Error(`DEC-2: run ${run.id} asked ${provider}:${modelId} but ${served.provider ?? '?'}:${served.model} answered — no row written`);
      }
      // ⚠️ THE ROLE MAP, NOT A FLAT LIST (pass 0b). Settlement applies each run's own role's
      // verdict; passing one merged array is what made a normative defect dirty the primary row.
      // ⚠️ NO `?? {}` (v10 requirement 5). An empty map is NOT "no map": under requirement 6 a
      // PROVIDED map carrying no key for a role settles that linkable role partial, so `?? {}` would
      // have made every uninstrumented save partial and left requirement 7 unreachable. The attached
      // map first, then whatever the callback delivered, then undefined — which is a real answer.
      const defectsByRole = readRetrievalTelemetry(audit)?.manifestDefectsByRole ?? publishedDefects;
      let linked = false;
      const status = await saveOpdAudit(audit, {
        model: served.model ?? modelId, provider: served.provider ?? provider, latencyMs: Date.now() - started,
      }, {
        onPersisted: async ({ status: st, auditId }) => {
          linked = true;
          await settleOwned(handle, outcomeForOwnedSave(st), auditId, defectsByRole);
        },
      });
      if (!linked) await settleOwned(handle, outcomeForOwnedSave(status), null, defectsByRole);
      const usage = await usageForTrace(audit.traceId);
      const usd = costUsd(served.model ?? modelId, usage.tokensIn, usage.tokensOut, false, PRICING);
      tokensIn += usage.tokensIn; tokensOut += usage.tokensOut; cost += usd;
      if (status === 'inserted') processed++;
      results.push({ uid: audit.keys.uid, index: audit.scorecard.headline, band: audit.scorecard.band, status, ms: Date.now() - started, model: served.model ?? modelId, provider: served.provider ?? provider, tokens_in: usage.tokensIn, tokens_out: usage.tokensOut, usd: Number(usd.toFixed(4)), traceId: audit.traceId ?? null });
    } catch (e) {
      // ⚠️ THE DEC-2 REFUSAL IS `persistence_refused`, NOT a generation failure (D9). It is thrown
      // from inside this try, so it arrives here alongside real audit failures and has to be told
      // apart by what it is: a decision not to persist a completed audit.
      await settleOwned(handle,
        /^DEC-2:/.test(String((e as Error).message)) ? 'persistence_refused'
          : published ? 'audit_generation_failed' : 'retrieval_not_run');
      // A NOTE that fails is data, not an outage: count it, record why, keep going. A whole run
      // must not be lost to one unparseable note.
      failed++;
      lastError = String((e as Error).message).slice(0, 500);
      results.push({ uid: String((row as Record<string, unknown>).uid || ''), error: lastError, ms: Date.now() - started });
    }
  }

  const audited = already.length + processed;
  const skippedCloud = cloudDone.filter((u) => !already.includes(u)).length;
  return {
    day, total, audited, processed, failed, skippedCloud,
    remaining: Math.max(0, total - audited - skippedCloud),
    dayComplete: total === 0 || audited + skippedCloud >= total,
    tokensIn, tokensOut, cost, lastError, results,
  };
}

/** The cron tick (?auto=1): work the ACTIVE run for this worker. */
async function autoTick(headers?: Headers): Promise<Record<string, unknown>> {
  const run = await activeRun(WORKER);
  const plan = planTick(run);

  if (plan.action === 'idle') {
    await logTick({ status: 'paused', note: plan.reason });
    return { auto: true, idle: true, note: plan.reason };
  }
  if (plan.action === 'skip') {
    await logTick({ status: plan.status === 'done' ? 'finished' : 'paused', note: plan.reason, run_id: run!.id });
    // §C4: every status write on this path is a TICK write and carries the still-active guard.
    if (plan.status === 'done') await setRunStatus(run!.id, 'done', null, { onlyIfActive: true });
    return { auto: true, skipped: plan.reason, run_id: run!.id, status: plan.status };
  }

  const active = run as BackfillRun;
  const lock = (await getSettings([MB_KEYS.lock]))[MB_KEYS.lock] || null;
  if (lockHeld(lock)) {
    await logTick({ status: 'locked', note: 'previous tick still running', run_id: active.id });
    return { auto: true, skipped: 'previous tick still running (soft lock)', run_id: active.id };
  }

  const resolved = resolveRunModel(active.model);
  if (!resolved.ok) {
    await setRunStatus(active.id, 'error', resolved.error, { onlyIfActive: true });
    await logTick({ status: 'error', note: resolved.error.slice(0, 200), run_id: active.id });
    return { auto: true, run_id: active.id, status: 'error', error: resolved.error };
  }
  // Reachability is re-checked EVERY tick, not only at creation: the rollback for this whole build
  // is unsetting a BEDROCK_* var, and a run that kept grinding against an unreachable provider would
  // turn that rollback into a wall of failed notes instead of one visible errored run.
  // ⚠️ §C2 — IT PROBES THE RUN'S OWN PROVIDER. It was hardcoded to 'bedrock' at both sites, which
  // for a vertex run would have asked an unrelated question: a deployment with the BEDROCK_* vars
  // unset would error a perfectly healthy Gemini run, and one with Vertex unconfigured would sail
  // past the check and fail note by note.
  if (!probeReachable(resolved.provider)) {
    const msg = `${resolved.provider} is not reachable in this deployment (credentials/env) — run set to error, resumable once configured`;
    await setRunStatus(active.id, 'error', msg, { onlyIfActive: true });
    await logTick({ status: 'error', note: msg, run_id: active.id });
    return { auto: true, run_id: active.id, status: 'error', error: msg };
  }

  await setSetting(MB_KEYS.lock, new Date().toISOString());
  try {
    // One invocation per tick, established at this boundary and threaded down (D11).
    const ctx = telemetryContextFor('opd_audit_mini_backfill', headers ?? null);
    await startInvocation(ctx);
    const batch = await processRunBatch(active, plan.day, resolved, ctx);
    await addRunProgress(active.id, {
      processed: batch.processed, failed: batch.failed,
      tokensIn: batch.tokensIn, tokensOut: batch.tokensOut, costUsd: batch.cost,
      lastError: batch.lastError,
    });
    const next = advanceAfterTick(active, plan.day, { processed: batch.processed, failed: batch.failed, dayComplete: batch.dayComplete });
    await setRunCursor(active.id, next.cursor, next.status);

    const okRuns = batch.results.filter((r) => !('error' in r));
    const avgMs = okRuns.length ? Math.round(okRuns.reduce((s, r) => s + Number(r.ms), 0) / okRuns.length) : null;
    await logTick({
      status: next.finished ? 'finished' : (batch.failed > 0 && batch.processed === 0 ? 'error' : 'running'),
      processed: batch.processed, day: plan.day, avg_ms: avgMs, run_id: active.id,
      note: batch.failed ? `${batch.failed} note error(s) this tick` : null,
    });
    return {
      auto: true, run_id: active.id, model: active.model, provider: resolved.provider, engine: OPD_ENGINE_VERSION,
      day: plan.day, cursor: next.cursor, status: next.status, finished: next.finished,
      total: batch.total, audited: batch.audited, processed: batch.processed, failed: batch.failed,
      remaining: batch.remaining, skippedCloud: batch.skippedCloud,
      tokens_in: batch.tokensIn, tokens_out: batch.tokensOut, cost_usd: Number(batch.cost.toFixed(4)),
      throughput: avgMs ? { avg_ms_per_note: avgMs } : null,
      results: batch.results,
    };
  } catch (e) {
    // A TICK that fails is infrastructure — every note in this run would fail the same way. Error
    // the run: loud, visible, resumable, and it stops burning the range against a broken provider.
    // A TelemetryDeclarationError arrives here too: it is a refusal to start, so the tick grades
    // nothing and the run is errored and resumable, exactly as for an unreachable provider.
    const msg = e instanceof TelemetryDeclarationError
      ? `503 ${e.message}`
      : String((e as Error).message).slice(0, 500);
    await setRunStatus(active.id, 'error', msg, { onlyIfActive: true });
    await logTick({ status: 'error', note: msg.slice(0, 200), run_id: active.id });
    return { auto: true, run_id: active.id, status: 'error', error: msg };
  } finally {
    await setSetting(MB_KEYS.lock, '').catch(() => {});
  }
}

async function statusPayload(): Promise<Record<string, unknown>> {
  const [active, recent] = await Promise.all([activeRun(WORKER), recentRuns(WORKER, 20)]);
  return {
    worker: WORKER, engine: OPD_ENGINE_VERSION, active_run: active, recent_runs: recent,
    bedrock_reachable: probeReachable('bedrock'),
    // §C2 — both accepted run providers are reported, so an operator can see WHICH arm this
    // deployment could start before they try to start it.
    vertex_reachable: probeReachable('vertex'),
    vertex_audit_model: deploymentGeminiAuditModel() ?? null,
  };
}

export async function GET(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (req.nextUrl.searchParams.get('auto') === '1') {
    try { return NextResponse.json({ ok: true, ...(await autoTick(req.headers)) }); }
    catch (e) {
      await logTick({ status: 'error', note: String((e as Error).message).slice(0, 200) });
      return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
    }
  }
  try { return NextResponse.json({ ok: true, ...(await statusPayload()) }); }
  catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}

/**
 * §C3 — run control. On THIS route rather than a sibling, deliberately: the tick, the control
 * actions and the status view are one object's lifecycle, they share an auth function and a worker
 * constant, and a console (S3) fetching one path cannot drift between two. The MCP surface in S3
 * calls the same actions with `source:'mcp'`.
 *
 * Actions: start_run {model, dayFrom, dayTo, nPerTick} · pause · resume · stop · status.
 */
export async function POST(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { /* empty body ⇒ status */ }
  const action = String(body.action ?? 'status').trim().toLowerCase();

  try {
    if (action === 'status') return NextResponse.json({ ok: true, ...(await statusPayload()) });

    if (action === 'start_run') {
      const plan = planRunCreate({ ...body, worker: WORKER, source: body.source });
      if (!plan.ok) return NextResponse.json({ ok: false, error: plan.error }, { status: 400 });
      // ONE ACTIVE RUN PER WORKER (§4.3.1) — a typed refusal, not a queue.
      const gate = canStartRun(await activeRun(WORKER));
      if (!gate.ok) return NextResponse.json({ ok: false, error: gate.error }, { status: 409 });
      // Resolve + reachability-check BEFORE the row exists: a run that could never have worked
      // should not appear in the history as one that failed.
      const resolved = resolveRunModel(plan.model);
      if (!resolved.ok) return NextResponse.json({ ok: false, error: resolved.error }, { status: 400 });
      if (!probeReachable(resolved.provider)) {
        const why = resolved.provider === 'bedrock'
          ? 'BEDROCK_REGION / BEDROCK_ROLE_ARN / BEDROCK_OIDC_AUDIENCE / GCP_SA_KEY'
          : 'the Vertex credentials (GCP_SA_KEY / GCP_PROJECT / GEMINI_MODEL)';
        return NextResponse.json({ ok: false, error: `${resolved.provider} is not reachable in this deployment (${why}) — refusing to create a run that cannot run` }, { status: 400 });
      }
      const created = await createRun(plan);
      return NextResponse.json({ ok: true, run: created, engine: OPD_ENGINE_VERSION, provider: resolved.provider, model_id: resolved.modelId });
    }

    if (action === 'pause' || action === 'resume' || action === 'stop') {
      const target = await currentRun(WORKER);
      if (!target) return NextResponse.json({ ok: false, error: 'no run to act on for this worker' }, { status: 404 });
      const change = planStatusChange(target.status, action);
      if (!change.ok) return NextResponse.json({ ok: false, error: change.error }, { status: 409 });
      await setRunStatus(target.id, change.status);
      return NextResponse.json({ ok: true, run_id: target.id, status: change.status });
    }

    return NextResponse.json({ ok: false, error: `unknown action '${action}' — expected start_run | pause | resume | stop | status` }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
