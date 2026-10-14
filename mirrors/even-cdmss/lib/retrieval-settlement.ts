/**
 * lib/retrieval-settlement.ts — linking telemetry to what the audit persistence actually did.
 * On-path kickoff D9, D12. PRD v2.1 §4.5 steps 4 and 5.
 *
 * ⚠️ PER-RUN ISOLATION IS THE WHOLE POINT. If primary settles and normative fails, this returns one
 * `settled` and one `failed`, writes a `persistence_link` failure row for the failed run, and DOES
 * NOT THROW. `telemetry_link_failed` is deliberately not a settlement outcome: a telemetry problem
 * on one role must not restate the other role's real, known outcome as unknown.
 */

import {
  stateForSettlement, isAllowedTransition, reconcilerStateFor,
  type SettlementOutcome, type RetrievalPersistenceState,
} from './retrieval-telemetry-core';
import {
  applyTerminalState,
  type LifecycleHandle, type LifecycleRun, type PerRunSettlementResult,
  type ManifestDefectsByRole,
} from './retrieval-telemetry-store';
import { failurePhasesForRun } from './retrieval-telemetry-failure-store';

export interface SettlementInput {
  /**
   * ONE BASE OUTCOME PER HANDLE. What the owner observed about the save, for the whole audit.
   *
   * ⚠️ `persisted_dirty` IS EXCLUDED, AND MUST NEVER ARRIVE PRE-DERIVED (addendum v1 line 523,
   * v9 §4.1). It is DERIVED here, per run, by `upgradeForDefects` from that run's own role's
   * manifest verdict. An owner that could pass it in would be deciding, from one flat verdict, a
   * question that belongs to each row separately — which is the contamination pass 0b removed.
   */
  outcome: Exclude<SettlementOutcome, 'persisted_dirty'>;
  /** Linked ONLY after the actual persistence result is known (§4.5 step 4). Null is a real state:
   *  a losing race, a failed save, or a retrieval that never produced an audit row. §4.2 forbids
   *  creating a synthetic audit row to populate it. */
  auditId: string | null;
  settledAt: string;
  /**
   * `validateManifest`'s output PER ROLE (pass 0b). Optional: a caller with no manifest verdict —
   * every single-role and uninstrumented owner — omits it and behaves exactly as before.
   *
   * ⚠️ THE CLEAN-TO-DIRTY UPGRADE IS APPLIED PER RUN, BELOW, NOT BY THE CALLER. That is the whole
   * correction: the owner knows one save result for the audit, but each ROW's manifest is its own,
   * and only the run itself can say whether its manifest was clean.
   *
   * ⚠️ OMITTING IT AND PASSING `{}` ARE NOT THE SAME THING (v10 requirements 6 and 7). Omitted
   * means "no verdict to give" and is clean. An empty PROVIDED map means "verdicts exist and none
   * of them is about this role", which settles a linkable clean run partial. Owners therefore pass
   * `undefined` rather than `?? {}` — see `verdictForRun`.
   */
  manifestDefectsByRole?: ManifestDefectsByRole;
}

/**
 * The synthetic defect that stands for "a map was provided and said nothing about this role".
 *
 * ⚠️ NOT A NEW OUTCOME VALUE, AND NOT A NEW PERSISTED VOCABULARY. It exists only to reach
 * `upgradeForDefects`, which is what keeps rule 3 honest: ONLY the clean branch is upgraded, so a
 * losing race or a skip is still never made partial. Nothing writes this string to the database —
 * `roleDefects` is read by `upgradeForDefects` and by nothing else — so this pass adds no SQL, no
 * DDL and no migration. v9 §5.4 considered a real "no verdict" outcome and did not propose one.
 */
export const MISSING_ROLE_VERDICT = 'manifest_verdict_absent_for_role';

/**
 * The manifest verdict that applies to ONE run, under v10 requirements 6, 7, 8, 9 and 10.
 *
 * Three cases, and they are three different statements:
 *
 *   1. NO MAP AT ALL (requirement 7). The caller has no manifest verdict to give — every
 *      single-role and uninstrumented owner. Backward compatible: clean.
 *
 *   2. MAP PROVIDED, OWN-ROLE KEY PRESENT (requirement 8). That entry decides, and an explicit
 *      `[]` is a real verdict of clean. This is the only case in which the caller has actually
 *      inspected this role's manifest.
 *
 *   3. MAP PROVIDED, OWN-ROLE KEY ABSENT (requirement 6). The caller was instrumented, produced
 *      verdicts, and produced none for this role — so nobody ever validated the manifest this row
 *      claims to describe. A LINKABLE clean run settles partial rather than clean. Silence from an
 *      instrument that was running is not evidence of cleanliness.
 *
 * ⚠️ LINKABLE ONLY (requirement 9). A revision-0 run never wrote a terminal manifest, so there is
 * nothing about it to be partial about; it keeps going through `stateForUnwrittenRun` and is never
 * linked by this rule. This is also what makes an attached-but-empty map safe: an empty map means
 * no terminal write landed, so every run on that handle is still at revision 0.
 *
 * ⚠️ OWN PROPERTIES ONLY (requirement 10). `hasOwnProperty`, not `in` and not truthiness. An
 * inherited key is not a verdict anyone recorded, and `Object.prototype` already carries names a
 * role could one day collide with. Truthiness would additionally read an explicit `[]` — a real
 * clean verdict — as absent, which is exactly the distinction rule 2 exists to keep.
 */
export function verdictForRun(
  map: ManifestDefectsByRole | undefined,
  role: string,
  linkable: boolean,
): readonly string[] {
  if (map === undefined) return [];                                        // 1
  if (Object.prototype.hasOwnProperty.call(map, role)) {
    return (map as Record<string, readonly string[] | undefined>)[role] ?? [];   // 2
  }
  return linkable ? [MISSING_ROLE_VERDICT] : [];                           // 3
}

/**
 * Settle every declared run of one handle.
 *
 * ⚠️ EXACTLY ONCE, AND ASSERTED DIRECTLY. The revision guard makes a second call a no-op, but a
 * no-op is not the same as never having been called: a double settlement means two owners believe
 * they own the same run, which is a wiring bug that an idempotent write would hide. The caller's
 * test asserts the call count, not just the final state.
 */
export async function settleRetrievalTelemetry(
  handle: LifecycleHandle,
  input: SettlementInput,
): Promise<PerRunSettlementResult[]> {
  const results: PerRunSettlementResult[] = [];
  let current = handle;

  // ⚠️ ONE RUN PER ROLE ON A SETTLING HANDLE (v9 §4.2). Settlement walks `handle.runs` and calls
  // `applyTerminalState` per run; two runs sharing a role would settle the same row twice and
  // `advance` would move both revisions, so the second write sees a revision it did not set. The
  // duplicate is REFUSED AND REPORTED rather than silently settled — `status` stays at D12's three
  // values and the new class goes in `rejection`, which is where a "did not happen, and here is
  // why" belongs.
  //
  // Not at declaration: `declareNoteRuns` legitimately declares one `primary` run per note in a
  // batch, and a guard there would stop the worker.
  const rolesSeen = new Set<string>();

  for (const run of handle.runs) {
    if (rolesSeen.has(run.role)) {
      results.push({
        role: run.role, runId: run.runId, status: 'rejected', rejection: 'duplicate_role_on_handle',
      });
      continue;
    }
    rolesSeen.add(run.role);
    // ⚠️ A ROLE STILL AT REVISION 0 IS NOT LINKED. Revision 0 means its terminal write never
    // landed, so there is no manifest to attach an audit to; linking it would claim this run
    // produced the evidence the audit was built from, which it demonstrably did not.
    //
    // ⚠️ HOISTED ABOVE THE OUTCOME, DELIBERATELY (v10 requirement 6). The missing-key rule below
    // applies only to a LINKABLE run, so linkability has to be known before the outcome is derived.
    // It is hoisted rather than duplicated inline: a second copy of `run.expectedRevision > 0` is
    // how the two definitions drift apart later. Line 94's use of it is unchanged.
    const linkable = run.expectedRevision > 0;
    // ⚠️ EACH RUN'S OWN ROLE'S DEFECTS, AND NOBODY ELSE'S (pass 0b). One base outcome arrives for
    // the handle; the clean-to-dirty upgrade is decided here, per run, from that run's own
    // manifest verdict — never from a verdict belonging to someone else.
    const roleDefects = verdictForRun(input.manifestDefectsByRole, run.role, linkable);
    const runOutcome = upgradeForDefects(input.outcome, roleDefects);
    const outcomeState: RetrievalPersistenceState = stateForSettlement(runOutcome);

    const state = linkable ? outcomeState : await stateForUnwrittenRun(run, outcomeState);
    const r = await applyTerminalState(current, run, {
      state, auditId: linkable ? input.auditId : null, settledAt: input.settledAt,
    });
    current = r.handle;
    results.push(
      r.status === 'failed'
        ? { role: run.role, runId: run.runId, status: 'failed', errorClass: r.errorClass }
        : r.status === 'rejected'
          // ⚠️ NOT `settled`. The five rejection classes each mean the row is NOT in the state this
          // caller asked for, and every one of them used to be reported as success — which is how
          // a permanently `started` row and a completed audit could both be true at once.
          ? { role: run.role, runId: run.runId, status: 'rejected', rejection: r.rejection }
          // `noop` IS settled: identical content already landed, and a retry of a write that
          // succeeded is not a second event.
          : { role: run.role, runId: run.runId, status: 'settled' },
    );
  }
  return results;
}

/**
 * The state for a run that never wrote its terminal manifest — D9's "settled from the failure
 * evidence", which the previous version of this module did not do.
 *
 * Two cases, and they are genuinely different:
 *
 *   · THE OUTCOME IS ONE A RUN THAT NEVER RETRIEVED CAN HONESTLY CARRY. `retrieval_not_run` and
 *     `audit_generation_failed` are both legal from `started` (D12 keeps the second deliberately,
 *     because `auditOpdNote` can throw at steps 7, 8 or 9). The owner's own outcome is the truth
 *     and is applied unchanged — this is the D9 owner matrix's "throw before adoption" and "throw
 *     after adoption" rows, and nothing about them is unknown.
 *
 *   · THE OUTCOME IMPLIES A RETRIEVAL THAT COMPLETED. `persisted_complete` and its siblings are
 *     legal only from `retrieval_complete`. A revision-0 row is not there, so the outcome cannot be
 *     applied and D12's transition guard rejects it — which is precisely what left these rows
 *     `started` while the caller was told they had settled. The failure evidence decides instead,
 *     by exactly the mapping D13 gives the reconciler: `retrieval_terminal` evidence means the
 *     write was attempted and failed (`telemetry_persistence_failed`); no evidence means nothing
 *     was ever heard from it (`aborted`).
 *
 * ⚠️ DECIDED, AND D9 IS AMENDED TO SAY IT (addendum v1 item 2, 13 Aug 2026; decisions §2). D9 used
 * to read that `aborted`, `persistence_unknown` and `telemetry_persistence_failed` were reachable
 * only by the reconciler, while the same section required a revision-0 run to be "settled from the
 * failure evidence" — and that evidence has exactly one mapping, which produces two of the three.
 * The amended rule is that the three states are produced only through `reconcilerStateFor`, wherever
 * it is called; settlement may call it for a revision-0 run; and the settlement mapping table itself
 * never names them. That is the same rule, not a new one, and the call below is it.
 *
 * The code was not changed to obey the older literal reading. `RECONCILER_STALE_AFTER_SECONDS` is
 * `WORKER_MAX_DURATION_SECONDS + 1800`, so waiting for the reconciler would leave a row whose fate
 * is already known sitting non-terminal for about 43 minutes before it received the identical value
 * from the identical mapping.
 */
async function stateForUnwrittenRun(
  run: LifecycleRun,
  outcomeState: RetrievalPersistenceState,
): Promise<RetrievalPersistenceState> {
  if (isAllowedTransition('started', outcomeState)) return outcomeState;
  return reconcilerStateFor('started', await failurePhasesForRun(run.runId));
}

/**
 * THE OWNER'S ONE LINE (D9). Every path in the owner matrix ends in a call to this.
 *
 * ⚠️ NEVER THROWS, AND NEVER RETURNS A REASON TO STOP. Constraint 1: an audit is never failed
 * because its telemetry could not be settled. The per-run results are still available to a caller
 * that wants them — `settleRetrievalTelemetry` is exported — but no owner in D9's matrix branches
 * on them, and one that did would be making a clinical write depend on a telemetry write.
 *
 * A null handle, or a handle with no runs, settles nothing: that is the uninstrumented path, which
 * is most callers, and it must cost nothing at all.
 */
export async function settleOwned(
  handle: LifecycleHandle | null | undefined,
  /** Narrowed with `SettlementInput.outcome` it forwards to (v9 §4.1): an owner cannot pre-derive
   *  `persisted_dirty` here either. The upgrade belongs to the run, not to the caller. */
  outcome: Exclude<SettlementOutcome, 'persisted_dirty'>,
  auditId: string | null = null,
  /**
   * ⚠️ TRAILING AND OPTIONAL, SO NO POSITIONAL ARGUMENT MOVES (pass 0b). The shape this function
   * promises is unchanged: ONE base outcome per handle, ONE settlement call. Omitting it is exactly
   * today's behaviour, which is what every single-role and uninstrumented owner does.
   */
  manifestDefectsByRole?: ManifestDefectsByRole,
): Promise<void> {
  if (!handle || handle.runs.length === 0) return;
  try {
    await settleRetrievalTelemetry(handle, {
      outcome, auditId, settledAt: new Date().toISOString(), manifestDefectsByRole,
    });
  } catch (e) {
    // settleRetrievalTelemetry isolates each run and does not throw; this is the belt for a
    // programming error inside it, not for a database fault, which is already handled below it.
    console.warn('[retrieval-telemetry] settlement threw, which it is not supposed to:', (e as Error).message);
  }
}

/**
 * The save result AND the manifest verdict together, because D17 needs both.
 *
 * `persisted_complete` requires `validateManifest` to have returned `[]`. A save that landed with a
 * dirty manifest is `persisted_partial` — the audit is real, and the record of how it was built is
 * incomplete. Only the clean branch can be upgraded: a losing race or a skip is not made partial by
 * a manifest defect, because neither of them persisted anything to be partial about.
 */
export function outcomeForOwnedSave(
  result: 'inserted' | 'updated' | 'exists' | 'skipped',
  // ⚠️ THE RETURN NARROWS WITH `SettlementInput.outcome` (v9 §4.1). This function maps four save
  // results to four BASE outcomes and provably never produces `persisted_dirty` — its type merely
  // said it might. Narrowing here is what lets the six owners keep passing its result straight into
  // `settleOwned` without any of them changing, which matters because they belong to commit D.
): Exclude<SettlementOutcome, 'persisted_dirty'> {
  return outcomeForSaveResult(result);
}

/**
 * The clean-to-dirty upgrade, applied to ONE run from ONE role's defects (pass 0b).
 *
 * ⚠️ ONLY THE CLEAN BRANCH IS UPGRADED, AND THAT IS UNCHANGED. A losing race or a skip is not made
 * partial by a manifest defect, because neither of them persisted anything to be partial about. No
 * defect code changed meaning in this rekeying: the same codes, from the same `validateManifest`,
 * decide the same upgrade — they are now attributed to the role that produced them.
 */
export function upgradeForDefects(
  base: SettlementOutcome,
  manifestDefects: readonly string[],
): SettlementOutcome {
  return base === 'persisted_clean' && manifestDefects.length > 0 ? 'persisted_dirty' : base;
}

/**
 * What `saveOpdAudit` returned, mapped to a settlement outcome (D9).
 *
 * ⚠️ ALL FOUR RETURN VALUES ARE COVERED, INCLUDING `skipped`. It is reachable — it is the no-uid
 * branch — and it means the audit was never keyed, which is a decision and not a failure. Mapping
 * it to anything else would report a deliberate skip as a lost write.
 */
export function outcomeForSaveResult(
  result: 'inserted' | 'updated' | 'exists' | 'skipped',
): Exclude<SettlementOutcome, 'persisted_dirty'> {
  switch (result) {
    case 'inserted':
    case 'updated':
      // The caller upgrades this to `persisted_dirty` when validateManifest returned anything.
      return 'persisted_clean';
    case 'exists':
      // ⚠️ A LOSING ON CONFLICT RACE IS NOT A FAILURE. D9 sends it to `completed_unpersisted`,
      // which is why the committed comment on `audit_persistence_failed` — "the audit write failed
      // or lost its ON CONFLICT race" — became false and was corrected.
      return 'losing_conflict';
    case 'skipped':
      return 'persistence_skipped';
  }
}
