/**
 * lib/retrieval-telemetry-store.ts — the durable retrieval lifecycle.
 * On-path kickoff D10, D11, D12. PRD v2.1 §4.5.
 *
 * ⚠️ THE AUDIT WRITE AND THE FINAL TELEMETRY LINK ARE NOT TRANSACTIONAL, AND CANNOT BE HERE.
 * lib/db.ts exports `sql` as a Proxy with only an `apply` trap over a bare function target, so the
 * driver's own `transaction` method is not reachable — and even if it were, it could not span the
 * application logic between the audit insert and the telemetry link. What replaces atomicity is
 * stated rather than assumed: idempotent updates, an explicit revision guard, and a reconciler.
 * Nothing in this module claims atomicity, and the build report declares this as a declaration.
 *
 * ⚠️ NOTHING MUTATES IN PLACE. Every write returns an UPDATED handle. A caller holding a stale
 * handle is rejected by the revision guard rather than silently overwriting a newer result.
 */

import { randomUUID } from 'node:crypto';
import { sql } from './db';
import {
  TELEMETRY_SCHEMA_VERSION, canonicalJson, isAllowedTransition, isTerminalState,
  COLUMN_CLASSIFICATION,
  type RetrievalRole, type RetrievalPersistenceState, type TelemetryRequestContext,
  type StampedRetrievalManifest, type RetrievalPayload, type OperationalTelemetry,
} from './retrieval-telemetry-core';
import { counterColumns, errorClassOf } from './retrieval-capture';
import { recordTelemetryFailure } from './retrieval-telemetry-failure-store';
import { bumpTelemetryWriteFailure, addDeclaredRetrievals } from './retrieval-invocation-store';

const appSource = () => process.env.APP_SOURCE || 'standalone';

// ════════════════════════════════════════════════════════════════════════════════════════════════
// THE HANDLE (D12)
// ════════════════════════════════════════════════════════════════════════════════════════════════

export interface LifecycleRun {
  role: RetrievalRole;
  runId: string;
  expectedRevision: number;
}

export interface LifecycleHandle {
  invocationId: string;
  runs: LifecycleRun[];
  /** Declared UP FRONT by the caller, not inferred from the role: the run route's POST arm audits
   *  and never saves, and no property of `primary` could have told us that. */
  persistenceIntent: 'will_persist' | 'never_persists';
}

/**
 * Why a settlement write did not happen. Each of these is a REAL outcome that used to be reported
 * as `settled`: `applyTerminalState` returns `rejected` from five places and all five were mapped
 * to success.
 */
export const SETTLEMENT_REJECTIONS = [
  'no_row', 'stale_revision', 'already_terminal', 'disallowed_transition', 'lost_update',
  // ⚠️ SIXTH CLASS (v9 §4.2). `LifecycleHandle.runs` is a plain array with no uniqueness rule, and
  // two functions assume uniqueness while disagreeing about it: `writeRetrievalTerminal` takes the
  // FIRST match by `find`, `advance` updates EVERY match by `map`. With two `primary` runs on one
  // handle, one row is written and both revisions advance, and nothing reports it.
  //
  // ⚠️ THE GUARD IS NOT AT DECLARATION, DELIBERATELY. `declareNoteRuns` legitimately maps every note
  // in a batch to one `primary` run and declares them together, so a 30-note batch produces a handle
  // carrying 30 `primary` runs. A declare-time guard would stop the worker. The guard belongs to the
  // two functions that assume uniqueness, and this class is what settlement reports when it sees it.
  //
  // No migration: a rejection class is a return value plus a free-text `error_class`, and
  // `error_class` carries no CHECK in the generated DDL or in migration 0035.
  'duplicate_role_on_handle',
] as const;
export type SettlementRejection = typeof SETTLEMENT_REJECTIONS[number];

export interface PerRunSettlementResult {
  role: RetrievalRole;
  runId: string;
  /**
   * ⚠️ `rejected` IS A THIRD VALUE, AND D12 FIXES THIS UNION AT TWO. Extending it is a change to a
   * decided signature and is flagged in the build report rather than taken quietly; it is here
   * because the alternative is worse. A rejected write means the row is NOT in the state the caller
   * asked for, and reporting that as `settled` told every owner in the D9 matrix that a link it
   * never got had been made. `noop` remains `settled`: identical content already landed.
   */
  status: 'settled' | 'failed' | 'rejected';
  errorClass?: string;
  /** Present only on `rejected`. */
  rejection?: SettlementRejection;
}

/**
 * `validateManifest`'s output, KEYED BY THE ROLE WHOSE MANIFEST PRODUCED IT (pass 0b).
 *
 * ⚠️ THE CONTAMINATION THIS REPLACES. The previous shape was one flat `string[]`, described by this
 * file's own comment as "whichever role was dirtiest" — and `outcomeForOwnedSave` then marked the
 * WHOLE save dirty if that list was non-empty. So one defect on the `normative_channel` manifest
 * made the `primary` row `persisted_partial`, and the reverse held. Two rows, one verdict, and the
 * verdict belonged to neither of them.
 *
 * Partial by role: a role that produced no manifest has no key, which is a different statement from
 * a role whose manifest validated clean (empty array).
 *
 * ⚠️ AND THEY NO LONGER SETTLE THE SAME WAY (v10 requirement 6). This comment used to end "Both
 * settle clean; only one of them ran," which became false. An empty array is a verdict of clean. A
 * MISSING key, on a map that was provided at all, means nobody validated the manifest that row
 * claims to describe — so a LINKABLE clean run settles `persisted_partial`. A run still at revision
 * 0 is unaffected: it never wrote a manifest, so there is nothing to be partial about. The rule is
 * `verdictForRun` in lib/retrieval-settlement.ts, and it turns on OWN properties only.
 *
 * Omitting the map entirely still settles clean, which is what every uninstrumented caller does.
 */
export type ManifestDefectsByRole = Partial<Record<RetrievalRole, readonly string[]>>;

/**
 * What an audit carries back about its own retrieval telemetry, for the owner that will settle it.
 *
 * D17 makes a persisted row `persisted_partial` when validation returned anything, so the owner
 * needs the verdict and cannot compute it — the manifest never leaves `auditOpdNote`. It now carries
 * one verdict PER ROLE, and `settleRetrievalTelemetry` applies each run's own.
 */
export interface RetrievalTelemetryOutcome {
  handle: LifecycleHandle | null;
  manifestDefectsByRole: ManifestDefectsByRole;
}

/** The property name D11 requires be NON-ENUMERABLE. */
export const RETRIEVAL_TELEMETRY_PROPERTY = '__retrievalTelemetry';

/**
 * Attach the outcome to the returned audit without widening what the audit IS.
 *
 * ⚠️ NON-ENUMERABLE, AND THAT IS THE WHOLE POINT. `JSON.stringify(audit)` is what reaches the store,
 * the lab and every log line; a handle appearing there would put invocation and run ids into places
 * §4.2 never authorised, and would change the serialized shape of an object other code compares.
 * The callback in D11 is the primary channel — this is the success-path convenience beside it.
 */
export function attachRetrievalTelemetry<T extends object>(audit: T, outcome: RetrievalTelemetryOutcome): T {
  Object.defineProperty(audit, RETRIEVAL_TELEMETRY_PROPERTY, {
    value: outcome, enumerable: false, writable: false, configurable: true,
  });
  return audit;
}

/** Read it back at the owner. Null when the audit was uninstrumented, which is most of them. */
export function readRetrievalTelemetry(audit: unknown): RetrievalTelemetryOutcome | null {
  const v = (audit as Record<string, unknown> | null | undefined)?.[RETRIEVAL_TELEMETRY_PROPERTY];
  return (v && typeof v === 'object') ? v as RetrievalTelemetryOutcome : null;
}

/** Run ids allocated by the WORKER before `auditOpdNote` is entered (D10). Threaded in and
 *  ADOPTED — never reallocated, never a second `started` row. */
export interface PredeclaredTelemetryRuns {
  primary: { runId: string; expectedRevision: 0 };
  normativeChannel?: { runId: string; expectedRevision: 0 };
}

/** Thrown by the worker's fail-closed declaration. Its own class so the route-level catch can
 *  return 503 rather than the generic 500 (D10). */
export class TelemetryDeclarationError extends Error {
  constructor(message: string) { super(message); this.name = 'TelemetryDeclarationError'; }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// DECLARE (§4.5 step 1)
// ════════════════════════════════════════════════════════════════════════════════════════════════

export interface DeclareInput {
  role: RetrievalRole;
  runId: string;
  uid: string | null;
  engineVersion: string | null;
  /** The three A/A experiment columns. All three are BOUND BY THE INSERT BELOW. They were declared
   *  here and bound by nothing until this pass, which left `opd_art_experiment_idx` — an index on
   *  `(experiment_run_id, pair_id)` — with a second column no writer could populate. Nothing was
   *  lost meanwhile because no caller supplies them either; what goes in them is an A/A question
   *  and V has not opened A/A. */
  experimentRunId?: string | null;
  pairId?: string | null;
  replicate?: string | null;
}

/**
 * Insert every run as `started`, in ONE statement, before any provider work.
 *
 * ⚠️ THE MULTI-ROW SHAPE IS DELIBERATE. A per-note insert inside `mapLimit` would put a round trip
 * before every note's retrieval and would make a partial declaration possible — half the day's
 * notes durable and half not, with nothing recording which half.
 *
 * ⚠️ `retrieval_outcome` IS OMITTED, NOT NULLED-AND-SET. The outcome CHECK requires it to be NULL
 * in state `started`, which is exactly right: the worker declares before retrieval begins and has
 * nothing to report yet.
 */
export async function declareRetrievals(
  ctx: TelemetryRequestContext,
  runs: DeclareInput[],
  persistenceIntent: LifecycleHandle['persistenceIntent'],
): Promise<LifecycleHandle> {
  if (runs.length === 0) {
    return { invocationId: ctx.invocationId, runs: [], persistenceIntent };
  }
  const cols = 14;
  const values = runs.map((_, i) => {
    const b = i * cols;
    return `(${Array.from({ length: cols }, (_, k) => `$${b + k + 1}`).join(', ')})`;
  }).join(', ');
  const params: unknown[] = [];
  for (const r of runs) {
    params.push(
      r.runId, r.role, ctx.route, ctx.invocationId, appSource(), ctx.deploymentSha,
      TELEMETRY_SCHEMA_VERSION, 'started', ctx.startedAt, r.uid, r.engineVersion,
      r.experimentRunId ?? null, r.pairId ?? null, r.replicate ?? null,
    );
  }
  let landed: Array<{ retrieval_run_id: string }>;
  try {
    landed = (await sql(
      `INSERT INTO opd_audit_retrieval_telemetry
         (retrieval_run_id, retrieval_role, route, invocation_id, app_source, deployment_sha,
          telemetry_schema_version, persistence_state, started_at, uid, engine_version,
          experiment_run_id, pair_id, replicate)
       VALUES ${values}
       ON CONFLICT (retrieval_run_id) DO NOTHING
       RETURNING retrieval_run_id`,
      params,
    )) as Array<{ retrieval_run_id: string }>;
  } catch (e) {
    // ⚠️ THE ONLY EVIDENCE A FAILED DECLARATION EVER LEAVES (D13). No retrieval row exists to
    // reconcile — the insert is what would have created it — so `work_declaration` failure rows
    // are the whole record, one per run this call was going to declare. The throw still
    // propagates: the worker's declaration is fail-closed (D10) and the non-worker caller in
    // `auditOpdNote` catches it and continues uninstrumented.
    await recordDeclarationFailure(ctx, runs, e);
    throw e;
  }
  // ⚠️ THE ROWS THAT LANDED, NOT THE ROWS THAT WERE ASKED FOR (D11: "counts newly inserted run ids
  // only"). `ON CONFLICT DO NOTHING` returns nothing for a run id somebody already declared, and
  // counting it again would inflate the denominator every coverage percentage divides by. That is
  // reachable the moment the worker's adoption path exists, which is this build.
  await addDeclaredRetrievals(ctx.invocationId, landed.length);
  return {
    invocationId: ctx.invocationId,
    runs: runs.map((r) => ({ role: r.role, runId: r.runId, expectedRevision: 0 })),
    persistenceIntent,
  };
}

/**
 * The WORKER-SHAPED declaration: one `primary` run per note, in one statement, before any provider
 * work, and FAIL-CLOSED (D10).
 *
 * ⚠️ ONE COPY FOR THREE ROUTES. The worker's single-day arm, its sweep arm, its re-audit arm and
 * the mini-backfill all declare the same way; four copies of a fail-closed rule would eventually
 * become three fail-closed rules and one that quietly logged. The returned ids are INDEX-ALIGNED to
 * `rows`, which is the contract every caller then threads into `predeclaredTelemetry`.
 */
export async function declareNoteRuns(
  ctx: TelemetryRequestContext,
  rows: ReadonlyArray<Record<string, unknown>>,
  engineVersion: string,
): Promise<string[]> {
  const runs: DeclareInput[] = rows.map((row) => ({
    role: 'primary' as const,
    runId: randomUUID(),
    uid: String(row.uid ?? '') || null,
    engineVersion,
  }));
  try {
    await declareRetrievals(ctx, runs, 'will_persist');
  } catch (e) {
    throw new TelemetryDeclarationError(
      `retrieval telemetry declaration failed (${String((e as Error).message).slice(0, 120)}) — no note of this day was processed`,
    );
  }
  return runs.map((r) => r.runId);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// TERMINAL WRITE (§4.5 step 3)
// ════════════════════════════════════════════════════════════════════════════════════════════════

export interface TerminalWriteInput {
  payload: RetrievalPayload;
  operational: OperationalTelemetry;
  /** Written HERE, not at declaration: the worker declares before `startTrace` runs, and two
   *  retrieving callers pass `trace: false` and carry null for the whole of their life (D10). */
  traceId: string | null;
  completedAt: string;
}

/**
 * Write one role's terminal manifest and move it to `retrieval_complete`. Returns an updated
 * handle whose revision has advanced for that role alone — revisions advance PER ROLE, so a
 * normative-channel write cannot invalidate the primary caller's handle.
 */
export async function writeRetrievalTerminal(
  handle: LifecycleHandle,
  role: RetrievalRole,
  input: TerminalWriteInput,
): Promise<LifecycleHandle> {
  const matches = handle.runs.filter((r) => r.role === role);
  if (matches.length === 0) throw new Error(`writeRetrievalTerminal: no declared run for role ${role}`);
  // ⚠️ THROWS RATHER THAN PICKING ONE (v9 §4.2), matching the throw above for a role with no run at
  // all. This function writes the FIRST match; `advance` then advances EVERY match. Silently writing
  // one row and advancing several revisions is the failure this refuses.
  if (matches.length > 1) {
    throw new Error(`writeRetrievalTerminal: ${matches.length} declared runs for role ${role} on one handle`);
  }
  const run = matches[0];

  const manifest: StampedRetrievalManifest = { ...input.payload, operational: input.operational };
  const counters = counterColumns(input.payload);

  try {
    const updated = (await sql(
      `UPDATE opd_audit_retrieval_telemetry
          SET persistence_state = 'retrieval_complete',
              retrieval_outcome = $3,
              retrieval_error_class = $4,
              completed_at = $5,
              trace_id = $6,
              expansion_status = $7,
              expansion_route_class = $8,
              expansion_served_model = $9,
              expansion_attempts = $10::jsonb,
              rerank_route_class = $11,
              expected_rerank_batches = $12,
              recorded_rerank_batches = $13,
              served_backend = $14,
              rerank_backend_downgraded = $15,
              rerank_soft_failed = $16,
              fused_candidate_count = $17,
              hydrated_candidate_count = $18,
              index_version = $19,
              context_hmac = $20,
              retrieval_manifest = $21::jsonb,
              telemetry_error = $22,
              active_backfill_run_id = $23,
              active_backfill_target = $24,
              active_backfill_state = $25,
              rerank_vertex_batches = $26,
              rerank_openrouter_batches = $27,
              rerank_local_batches = $28,
              rerank_failed_batches = $29,
              rerank_unattributed_batches = $30,
              rerank_not_served_batches = $31,
              rerank_429_attempts = $32,
              row_revision = row_revision + 1
        WHERE retrieval_run_id = $1
          AND row_revision = $2
          AND persistence_state = 'started'
        RETURNING row_revision`,
      [
        run.runId, run.expectedRevision,
        input.payload.retrieval_outcome, input.payload.retrieval_error_class,
        input.completedAt, input.traceId,
        input.payload.expansion.status, input.payload.expansion.served_route_class,
        input.payload.expansion.served_model,
        input.payload.expansion.attempts === null ? null : JSON.stringify(input.payload.expansion.attempts),
        rerankRouteClassOf(input.payload),
        input.payload.expected_batch_count, input.payload.recorded_rerank_batches,
        input.payload.served_backend, input.payload.rerank_backend_downgraded,
        input.payload.rerank_soft_failed,
        input.payload.fused_candidate_count, input.payload.hydrated_candidate_count,
        input.payload.index_version, input.payload.scorer_context_hmac,
        canonicalJson(manifest), input.payload.telemetry_error,
        input.operational.active_backfill_run_id, input.operational.active_backfill_target,
        input.operational.active_backfill_state,
        counters.rerank_vertex_batches, counters.rerank_openrouter_batches,
        counters.rerank_local_batches, counters.rerank_failed_batches,
        counters.rerank_unattributed_batches, counters.rerank_not_served_batches,
        counters.rerank_429_attempts,
      ],
    )) as Array<{ row_revision: number }>;

    if (updated.length === 0) {
      // ══ THE REJECTED TERMINAL WRITE (addendum v7 §8) ═══════════════════════════════════════════
      //
      // Zero rows updated is NOT an exception, so the catch below never fires and — until this —
      // the only trace was a `console.warn`. The manifest, the counters and the defect list computed
      // for this write were computed and discarded, and nothing in the database recorded that the
      // attempt had happened at all.
      //
      // ⚠️ STILL NEVER RETRIED BLINDLY (D12). A blind retry is how an old invocation overwrites a
      // newer terminal result. The reread below is a READ, and its only outcome is a decision about
      // what to record — it never rewrites the row.
      await rejectedEvidence(handle, run, input.completedAt);
      return handle;
    }
    return advance(handle, role, updated[0].row_revision);
  } catch (e) {
    await failEvidence(handle.invocationId, run, 'retrieval_terminal', 'retrieval_complete', e, input.completedAt);
    return handle;
  }
}

/** The single served class the ROW carries for reranking. The per-batch detail lives in the
 *  manifest; this is the row-level summary a census groups by. */
function rerankRouteClassOf(p: RetrievalPayload): string | null {
  if (p.batches.length === 0) return null;
  const classes = new Set(p.batches.map((b) => b.served_route_class ?? 'unattributed'));
  return classes.size === 1 ? [...classes][0] : 'mixed';
}

function advance(handle: LifecycleHandle, role: RetrievalRole, revision: number): LifecycleHandle {
  return {
    ...handle,
    runs: handle.runs.map((r) => (r.role === role ? { ...r, expectedRevision: revision } : r)),
  };
}

/** Write failure evidence, and fall back to the invocation counter when even that fails (D12). */
/**
 * Durable evidence for a terminal compare-and-set that matched no row, plus the reread that decides
 * whether anything is owed (addendum v7 §8).
 *
 * ⚠️ REREAD, AND PRESERVE AN EXISTING TERMINAL ROW. Two different things produce zero rows: the
 * revision moved under us, or the row already left `started`. Only a read can tell them apart, and
 * the answer decides whether this rejection is benign. **A terminal row is never downgraded** — this
 * function writes no UPDATE at all, so preservation is structural rather than a rule someone has to
 * remember.
 *
 * ⚠️ FAIL-SAFE, LIKE EVERY OTHER TELEMETRY PATH. Constraint 2: a telemetry write that fails degrades
 * to a no-op, never to a 500 and never to wrong data. The reread is wrapped, the evidence write is
 * already fail-open through `recordTelemetryFailure`, and a failure of the evidence write itself
 * falls back to the invocation counter exactly as `failEvidence` does.
 */
async function rejectedEvidence(
  handle: LifecycleHandle,
  run: LifecycleRun,
  observedAt: string,
): Promise<void> {
  let observedState: string | null = null;
  try {
    const rows = (await sql(
      `SELECT persistence_state, row_revision, audit_id
         FROM opd_audit_retrieval_telemetry
        WHERE retrieval_run_id = $1`,
      [run.runId],
    )) as Array<{ persistence_state: string; row_revision: number }>;
    observedState = rows[0]?.persistence_state ?? null;
  } catch {
    // The reread is diagnostic. Losing it must not lose the evidence write below.
    observedState = null;
  }

  const alreadyTerminal = observedState != null && isTerminalState(observedState);
  console.warn(
    '[retrieval-telemetry] terminal write rejected (revision or state moved)', role_(run),
    alreadyTerminal ? `— row already terminal (${observedState}), preserved` : `— row state ${observedState ?? 'unknown'}`,
  );

  const ok = await recordTelemetryFailure({
    invocationId: handle.invocationId, retrievalRunId: run.runId, retrievalRole: run.role,
    failedPhase: 'retrieval_terminal_rejected',
    // The state this write INTENDED to reach. It is not the state the row is in — that is the
    // reread above, and it is deliberately not asserted as an outcome here.
    intendedState: 'retrieval_complete',
    errorClass: alreadyTerminal ? 'row_already_terminal' : 'revision_or_state_moved',
    observedAt,
  });
  if (!ok) await bumpTelemetryWriteFailure(handle.invocationId);
}

/** The role, for the log line. Kept tiny so the warn call reads at a glance. */
function role_(run: LifecycleRun): string { return run.role; }

async function failEvidence(
  invocationId: string,
  run: LifecycleRun,
  phase: 'retrieval_terminal' | 'persistence_link' | 'work_declaration',
  intended: RetrievalPersistenceState | null,
  e: unknown,
  observedAt: string,
): Promise<void> {
  const ok = await recordTelemetryFailure({
    invocationId, retrievalRunId: run.runId, retrievalRole: run.role,
    failedPhase: phase, intendedState: intended, errorClass: errorClassOf(e), observedAt,
  });
  if (!ok) await bumpTelemetryWriteFailure(invocationId);
}

/**
 * One `work_declaration` failure row per run the failed batch was going to declare (kickoff test
 * 29, D13). NEVER THROWS — `failEvidence` is fail-open all the way down — so the declaration's own
 * error is the one that reaches the caller.
 *
 * `observed_at` is the invocation's start: the declaration is the first durable write a request
 * makes, and the failure table's retention anchor should sit with the invocation it belongs to.
 */
async function recordDeclarationFailure(
  ctx: TelemetryRequestContext,
  runs: DeclareInput[],
  e: unknown,
): Promise<void> {
  for (const r of runs) {
    await failEvidence(
      ctx.invocationId, { role: r.role, runId: r.runId, expectedRevision: 0 },
      'work_declaration', 'started', e, ctx.startedAt,
    );
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// THE UPDATE PRECEDENCE (D12) — no-op, then revision, then transition, then apply
// ════════════════════════════════════════════════════════════════════════════════════════════════

export interface SettleWriteInput {
  state: RetrievalPersistenceState;
  auditId: string | null;
  settledAt: string;
}

/**
 * Apply a terminal state to one run, in D12's EXACT precedence order.
 *
 *   1. identical-content no-op  — does NOT increment row_revision
 *   2. expected-revision check  — rejected and logged on mismatch, never retried blindly
 *   3. transition check         — terminal states never transition
 *   4. apply, and increment
 *
 * The order matters. Checking the revision first would burn a revision on a write that changed
 * nothing, and a retry that changed nothing would then look like a conflict to the next caller.
 */
export async function applyTerminalState(
  handle: LifecycleHandle,
  run: LifecycleRun,
  input: SettleWriteInput,
): Promise<{
  handle: LifecycleHandle;
  status: 'settled' | 'noop' | 'rejected' | 'failed';
  errorClass?: string;
  rejection?: SettlementRejection;
}> {
  /** A rejection leaves DURABLE EVIDENCE, not only a log line. The intended state never landed, so
   *  D13's `persistence_link` mapping is exactly the right classification for a row still short of
   *  it — and a row that is already terminal is never selected by the reconciler, so evidence
   *  attached to one is inert rather than misleading. */
  const reject = async (rejection: SettlementRejection, why: string) => {
    console.warn('[retrieval-telemetry] settlement rejected:', rejection, run.role, why);
    await failEvidence(
      handle.invocationId, run, 'persistence_link', input.state,
      { name: `settlement_rejected_${rejection}` }, input.settledAt,
    );
    return { handle, status: 'rejected' as const, rejection };
  };
  try {
    const current = (await sql(
      `SELECT persistence_state, row_revision, audit_id
         FROM opd_audit_retrieval_telemetry
        WHERE retrieval_run_id = $1`,
      [run.runId],
    )) as Array<{ persistence_state: string; row_revision: number; audit_id: string | null }>;

    if (current.length === 0) return reject('no_row', run.runId);
    const row = current[0];

    // 1. IDENTICAL CONTENT — a retry of a write that already landed. No revision is burned.
    if (row.persistence_state === input.state && row.audit_id === input.auditId) {
      return { handle, status: 'noop' };
    }
    // 2. REVISION
    if (row.row_revision !== run.expectedRevision) {
      return reject('stale_revision', `expected ${run.expectedRevision}, found ${row.row_revision}`);
    }
    // 3. TRANSITION — terminal states never transition, and the table is the only authority.
    if (isTerminalState(row.persistence_state)) {
      return reject('already_terminal', row.persistence_state);
    }
    if (!isAllowedTransition(row.persistence_state, input.state)) {
      return reject('disallowed_transition', `${row.persistence_state} -> ${input.state}`);
    }
    // 4. APPLY
    const updated = (await sql(
      `UPDATE opd_audit_retrieval_telemetry
          SET persistence_state = $3, audit_id = $4, persistence_settled_at = $5,
              row_revision = row_revision + 1
        WHERE retrieval_run_id = $1 AND row_revision = $2
        RETURNING row_revision`,
      [run.runId, run.expectedRevision, input.state, input.auditId, input.settledAt],
    )) as Array<{ row_revision: number }>;
    // A zero-row UPDATE after the revision already matched on the SELECT means somebody else moved
    // the row between the two statements. Not retried — that is what the reconciler is for.
    if (updated.length === 0) return reject('lost_update', run.runId);
    return { handle: advance(handle, run.role, updated[0].row_revision), status: 'settled' };
  } catch (e) {
    await failEvidence(handle.invocationId, run, 'persistence_link', input.state, e, input.settledAt);
    return { handle, status: 'failed', errorClass: errorClassOf(e) };
  }
}

/** The projection the identical-content check compares, derived from the DDL and classified in
 *  COLUMN_CLASSIFICATION. Exported so the test can assert the classification is total rather than
 *  a list somebody remembered to keep up to date. */
export const EQUALITY_PROJECTION = COLUMN_CLASSIFICATION.mutable_terminal;
