export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// The reconciler reads and updates a bounded slice of rows and makes no model call. 300 is the
// platform default and is not derived from anything here; the BOUND that matters is `limit` below.
export const maxDuration = 300;

/**
 * app/api/admin/retrieval-telemetry-reconcile/route.ts — the deadline pass (D13, PRD v2.1 §4.5 step 6).
 *
 * ⚠️ WHAT THIS EXISTS FOR. A serverless function that is killed cannot run its own closing write.
 * Nothing in the lifecycle can therefore guarantee that a `started` or `retrieval_complete` row ever
 * reaches a terminal state — and a row stuck non-terminal is indistinguishable, to every reader,
 * from a retrieval still in flight. This pass is the only thing that ends that ambiguity, and it
 * ends it by EVIDENCE rather than by assumption: a row that stalled with a recorded telemetry
 * failure and a row that simply went silent get different states, because they need different
 * remediations.
 *
 * ⚠️ THE GRACE IS PREREGISTERED AND IS NOT READ FROM THE ENVIRONMENT.
 * `RECONCILER_STALE_AFTER_SECONDS` is a committed constant in lib/opd-audit-runtime-config.ts, its
 * value is recorded in the build report before any canary opens, and changing it restarts the
 * window. A grace that can be shortened after the fact to make a gate pass is not a grace.
 *
 * ⚠️ IT NEVER JOINS `(uid, engine_version)` TO FIND AN AUDIT. Two concurrent executions for one note
 * are two rows by design; a join on that pair would link a run to an audit some other run produced.
 * A row this pass touches is one nobody linked, and it stays unlinked.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { RECONCILER_STALE_AFTER_SECONDS } from '@/lib/opd-audit-runtime-config';
import {
  telemetryContextFor, reconcilerStateFor, isAllowedTransition, isTerminalState,
  type RetrievalPersistenceState,
} from '@/lib/retrieval-telemetry-core';
import { startInvocation, closeInvocation } from '@/lib/retrieval-invocation-store';
import { failurePhasesForRun } from '@/lib/retrieval-telemetry-failure-store';

/** The same guard the worker route uses: un-spoofable cron header, CRON_SECRET, or an admin session. */
async function authed(req: NextRequest): Promise<boolean> {
  const isCron = req.headers.get('x-vercel-cron') !== null;
  const auth = req.headers.get('authorization') || '';
  const bearerOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const secret = req.nextUrl.searchParams.get('secret');
  const secretOk = !!process.env.CRON_SECRET && !!secret && secret === process.env.CRON_SECRET;
  if (isCron || bearerOk || secretOk) return true;
  try { return await isAdminUnlocked(); } catch { return false; }
}

interface StaleRow {
  retrieval_run_id: string;
  retrieval_role: string | null;
  persistence_state: string;
  row_revision: number;
}

/** The rows past the deadline, oldest first, BOUNDED. `opd_art_nonterminal_idx` is this query.
 *
 *  ⚠️ NOT EXPORTED, AND NEITHER IS THE UPDATE BELOW. A Next route module may export only its
 *  handlers and a fixed set of config fields; exporting these for a test to import fails the build
 *  with "is not a valid Route export field". `lib/__tests__/reconciler-races.test.ts` reads them out
 *  of this file's source instead, which is the weaker of the two and is said so there. */
const RECONCILER_SELECT_SQL =
  `SELECT retrieval_run_id, retrieval_role, persistence_state, row_revision
     FROM opd_audit_retrieval_telemetry
    WHERE persistence_state IN ('started', 'retrieval_complete')
      AND started_at < $1
    ORDER BY started_at
    LIMIT $2`;

/**
 * The compare-and-set. The revision guard is what makes a late terminal write win over this pass:
 * if the row moved between the read and the write, this update matches nothing.
 *
 * The state predicate is belt to the revision's braces — it also makes the statement incapable of
 * transitioning an already terminal row even if a revision somehow matched.
 */
const RECONCILER_UPDATE_SQL =
  `UPDATE opd_audit_retrieval_telemetry
      SET persistence_state = $3, persistence_settled_at = $4, row_revision = row_revision + 1
    WHERE retrieval_run_id = $1
      AND row_revision = $2
      AND persistence_state IN ('started', 'retrieval_complete')
    RETURNING row_revision`;

/** One row's current state, for the reread after a revision mismatch. */
const REREAD_SQL =
  `SELECT retrieval_run_id, retrieval_role, persistence_state, row_revision
     FROM opd_audit_retrieval_telemetry
    WHERE retrieval_run_id = $1`;

type Verdict =
  | { runId: string; result: 'reconciled'; from: string; to: RetrievalPersistenceState; reread: boolean }
  | { runId: string; result: 'won_by_a_later_write'; from: string }
  | { runId: string; result: 'transition_not_allowed'; from: string; to: RetrievalPersistenceState }
  | { runId: string; result: 'row_vanished' };

/**
 * Reconcile one row, with at most ONE reread.
 *
 * D13: "A revision mismatch causes a reread and reclassification, never a blind retry." Both halves
 * are load-bearing. Rereading is not retrying: the second attempt is computed from what the row
 * became, not from what this pass decided before it moved. And it happens once — a loop here would
 * be a spin against a row somebody else is actively writing.
 */
async function reconcileRow(row: StaleRow, at: string, reread = false): Promise<Verdict> {
  const from = row.persistence_state;
  // A successful terminal state ALWAYS wins over earlier failure evidence. Failure rows are
  // historical: never deleted, never consumed, and never able to un-settle a settled row.
  if (isTerminalState(from)) return { runId: row.retrieval_run_id, result: 'won_by_a_later_write', from };

  // "Where several failures exist, the latest phase relevant to the current row state controls" —
  // the read is ordered newest-first and `reconcilerStateFor` asks only about the phase that is
  // relevant to THIS state: `retrieval_terminal` for a `started` row, `persistence_link` for a
  // `retrieval_complete` one.
  const phases = await failurePhasesForRun(row.retrieval_run_id);
  const to = reconcilerStateFor(from as 'started' | 'retrieval_complete', phases);

  if (!isAllowedTransition(from, to)) {
    // Unreachable with today's table, and recorded rather than forced: the transition table is the
    // only authority, and a reconciler that could overrule it would be a second one.
    return { runId: row.retrieval_run_id, result: 'transition_not_allowed', from, to };
  }

  const updated = (await sql(RECONCILER_UPDATE_SQL, [row.retrieval_run_id, row.row_revision, to, at])) as Array<{ row_revision: number }>;
  if (updated.length > 0) return { runId: row.retrieval_run_id, result: 'reconciled', from, to, reread };

  if (reread) {
    // Already reread once. Whoever is writing this row is welcome to it; the next pass will see
    // whatever they left. Never a blind retry.
    return { runId: row.retrieval_run_id, result: 'won_by_a_later_write', from };
  }
  const fresh = (await sql(REREAD_SQL, [row.retrieval_run_id])) as StaleRow[];
  if (fresh.length === 0) return { runId: row.retrieval_run_id, result: 'row_vanished' };
  return reconcileRow(fresh[0], at, true);
}

/**
 * GET — one bounded pass. Idempotent: a row it already settled is terminal and is not selected.
 *
 * `?limit=` bounds the slice (default 500, max 2000) and `?dry=1` reports what it WOULD do without
 * writing, which is how an operator inspects a window before the first real pass.
 */
export async function GET(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const p = req.nextUrl.searchParams;
  const limit = Math.max(1, Math.min(2000, Number(p.get('limit') || 500)));
  const dry = p.get('dry') === '1';

  // The reconciler's runs go in the invocation table too, as `kind = 'reconciler'` — and they are
  // NOT retrieval work. §2 forbids reporting a tick as a workload, which is exactly what a
  // reconciler pass counted as `kind = 'retrieval'` would be.
  const ctx = telemetryContextFor('reconciler', req.headers);
  await startInvocation(ctx, 'reconciler');

  const at = new Date().toISOString();
  const cutoff = new Date(Date.parse(at) - RECONCILER_STALE_AFTER_SECONDS * 1000).toISOString();
  try {
    const stale = (await sql(RECONCILER_SELECT_SQL, [cutoff, limit])) as StaleRow[];
    const verdicts: Verdict[] = [];
    for (const row of stale) {
      if (dry) {
        const phases = await failurePhasesForRun(row.retrieval_run_id);
        verdicts.push({
          runId: row.retrieval_run_id, result: 'reconciled', from: row.persistence_state,
          to: reconcilerStateFor(row.persistence_state as 'started' | 'retrieval_complete', phases), reread: false,
        });
        continue;
      }
      verdicts.push(await reconcileRow(row, at));
    }

    const tally = verdicts.reduce<Record<string, number>>((m, v) => {
      const key = v.result === 'reconciled' ? `reconciled:${v.to}` : v.result;
      m[key] = (m[key] ?? 0) + 1;
      return m;
    }, {});
    await closeInvocation(ctx, new Date().toISOString());
    return NextResponse.json({
      ok: true,
      dry,
      // The grace, echoed on every response so an operator never has to guess which one ran.
      grace_seconds: RECONCILER_STALE_AFTER_SECONDS,
      cutoff,
      selected: stale.length,
      limit,
      // A full slice means there is more behind it. Said plainly rather than left to be inferred
      // from `selected === limit`, because a silent truncation reads as "everything was covered".
      more_may_remain: stale.length === limit,
      tally,
      verdicts,
    });
  } catch (e) {
    await closeInvocation(ctx, new Date().toISOString());
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
