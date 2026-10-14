export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/admin/mini-backfill-monitor — data for the mini-pipeline monitoring view.
 * Admin session or ?token=ADMIN_TOKEN. Poll-friendly (the client refreshes the live parts).
 *
 * Returns:
 *   kpis       — processed today / total mini rows / avg s per note / current state
 *   throughput — notes processed per time bucket over the range (from opd_note_audits.audited_at,
 *                model=qwen → the mini's OWN work; Gemini rows carry a gemini model and are excluded)
 *   ticks      — per-tick state (running/paused/closed_window/locked/finished/error) for the strip
 *   inflight   — is a tick running right now (soft lock) + which day + how long
 *   recent     — the last N mini audits (uid, band, index, latency) for the live feed
 *
 * ?range = 24h | 7d | 30d | all  (default 7d) controls the throughput bucket size.
 */
import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { requireAdmin } from '@/lib/admin-gate';
import { sql } from '@/lib/db';
import { readState, getTicks, windowOpen, lockHeld, MB_LOCK_TTL_MS } from '@/lib/mini-backfill';
import { activeRun, recentRuns } from '@/lib/backfill-runs';
import { readBatchState, batchProgress, readBatchModel } from '@/lib/lab-batch';
import { estimateRunEta, etaSeconds, isStalled, rollingPace, STALL_AFTER_MS } from '@/lib/backfill-runs-core';
import { OPD_ENGINE_VERSION } from '@/lib/opd-note-audit-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const num = (v: unknown): number => Number(v ?? 0);

// mini rows carry a local (qwen/ollama) model; Gemini prod rows carry a gemini model.
const MINI_MODEL_FILTER = `(model ILIKE '%qwen%' OR model ILIKE '%ollama%' OR model ILIKE '%mini%' OR engine_version LIKE '%-mini' OR engine_version LIKE '%-lab')`;

const RANGES: Record<string, { hours: number; trunc: string; bucketMin: number }> = {
  '24h': { hours: 24, trunc: 'hour', bucketMin: 60 },
  '7d': { hours: 24 * 7, trunc: 'hour', bucketMin: 60 },
  '30d': { hours: 24 * 30, trunc: 'day', bucketMin: 1440 },
  'all': { hours: 24 * 400, trunc: 'day', bucketMin: 1440 },
};

export async function GET(req: NextRequest) {
  if (!(await isAdminUnlocked())) { const denied = requireAdmin(req); if (denied) return denied; }
  // ⚠️ FIXED 8 Aug 2026 — THE DEFAULT RANGE CRASHED THE WHOLE MONITOR. This line used to test
  // `(get('range') || '7d') in RANGES` and then return `get('range')` RAW on the true branch, so a
  // request with NO ?range param tested the string '7d', passed, and resolved to `null`.
  // `RANGES[null]` is undefined, and the first read of `range.hours` below threw. The observable
  // symptom in production was that the bare URL 500'd with "Cannot read properties of undefined
  // (reading 'hours')" while `?range=7d` worked — i.e. the monitoring surface was down in exactly
  // the case an operator reaches it in, and up in the case anyone testing it would have used.
  //
  // The defect was that the guard and the value were two different expressions. They are now one:
  // the parameter is read ONCE, defaulted ONCE, and validated against the same variable that is then
  // used to index. An unknown range (?range=nonsense) falls back to '7d' AND reports '7d' in the
  // payload, so the response can never name a window other than the one it actually queried.
  const requestedRange = req.nextUrl.searchParams.get('range') ?? '7d';
  const rangeKey = requestedRange in RANGES ? requestedRange : '7d';
  const range = RANGES[rangeKey];

  try {
    const st = await readState();
    const lb = await readBatchState();
    // S2 §C5 — the run objects, so the S3 console has data to render without a second fetch. Data
    // only: no UI changes in this slice, and every existing field below is untouched. Best-effort,
    // because a monitoring view must not go down with the runs table.
    const [runActive, runHistory] = await Promise.all([
      activeRun('opd').catch(() => null),
      recentRuns('opd', 20).catch(() => []),
    ]);
    const lbProg = lb.experiment ? await batchProgress(lb.experiment, lb.uids) : { total: 0, done: 0, remaining: 0 };
    const lbModel = await readBatchModel().catch(() => '');

    const [buckets, labBuckets, todayRow, totalRow, labTodayRow, labTotalRow, recent, labRecent, scoredRow, totalUidRow, ticks] = await Promise.all([
      // backfill throughput: autopilot mini audits per bucket (opd_note_audits)
      run(
        `SELECT date_trunc($2, audited_at) AS bucket, count(*)::int AS notes, round(avg(latency_ms))::int AS avg_ms
           FROM opd_note_audits
          WHERE audited_at >= NOW() - ($1 || ' hours')::interval AND ${MINI_MODEL_FILTER}
          GROUP BY 1 ORDER BY 1 ASC`,
        [String(range.hours), range.trunc],
      ).catch(() => [] as Record<string, unknown>[]),
      // MCP / experiment throughput: Lab-MCP + manual mini runs (lab_analyses, same single box)
      run(
        `SELECT date_trunc($2, created_at) AS bucket, count(*)::int AS notes, round(avg(latency_ms))::int AS avg_ms
           FROM lab_analyses
          WHERE created_at >= NOW() - ($1 || ' hours')::interval
          GROUP BY 1 ORDER BY 1 ASC`,
        [String(range.hours), range.trunc],
      ).catch(() => [] as Record<string, unknown>[]),
      run(
        `SELECT count(*)::int AS n, round(avg(latency_ms))::int AS avg_ms
           FROM opd_note_audits
          WHERE (audited_at AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date AND ${MINI_MODEL_FILTER}`,
      ).catch(() => [{ n: 0, avg_ms: 0 }]),
      run(`SELECT count(*)::int AS n FROM opd_note_audits WHERE ${MINI_MODEL_FILTER}`).catch(() => [{ n: 0 }]),
      run(
        `SELECT count(*)::int AS n FROM lab_analyses
          WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date`,
      ).catch(() => [{ n: 0 }]),
      run(`SELECT count(*)::int AS n FROM lab_analyses`).catch(() => [{ n: 0 }]),
      // live feed: last mini audits (backfill) + last MCP/lab runs, merged client-side by time
      run(
        `SELECT uid, band, note_quality_index AS idx, latency_ms, audited_at AS at, consult_type, prescription_type
           FROM opd_note_audits
          WHERE ${MINI_MODEL_FILTER}
          ORDER BY audited_at DESC LIMIT 12`,
      ).catch(() => [] as Record<string, unknown>[]),
      run(
        `SELECT input_ref AS uid, output->>'band' AS band, (output->>'index')::int AS idx,
                latency_ms, created_at AS at, kind, experiment
           FROM lab_analyses
          ORDER BY created_at DESC LIMIT 12`,
      ).catch(() => [] as Record<string, unknown>[]),
      // RE-SCORE COVERAGE: distinct notes now at the live prod engine vs distinct notes ever audited.
      run(`SELECT count(DISTINCT uid)::int AS scored FROM opd_note_audits WHERE engine_version = $1`, [OPD_ENGINE_VERSION]).catch(() => [{ scored: 0 }]),
      run(`SELECT count(DISTINCT uid)::int AS total FROM opd_note_audits`).catch(() => [{ total: 0 }]),
      getTicks(range.hours <= 48 ? 48 : Math.min(range.hours, 24 * 30)),
    ]);

    // ══ S2b §C3 — ETA AND THE STALL ALARM (BAKEOFF-DESIGN §6 gaps 4 + 5) ═══════════════════════
    //
    // DATA ONLY, no UI: the console renders these in S3. They exist now because the standing
    // monitoring rule (§7, V, 8 Aug) requires an estimated completion and a visibly flagged stall on
    // any experiment over five notes BEFORE it starts, and the bake-off is 600 notes across four
    // arms. Both arms of that bake-off are covered: the Gemini arm is a RUN, the three Bedrock arms
    // are lab BATCHES, and a rule that only watched one of them would leave three-quarters of the
    // experiment unwatched.
    //
    // The run's pace comes from `ticks`, already fetched above — no new query, no new column.
    const nowMs = Date.now();
    const runPace = runActive ? rollingPace(ticks, runActive.id) : null;
    const runEta = runActive && runPace ? estimateRunEta(runActive, runPace) : null;
    const runStalled = isStalled(
      { active: runActive?.status === 'active', lastProgressMs: runActive?.updated_at ? Date.parse(runActive.updated_at) : null },
      nowMs,
    );
    // The batch's heartbeat is its last tick summary; its remaining is EXACT (the cohort is a known
    // list), so unlike the run its ETA needs no notes-per-day estimate.
    const lbLast = (lb.last ?? null) as Record<string, unknown> | null;
    const lbTickMs = Array.isArray(lbLast?.results)
      ? (lbLast!.results as Record<string, unknown>[]).filter((r) => !('error' in r) && Number(r.ms) > 0).map((r) => Number(r.ms))
      : [];
    const lbAvgMs = lbTickMs.length ? Math.round(lbTickMs.reduce((s, m) => s + m, 0) / lbTickMs.length) : null;
    // ⚠️ A CLOSED NIGHT WINDOW IS NOT A STALL. `window: 'night'` means idle 05:00–00:00 IST BY
    // DESIGN, and an alarm that fires for nineteen hours a day is one operators stop reading.
    const lbActive = !!(lb.experiment && lb.enabled && windowOpen(lb.window));
    const lbStalled = isStalled(
      { active: lbActive, lastProgressMs: lbLast?.at ? Date.parse(String(lbLast.at)) : null },
      nowMs,
    );

    const inflightMs = st.lock && lockHeld(st.lock) ? Date.now() - Date.parse(st.lock) : null;
    const state: 'running' | 'paused' | 'idle_window_closed' =
      !st.enabled ? 'paused' : windowOpen(st.window) ? 'running' : 'idle_window_closed';

    return NextResponse.json({
      ok: true,
      range: rangeKey,
      generatedAt: new Date().toISOString(),
      kpis: {
        processedToday: num(todayRow[0]?.n),
        totalMini: num(totalRow[0]?.n),
        mcpToday: num(labTodayRow[0]?.n),
        mcpTotal: num(labTotalRow[0]?.n),
        avgSecPerNote: todayRow[0]?.avg_ms ? Math.round(num(todayRow[0].avg_ms) / 1000) : (st.last && (st.last as Record<string, unknown>).throughput ? Math.round(num(((st.last as Record<string, unknown>).throughput as Record<string, unknown>).avg_ms_per_note) / 1000) : null),
        state,
        window: st.window,
        tag: st.tag,
        engine: OPD_ENGINE_VERSION,
        cursor: st.cursor,
        floor: st.floor,
      },
      coverage: (() => { const scored = num(scoredRow[0]?.scored); const total = num(totalUidRow[0]?.total); return { engine: OPD_ENGINE_VERSION, scored, total, pct: total > 0 ? Math.round((scored / total) * 100) : 0 }; })(),
      // Only surface an ACTIVE eval batch — a paused/cancelled batch (enabled=0) yields null so its
      // stale experiment/uids/progress don't linger on the card (and can't offer a Resume). Stop clears it.
      labBatch: (lb.experiment && lb.enabled) ? {
        enabled: lb.enabled, experiment: lb.experiment, kind: lb.kind, n: lb.n, window: lb.window,
        total: lbProg.total, done: lbProg.done, remaining: lbProg.remaining, lastError: lb.lastError,
        // S2b: who is grading (null ⇒ the free mini) and when it last moved.
        model: lbModel || null,
        avgMsPerNote: lbAvgMs,
        etaSec: etaSeconds(lbProg.remaining, lbAvgMs),
        lastTickAt: lbLast?.at ? String(lbLast.at) : null,
        stalled: lbStalled,
        stallAfterSec: Math.round(STALL_AFTER_MS / 1000),
      } : null,
      // two stacked series over the same time axis (the mini is ONE box — these together are its load)
      throughput: buckets.map((b) => ({ t: String(b.bucket), notes: num(b.notes), avgSec: b.avg_ms ? Math.round(num(b.avg_ms) / 1000) : null })),
      mcpThroughput: labBuckets.map((b) => ({ t: String(b.bucket), notes: num(b.notes), avgSec: b.avg_ms ? Math.round(num(b.avg_ms) / 1000) : null })),
      bucketMinutes: range.bucketMin,
      // run_id rides each tick so the S3 graph can colour by run (§4.3.7).
      ticks: ticks.map((t) => ({ t: t.ts, status: t.status, processed: t.processed, runId: t.run_id })),
      activeRun: runActive,
      // §C3 — read `eta.basis` before quoting `eta.seconds`: the notes-per-day denominator is
      // ESTIMATED from the days this run has already finished, and is null until one has.
      runEta,
      runPace,
      runStalled,
      stallAfterSec: Math.round(STALL_AFTER_MS / 1000),
      runs: runHistory,
      inflight: inflightMs != null ? { active: true, day: (st.last as Record<string, unknown> | null)?.day ?? st.cursor ?? null, sinceSec: Math.round(inflightMs / 1000), ttlSec: Math.round(MB_LOCK_TTL_MS / 1000) } : { active: false },
      recent: [
        ...recent.map((r) => ({
          source: 'backfill' as const,
          uid: String(r.uid),
          band: r.band ? String(r.band) : null,
          idx: r.idx == null ? null : num(r.idx),
          sec: r.latency_ms == null ? null : Math.round(num(r.latency_ms) / 1000),
          at: String(r.at),
          kind: [r.prescription_type, r.consult_type].filter(Boolean).map(String).join(' · ') || null,
        })),
        ...labRecent.map((r) => ({
          source: 'mcp' as const,
          uid: r.uid ? String(r.uid) : '(text)',
          band: r.band ? String(r.band) : null,
          idx: r.idx == null ? null : num(r.idx),
          sec: r.latency_ms == null ? null : Math.round(num(r.latency_ms) / 1000),
          at: String(r.at),
          kind: r.experiment ? `exp: ${String(r.experiment)}` : (r.kind ? String(r.kind) : null),
        })),
      ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 14),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
