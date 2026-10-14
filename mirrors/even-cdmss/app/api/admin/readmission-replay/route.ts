export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * READMISSION REPLAY (CDMSS-READMISSIONS-R8.1-FINDING-VERSIONS PRD v1.0, V2/O3/O5,
 * 20 Aug 2026) — a manual research tool for measuring VERDICT STABILITY: re-assemble one
 * audited case, run the SAME recon legs the refresh runs (assembleForRow + runReconSequence,
 * reused not forked), on the model named in the request (Bedrock only; default Opus 4.6),
 * 1–3 runs, and write ONE snapshot per successful run to readmission_finding_versions with
 * capture_reason 'replay'.
 *
 * O5 IS THE CONTRACT: the replay writes snapshots and nothing else. It NEVER writes
 * readmission_findings, app_settings or backfill_runs — a stability run must not silently
 * become a re-audit. (Trace / usage rows are still written, as the refresh probe's are.)
 * The snapshot insert THROWS on failure (O2) — surfaced as a 500, never swallowed.
 *
 * The response says plainly that the evidence was re-fetched from db13 and may differ from
 * the evidence the live row saw; template_coverage on each snapshot is what lets a reader
 * check before treating two verdicts as one stability pair.
 *
 * Auth: Vercel cron header / Bearer|?secret=CRON_SECRET / admin session — the refresh
 * runner's block, copied.
 *   GET  ?dedup_key=X                                  → the per-case version list (fail-safe:
 *                                                        DB error = empty list + error line, never a 500)
 *   POST {action:'replay', dedup_key, runs?, model?}    → 1–3 stability runs, snapshots + per-run verdicts
 *   POST {action:'list', dedup_key}                     → the same per-case list
 */
import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { startTrace, finishTrace, tracedChat } from '@/lib/trace';
import { modelsAgree, TEXT_MODEL } from '@/lib/llm';
import { probeReachable } from '@/lib/lab-override';
import { parsePassClaims } from '@/lib/readmission-prompts';
import type { PassClaims } from '@/lib/readmission-reconcile-core';
import { deriveJudgements, JUDGEMENT_RULE_VERSION } from '@/lib/readmission-reconcile-core';
import { REFRESH_LEG_BUDGET_MS, REFRESH_LEG_MAX_TRIES, type ProbeLeg } from '@/lib/readmission-refresh-core';
import { servedCallForAudit, usageForTrace } from '@/lib/backfill-runs';
import { PRICING } from '@/lib/llm-cost';
import { costUsd } from '@/lib/llm-cost-core';
import { assembleForRow, runReconSequence, type PassFn } from '@/lib/readmission/run';
import { auditedRowForNarrative, READMIT_ENGINE_VERSION } from '@/lib/readmission/store';
import { insertSnapshot, listVersionsForCase } from '@/lib/readmission/versions-store';
import {
  buildReplaySnapshot, isDedupKeyShape, parseReplayModel, validateRuns, REPLAY_EVIDENCE_NOTE,
} from '@/lib/readmission-versions-core';

async function authed(req: NextRequest): Promise<boolean> {
  const isCron = req.headers.get('x-vercel-cron') !== null;
  const auth = req.headers.get('authorization') || '';
  const bearerOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const secret = req.nextUrl.searchParams.get('secret');
  const secretOk = !!process.env.CRON_SECRET && !!secret && secret === process.env.CRON_SECRET;
  if (isCron || bearerOk || secretOk) return true;
  try { return await isAdminUnlocked(); } catch { return false; }
}

/** bedrockPass's transport, on the REQUESTED model id — bedrockPass itself pins Opus 4.6,
 *  and O3 says the replay runs on the model named in the request, so the pin moves here. */
function passOnModel(traceId: string, bedrockModelId: string): PassFn {
  return async (label, prompt): Promise<PassClaims | null> => {
    const r = await tracedChat(traceId, label, {
      model: TEXT_MODEL,   // nominal — the bedrock target outranks it and has no ladder
      messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
      temperature: 0.1,
      max_tokens: 3000,
    }, { bedrock: bedrockModelId, timeoutMs: REFRESH_LEG_BUDGET_MS, maxTries: REFRESH_LEG_MAX_TRIES });
    const content: string = r?.choices?.[0]?.message?.content ?? '';
    return parsePassClaims(content);
  };
}

interface ReplayRunOut extends Record<string, unknown> { run: number; ok: boolean }

export async function GET(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const key = String(req.nextUrl.searchParams.get('dedup_key') ?? '').trim();
  if (!key || !isDedupKeyShape(key)) return NextResponse.json({ ok: false, error: 'dedup_key required' }, { status: 400 });
  const list = await listVersionsForCase(key);
  return NextResponse.json({ ok: true, dedup_key: key, engine_version: READMIT_ENGINE_VERSION, count: list.rows.length, versions: list.rows, error: list.error });
}

export async function POST(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { /* empty ⇒ 400 below */ }
  const action = String(body.action ?? 'replay').trim().toLowerCase();
  try {
    const key = String(body.dedup_key ?? '').trim();
    if (!key || !isDedupKeyShape(key)) return NextResponse.json({ ok: false, error: 'dedup_key required' }, { status: 400 });

    if (action === 'list') {
      const list = await listVersionsForCase(key);
      return NextResponse.json({ ok: true, dedup_key: key, engine_version: READMIT_ENGINE_VERSION, count: list.rows.length, versions: list.rows, error: list.error });
    }
    if (action !== 'replay') {
      return NextResponse.json({ ok: false, error: `unknown action '${action}' — expected replay | list` }, { status: 400 });
    }

    const runsV = validateRuns(body.runs);
    if (!runsV.ok) return NextResponse.json({ ok: false, error: runsV.error }, { status: 400 });
    const modelV = parseReplayModel(body.model);
    if (!modelV.ok) return NextResponse.json({ ok: false, error: modelV.error }, { status: 400 });
    if (!probeReachable('bedrock')) {
      return NextResponse.json({ ok: false, error: 'bedrock is not reachable in this deployment' }, { status: 400 });
    }
    const row = await auditedRowForNarrative(key);
    if (!row) return NextResponse.json({ ok: false, error: `no audited finding '${key}' at ${READMIT_ENGINE_VERSION}` }, { status: 404 });

    // ONE re-assemble per request (the PRD's singular "re-assemble the case"): every run in
    // this request reads the SAME re-fetched evidence, so run-to-run disagreement measures
    // the model, not db13 drift between runs. The note below covers the request-vs-live gap.
    const assembled = await assembleForRow(row);
    if ('notAuditable' in assembled) {
      return NextResponse.json({ ok: false, error: `evidence could not be re-assembled: ${assembled.notAuditable}`, note: REPLAY_EVIDENCE_NOTE });
    }

    const runs: ReplayRunOut[] = [];
    for (let i = 0; i < runsV.runs; i++) {
      const t0 = Date.now();
      const legs: ProbeLeg[] = [];
      const traceId = await startTrace('readmit_replay', { dedupKey: key, engine: READMIT_ENGINE_VERSION, model: modelV.model, run: i + 1, runs: runsV.runs });
      const raw = passOnModel(traceId, modelV.modelId);
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

      // A failed reading (unparseable leg → runReconSequence throws) is reported per-run and
      // NOT snapshotted — a reading that never closed is not a reading. Remaining runs proceed.
      let seq: Awaited<ReturnType<typeof runReconSequence>> | null = null;
      let legError: string | null = null;
      try {
        seq = await runReconSequence({ row, inputs: assembled.inputs, indexDischargeAt: assembled.indexDischargeAt, pass });
      } catch (e) {
        legError = String((e as Error).message).slice(0, 400);
      }
      if (!seq) {
        await finishTrace(traceId, 'error', legError ?? 'recon failed').catch(() => {});
        runs.push({ run: i + 1, ok: false, reason: legError ?? 'recon failed', legs, trace_id: traceId, ms: Date.now() - t0 });
        continue;
      }
      const finding = seq.finding;
      const judgements = deriveJudgements(finding);

      // Who answered — off the trace, never assumed (the refresh's DEC-2 posture). The model
      // column carries the TRUTH (what answered); a disagreement with the request is recorded
      // on the snapshot, not hidden — stability is grouped per model, which stays honest.
      const served = await servedCallForAudit(traceId, legs[legs.length - 1]?.label ?? 'readmit_recon_a');
      const modelMismatch = served.model != null && !modelsAgree(served.model, modelV.modelId);
      const model = served.model ?? modelV.modelId;
      const provider = served.provider ?? 'bedrock';

      let tokensIn = 0, tokensOut = 0, usd = 0;
      for (const label of new Set(legs.map((l) => l.label))) {
        const u = await usageForTrace(traceId, label);
        tokensIn += u.tokensIn; tokensOut += u.tokensOut;
        usd += costUsd(model, u.tokensIn, u.tokensOut, false, PRICING);
      }

      const snapshot = buildReplaySnapshot({
        dedupKey: key, engineVersion: READMIT_ENGINE_VERSION, finding,
        preventableInjury: judgements.preventableInjury, negligence: judgements.negligence,
        judgementRuleVersion: JUDGEMENT_RULE_VERSION,
        model, provider, traceId, requestedModel: modelV.model, modelMismatch,
        runIndex: i + 1, runsTotal: runsV.runs, ms: Date.now() - t0,
        tokensIn, tokensOut, usd, promoted: seq.promoted,
      });
      // O2: a failed snapshot THROWS — rethrown to the outer catch (500). Snapshots already
      // written for earlier runs stand; the response never pretends a run was kept when it wasn't.
      let snapshotId: string;
      try {
        snapshotId = await insertSnapshot(snapshot);
      } catch (e) {
        await finishTrace(traceId, 'error', 'replay snapshot insert failed').catch(() => {});
        throw e;
      }
      await finishTrace(traceId, 'success');
      runs.push({
        run: i + 1, ok: true, snapshot_id: snapshotId,
        verdicts: { planned: snapshot.planned, sameCondition: snapshot.sameCondition, avoidable: snapshot.avoidable, nOmissions: finding.omissions?.length ?? 0 },
        preventable_injury: judgements.preventableInjury, negligence: judgements.negligence,
        model, provider, ...(modelMismatch ? { model_mismatch: true } : {}),
        ms: Date.now() - t0, tokens_in: tokensIn, tokens_out: tokensOut, usd: Number(usd.toFixed(4)),
        trace_id: traceId, template_coverage: snapshot.templateCoverage, legs,
      });
    }

    return NextResponse.json({
      ok: runs.every((r) => r.ok),
      note: REPLAY_EVIDENCE_NOTE,
      dedup_key: key,
      engine_version: READMIT_ENGINE_VERSION,
      requested_model: modelV.model,
      runs_requested: runsV.runs,
      live_row_untouched: true,   // O5: readmission_findings, app_settings, backfill_runs — none written
      runs,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
