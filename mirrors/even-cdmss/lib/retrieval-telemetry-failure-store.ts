/**
 * lib/retrieval-telemetry-failure-store.ts — per-run telemetry-write failure evidence.
 * On-path kickoff D2, D12. PRD v2.1 §3 constraint 8 (fail visibly).
 *
 * ⚠️ THIS IS THE LAST LINE, AND IT IS FAIL-OPEN. Every write here is wrapped so its own exception
 * cannot propagate. When it throws, exactly two things happen and nothing else: a log line, and an
 * increment of `telemetry_write_failures` on the invocation row. If that increment throws too, a
 * log line and nothing else.
 *
 * ⚠️ THE COUNTER IS A COLUMN, NOT A VARIABLE. §4.1 forbids mutable process-global state, and a
 * per-process number would not survive the invocation anyway — the whole point of this counter is
 * that it is readable AFTER the invocation that failed is gone. The invocation row is the honest
 * record, or there is none.
 */

import { sql } from './db';
import type { TelemetryFailurePhase, RetrievalRole, RetrievalPersistenceState } from './retrieval-telemetry-core';
import { RUN_SCOPED_FAILURE_PHASES } from './retrieval-telemetry-core';

export interface TelemetryFailureRow {
  invocationId: string;
  /** Required on `work_declaration`, `retrieval_terminal` and `persistence_link` (the CHECK). */
  retrievalRunId: string | null;
  retrievalRole: RetrievalRole | null;
  failedPhase: TelemetryFailurePhase;
  /** What the write was TRYING to record. Null where the phase has no target state. */
  intendedState: RetrievalPersistenceState | null;
  /** A CLASS NAME. Never a message, never a value. */
  errorClass: string;
  observedAt: string;
}

/**
 * Record one telemetry-write failure. NEVER THROWS.
 *
 * Returns `true` when the evidence landed, `false` when even this could not be written — the
 * caller uses that to decide whether to fall back to the invocation counter. A caller must not
 * treat `false` as fatal: an audit is never failed because its telemetry could not be recorded
 * (constraint 1), it is recorded as unreconciled and the reconciler picks it up.
 */
export async function recordTelemetryFailure(row: TelemetryFailureRow): Promise<boolean> {
  // Guard the CHECK from the application side too, so a bad call is a clear local error rather
  // than a constraint violation that reads as a database problem.
  if ((RUN_SCOPED_FAILURE_PHASES as readonly string[]).includes(row.failedPhase)
    && (!row.retrievalRunId || !row.retrievalRole)) {
    console.error('[retrieval-telemetry] failure row for a run-scoped phase has no run id or role', row.failedPhase);
    return false;
  }
  try {
    await sql(
      `INSERT INTO opd_retrieval_telemetry_failures
         (invocation_id, retrieval_run_id, retrieval_role, failed_phase, intended_state, observed_at, error_class)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [row.invocationId, row.retrievalRunId, row.retrievalRole, row.failedPhase,
        row.intendedState, row.observedAt, row.errorClass],
    );
    return true;
  } catch (e) {
    // The last line failed. Log, and let the caller bump the invocation counter.
    console.error('[retrieval-telemetry] failure store write failed:', String((e as Error)?.message).slice(0, 200));
    return false;
  }
}

/**
 * Read the failure phases recorded for one run, most recent first.
 *
 * ⚠️ TWO READERS, NOT ONE (corrected 13 Aug 2026, addendum v2 item 0a). This said "Used ONLY by the
 * reconciler (D13)", and addendum v1 item 2 preserved that line on the grounds that it was a true
 * claim about who reads. It was not true when it was written. The readers are:
 *
 *   1. the reconciler (D13), deciding whether a stalled row stalled with evidence or in silence;
 *   2. SETTLEMENT, through `stateForUnwrittenRun` in `lib/retrieval-settlement.ts` — imported at
 *      its line 19 and called at its line 110 — for a run still at revision 0, whose outcome D12's
 *      transition guard cannot apply. That is D9 as amended by addendum v1 item 2: these states are
 *      produced only through `reconcilerStateFor`, and settlement may call it.
 *
 * Both readers ask the same question of the same rows and get the same mapping, which is why the
 * second reader was easy to miss and why the count is now written down rather than described.
 *
 * Failure rows are HISTORICAL: they are never deleted and never consumed, and a successful terminal
 * state always wins over earlier failure evidence.
 */
export async function failurePhasesForRun(retrievalRunId: string): Promise<string[]> {
  const rows = (await sql(
    `SELECT failed_phase FROM opd_retrieval_telemetry_failures
      WHERE retrieval_run_id = $1
      ORDER BY observed_at DESC`,
    [retrievalRunId],
  )) as Array<{ failed_phase: string }>;
  return rows.map((r) => r.failed_phase);
}
