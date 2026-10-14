/**
 * lib/retrieval-invocation-store.ts — invocation accounting and overlap analysis.
 * On-path kickoff D2, D11, D12. PRD v2.1 §1 (did worker, ACTIVE backfill and hosted lab overlap?).
 *
 * ⚠️ THE INVOCATION INSERT IS FAIL-OPEN, EVEN ON THE WORKER. Only the worker's RETRIEVAL-ROW batch
 * is fail-closed (D10/D11), and that asymmetry is deliberate: a missing declaration means a
 * retrieval could run with no durable start, which §4.5 step 1 exists to prevent; a missing
 * invocation row costs an overlap analysis a data point. One of those is worth failing an audit
 * over and the other is not.
 */

import { sql } from './db';
import { recordTelemetryFailure } from './retrieval-telemetry-failure-store';
import { errorClassOf } from './retrieval-capture';
import type { TelemetryRequestContext, InvocationKind } from './retrieval-telemetry-core';

/** `process.env.APP_SOURCE || 'standalone'` — the idiom lib/db.ts line 7 already uses.
 *
 *  ⚠️ NEVER BIND `process.env.APP_SOURCE` BARE. It is `string | undefined`, the column is NOT NULL,
 *  and a bound `undefined` reaches Postgres as NULL and FAILS the insert rather than falling back
 *  to the column default. The default is documentation and a second line of defence for
 *  hand-written SQL — it is not a rescue for a bound null. */
const appSource = () => process.env.APP_SOURCE || 'standalone';

/**
 * Open an invocation. Fail-open: a failure is recorded as evidence and the caller proceeds.
 *
 * ⚠️ THE NEW TABLES ARE NOT IN `STAMP_TABLES` AND MUST NOT BE (D10). `injectAppSource` rewrites a
 * single `VALUES ( … )` group and bails on a nested paren; adding these tables would make a
 * multi-row declaration insert depend on a regex. `app_source` is passed explicitly instead.
 */
export async function startInvocation(ctx: TelemetryRequestContext, kind: InvocationKind = 'retrieval'): Promise<void> {
  try {
    await sql(
      `INSERT INTO opd_retrieval_invocations
         (invocation_id, kind, route, route_class, app_source, deployment_sha, vercel_request_id,
          started_at, closure_state, declared_retrievals, telemetry_write_failures)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'closure_unknown', 0, 0)
       ON CONFLICT (invocation_id) DO NOTHING`,
      [ctx.invocationId, kind, ctx.route, ctx.routeClass, appSource(),
        ctx.deploymentSha, ctx.vercelRequestId, ctx.startedAt],
    );
  } catch (e) {
    await recordTelemetryFailure({
      invocationId: ctx.invocationId, retrievalRunId: null, retrievalRole: null,
      failedPhase: 'invocation_start', intendedState: null,
      errorClass: errorClassOf(e), observedAt: ctx.startedAt,
    });
  }
}

/** Count newly inserted run ids onto the invocation. Only NEW ids — an adopted predeclared run was
 *  already counted by whoever declared it, and counting it twice would inflate the denominator the
 *  canary's coverage percentage divides by. */
export async function addDeclaredRetrievals(invocationId: string, n: number): Promise<void> {
  if (n <= 0) return;
  try {
    await sql(
      `UPDATE opd_retrieval_invocations SET declared_retrievals = declared_retrievals + $2
        WHERE invocation_id = $1`,
      [invocationId, n],
    );
  } catch (e) {
    console.error('[retrieval-telemetry] declared_retrievals increment failed:', String((e as Error)?.message).slice(0, 200));
  }
}

/**
 * THE ONLY WRITER of `telemetry_write_failures` (D12). Called when the failure store itself could
 * not record — this counter is then the last surviving evidence that anything went wrong.
 *
 * If this throws too: log and continue. There is nowhere further down to go, and an audit is never
 * failed because its telemetry could not be recorded.
 */
export async function bumpTelemetryWriteFailure(invocationId: string): Promise<void> {
  try {
    await sql(
      `UPDATE opd_retrieval_invocations SET telemetry_write_failures = telemetry_write_failures + 1
        WHERE invocation_id = $1`,
      [invocationId],
    );
  } catch (e) {
    console.error('[retrieval-telemetry] telemetry_write_failures increment failed:',
      String((e as Error)?.message).slice(0, 200));
  }
}

/** Close an invocation. An invocation that never reaches this stays `closure_unknown`, honestly —
 *  a killed serverless function cannot run its own closing write, and pretending otherwise is what
 *  makes a window look complete when it is not. */
export async function closeInvocation(ctx: TelemetryRequestContext, endedAt: string): Promise<void> {
  try {
    await sql(
      `UPDATE opd_retrieval_invocations
          SET ended_at = $2, closure_state = 'closed'
        WHERE invocation_id = $1`,
      [ctx.invocationId, endedAt],
    );
  } catch (e) {
    await recordTelemetryFailure({
      invocationId: ctx.invocationId, retrievalRunId: null, retrievalRole: null,
      failedPhase: 'closure', intendedState: null,
      errorClass: errorClassOf(e), observedAt: endedAt,
    }).then((ok) => { if (!ok) return bumpTelemetryWriteFailure(ctx.invocationId); });
  }
}
