/**
 * app/api/admin/lvc-judge-aa/route.ts — LVC applicability-judge A/A harness.
 * DETERMINISM-TRIO PRD v1.0 §4 (D-4: MEASURE ONLY), 8 Aug 2026.
 * LVC JUDGE PINNING PRD v1.0 §4 (Unit C — the round is now a parameter), 10 Aug 2026.
 *
 * WHAT IT DOES. For each sampled note it assembles the judge context ONCE through the production
 * pipeline (lib/lvc.ts `matchLowValueCare`), then runs that pipeline TWICE more with the recall
 * result PINNED to what the first pass produced — so both runs hand `defaultJudge` a byte-identical
 * context object at WHATEVER the production configuration currently is (the same model resolution,
 * surface 'surface'). The two verdict sets and their comparison go to `lab_analyses` under the
 * round tag, default `lvc_judge_aa_r1`.
 *
 * ⚠️ THE CONFIGURATION UNDER TEST MOVED ON 10 AUGUST, AND THAT IS THE POINT. r1 measured the
 * judge at temperature 0.1, no seed, no top_p: 38/47 cases identical (80.9%) against a 95% bar.
 * `defaultJudge` is now pinned (temperature 0, seed AUDIT_LLM_SEED, top_p 1) and refuses any
 * non-Gemini served model. This route was NOT re-pointed at the old configuration to preserve a
 * comparison — it deliberately still measures whatever production runs, which is what makes
 * `?experiment=lvc_judge_aa_r2` a before/after and not two different instruments.
 *
 * WHAT IT STILL DOES NOT DO. It reads no threshold and writes no floor, forks no judge, and
 * touches no scoring table. The r1 rows are immutable history; r2 lands under its own tag.
 *
 * ⚠️ WHY THE VERDICTS COME FROM THE TRACE. `matchLowValueCare` returns assembled FLAGS, not the
 * judge's raw verdicts (assembleFlags drops everything below the surface's confidence floor).
 * Reading `lvc_judge_verdicts` — the observability event the
 * pipeline already writes on every real /api/appropriateness call — is the only way to observe the
 * PRODUCTION judge without forking it, and a forked judge would measure a different function than
 * the one in question. Only that event kind is read, and only its (id, verdict, confidence) triples;
 * the payload is never stored. CONSEQUENCE, FLAGGED: each case writes 2 `appropriateness` traces,
 * exactly as two real order-checks would. No scoring table is touched — not opd_note_audits, not
 * appropriateness_runs. Results land in lab_analyses and nowhere else.
 *
 * BUDGET. ~2 judge calls per case, fired by the ORCHESTRATOR when this route is called — never by
 * CI and never by the nightly worker. Sequential (concurrency 1), stops cleanly at 250 s and
 * reports progress; call it again to resume, since uids already stored for the tag are skipped.
 *
 * EVERY SQL STRING IN THIS FILE IS INFERRED (the builder has no live DB) and is reproduced verbatim
 * in the build report for orchestrator validation. Fail-safe throughout: a failure returns a JSON
 * error body, never a 500 mid-batch, and never a partial junk row.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { sql } from '@/lib/db';
import { matchLowValueCare, type MatchInput } from '@/lib/lvc';
// ⚠️ ONE STATEMENT, WITH AN INLINE `type` SPECIFIER, DELIBERATELY. `scripts/lib/import-scan.mjs`
// marks a standalone type-only declaration as a type-only edge, and the committed architecture map
// holds exactly one `app/api → retrieval-telemetry-core` edge, of kind `value`. Splitting this into
// a value import plus a separate type-only one would add a second, `type`-kind edge and rewrite
// lib/architecture/map.generated.ts, which this pass is not authorized to change. The inline form
// leaves the map untouched because a clause is type-only only when EVERY specifier carries `type`.
//
// ⚠️ AND THE WORDING ABOVE IS LOAD-BEARING, WHICH IS NOT OBVIOUS. That scanner is text-level and
// does not skip comments: its pattern is `import` + `type` + anything-without-a-quote + `from` +
// a quoted specifier. Spelling those two keywords adjacently in this comment let the match run on
// past the prose and bind to the REAL statement's specifier below, which added exactly the `type`
// edge this comment exists to prevent. Measured, not reasoned about: it moved map.generated.ts.
import { telemetryContextFor, type TelemetryRequestContext } from '@/lib/retrieval-telemetry-core';
import type { JudgedRec, LvcRecommendation, Verdict } from '@/lib/lvc-core';
import { compareJudgedRuns, summarizeAa, resolveAaExperiment, AA_EXPERIMENT_DEFAULT, type AaCaseComparison } from '@/lib/lvc-judge-aa-core';
import { fetchOpdNoteByUid } from '@/lib/metabase';
import { rowToOpdCase, opdCaseText, type DeidOpdCase } from '@/lib/opd-ingest-core';
import { OPD_ENGINE_VERSIONS_CURRENT } from '@/lib/opd-note-audit-core';
import { enrichOpdMeds } from '@/lib/formulary';
import { saveLabAnalysis } from '@/lib/lab';
import { doneUids } from '@/lib/lab-batch';
import { servedCallForAudit } from '@/lib/backfill-runs';
import { remainingBudgetMs } from '@/lib/lab-batch-core';

export const runtime = 'nodejs';
export const maxDuration = 300;   // the route's own deadline is 250 s; this is the platform headroom

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/**
 * ROUND TAG (LVC JUDGE PINNING PRD v1.0 §4, 10 Aug 2026). The round is now a PARAMETER, because
 * D-4 pre-registers a second run of this exact harness against the pinned judge: `?experiment=
 * lvc_judge_aa_r2`. Validated against AA_EXPERIMENT_RE and defaulted to r1, so the baseline tag is
 * what an unparameterised call still writes and reads — nothing about r1 moves.
 *
 * The tag is load-bearing in two places, which is why it is validated rather than passed through:
 * it is the resume skip-set (`doneUids(experiment)`) and it is the `experiment` column the report
 * is read off. A typo would start an empty round that resumes nothing.
 */
const AA_ENGINE = 'lvc-judge-aa/1.0';
const APP_SOURCE = process.env.APP_SOURCE || 'standalone';
/** §4.2 — stop cleanly near 250 s and let the next call resume. */
const DEADLINE_MS = 250_000;
/** Reserve before starting another case: two Pro judge calls plus the store. Never start one we
 *  cannot finish — a half-run case writes nothing and would be re-run from scratch anyway. */
const PER_CASE_RESERVE_MS = 60_000;

// ── INFERRED SQL 1 — the sample (§4.2) ────────────────────────────────────────────────────────────
// Recent distinct note uids whose stored current-engine audit contains at least one NON-INFORMATIONAL
// finding with a non-null rule_ref, newest first. `engine_version = ANY(...)` uses the READ-side
// FAMILY (OPD_ENGINE_VERSIONS_CURRENT), which is the documented convention for every user-facing read
// — an exact match on OPD_ENGINE_VERSION would return nothing at all the day an engine bumps.
// jsonb_typeof guards a non-array `findings` (jsonb_array_elements would raise on one).
const SAMPLE_SQL = `SELECT s.uid AS uid, s.note_date AS note_date
  FROM (
    SELECT DISTINCT ON (a.uid) a.uid AS uid, a.note_date AS note_date
      FROM opd_note_audits a
     WHERE a.app_source = $1
       AND a.engine_version = ANY($2)
       AND jsonb_typeof(a.findings) = 'array'
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(a.findings) f
          WHERE (f->>'informational') IS DISTINCT FROM 'true'
            AND f->>'rule_ref' IS NOT NULL
       )
     ORDER BY a.uid, a.note_date DESC NULLS LAST
  ) s
 ORDER BY s.note_date DESC NULLS LAST
 LIMIT $3`;

// ── INFERRED SQL 2 — the judge's own verdicts, off the trace the pipeline just wrote ──────────────
// ONE event kind, the LAST one on the trace. Only (id, verdict, confidence) are extracted; the
// payload itself is never stored or returned.
const VERDICTS_SQL = `SELECT payload
  FROM trace_events
 WHERE trace_id = $1 AND kind = 'lvc_judge_verdicts'
 ORDER BY seq DESC
 LIMIT 1`;

interface SampledUid { uid: string; noteDate: string | null }

/** Fail-safe: any error returns an empty sample and the caller reports it — never throws. */
async function sampleUids(n: number): Promise<{ rows: SampledUid[]; error?: string }> {
  try {
    const rows = await run(SAMPLE_SQL, [APP_SOURCE, [...OPD_ENGINE_VERSIONS_CURRENT], n]);
    return {
      rows: rows.map((r) => ({ uid: String(r.uid), noteDate: r.note_date == null ? null : String(r.note_date) }))
        .filter((r) => !!r.uid),
    };
  } catch (e) {
    return { rows: [], error: `sample query failed: ${String((e as Error).message).slice(0, 300)}` };
  }
}

/** The judge's verdicts for one run, read back from its trace and re-paired with the recs. */
async function verdictsFromTrace(traceId: string | undefined, recs: LvcRecommendation[]): Promise<JudgedRec[]> {
  if (!traceId) return [];
  let rows: Record<string, unknown>[];
  try { rows = await run(VERDICTS_SQL, [traceId]); } catch { return []; }
  const payload = rows?.[0]?.payload as { verdicts?: unknown } | null | undefined;
  const list = Array.isArray(payload?.verdicts) ? payload!.verdicts as unknown[] : [];
  const byId = new Map(recs.map((r) => [r.id, r]));
  const out: JudgedRec[] = [];
  for (const v of list) {
    const o = (v ?? {}) as Record<string, unknown>;
    const rec = byId.get(String(o.id ?? ''));
    if (!rec) continue;
    out.push({
      rec,
      verdict: String(o.verdict ?? 'insufficient_info') as Verdict,
      confidence: Number(o.confidence) || 0,
      why: '', consider_instead: null,
    });
  }
  return out;
}

/** The judge context for one note, assembled from the note the SAME way the audit assembles it. */
function inputForCase(oc: DeidOpdCase): MatchInput {
  // enrichOpdMeds is what auditOpdNote runs before anything reads the case (brand→generic + class),
  // so the scenario text this harness judges is the text the rest of the system would see.
  enrichOpdMeds(oc.medications);
  const orders = [
    ...oc.medications.map((m) => (m.resolvedGeneric || m.generic || m.brand || '').trim()),
    ...oc.investigations.map((i) => String(i || '').trim()),
  ].filter(Boolean);
  return {
    scenario: opdCaseText(oc),
    proposedActions: Array.from(new Set(orders)),
    surface: 'surface',            // §4.1 — the opt-in surface's model resolution, the judge under test
  };
}

interface CaseResult {
  uid: string;
  status: 'compared' | 'no_orders' | 'no_recall' | 'no_verdicts' | 'error';
  comparison?: AaCaseComparison;
  stored?: string;
  detail?: string;
}

/**
 * One case: assemble ONCE, judge TWICE on the pinned context, compare, store.
 * Never throws — the caller records the status and moves to the next uid.
 *
 * `ctx` is REQUIRED and comes last. It is the request's telemetry context, made once in `GET` and
 * threaded down — not optional, and not an options bag, so a future caller cannot quietly drop it
 * and leave pass 0's retrieval unrecorded while everything still compiles.
 */
async function runCase(uid: string, save: boolean, experiment: string, ctx: TelemetryRequestContext): Promise<CaseResult> {
  const t0 = Date.now();
  try {
    const row = await fetchOpdNoteByUid(uid);
    if (!row) return { uid, status: 'error', detail: 'no db13 OPD note for uid' };
    const { case: oc } = rowToOpdCase(row);
    const input = inputForCase(oc);
    if (!input.proposedActions?.length) return { uid, status: 'no_orders' };

    // ── Pass 0: assemble the context ONCE, through the production pipeline. The injected judge
    // captures what the real judge WOULD have been handed and returns the pipeline's own soft-fail
    // shape, so no LLM judge call is spent and nothing downstream is disturbed. Untraced: it makes
    // no model call worth attributing.
    //
    // ⚠️ AND THIS IS THE ONLY PASS THAT DECLARES TELEMETRY (D7, step 13). Pass 0 is the one that
    // reaches `defaultRecall` and performs real semantic retrieval, so it is the one that has a
    // retrieval to record. `defaultRecall` opens the invocation itself, idempotently and fail-open,
    // whenever `input.telemetry` is present — so nothing here calls `startInvocation`, and nothing
    // closes: no retrieval route closes an invocation, and these rows stay `closure_unknown` by
    // design.
    //
    // ⚠️ WHY THE FIELD GOES ON THE SPREAD AND NOT ON `input`, stated accurately. What actually keeps
    // passes A and B clean is their INJECTED `recall`: `matchLowValueCare` resolves
    // `deps.recall ?? defaultRecall`, the pinned arms supply their own, so `defaultRecall` — the one
    // and only reader of `input.telemetry` in this codebase — never runs on them. A field set on
    // `input` would therefore not instrument them today either. The spread is defence in depth: if a
    // later change ever removes the pinned `recall` injection, a field living on `input` would
    // silently begin instrumenting arms that perform no semantic retrieval at all, which D7 forbids.
    let captured: LvcRecommendation[] = [];
    await matchLowValueCare({ ...input, trace: false, telemetry: { ctx, route: 'lvc_judge_aa' } }, {
      judge: async (_ctx, recs) => {
        captured = recs;
        return recs.map((rec) => ({ rec, verdict: 'insufficient_info' as Verdict, confidence: 0, why: '', consider_instead: null }));
      },
    });
    if (!captured.length) {
      // Nothing recalled ⇒ the judge is never called on this note. Stored (when saving) so the
      // resume skip is honest and the uid is not re-fetched every call.
      const empty = compareJudgedRuns(uid, [], []);
      const stored = save ? await saveLabAnalysis({
        experiment, kind: 'lvc_judge_aa', engine: AA_ENGINE, inputRef: uid,
        inputPreview: input.scenario.slice(0, 200),
        output: { uid, status: 'no_recall', nRecs: 0, comparison: empty },
        model: null, latencyMs: Date.now() - t0, provider: null,
      }) : undefined;
      return { uid, status: 'no_recall', comparison: empty, stored };
    }

    // ── Passes A and B: the REAL judge, twice, on the pinned recall. `recall` is pinned so the two
    // runs cannot differ in what they were asked; `judge` is NOT injected, so defaultJudge runs at
    // the production configuration. `proposedActions` is set, so candidate extraction is skipped
    // and the candidates (hence judgeCtx) are identical by construction.
    const pinned = { recall: async () => captured };
    const a = await matchLowValueCare(input, pinned);
    const b = await matchLowValueCare(input, pinned);
    const [judgedA, judgedB] = await Promise.all([
      verdictsFromTrace(a.traceId, captured),
      verdictsFromTrace(b.traceId, captured),
    ]);
    if (!judgedA.length && !judgedB.length) {
      return { uid, status: 'no_verdicts', detail: 'no lvc_judge_verdicts event on either trace' };
    }
    const comparison = compareJudgedRuns(uid, judgedA, judgedB);

    // Attribution is DERIVED FROM WHAT SERVED (F11 / DEC-2), never from what was requested.
    const served = await servedCallForAudit(a.traceId, 'lvc_judge');
    const stored = save ? await saveLabAnalysis({
      experiment, kind: 'lvc_judge_aa', engine: AA_ENGINE, inputRef: uid,
      inputPreview: input.scenario.slice(0, 200),
      output: {
        uid, status: 'compared', surface: 'surface',
        nRecsRecalled: captured.length,
        orders: input.proposedActions,
        runA: { traceId: a.traceId ?? null, verdicts: judgedA.map((j) => ({ id: j.rec.id, verdict: j.verdict, confidence: j.confidence })), nFlags: a.flags.length },
        runB: { traceId: b.traceId ?? null, verdicts: judgedB.map((j) => ({ id: j.rec.id, verdict: j.verdict, confidence: j.confidence })), nFlags: b.flags.length },
        comparison,
        served,
      },
      model: served.model, provider: served.provider, latencyMs: Date.now() - t0,
    }) : undefined;
    return { uid, status: 'compared', comparison, stored };
  } catch (e) {
    return { uid, status: 'error', detail: String((e as Error).message).slice(0, 300) };
  }
}

// GET /api/admin/lvc-judge-aa?n=50&save=1&experiment=lvc_judge_aa_r2 — admin-gated.
// Sequential, resumable, 250 s deadline. `experiment` omitted or junk ⇒ the r1 baseline tag.
export async function GET(req: NextRequest) {
  const denied = requireAdmin(req); if (denied) return denied;
  const deadlineAt = Date.now() + DEADLINE_MS;

  const nRaw = parseInt(req.nextUrl.searchParams.get('n') || '50', 10);
  const n = Math.max(1, Math.min(100, Number.isFinite(nRaw) ? nRaw : 50));
  const save = (req.nextUrl.searchParams.get('save') ?? '1') !== '0';
  const experimentRaw = req.nextUrl.searchParams.get('experiment');
  const experiment = resolveAaExperiment(experimentRaw);
  // Reported so a rejected tag is VISIBLE rather than silently swallowed — a caller who typo'd
  // `lvc_judge_aa_R2` must be able to see that they measured r1 again.
  const experimentRejected = !!experimentRaw && experiment !== experimentRaw.trim();

  // ── THE TELEMETRY CONTEXT, MINTED HERE AND ONLY HERE (D7, D11, step 13) ──────────────────────
  // ONE context per REQUEST. This boundary is the only thing that knows the request, so it is the
  // only thing that can make one; `runCase` receives it and never mints its own. Minting it per case
  // instead would give every note in one call its own invocation id and report a single run as N
  // invocations — which is the exact shape §2 forbids reporting as a workload. Never module-global:
  // §4.1 forbids mutable process-global state, and two overlapping requests would share an id.
  // `labExperimentId` carries the round tag, so a row is attributable to the A/A round that made it.
  const ctx = telemetryContextFor('lvc_judge_aa', req.headers, { labExperimentId: experiment });

  const sample = await sampleUids(n);
  if (sample.error) return NextResponse.json({ ok: false, experiment, experimentRejected, error: sample.error, stored: 0 });

  // Resume: uids already stored for this tag are done (the SAME done-set primitive the lab batch uses).
  let done: Set<string>;
  try { done = await doneUids(experiment); } catch { done = new Set<string>(); }
  const queue = sample.rows.filter((r) => !done.has(r.uid));

  const results: CaseResult[] = [];
  let stopped: string | null = null;
  for (const item of queue) {
    if (remainingBudgetMs(deadlineAt) < PER_CASE_RESERVE_MS) { stopped = 'deadline'; break; }
    results.push(await runCase(item.uid, save, experiment, ctx));   // sequential — concurrency 1 (§4.2)
  }

  const comparisons = results.map((r) => r.comparison).filter((c): c is AaCaseComparison => !!c);
  return NextResponse.json({
    ok: true,
    experiment,
    experimentRejected,
    defaultExperiment: AA_EXPERIMENT_DEFAULT,
    save,
    sampled: sample.rows.length,
    alreadyDone: sample.rows.length - queue.length,
    processed: results.length,
    remaining: Math.max(0, queue.length - results.length),
    stopped,
    stored: results.filter((r) => !!r.stored).length,
    statuses: results.reduce<Record<string, number>>((m, r) => { m[r.status] = (m[r.status] ?? 0) + 1; return m; }, {}),
    summary: summarizeAa(comparisons),
    cases: results.map((r) => ({
      uid: r.uid, status: r.status, detail: r.detail ?? null,
      nRecs: r.comparison?.nRecs ?? 0,
      identicalVerdictSet: r.comparison?.identicalVerdictSet ?? null,
      nFlips: r.comparison?.nFlips ?? 0,
    })),
  });
}
