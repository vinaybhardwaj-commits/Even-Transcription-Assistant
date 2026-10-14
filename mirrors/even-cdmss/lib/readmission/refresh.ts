/**
 * lib/readmission/refresh.ts — the R4.1 TEMPLATE-REFRESH run, IMPURE half (CDMSS-READMISSIONS-
 * R4.1-PRD v1.0 R41-4..R41-7): the delta detector, the Opus-4.6-on-Bedrock transport for the recon
 * legs, the single-case PROBE (S2 discipline — no run touches real backlog until every recon leg
 * has closed valid JSON on Opus for the current prompt fingerprints), the in-place re-analysis,
 * and the run type on the Bedrock backfill rails (lib/backfill-runs*.ts, reused not forked).
 *
 * WHAT A REFRESH DOES to one audited finding whose stays now carry final OT / PAC / progress rows
 * the stored templateCoverage does not reflect: full re-assemble (assembleForRow — templates
 * included) → the SAME recon sequence as the Vertex audit (run.ts runReconSequence; prompt
 * builders byte-identical, fingerprint-pinned) answered by Opus → saveAuditResult IN PLACE at
 * (dedup_key, engine 0.2) — deriveJudgements re-runs untouched inside it, provider + model
 * stamped off the trace (DEC-2) → the narrative rewritten (source 'refresh') with its ledger =
 * the catalog the legs just read (no stale-id filter needed) → a `lastRefresh` note on the blob.
 * No parallel rows, no engine bump, no board blank. The badge may move only because a re-derived
 * `avoidable` moved (R41-6).
 *
 * VERTEX PATH: zero-diff. runReadmissionAudit still injects vertexPass (byte-identical
 * tracedChat options); this file never touches the worker route or its box arithmetic.
 *
 * SCHEDULING: never auto-started. Ticked by the idle-OPD backfill cron hook (after the narrative
 * worker had nothing to do) and by /api/admin/readmission-refresh?auto=1. One case per tick.
 */
import { startTrace, finishTrace, tracedChat } from '../trace';
import { modelsAgree, TEXT_MODEL } from '../llm';
import { probeReachable } from '../lab-override';
import { getSettings, setSetting, lockHeld, logTick, getTicks } from '../mini-backfill';
import {
  planTick, advanceAfterTick, rollingPace, estimateRunEta, isStalled, canStartRun, planRunCreate, planStatusChange,
  isDay, type BackfillRun, type RunCreatePlan,
} from '../backfill-runs-core';
import { activeRun, currentRun, createRun, recentRuns, setRunCursor, setRunStatus, addRunProgress, usageForTrace, servedCallForAudit } from '../backfill-runs';
import { PRICING } from '../llm-cost';
import { costUsd } from '../llm-cost-core';
import { parsePassClaims } from '../readmission-prompts';
import type { PassClaims, ReadmissionFinding } from '../readmission-reconcile-core';
import { NARRATIVE_MODEL, NARRATIVE_MODEL_ID, type CaseArtefacts } from '../readmission-narrative-core';
import {
  REFRESH_WORKER, REFRESH_N_PER_TICK, REFRESH_LEG_BUDGET_MS, REFRESH_LEG_MAX_TRIES, REFRESH_NARRATIVE_BUDGET_MS, REFRESH_PROBE_KEY,
  reconPromptFingerprints, probePassed, probeUnlocksRun, refreshDelta, refreshLanded, countsForStay, REFRESH_MAX_ATTEMPTS,
  type ProbeLeg, type ProbeRecord, type TemplateKey,
} from '../readmission-refresh-core';
import { assembleForRow, runReconSequence, type PassFn } from './run';
import { composeCaseArtefacts } from './narrative';
import { resolveNarrativeRunModel } from './narrative-backfill';
import { fetchTemplateExistence } from './db13';
import {
  auditedRowsForRefresh, auditedRowForNarrative, saveAuditResult, saveCaseArtefacts, READMIT_ENGINE_VERSION, type NarrativeRow, type PendingRow,
} from './store';
import { asJson } from './surface-row';

export const REFRESH_LOCK_KEY = 'readmit_refresh_lock';
export const REFRESH_TICK_BUDGET_MS = 200_000;

// ── the Opus transport for the recon legs (R41-4) ────────────────────────────────────────

/** Byte-identical prompt in, Opus 4.6 on Bedrock answering — no ladder, no fallback, one try. */
export function bedrockPass(traceId: string): PassFn {
  return async (label, prompt): Promise<PassClaims | null> => {
    const r = await tracedChat(traceId, label, {
      model: TEXT_MODEL,   // nominal — the bedrock target outranks it and has no ladder
      messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
      temperature: 0.1,
      max_tokens: 3000,
    }, { bedrock: NARRATIVE_MODEL_ID, timeoutMs: REFRESH_LEG_BUDGET_MS, maxTries: REFRESH_LEG_MAX_TRIES });
    const content: string = r?.choices?.[0]?.message?.content ?? '';
    return parsePassClaims(content);
  };
}

// ── the delta detector ───────────────────────────────────────────────────────────────────

export interface RefreshCandidate { row: NarrativeRow; sources: TemplateKey[]; attempts: number }
export interface RefreshScan { ok: boolean; reason?: string; scanned: number; pending: RefreshCandidate[]; stuck: number; detectorUnavailable: boolean }

const refreshMeta = (blob: (ReadmissionFinding & CaseArtefacts & { refreshAttempts?: number; lastRefresh?: unknown }) | null) => ({
  coverage: blob?.templateCoverage ?? null,
  attempts: Number(blob?.refreshAttempts ?? 0) || 0,
});

/** Which audited findings (optionally on one audited_at UTC day) are refresh-pending NOW. One
 *  db13 round (three batched counts) per scan; a db13 fault → detectorUnavailable, nothing pending. */
export async function scanRefreshPending(opts: { day?: string | null } = {}): Promise<RefreshScan> {
  const rows = await auditedRowsForRefresh({ day: opts.day ?? null });
  const ids = rows.flatMap((r) => [r.index_encounter_id, r.finding_class === 'out_of_network' ? null : r.readmit_encounter_id]);
  const ex = await fetchTemplateExistence(ids);
  if (!ex.ok) return { ok: false, reason: 'db13 template existence read failed — detector unavailable this tick', scanned: rows.length, pending: [], stuck: 0, detectorUnavailable: true };
  const pending: RefreshCandidate[] = [];
  let stuck = 0;
  for (const r of rows) {
    const blob = asJson<ReadmissionFinding & CaseArtefacts & { refreshAttempts?: number }>(r.finding);
    const meta = refreshMeta(blob);
    const counts = countsForStay(ex.byEncounter, [r.index_encounter_id, r.finding_class === 'out_of_network' ? null : r.readmit_encounter_id]);
    const d = refreshDelta(meta.coverage, counts, meta.attempts);
    if (d.stuck) stuck++;
    if (d.pending) pending.push({ row: r, sources: d.sources, attempts: meta.attempts });
  }
  return { ok: true, scanned: rows.length, pending, stuck, detectorUnavailable: false };
}

// ── one case: re-analyze (probe or refresh) ──────────────────────────────────────────────

export interface RefreshOneResult {
  dedupKey: string;
  ok: boolean;
  reason?: string;
  legs: ProbeLeg[];
  judgements?: { planned: string | null; sameCondition: string | null; avoidable: string | null; nOmissions: number };
  coverage?: unknown;
  narrativeValid?: boolean | null;
  saved: boolean;
  ms: number;
  tokensIn: number;
  tokensOut: number;
  usd: number;
  traceId: string | null;
  model: string | null;
  provider: string | null;
}

/** Test seams for reanalyzeOnOpus (production never passes them). */
export interface ReanalyzeDeps {
  assemble?: typeof assembleForRow;
  pass?: (traceId: string) => PassFn;
  served?: typeof servedCallForAudit;
  saveAudit?: typeof saveAuditResult;
  saveArtefacts?: typeof saveCaseArtefacts;
  compose?: typeof composeCaseArtefacts;
  trace?: { start: typeof startTrace; finish: typeof finishTrace };
  usage?: typeof usageForTrace;
}

/**
 * Re-analyze ONE audited finding on Opus. `save:false` (the probe) reports and writes NO finding
 * (trace / usage rows are still written); `save:true` (the refresh) writes in place. Never throws.
 *
 * ADDENDUM A1 — THE ATTEMPT CAP IS COMPLETE: on the save path EVERY failure — re-assemble failure,
 * an unparseable / thrown leg, the DEC-2 model-disagreement refusal, the in-place write failure —
 * increments `refreshAttempts` (and records `lastRefreshError`), so a case that keeps failing is
 * parked as refresh_stuck at REFRESH_MAX_ATTEMPTS instead of being re-offered every tick at Opus
 * cost with the cursor pinned. A refresh that SUCCEEDS but whose coverage for every targeted source
 * came back `fetch_failed` read nothing new: it counts as an attempt too (no reset). The probe
 * (save:false) never touches attempts.
 */
export async function reanalyzeOnOpus(row: PendingRow, opts: { save: boolean; runId?: number | null; sources?: TemplateKey[] }, deps: ReanalyzeDeps = {}): Promise<RefreshOneResult> {
  const t0 = Date.now();
  const legs: ProbeLeg[] = [];
  const base = { dedupKey: row.dedup_key, legs, saved: false, tokensIn: 0, tokensOut: 0, usd: 0, traceId: null as string | null, model: null as string | null, provider: null as string | null };
  const assemble = deps.assemble ?? assembleForRow;
  const served0 = deps.served ?? servedCallForAudit;
  const saveAudit = deps.saveAudit ?? saveAuditResult;
  const saveArtefacts = deps.saveArtefacts ?? saveCaseArtefacts;
  const compose = deps.compose ?? composeCaseArtefacts;
  const trace = deps.trace ?? { start: startTrace, finish: finishTrace };
  const usage = deps.usage ?? usageForTrace;
  let traceId: string | null = null;
  const attemptsSoFar = Number(asJson<{ refreshAttempts?: number }>((row as NarrativeRow).finding ?? null)?.refreshAttempts ?? 0) || 0;
  /** The ONE place a failed refresh is booked (save path only): attempts + 1, the reason, parked at the cap. */
  const bookFailure = async (reason: string): Promise<{ attempts: number; stuck: boolean }> => {
    const attempts = attemptsSoFar + 1;
    const stuck = attempts >= REFRESH_MAX_ATTEMPTS;
    if (opts.save) await saveArtefacts(row.dedup_key, { refreshAttempts: attempts, lastRefreshError: { at: new Date().toISOString(), reason: reason.slice(0, 400), attempts, stuck } }).catch(() => {});
    return { attempts, stuck };
  };
  const fail = async (reason: string, extra: Partial<RefreshOneResult> = {}): Promise<RefreshOneResult> => {
    const b = await bookFailure(reason);
    return { ...base, ...extra, ok: false, reason: `${reason}${opts.save ? ` (attempt ${b.attempts}/${REFRESH_MAX_ATTEMPTS}${b.stuck ? ' — parked as refresh_stuck' : ''})` : ''}`, ms: Date.now() - t0 };
  };
  try {
    const assembled = await assemble(row);
    if ('notAuditable' in assembled) return fail(`evidence could not be re-assembled: ${assembled.notAuditable}`);
    traceId = await trace.start(opts.save ? 'readmit_refresh' : 'readmit_refresh_probe', { dedupKey: row.dedup_key, engine: READMIT_ENGINE_VERSION, model: NARRATIVE_MODEL, runId: opts.runId ?? null });
    base.traceId = traceId;
    // Every leg is recorded — label, wall, whether the JSON closed, the verdicts parsed — so the
    // probe report reads leg by leg (S2 discipline: "closed valid JSON on all legs").
    const raw = (deps.pass ?? bedrockPass)(traceId);
    const pass: PassFn = async (label, prompt) => {
      const l0 = Date.now();
      let claims: PassClaims | null = null;
      let err: string | null = null;
      try { claims = await raw(label, prompt); } catch (e) { err = String((e as Error).message).slice(0, 200); }
      legs.push({
        label, ms: Date.now() - l0, jsonClosed: claims != null,
        verdicts: claims
          ? { planned: claims.planned?.verdict ?? null, sameCondition: claims.sameCondition?.verdict ?? null, avoidable: claims.avoidable?.verdict ?? null, omissions: claims.omissions?.length ?? 0, exculpatory: claims.exculpatory?.length ?? 0, refusals: claims.refusalRecord?.length ?? 0 }
          : { error: err ?? 'unparseable' },
      });
      return claims;
    };
    const seq = await runReconSequence({ row, inputs: assembled.inputs, indexDischargeAt: assembled.indexDischargeAt, pass });
    const finding = seq.finding;
    const judgements = { planned: finding.planned?.verdict ?? null, sameCondition: finding.sameCondition?.verdict ?? null, avoidable: finding.avoidable?.verdict ?? null, nOmissions: finding.omissions.length };

    // Who answered — off the trace, never assumed (DEC-2). A disagreement is a refusal.
    const served = await served0(traceId, legs[legs.length - 1]?.label ?? 'readmit_recon_a');
    if (served.model && !modelsAgree(served.model, NARRATIVE_MODEL_ID)) {
      await trace.finish(traceId, 'error', 'DEC-2 model disagreement');
      return fail(`DEC-2: asked ${NARRATIVE_MODEL_ID} but ${served.provider ?? '?'}:${served.model} answered — nothing saved`, { judgements });
    }
    const model = served.model ?? NARRATIVE_MODEL_ID, provider = served.provider ?? 'bedrock';

    let narrativeValid: boolean | null = null;
    let saved = false;
    let tokensIn = 0, tokensOut = 0, usd = 0;
    if (opts.save) {
      // IN PLACE at (dedup_key, engine 0.2): the SAME UPDATE the Vertex audit uses; deriveJudgements
      // re-runs untouched inside it; the whole finding blob is replaced (the artefacts are re-added
      // below; if the narrative leg fails, the narrative backfill sweep re-offers the case).
      const ok = await saveAudit({ dedupKey: row.dedup_key, status: 'audited', finding, model, provider, traceId, promoted: seq.promoted });
      if (!ok) { await trace.finish(traceId, 'partial'); return fail('re-analysis produced a finding but the in-place store write failed', { judgements }); }
      saved = true;
      const n = await compose({
        row, finding, catalog: assembled.inputs.catalog, identity: assembled.identity,
        ledgerSource: 'audit', narrativeSource: 'refresh', traceId, budgetMs: REFRESH_NARRATIVE_BUDGET_MS,
      });
      narrativeValid = n.ok ? (n.valid ?? null) : null;
      tokensIn += n.tokensIn; tokensOut += n.tokensOut; usd += n.costUsd;
      // Addendum A1: a refresh that landed rows for its targeted sources resets the counter; one whose
      // targeted sources all came back fetch_failed read nothing new — it is an ATTEMPT (increment,
      // never reset), and since fetch_failed no longer pends it cannot loop.
      const landed = refreshLanded(finding.templateCoverage ?? null, opts.sources ?? []);
      const attemptsAfter = landed ? 0 : attemptsSoFar + 1;
      await saveArtefacts(row.dedup_key, {
        lastRefresh: { at: new Date().toISOString(), runId: opts.runId ?? null, model, provider, sources: opts.sources ?? [], landed, narrative: n.ok ? (n.valid ? 'stored' : 'invalid') : 'failed', traceId },
        refreshAttempts: attemptsAfter,
        ...(landed ? {} : { lastRefreshError: { at: new Date().toISOString(), reason: 'refresh landed no template rows — every targeted source came back fetch_failed', attempts: attemptsAfter, stuck: attemptsAfter >= REFRESH_MAX_ATTEMPTS } }),
      });
    }
    // Recon-leg spend off THIS trace (all readmit_% legs); the narrative added its own above.
    for (const label of new Set(legs.map((l) => l.label))) {
      const u = await usage(traceId, label);
      tokensIn += u.tokensIn; tokensOut += u.tokensOut;
      usd += costUsd(model, u.tokensIn, u.tokensOut, false, PRICING);
    }
    await trace.finish(traceId, 'success');
    return { ...base, ok: true, judgements, coverage: finding.templateCoverage ?? null, narrativeValid, saved, ms: Date.now() - t0, tokensIn, tokensOut, usd, model, provider };
  } catch (e) {
    // An unparseable / thrown leg (or any other throw): booked like every other failure.
    const msg = String((e as Error).message).slice(0, 400);
    if (traceId) await trace.finish(traceId, 'error', msg).catch(() => {});
    return fail(msg);
  }
}

// ── the probe (R41-5) ────────────────────────────────────────────────────────────────────

/** Probe ONE named case on Opus: every recon leg's JSON closure + parsed verdicts, the derived
 *  judgements, and (unless save:true) NO write. A passed probe is recorded against the CURRENT
 *  prompt fingerprints — the run refuses to start without it. */
export async function probeCase(dedupKey: string, save = false): Promise<RefreshOneResult & { probe: ProbeRecord | null; fingerprints: string; recorded: boolean }> {
  const fingerprints = reconPromptFingerprints();
  const none = { probe: null, fingerprints, recorded: false };
  if (!probeReachable('bedrock')) return { ...none, dedupKey, ok: false, reason: 'bedrock is not reachable in this deployment', legs: [], saved: false, ms: 0, tokensIn: 0, tokensOut: 0, usd: 0, traceId: null, model: null, provider: null };
  const row = await auditedRowForNarrative(dedupKey);
  if (!row) return { ...none, dedupKey, ok: false, reason: `no audited finding '${dedupKey}' at ${READMIT_ENGINE_VERSION}`, legs: [], saved: false, ms: 0, tokensIn: 0, tokensOut: 0, usd: 0, traceId: null, model: null, provider: null };
  const r = await reanalyzeOnOpus(row, { save });
  const passed = r.ok && probePassed(r.legs);
  const record: ProbeRecord = { passed, fingerprints, dedupKey, at: new Date().toISOString(), model: NARRATIVE_MODEL, legs: r.legs, narrativeValid: r.narrativeValid ?? null, saved: r.saved };
  let recorded = false;
  // Only a PASSED probe is recorded (a failed one must not overwrite an earlier pass for the same
  // fingerprints; the report carries the failure regardless).
  if (passed) { try { await setSetting(REFRESH_PROBE_KEY, JSON.stringify(record)); recorded = true; } catch { recorded = false; } }
  return { ...r, probe: record, fingerprints, recorded };
}

/** The gate the run start reads: the stored probe vs the CURRENT fingerprints. */
export async function refreshRunUnlocked(): Promise<{ ok: true; record: ProbeRecord } | { ok: false; reason: string }> {
  const raw = (await getSettings([REFRESH_PROBE_KEY]))[REFRESH_PROBE_KEY] || null;
  return probeUnlocksRun(raw, reconPromptFingerprints());
}

// ── the run type on the rails (R41-7) ────────────────────────────────────────────────────

/** Plan a refresh run: the rails' validation, the exact Opus id, n_per_tick forced to 1. */
export function planRefreshRun(body: Record<string, unknown>): RunCreatePlan {
  const plan = planRunCreate({ ...body, worker: REFRESH_WORKER });
  if (!plan.ok) return plan;
  const m = resolveNarrativeRunModel(plan.model);
  if (!m.ok) return { ok: false, error: m.error.replace('narrative run model', 'refresh run model') };
  return { ...plan, nPerTick: REFRESH_N_PER_TICK };
}

export async function startRefreshRun(body: Record<string, unknown>): Promise<{ ok: true; run: BackfillRun; probe: ProbeRecord } | { ok: false; status: number; error: string }> {
  const plan = planRefreshRun(body);
  if (!plan.ok) return { ok: false, status: 400, error: plan.error };
  // THE PROBE GATE (R41-5): no passed probe for the current prompt fingerprints → no run. Ever.
  const gate = await refreshRunUnlocked();
  if (!gate.ok) return { ok: false, status: 412, error: `probe gate: ${gate.reason}` };
  const one = canStartRun(await activeRun(REFRESH_WORKER));
  if (!one.ok) return { ok: false, status: 409, error: one.error };
  if (!probeReachable('bedrock')) return { ok: false, status: 400, error: 'bedrock is not reachable in this deployment — refusing to create a run that cannot run' };
  const created = await createRun(plan);
  return { ok: true, run: created, probe: gate.record };
}

export async function controlRefreshRun(action: 'pause' | 'resume' | 'stop'): Promise<{ ok: true; run_id: number; status: string } | { ok: false; status: number; error: string }> {
  const target = await currentRun(REFRESH_WORKER);
  if (!target) return { ok: false, status: 404, error: 'no refresh run to act on' };
  const change = planStatusChange(target.status, action);
  if (!change.ok) return { ok: false, status: 409, error: change.error };
  // resume re-checks the gate too: prompts may have changed while paused
  if (action === 'resume') { const gate = await refreshRunUnlocked(); if (!gate.ok) return { ok: false, status: 412, error: `probe gate: ${gate.reason}` }; }
  await setRunStatus(target.id, change.status);
  return { ok: true, run_id: target.id, status: change.status };
}

export interface RefreshTickResult extends Record<string, unknown> { worker: typeof REFRESH_WORKER }

/** Work the ACTIVE refresh run: ONE pending case on the cursor day; empty days marched past. */
export async function refreshTick(): Promise<RefreshTickResult> {
  const run = await activeRun(REFRESH_WORKER);
  const plan = planTick(run);
  if (plan.action === 'idle') return { worker: REFRESH_WORKER, idle: true, note: plan.reason };
  if (plan.action === 'skip') {
    await logTick({ status: plan.status === 'done' ? 'finished' : 'paused', note: plan.reason, run_id: run!.id });
    if (plan.status === 'done') await setRunStatus(run!.id, 'done', null, { onlyIfActive: true });
    return { worker: REFRESH_WORKER, skipped: plan.reason, run_id: run!.id, status: plan.status };
  }
  const active = run as BackfillRun;
  const lock = (await getSettings([REFRESH_LOCK_KEY]))[REFRESH_LOCK_KEY] || null;
  if (lockHeld(lock)) {
    await logTick({ status: 'locked', note: 'previous refresh tick still running', run_id: active.id });
    return { worker: REFRESH_WORKER, skipped: 'previous tick still running (soft lock)', run_id: active.id };
  }
  const resolved = resolveNarrativeRunModel(active.model);
  if (!resolved.ok) {
    await setRunStatus(active.id, 'error', resolved.error, { onlyIfActive: true });
    await logTick({ status: 'error', note: resolved.error.slice(0, 200), run_id: active.id });
    return { worker: REFRESH_WORKER, run_id: active.id, status: 'error', error: resolved.error };
  }
  // The gate holds for the LIFE of the run: prompts changed mid-run → error, resumable after a new probe.
  const gate = await refreshRunUnlocked();
  if (!gate.ok) {
    await setRunStatus(active.id, 'error', `probe gate: ${gate.reason}`, { onlyIfActive: true });
    await logTick({ status: 'error', note: `probe gate: ${gate.reason}`.slice(0, 200), run_id: active.id });
    return { worker: REFRESH_WORKER, run_id: active.id, status: 'error', error: `probe gate: ${gate.reason}` };
  }
  if (!probeReachable('bedrock')) {
    const msg = 'bedrock is not reachable in this deployment — run set to error, resumable once configured';
    await setRunStatus(active.id, 'error', msg, { onlyIfActive: true });
    await logTick({ status: 'error', note: msg, run_id: active.id });
    return { worker: REFRESH_WORKER, run_id: active.id, status: 'error', error: msg };
  }

  await setSetting(REFRESH_LOCK_KEY, new Date().toISOString());
  const t0 = Date.now();
  try {
    let day = plan.day;
    let cursor = day, status = active.status, finished = false;
    let processed = 0, failed = 0, tokensIn = 0, tokensOut = 0, cost = 0, emptyDays = 0;
    let lastError: string | null = null;
    let result: RefreshOneResult | null = null;
    let pendingOnDay = 0, stuckOnDay = 0, detectorUnavailable = false;
    for (;;) {
      const scan = await scanRefreshPending({ day });
      if (scan.detectorUnavailable) { detectorUnavailable = true; lastError = scan.reason ?? null; break; }   // cursor stays; next tick re-asks
      stuckOnDay = scan.stuck;
      const next = scan.pending[0] ?? null;
      if (next) {
        result = await reanalyzeOnOpus(next.row, { save: true, runId: active.id, sources: next.sources });
        tokensIn += result.tokensIn; tokensOut += result.tokensOut; cost += result.usd;
        if (result.ok) processed++; else { failed++; lastError = (result.reason ?? 'unknown').slice(0, 500); }
      }
      // Remaining on this day after this tick's work: a failed case stays pending (re-offered next
      // tick until the attempt cap parks it); a stuck case is not pending. Cursor moves only at 0.
      pendingOnDay = Math.max(0, scan.pending.length - (result?.ok ? 1 : 0));
      const dayComplete = pendingOnDay === 0;
      const adv = advanceAfterTick(active, day, { processed, failed, dayComplete });
      cursor = adv.cursor; status = adv.status; finished = adv.finished;
      await setRunCursor(active.id, adv.cursor, adv.status);
      if (next || !dayComplete || finished) break;
      emptyDays++;
      if (emptyDays >= 40 || Date.now() - t0 > REFRESH_TICK_BUDGET_MS) break;
      day = adv.cursor;
      if (!isDay(day)) break;
    }
    await addRunProgress(active.id, { processed, failed, tokensIn, tokensOut, costUsd: cost, lastError });
    await logTick({
      status: finished ? 'finished' : (failed > 0 && processed === 0 && result ? 'error' : 'running'),
      processed, day: plan.day, avg_ms: result?.ok ? result.ms : null, run_id: active.id,
      note: [failed ? `${failed} case error(s)` : null, stuckOnDay ? `${stuckOnDay} stuck (attempt-capped)` : null, detectorUnavailable ? 'detector unavailable (db13)' : null, emptyDays ? `${emptyDays} empty day(s) skipped` : null].filter(Boolean).join(' · ') || null,
    });
    return {
      worker: REFRESH_WORKER, run_id: active.id, model: active.model, provider: 'bedrock', engine: READMIT_ENGINE_VERSION,
      day: plan.day, cursor, status, finished, processed, failed, pending_on_day: pendingOnDay, stuck_on_day: stuckOnDay,
      detector_unavailable: detectorUnavailable, empty_days_skipped: emptyDays,
      tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: Number(cost.toFixed(4)), result,
    };
  } catch (e) {
    const msg = String((e as Error).message).slice(0, 500);
    await setRunStatus(active.id, 'error', msg, { onlyIfActive: true });
    await logTick({ status: 'error', note: msg.slice(0, 200), run_id: active.id });
    return { worker: REFRESH_WORKER, run_id: active.id, status: 'error', error: msg };
  } finally {
    await setSetting(REFRESH_LOCK_KEY, '').catch(() => {});
  }
}

/** The progress surface + the refresh-pending count (whole engine, all days). */
export async function refreshStatus(nowMs: number = Date.now()): Promise<Record<string, unknown>> {
  const [active, recent, ticks, scan, gate] = await Promise.all([
    activeRun(REFRESH_WORKER).catch(() => null),
    recentRuns(REFRESH_WORKER, 20).catch(() => []),
    getTicks(48).catch(() => []),
    scanRefreshPending({}),
    refreshRunUnlocked(),
  ]);
  const pace = active ? rollingPace(ticks, active.id) : null;
  const eta = active && pace ? estimateRunEta(active, pace) : null;
  const stalled = active ? isStalled({ active: active.status === 'active', lastProgressMs: active.updated_at ? Date.parse(active.updated_at) : null }, nowMs) : false;
  const byDay = new Map<string, number>();
  for (const c of scan.pending) { const d = (c.row.audited_at ?? '').slice(0, 10); byDay.set(d, (byDay.get(d) ?? 0) + 1); }
  return {
    worker: REFRESH_WORKER, engine: READMIT_ENGINE_VERSION, model: NARRATIVE_MODEL, n_per_tick: REFRESH_N_PER_TICK,
    bedrock_reachable: probeReachable('bedrock'),
    prompt_fingerprints: reconPromptFingerprints(),
    probe_gate: gate.ok ? { unlocked: true, probe: gate.record } : { unlocked: false, reason: gate.reason },
    refresh_pending: scan.pending.length, refresh_stuck: scan.stuck, scanned: scan.scanned, detector_unavailable: scan.detectorUnavailable,
    pending_by_audited_day: Object.fromEntries([...byDay.entries()].sort()),
    pending_sample: scan.pending.slice(0, 20).map((c) => ({ dedup_key: c.row.dedup_key, sources: c.sources, attempts: c.attempts })),
    active_run: active, recent_runs: recent, pace, eta, stalled,
  };
}
