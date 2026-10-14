/**
 * lib/retrieval-telemetry-core.ts — the PURE core of Stage 0a rerank telemetry.
 * CDMSS-RERANK-TELEMETRY-PRD-v2.1-11-AUG-2026 §4.2, §4.3, §4.6, and the on-path kickoff's D2, D5,
 * D9, D12, D15, D16, D17.
 *
 * OBSERVATION ONLY. Nothing here decides a ranking, chooses a provider, sizes a batch or reaches a
 * scorer input. No fs, no net, no clock, no process.env — `node:crypto` is computation, and the
 * HMAC key is passed IN so this module can be unit-tested without a secret and can never leak one.
 *
 * ⚠️ NO CLINICAL TEXT EVER REACHES A FIELD DEFINED HERE. Every identifier-shaped value is a keyed
 * HMAC and every measurement is a count, an enum or a timing. §6.4 asserts it on the two
 * field-bearing declarations; the types are written so the honest version is also the easy one —
 * there is no free-text field to fill.
 *
 * ⚠️ AND THE IN-MEMORY CAPTURE TYPE IS NOT DECLARED HERE, deliberately (D5). It holds RAW passage
 * bytes on their way to becoming keyed HMACs, so it lives in lib/retrieval-capture.ts — the
 * sentence above is only true if it stays out. A source assertion pins that this file does not
 * contain its NAME, which is why the name is not written anywhere in this file, not even in a
 * comment: the cheapest possible check is one that cannot be argued with.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
/**
 * ⚠️ THIS FILE'S FIRST OUTBOUND IMPORT (v11 §4 item 4, §5). It had none until now — only
 * `node:crypto` above — and `lib/transport-attribution-core.ts` imports nothing at all, so no cycle
 * is possible in either direction. The architecture map gains one edge because of this line, and
 * `lib/architecture/map.generated.ts` is regenerated in the same commit.
 *
 * The alternative was a second copy of the six values here, which is the defect this pass removes
 * from `RERANK_SEED_STATUSES` a few lines below. One authority, imported.
 */
import { TRANSPORT_ATTEMPT_OUTCOMES } from './transport-attribution-core';

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 1. VERSIONS — independent of the application deployment (§4.3)
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The row contract (the columns the migration route creates). Bumped when a COLUMN changes.
 * Separate from the manifest version on purpose: the JSONB payload evolves far faster than the
 * scalar columns, and a canary window must be able to say "one schema version" about each.
 *
 * 1 → 2: the on-path build. Fourteen persistence states (from eight), the retrieval role, the two
 * candidate counts, the served backend and its downgrade flag, the index version, the backfill
 * activity triple, and the two sibling tables.
 */
export const TELEMETRY_SCHEMA_VERSION = 2;

/**
 * The JSONB manifest contract. Bumped when a manifest FIELD changes.
 *
 * ⚠️ 2 → 3 (pass 0a). Addendum v7 §10 added `rerank_temperature` and `rerank_seed_status` to
 * `retrieval_config`, and the version did not move — so a manifest WITH the fields and one WITHOUT
 * them both claimed version 2, which is exactly what the version exists to prevent. PRD §7 gates the
 * canary on recognised manifest versions, and a version that does not discriminate cannot gate.
 *
 * ⚠️ THERE ARE NO VERSION-2 ROWS ANYWHERE. The three telemetry tables have never been created in
 * production, and the only database that has ever held them is the measurement branch, whose rows
 * are synthetic and carry `route = 'script'`. So this bump orphans no stored data, and the validator
 * below deliberately recognises ONE version rather than a list — see `manifest_version_unrecognized`.
 */
export const MANIFEST_SCHEMA_VERSION = 3;

/**
 * The HMAC key generation. §4.3 requires a versioned key identifier: a rotated key produces
 * different digests for identical input, and without this a window would silently compare
 * pre-rotation and post-rotation HMACs as if they disagreed.
 */
export const HMAC_KEY_VERSION = 'k1';

/** The one `telemetry_error` value §4.3 and D8 give a defined meaning to. */
export const TELEMETRY_ERROR_HMAC_KEY_ABSENT = 'hmac_key_absent';

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 2. PERSISTENCE STATES (§4.2, D9) — one vocabulary, generated into the CHECK constraint
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * ⚠️ THIS LIST IS THE SOURCE OF TRUTH. The migration route GENERATES its CHECK from it (D2 forbids
 * hand-typing the values), and the `.sql` mirror is held to the route by a parity test. §4.2 asks
 * for a database constraint OR an equivalently centralized runtime definition; this ships both,
 * because the failure they guard differs at each end — the constraint stops a bad write, the union
 * type stops a bad read.
 *
 * ⚠️ `not_eligible` IS REMOVED (D9). It was in the committed vocabulary and had no owner in the
 * settlement matrix: every case that would have used it is really one of `retrieval_not_run`,
 * `no_persistence_intended` or `persistence_skipped`, which say WHY. A state nobody writes is a
 * state that makes a census look complete while answering nothing.
 */
export const RETRIEVAL_PERSISTENCE_STATES = [
  // ── NON-TERMINAL (2) ──────────────────────────────────────────────────────────────────────────
  /** Written BEFORE any provider work (§4.5 step 1). A killed invocation stays visible as this. */
  'started',
  /** Retrieval settled and its terminal manifest is written; the audit's fate is not yet known. */
  'retrieval_complete',

  // ── TERMINAL (12) ─────────────────────────────────────────────────────────────────────────────
  /** The audit persisted, and validation of this run's manifest was clean. */
  'persisted_complete',
  /** The audit persisted; the manifest is incomplete — recorded, never silently upgraded. */
  'persisted_partial',
  /**
   * The audit was written by ANOTHER execution: this one lost its ON CONFLICT race. Its telemetry
   * survives unlinked (§4.5 step 5) — the losing computation really happened and really cost money.
   */
  'completed_unpersisted',
  /** A governance refusal (DEC-2) stopped the write. Not a failure; a decision. */
  'persistence_refused',
  /**
   * The audit write itself FAILED.
   *
   * ⚠️ CORRECTED (D9). The committed comment on this state read "the audit write failed or lost its
   * ON CONFLICT race". The second half is now false and is removed: D9's outcome table sends
   * `losing_conflict` to `completed_unpersisted`, precisely so a race — which is normal, expected
   * concurrency — stops being reported as a failure. The state itself did not change.
   */
  'audit_persistence_failed',
  /** The audit threw before any save was attempted. `saveOpdAudit` was never called. */
  'audit_generation_failed',
  /** Telemetry's own write failed. Fail-visibly (constraint 8): the gap is stated, not hidden. */
  'telemetry_persistence_failed',
  /** Reconciled from a stale `started` after max invocation duration + grace (§4.5 step 6). */
  'aborted',
  /** Reconciled from a stale `retrieval_complete`: the audit's fate is genuinely unknown. */
  'persistence_unknown',
  /** Declared, then the retrieval never ran (the note was unresolvable, the caller returned early). */
  'retrieval_not_run',
  /** This caller never intended to write an audit at all — a lab read, a recall, a dry run. */
  'no_persistence_intended',
  /** `saveOpdAudit` returned `skipped`: there was no uid to key the row on. */
  'persistence_skipped',
] as const;

export type RetrievalPersistenceState = typeof RETRIEVAL_PERSISTENCE_STATES[number];

/** The two states a run can still move out of. */
export const NON_TERMINAL_PERSISTENCE_STATES = ['started', 'retrieval_complete'] as const;

/** Terminal for canary purposes: a window closes only when every run reaches one of these. */
export const TERMINAL_PERSISTENCE_STATES: readonly RetrievalPersistenceState[] =
  RETRIEVAL_PERSISTENCE_STATES.filter(
    (s): s is RetrievalPersistenceState => !(NON_TERMINAL_PERSISTENCE_STATES as readonly string[]).includes(s),
  );

export function isTerminalState(s: string): boolean {
  return (TERMINAL_PERSISTENCE_STATES as readonly string[]).includes(s);
}

/**
 * States in which `retrieval_outcome` MUST be recorded — the run got far enough to have one.
 * Generated into the outcome CHECK alongside the set below (D2 forbids hand-typing either).
 */
export const OUTCOME_REQUIRED_STATES: readonly RetrievalPersistenceState[] = [
  'retrieval_complete', 'persisted_complete', 'persisted_partial', 'completed_unpersisted',
  'persistence_refused', 'audit_persistence_failed', 'persistence_skipped',
  'no_persistence_intended', 'persistence_unknown',
] as const;

/**
 * States in which an outcome may be present or absent, because the run may have been settled from
 * either side of its terminal write.
 *
 * ⚠️ `audit_generation_failed` IS HERE, NOT IN THE REQUIRED SET (D9/D12). D11 puts the primary
 * terminal write at step 12 and `auditOpdNote` can throw at step 7, 8 or 9 — so a row settled this
 * way may still be `started`, having never recorded an outcome. Requiring one would leave the only
 * honest settlement unreachable and hand the row to the reconciler as an `aborted` guess.
 */
export const OUTCOME_EITHER_STATES: readonly RetrievalPersistenceState[] = [
  'aborted', 'retrieval_not_run', 'telemetry_persistence_failed', 'audit_generation_failed',
] as const;

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 3. ROLES (§4.1) AND THE ROUTE TAXONOMY (§5 step 1)
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The closed set of retrieval roles, declared BEFORE retrieval runs (§4.1). One audit can produce
 * two rows — `primary` and `normative_channel` — which is why §7's linked-run rule is role-based:
 * a correctly instrumented audit that ran the normative channel has two linked rows, not one.
 */
export const RETRIEVAL_ROLES = [
  'primary',            // defaultRetrieve in lib/opd-note-audit.ts — the audit's own evidence
  'normative_channel',  // normativeChannelRetrieve — the guideline leg, expansion always skipped
  'lvc_recall',         // defaultRecall's semantic leg in lib/lvc.ts
  'lab_direct',         // labRetrieve's direct branch in lib/mcp-tools.ts
  'lab_multi_query',    // labRetrieve's multi-query branch
] as const;
export type RetrievalRole = typeof RETRIEVAL_ROLES[number];

/**
 * Every entrypoint that can execute an OPD retrieval. The class is what §8's overlap analysis
 * groups by; the route is the specific caller, kept so "which backfill" stays answerable.
 *
 * `unknown_route` exists because §4.4's rule against guessing applies here too: a retrieval reached
 * from a caller this list does not name is recorded as unknown, never assigned to the nearest match.
 * §7/A3 excludes exactly one case by name — `lvc_recall` rows from the appropriateness surface,
 * which has no taxonomy member — and that exclusion is why the value must stay honest.
 */
export const RETRIEVAL_ROUTES = [
  'opd_audit_worker',          // /api/opd-audit/worker — the nightly cron
  'opd_audit_run',             // /api/opd-audit/run — manual single-note
  'opd_audit_mini_backfill',   // /api/admin/opd-audit-mini-backfill
  'opd_dosing_backfill',       // /api/admin/opd-dosing-backfill
  'opd_rescore_direction',     // /api/admin/opd-rescore-direction
  'lab_batch',                 // lib/lab-batch.ts — hosted lab
  'mcp_tools',                 // lib/mcp-tools.ts — lab/measurement seam
  'lvc_judge_aa',              // /api/admin/lvc-judge-aa — A/A replicates
  'script',                    // scripts/*.mjs — local, never in a canary window
  'unknown_route',
] as const;
export type RetrievalRoute = typeof RETRIEVAL_ROUTES[number];

/**
 * The invocation table's route vocabulary: every retrieval route, plus the reconciler, which owns
 * invocations but performs no retrieval. Kept as a SEPARATE type so `RetrievalRoute` cannot
 * accidentally admit `reconciler` on a retrieval row (D17).
 */
export const INVOCATION_ROUTES = [...RETRIEVAL_ROUTES, 'reconciler'] as const;
export type InvocationRoute = typeof INVOCATION_ROUTES[number];

export type RouteClass = 'worker' | 'backfill' | 'lab' | 'manual' | 'unknown' | 'reconciler';

const ROUTE_CLASS: Readonly<Record<InvocationRoute, RouteClass>> = {
  opd_audit_worker: 'worker',
  opd_audit_run: 'manual',
  opd_audit_mini_backfill: 'backfill',
  opd_dosing_backfill: 'backfill',
  opd_rescore_direction: 'backfill',
  lab_batch: 'lab',
  mcp_tools: 'lab',
  lvc_judge_aa: 'lab',
  script: 'manual',
  unknown_route: 'unknown',
  reconciler: 'reconciler',
};

export function routeClassOf(route: string): RouteClass {
  return ROUTE_CLASS[route as InvocationRoute] ?? 'unknown';
}

/**
 * The invocation-level facts a boundary establishes once and threads down (§4.1, D11).
 *
 * ⚠️ THREADED EXPLICITLY, NEVER MODULE STATE. §4.1 forbids mutable process-global state in a
 * serverless process that serves concurrent requests, and that applies to the context, the capture
 * and every id — not only to invocation ids. One module-level "current invocation" would attribute
 * two overlapping requests to whichever wrote last.
 */
export interface TelemetryRequestContext {
  invocationId: string;
  route: InvocationRoute;
  routeClass: RouteClass;
  deploymentSha: string | null;
  /** From `x-vercel-id`. The key is OMITTED when the header is absent — never an empty string. */
  vercelRequestId: string | null;
  startedAt: string;
  routingFlags: Record<string, string>;
  /** Hosted-lab linkage, when this invocation belongs to an experiment. */
  labExperimentId?: string | null;
}

/**
 * Build the context ONE boundary establishes, from that boundary's own request (D11).
 *
 * ⚠️ ONE PLACE, BECAUSE THERE ARE TEN BOUNDARIES. Eight routes and two scripts each create exactly
 * one of these; ten hand-written literals would drift on the deployment SHA env var, on the route
 * class, or on what an absent `x-vercel-id` means, and the drift would look like data.
 *
 * ⚠️ AN ABSENT `x-vercel-id` OMITS THE KEY, never an empty string. An empty string is a value and
 * would be read as one; absence is absence. `routing_flags` stays `Record<string, string>`, so the
 * only honest way to say "not present" is not to have the key.
 */
export function telemetryContextFor(
  route: InvocationRoute,
  headers?: { get(name: string): string | null } | null,
  extra?: { routingFlags?: Record<string, string>; labExperimentId?: string | null },
): TelemetryRequestContext {
  const vercelRequestId = headers?.get('x-vercel-id') || null;
  const routingFlags: Record<string, string> = { ...(extra?.routingFlags ?? {}) };
  return {
    invocationId: randomUUID(),
    route,
    routeClass: routeClassOf(route),
    deploymentSha: process.env.VERCEL_GIT_COMMIT_SHA || null,
    vercelRequestId,
    startedAt: new Date().toISOString(),
    routingFlags,
    labExperimentId: extra?.labExperimentId ?? null,
  };
}

/** Invocation accounting (D2). `reconciler` runs are invocations too, and must not be counted as
 *  retrieval work — §2 forbids reporting a tick as a workload. */
export const INVOCATION_KINDS = ['retrieval', 'reconciler'] as const;
export type InvocationKind = typeof INVOCATION_KINDS[number];

/** An invocation that never reached its own closing write stays `closure_unknown`, honestly. */
export const INVOCATION_CLOSURE_STATES = ['closed', 'closure_unknown'] as const;
export type InvocationClosureState = typeof INVOCATION_CLOSURE_STATES[number];

/**
 * The reranker seed-status vocabulary, as the MANIFEST contract defines it (addendum v7 §10).
 *
 * ⚠️ THIS IS NOW THE ONLY DECLARATION (v11 §7, review 22 item 5). It was duplicated in
 * `lib/retrieval-capture.ts`, identically, because pass 0a's file contract did not include capture
 * and the constant could not be moved then. This pass's contract includes both files, so capture's
 * copy is deleted and capture re-exports THIS OBJECT. `lib/rerank.ts:21` imports the type from
 * capture and needs no change, because the type moved with the const.
 *
 * ⚠️ IDENTITY IS TESTED WITH `strictEqual`, NOT DEEP EQUALITY. A deep-equal assertion passes against
 * a re-declared copy with the same members, which is exactly the drift this collapse removes; only a
 * reference comparison can tell one array from two.
 *
 *   not_applicable  no rerank decode ran, or the backend takes no seed (Cohere is a deterministic
 *                   cross-encoder with neither seed nor temperature)
 *   unseeded        the call set no seed at all — TODAY'S JUDGE, on every path
 *   applied_local   a seed was set and the call served locally, so it reached the model
 *   stripped_cloud  a seed was set in the Ollama options bag and the call served on a cloud tier,
 *                   which strips that bag — so the seed did NOT reach the model
 */
export const RERANK_SEED_STATUSES = ['not_applicable', 'unseeded', 'applied_local', 'stripped_cloud'] as const;
export type RerankSeedStatus = typeof RERANK_SEED_STATUSES[number];

/** The phases a telemetry write can fail in (D2's failure table CHECK). */
export const TELEMETRY_FAILURE_PHASES = [
  'invocation_start', 'work_declaration', 'retrieval_terminal', 'retrieval_terminal_rejected',
  'persistence_link', 'closure',
] as const;
export type TelemetryFailurePhase = typeof TELEMETRY_FAILURE_PHASES[number];

/** The phases that name a specific run, and therefore require a run id and role (D2). */
export const RUN_SCOPED_FAILURE_PHASES: readonly TelemetryFailurePhase[] =
  ['work_declaration', 'retrieval_terminal', 'retrieval_terminal_rejected', 'persistence_link'] as const;

/**
 * ⚠️ `retrieval_terminal_rejected` IS A SIBLING OF `retrieval_terminal`, NOT A REPLACEMENT, AND THE
 * RECONCILER DELIBERATELY DOES NOT MAP IT (addendum v7 §8).
 *
 * A rejected terminal write is a compare-and-set that matched no row: the revision moved, or the row
 * left `started`. That is NOT the same event as a terminal write that threw, and conflating them
 * would lose the distinction the phase exists to record.
 *
 * `reconcilerStateFor` below tests membership of `'retrieval_terminal'` EXACTLY, so a row carrying
 * only this new phase reconciles as `aborted` — the no-evidence answer. That is intentional and is
 * the prior settled decision (decisions §8, 13 Aug): record the event so it becomes countable, and
 * decide the state mapping when C0 shows how often each case occurs. Mapping it now would be a
 * guess dressed as a rule. If C0 shows this path is common, that is the moment to revisit it.
 */

/**
 * Whether a provider backfill was ACTUALLY WORKING when this retrieval ran.
 *
 * ⚠️ LOAD-BEARING, not decoration. §2 forbids twice — once as an evidence boundary and once as a
 * §7 gate — reporting a cron tick as a workload. 360 backfill route invocations were observed;
 * how many of them did work is unknown, and without this flag every overlap analysis would repeat
 * that error with a bigger number.
 */
export const BACKFILL_ACTIVITY = ['active', 'idle'] as const;
export type BackfillActivity = typeof BACKFILL_ACTIVITY[number];

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 4. KEYED HMAC (§4.3) — plain hashes of patient-derived text are not acceptable
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * HMAC-SHA-256 over UTF-8, prefixed with its key version so a rotation is visible in the value
 * itself rather than inferred from a timestamp. Returns `<keyVersion>:<hex>`.
 *
 * ⚠️ WHY NOT sha256. A retrieval question and a passage are patient-derived. An unkeyed digest of a
 * short clinical string is reversible by dictionary attack — the digest IS the source, for anyone
 * willing to enumerate. The key is the whole protection, so it is required, non-empty, and never
 * defaulted: a missing key throws rather than silently degrading to something weaker.
 *
 * ⚠️ THE GUARD TRIMS (D8). It used to test `secret.length === 0` while the build-time guard tested
 * a trimmed value, so a key of three spaces was ABSENT to the deploy check and USABLE here — the
 * two would have disagreed about whether production was configured. A whitespace key is not a key.
 */
export function telemetryHmac(secret: string, value: string, keyVersion = HMAC_KEY_VERSION): string {
  if (typeof secret !== 'string' || secret.trim().length === 0) {
    throw new Error('telemetry HMAC secret is required — an unkeyed digest of clinical text is not acceptable (§4.3)');
  }
  const digest = createHmac('sha256', secret).update(Buffer.from(value ?? '', 'utf8')).digest('hex');
  return `${keyVersion}:${digest}`;
}

/** Constant-time compare of two `<keyVersion>:<hex>` values. False when the key versions differ. */
export function hmacEquals(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 5. MANIFEST (§4.3, D5, D15, D16)
// ════════════════════════════════════════════════════════════════════════════════════════════════

export type ExpansionStatus = 'expanded' | 'skipped' | 'failed_open';

/**
 * Variant-generation status. SIX real values plus `not_collected`.
 *
 * ⚠️ `parse_failure` AND `failed_open` ARE DIFFERENT (A11). Today both land in one catch, so the
 * real generator needs an inner `try` around the parse to tell them apart — a parse failure means a
 * completion ARRIVED, cost tokens and did not parse, which §4.6 prices and §4.4 says keeps its
 * provider, model and usage. A failed-open means the call itself never produced one.
 *
 * ⚠️ `not_collected` IS FOR THE INJECTED SEAM ONLY (A11). `MultiQueryDeps.variantsFn` returns a
 * bare string array, from which `parsed_empty` and `failed_open` are indistinguishable. Guessing
 * either would put a fabricated fact in a provenance record. An admitted gap is not a defect.
 */
export type VariantStatus =
  | 'generated' | 'parsed_empty' | 'all_invalid' | 'not_an_array'
  | 'parse_failure' | 'failed_open' | 'not_collected';

/** The outcome of retrieving for ONE variant arm. Index 0 is the original expanded arm. */
export type VariantOutcome = 'success' | 'zero_hits' | 'retrieval_failure';

/** §4.3: a successful retrieval with hits, a successful retrieval with none, and a failure. */
export type RetrievalOutcome = 'success' | 'zero_hits' | 'retrieval_failure';

/**
 * The terminal outcome of one rerank batch. §6.2 requires these to be DISTINCT: a parse failure and
 * a missing score key are different defects with different fixes, and collapsing them is how a
 * scoring gap becomes invisible.
 *
 * ⚠️ `timeout` IS A MEMBER (D15), not a synonym for `terminal_failure`. A batch that timed out and
 * a batch that was refused are the same shape in the scores array and want opposite remediation —
 * one is a capacity question, the other is not.
 */
export type BatchOutcome =
  | 'success'
  | 'timeout'
  | 'terminal_failure'
  | 'parse_failure'
  | 'missing_score_key'
  | 'nonnumeric_score';

/**
 * Precedence when several defects coexist, highest first (D15). Independent COUNTS are preserved
 * alongside, so a response with both a missing key and a non-numeric one records both facts and
 * one outcome.
 */
export const BATCH_OUTCOME_PRECEDENCE: readonly BatchOutcome[] = [
  'timeout', 'terminal_failure', 'parse_failure', 'missing_score_key', 'nonnumeric_score', 'success',
] as const;

/**
 * Where a stage or batch was actually served.
 *
 * ⚠️ `unattributed` AND `not_served` ARE DIFFERENT FACTS AND §4.4 FORBIDS MERGING THEM.
 * `unattributed` — a completion may have arrived and attribution is unavailable. It is recorded
 * telemetry, it fails the served-attribution objective, and §7 requires it resolved before C0.
 * `not_served` — telemetry can PROVE no completion arrived, and the proof is the failure
 * attribution D14 attaches to the thrown error. Without that proof the honest answer is
 * `unattributed`, not the more convenient one.
 */
export type ServedRouteClass = 'vertex' | 'openrouter' | 'local' | 'unattributed' | 'not_served';

/** One attempt as it reaches the manifest. `provider` is required by §4.6 — cost is countable by
 *  provider, model, attempt and usage, and a ladder's attempts can span three providers. */
export interface ManifestAttempt {
  provider: string;
  attempt: number;
  /** One of the six committed `TransportAttemptOutcome` values (§4.3). */
  outcome: string;
  status: number | null;
}

export interface ManifestBatch {
  /** STABLE index derived from candidate boundaries, never promise completion order (constraint 7). */
  batch_index: number;
  candidate_start: number;
  candidate_end: number;
  intended_provider: string;
  intended_model: string;
  /**
   * What actually served it. The type permits null DEFENSIVELY; the validator rejects it (A6).
   * A batch record exists only where a request was PLANNED, so a null here is a defect and not a
   * declaration — the explicit null belongs at stage level, where a stage can make no request.
   */
  served_route_class: ServedRouteClass | null;
  served_model: string | null;
  /** Ordered attempt outcomes, from the transport's own evidence — never reconstructed. */
  attempts: ManifestAttempt[] | null;
  outcome: BatchOutcome;
  expected_score_keys: number;
  /** Keys that arrived AND parsed as a finite number. A legitimate 0 counts here (§6.2). */
  finite_score_keys: number;
  /** Independent defect counts, preserved alongside the single `outcome` above (D15). */
  missing_score_keys: number;
  nonnumeric_score_keys: number;
  /** Null, not zero, when the provider returned no usage (§4.6). */
  prompt_tokens: number | null;
  completion_tokens: number | null;
}

/** The multi-query section (D6). Required on role `lab_multi_query`, absent elsewhere. */
export interface MultiQuerySection {
  variant_generation: {
    status: VariantStatus;
    /** Null permitted only when the stage made no request (D16's explicit stage-level null). */
    served_route_class: ServedRouteClass | null;
    served_model: string | null;
    attempts: ManifestAttempt[] | null;
    prompt_tokens: number | null;
    completion_tokens: number | null;
    generated_variant_count: number;
  };
  /** `variants.length` equals `generated_variant_count + 1` — index 0 is the ORIGINAL arm. */
  variants: Array<{ index: number; outcome: VariantOutcome; candidate_count: number }>;
}

/**
 * THE TEXT-FREE PAYLOAD. Every field here is a count, an enum, an id or a keyed HMAC.
 *
 * ⚠️ §6.4 SLICES THIS DECLARATION BY NAME and fails if a field that could hold clinical text is
 * added to it. Renaming it without re-pointing that test makes the assertion pass vacuously, which
 * is why the rewritten pin asserts its slice is non-empty before testing it.
 */
export interface RetrievalPayload {
  manifest_schema_version: number;
  /** Null ONLY with `telemetry_error = 'hmac_key_absent'`, which cannot happen in production. */
  hmac_key_version: string | null;
  telemetry_error: string | null;

  retrieval_outcome: RetrievalOutcome;
  /** A class name. Never a message, never a value. Required when the outcome is a failure. */
  retrieval_error_class: string | null;

  expansion: {
    status: ExpansionStatus;
    input_hmac: string | null;
    served_route_class: ServedRouteClass | null;
    served_model: string | null;
    attempts: ManifestAttempt[] | null;
  };

  multi_query?: MultiQuerySection;

  /**
   * TWO CANDIDATE COUNTS, NOT ONE (§4.3). `fused` is the pool after the cap; `hydrated` is what the
   * re-read actually returned, and it is the number the rerank guard tests. They can differ, and
   * the difference is a dropped row — invisible if only one is recorded.
   */
  fused_candidate_ids: number[];
  hydrated_candidate_ids: number[];
  fused_candidate_count: number;
  hydrated_candidate_count: number;
  /** One per HYDRATED row, not per fused id. Null only with `hmac_key_absent`. */
  pre_rerank_passage_hmacs: string[] | null;

  intended_backend: string;
  intended_model: string;
  /**
   * WHAT ACTUALLY RAN (A10). `lib/rerank.ts` falls through from Cohere to the judge when Cohere is
   * the environment default and its health check fails. Intended Cohere implies one expected batch;
   * the judge then serves N. Under §7's never-waived reconciliation every such row would be
   * `persisted_partial` BY CONSTRUCTION, so the expected count is derived from what served.
   * Null only when no rerank request was made at all.
   */
  served_backend: string | null;
  rerank_backend_downgraded: boolean;
  /** Derived from `served_backend`, never from `intended_backend` (A10). */
  expected_batch_count: number;
  recorded_rerank_batches: number;
  /** Cohere entered and soft-failed to input order. Describes degraded RANKING, not missing
   *  evidence — it never waives the batch reconciliation (§7). */
  rerank_soft_failed: boolean;

  ordered_final_candidate_ids: number[];
  /** Keyed HMAC of the EXACT rendered scorer context — the byte-identity anchor for §6.1.
   *  Required on role `primary`; null on the other four, and that null is not a defect (A2). */
  scorer_context_hmac: string | null;

  /**
   * ⚠️ `null` IS ADMITTED, AND IS A CLAIM (widened by addendum v7 §10). The house rule elsewhere in
   * this module is that an omitted field and a declared null are different statements: absence reads
   * as "this stage did not happen", null reads as "it happened and there is no value". The reranker
   * decode settings need exactly that distinction — `rerank_temperature: null` means no rerank
   * decode ran, which is a fact, where an absent key would mean the field was never implemented.
   */
  retrieval_config: Record<string, string | number | boolean | null>;
  corpus_version: string | null;
  /** The embedding column and the embed model it implies — together, which candidates exist. */
  index_version: string | null;

  batches: ManifestBatch[];
}

/**
 * THE OPERATIONAL STAMP. Route, identity, timing and the environment facts a window needs.
 * §6.4 slices this declaration by name too.
 */
export interface OperationalTelemetry {
  route: RetrievalRoute;
  route_class: RouteClass;
  retrieval_role: RetrievalRole;
  invocation_id: string;
  /** Null on the two retrieving `trace: false` callers, for the whole of their life (D10/D11). */
  trace_id: string | null;
  deployment_sha: string | null;
  started_at: string;
  completed_at: string | null;
  routing_flags: Record<string, string>;
  active_backfill_run_id: string | null;
  /**
   * THE ACTIVE BACKFILL RUN'S `model`. Null when there is no active run (addendum v7 §7).
   *
   * ⚠️ THE NAME PROMISES MORE THAN THE DATA HOLDS, AND THAT IS RECORDED RATHER THAN RENAMED.
   * `BackfillRun` has no `target` field at all — verified, and v7 §7 says to stop if one appears.
   * What this carries is the grader model identifier the run is written against. No code reads the
   * value back, so nothing depends on the misreading today; the definition is written here so that
   * no future reader infers a day range, a cursor or a note set from the word "target".
   *
   * ⚠️ NOT RENAMED, DELIBERATELY. Renaming a persisted column is a migration, and neither v7 nor
   * this pass authorizes one for that purpose.
   *
   * Null is a MEASUREMENT here, paired with `active_backfill_state`: PRD §7 needs active
   * provider-backfill intervals for overlap analysis and states that an idle cron tick is not an
   * interval. Null target with state `idle` is exactly "no active run", which is that distinction.
   */
  active_backfill_target: string | null;
  active_backfill_state: BackfillActivity | null;
  active_lab_experiment_id: string | null;
}

/**
 * The stamped manifest. A one-line INTERSECTION with no field list of its own — which is exactly
 * why §6.4 asserts its shape rather than scanning its source: there is nothing to scan, and a
 * third ban loop over this name would pass vacuously forever.
 */
export type StampedRetrievalManifest = RetrievalPayload & { operational: OperationalTelemetry };

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 6. VALIDATION (D17) — takes `unknown`, validates at run time, returns CODES only
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** Own-property presence, so an absent field and an explicit null are different answers. */
function has(o: unknown, k: string): boolean {
  return !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
}
function get(o: unknown, k: string): unknown {
  return has(o, k) ? (o as Record<string, unknown>)[k] : undefined;
}
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNonEmptyStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isIdArray = (v: unknown): v is number[] => Array.isArray(v) && v.every(isFiniteNum);

/**
 * ══ THE D17 FIELD MATRIX (addendum v26 §3.1; Saul review 37 finding 1) ═══════════════════════════
 *
 * ONE explicit table is the source of truth for which manifest fields exist, whether each may be
 * null, what type it carries, and which code each failure produces. `validateManifest` DERIVES its
 * field checks from this table; it no longer carries one hand-written `if` per field. A field that
 * is not in the matrix is not validated, and that is now a visible fact of the table rather than an
 * omission somewhere in a 250-line function — which is how `prompt_tokens`, `completion_tokens`,
 * `candidate_start`'s independence and the licence's accompanying fields all went unchecked while
 * a manifest was being classified as complete.
 *
 * PATHS. Dotted; a segment ending in `[]` walks the array and applies the rule to every MEMBER (a
 * rule whose path itself ends in `[]` is the member's own shape rule). Sub-rules of a container are
 * evaluated only when the container is present and of the right shape; the container's own rule
 * reports otherwise — one code per defect, never a cascade.
 *
 * NULLABILITY is a named condition evaluated against the manifest, so "null permitted only under
 * the HMAC-absent licence" (D8), "only on a skipped stage" (A6), "only with no batches" (A10) and
 * "required on primary, REQUIRED NULL on the other four roles" (A2, v25 §3.3) are stated as data.
 *
 * ORIGIN names the contract line each entry comes from: D17's required-field list, D8's licence,
 * D15's independent score counts, D16/A6's stage-level null, addendum v7 §10's decode fields, or
 * addendum v25/v26's repairs. The tests enumerate this array; a coverage number stated anywhere is
 * `D17_FIELD_MATRIX.length`, printed by the test that iterates it, never recalled.
 *
 * ⚠️ NEVER THROWS. Every rule reads through `has`/own-property lookups and type predicates only. A
 * null or non-object array member is reported by the member rule and skipped by the field rules
 * (v26 §3.2: a validator that throws on malformed input is a defect, not a guard).
 */
export type D17FieldType =
  | 'string' | 'nonempty_string' | 'boolean' | 'finite_number' | 'nonneg_number'
  | 'object' | 'array' | 'id_array' | 'string_array' | 'attempts' | 'enum';

/** When null is permitted. Evaluated against the manifest being validated. */
export type D17Nullability =
  | 'never'                        // null is a defect
  | 'always'                       // null is a declaration
  | 'hmac_key_absent'              // D8: null only when telemetry_error declares the licence
  | 'hmac_key_absent_or_skipped'   // expansion.input_hmac: the licence, or a stage that made no request
  | 'skipped'                      // A6: the stage-level null, on a skipped stage only
  | 'no_batches'                   // A10: served_backend may be null only when no request was made
  | 'unless_failure'               // retrieval_error_class: required when the outcome is a failure
  | 'primary_hmac';                // A2 / v25 §3.3: primary → null only under the licence; other roles → MUST be null

export interface D17FieldRule {
  path: string;
  origin: 'D17' | 'D8' | 'D15' | 'D16' | 'v7 §10' | 'v25 §3.2' | 'v25 §3.3' | 'v26 §3.4' | 'v26 §3.5' | 'v26 §3.1';
  nullable: D17Nullability;
  type: D17FieldType;
  /** For `enum`: the permitted values. */
  values?: readonly unknown[];
  /** The code when the OWN PROPERTY is absent. */
  absent: string;
  /** The code when the value is null and null is not permitted here. */
  nullCode: string;
  /** The code when the value is present, non-null, and of the wrong type or shape. */
  invalid: string;
  /** `primary_hmac` only: the code when a non-primary role carries a non-null value. */
  mustBeNullCode?: string;
}

const RETRIEVAL_OUTCOMES: readonly RetrievalOutcome[] = ['success', 'zero_hits', 'retrieval_failure'];
const EXPANSION_STATUSES: readonly ExpansionStatus[] = ['expanded', 'skipped', 'failed_open'];
const SERVED_ROUTE_CLASSES: readonly ServedRouteClass[] = ['vertex', 'openrouter', 'local', 'unattributed', 'not_served'];
const VARIANT_STATUSES: readonly VariantStatus[] = ['generated', 'parsed_empty', 'all_invalid', 'not_an_array', 'parse_failure', 'failed_open', 'not_collected'];
const VARIANT_OUTCOMES: readonly VariantOutcome[] = ['success', 'zero_hits', 'retrieval_failure'];

export const D17_FIELD_MATRIX: readonly D17FieldRule[] = [
  { path: 'manifest_schema_version', origin: 'D17', nullable: 'never', type: 'enum', values: [MANIFEST_SCHEMA_VERSION], absent: 'manifest_version_unrecognized', nullCode: 'manifest_version_unrecognized', invalid: 'manifest_version_unrecognized' },
  // D8: the licence lets the HMAC BE null; it does not let the field be absent or wrongly typed (v26 §3.4).
  { path: 'hmac_key_version', origin: 'D8', nullable: 'hmac_key_absent', type: 'nonempty_string', absent: 'hmac_key_version_field_absent', nullCode: 'hmac_key_version_absent', invalid: 'hmac_key_version_absent' },
  { path: 'telemetry_error', origin: 'D8', nullable: 'always', type: 'enum', values: [TELEMETRY_ERROR_HMAC_KEY_ABSENT], absent: 'telemetry_error_field_absent', nullCode: 'telemetry_error_invalid', invalid: 'telemetry_error_invalid' },
  { path: 'operational', origin: 'D17', nullable: 'never', type: 'object', absent: 'operational_absent', nullCode: 'operational_absent', invalid: 'operational_absent' },
  { path: 'operational.route', origin: 'D17', nullable: 'never', type: 'enum', values: RETRIEVAL_ROUTES, absent: 'route_absent_or_invalid', nullCode: 'route_absent_or_invalid', invalid: 'route_absent_or_invalid' },
  { path: 'operational.route_class', origin: 'D17', nullable: 'never', type: 'nonempty_string', absent: 'route_class_absent', nullCode: 'route_class_absent', invalid: 'route_class_absent' },
  { path: 'operational.retrieval_role', origin: 'D17', nullable: 'never', type: 'enum', values: RETRIEVAL_ROLES, absent: 'retrieval_role_absent_or_invalid', nullCode: 'retrieval_role_absent_or_invalid', invalid: 'retrieval_role_absent_or_invalid' },
  { path: 'operational.invocation_id', origin: 'D17', nullable: 'never', type: 'nonempty_string', absent: 'invocation_id_absent', nullCode: 'invocation_id_absent', invalid: 'invocation_id_absent' },
  { path: 'operational.started_at', origin: 'D17', nullable: 'never', type: 'nonempty_string', absent: 'started_at_absent', nullCode: 'started_at_absent', invalid: 'started_at_absent' },
  { path: 'operational.completed_at', origin: 'D17', nullable: 'never', type: 'nonempty_string', absent: 'completed_at_absent', nullCode: 'completed_at_absent', invalid: 'completed_at_absent' },
  { path: 'operational.trace_id', origin: 'D17', nullable: 'always', type: 'string', absent: 'trace_id_field_absent', nullCode: 'trace_id_field_absent', invalid: 'trace_id_invalid' },
  { path: 'operational.deployment_sha', origin: 'D17', nullable: 'always', type: 'string', absent: 'deployment_sha_field_absent', nullCode: 'deployment_sha_field_absent', invalid: 'deployment_sha_invalid' },
  { path: 'operational.routing_flags', origin: 'D17', nullable: 'never', type: 'object', absent: 'routing_flags_absent', nullCode: 'routing_flags_absent', invalid: 'routing_flags_absent' },
  { path: 'operational.active_backfill_run_id', origin: 'D17', nullable: 'always', type: 'string', absent: 'active_backfill_run_id_field_absent', nullCode: 'active_backfill_run_id_field_absent', invalid: 'active_backfill_run_id_invalid' },
  { path: 'operational.active_backfill_target', origin: 'D17', nullable: 'always', type: 'string', absent: 'active_backfill_target_field_absent', nullCode: 'active_backfill_target_field_absent', invalid: 'active_backfill_target_invalid' },
  { path: 'operational.active_backfill_state', origin: 'D17', nullable: 'always', type: 'enum', values: BACKFILL_ACTIVITY, absent: 'active_backfill_state_field_absent', nullCode: 'active_backfill_state_field_absent', invalid: 'active_backfill_state_invalid' },
  { path: 'operational.active_lab_experiment_id', origin: 'D17', nullable: 'always', type: 'string', absent: 'active_lab_experiment_id_field_absent', nullCode: 'active_lab_experiment_id_field_absent', invalid: 'active_lab_experiment_id_invalid' },
  { path: 'retrieval_outcome', origin: 'D17', nullable: 'never', type: 'enum', values: RETRIEVAL_OUTCOMES, absent: 'retrieval_outcome_absent_or_invalid', nullCode: 'retrieval_outcome_absent_or_invalid', invalid: 'retrieval_outcome_absent_or_invalid' },
  { path: 'retrieval_error_class', origin: 'D17', nullable: 'unless_failure', type: 'nonempty_string', absent: 'retrieval_error_class_field_absent', nullCode: 'retrieval_error_class_absent_on_failure', invalid: 'retrieval_error_class_invalid' },
  { path: 'expansion', origin: 'D17', nullable: 'never', type: 'object', absent: 'expansion_absent', nullCode: 'expansion_absent', invalid: 'expansion_absent' },
  { path: 'expansion.status', origin: 'D17', nullable: 'never', type: 'enum', values: EXPANSION_STATUSES, absent: 'expansion_status_absent_or_invalid', nullCode: 'expansion_status_absent_or_invalid', invalid: 'expansion_status_absent_or_invalid' },
  { path: 'expansion.input_hmac', origin: 'D8', nullable: 'hmac_key_absent_or_skipped', type: 'nonempty_string', absent: 'expansion_input_hmac_field_absent', nullCode: 'expansion_input_hmac_absent', invalid: 'expansion_input_hmac_invalid' },
  { path: 'expansion.served_route_class', origin: 'D16', nullable: 'skipped', type: 'enum', values: SERVED_ROUTE_CLASSES, absent: 'expansion_served_route_class_field_absent', nullCode: 'expansion_served_route_class_absent', invalid: 'expansion_served_route_class_invalid' },
  { path: 'expansion.served_model', origin: 'D17', nullable: 'always', type: 'string', absent: 'expansion_served_model_field_absent', nullCode: 'expansion_served_model_field_absent', invalid: 'expansion_served_model_invalid' },
  { path: 'expansion.attempts', origin: 'D17', nullable: 'always', type: 'attempts', absent: 'expansion_attempts_field_absent', nullCode: 'expansion_attempts_field_absent', invalid: 'attempt_outcome_absent_or_invalid' },
  { path: 'fused_candidate_ids', origin: 'D17', nullable: 'never', type: 'id_array', absent: 'fused_candidate_ids_absent', nullCode: 'fused_candidate_ids_absent', invalid: 'fused_candidate_ids_absent' },
  { path: 'hydrated_candidate_ids', origin: 'D17', nullable: 'never', type: 'id_array', absent: 'hydrated_candidate_ids_absent', nullCode: 'hydrated_candidate_ids_absent', invalid: 'hydrated_candidate_ids_absent' },
  { path: 'fused_candidate_count', origin: 'D17', nullable: 'never', type: 'nonneg_number', absent: 'fused_candidate_count_absent', nullCode: 'fused_candidate_count_absent', invalid: 'fused_candidate_count_absent' },
  { path: 'hydrated_candidate_count', origin: 'D17', nullable: 'never', type: 'nonneg_number', absent: 'hydrated_candidate_count_absent', nullCode: 'hydrated_candidate_count_absent', invalid: 'hydrated_candidate_count_absent' },
  { path: 'pre_rerank_passage_hmacs', origin: 'D8', nullable: 'hmac_key_absent', type: 'string_array', absent: 'pre_rerank_passage_hmacs_field_absent', nullCode: 'pre_rerank_passage_hmacs_absent', invalid: 'pre_rerank_passage_hmacs_absent' },
  { path: 'intended_backend', origin: 'D17', nullable: 'never', type: 'nonempty_string', absent: 'intended_backend_absent', nullCode: 'intended_backend_absent', invalid: 'intended_backend_absent' },
  { path: 'intended_model', origin: 'D17', nullable: 'never', type: 'nonempty_string', absent: 'intended_model_absent', nullCode: 'intended_model_absent', invalid: 'intended_model_absent' },
  { path: 'served_backend', origin: 'D17', nullable: 'no_batches', type: 'nonempty_string', absent: 'served_backend_field_absent', nullCode: 'served_backend_absent_with_batches', invalid: 'served_backend_invalid' },
  { path: 'rerank_backend_downgraded', origin: 'D17', nullable: 'never', type: 'boolean', absent: 'rerank_backend_downgraded_absent', nullCode: 'rerank_backend_downgraded_absent', invalid: 'rerank_backend_downgraded_absent' },
  { path: 'expected_batch_count', origin: 'D17', nullable: 'never', type: 'nonneg_number', absent: 'expected_batch_count_absent', nullCode: 'expected_batch_count_absent', invalid: 'expected_batch_count_absent' },
  { path: 'recorded_rerank_batches', origin: 'D17', nullable: 'never', type: 'nonneg_number', absent: 'recorded_rerank_batches_absent', nullCode: 'recorded_rerank_batches_absent', invalid: 'recorded_rerank_batches_absent' },
  { path: 'rerank_soft_failed', origin: 'D17', nullable: 'never', type: 'boolean', absent: 'rerank_soft_failed_absent', nullCode: 'rerank_soft_failed_absent', invalid: 'rerank_soft_failed_absent' },
  { path: 'ordered_final_candidate_ids', origin: 'D17', nullable: 'never', type: 'id_array', absent: 'ordered_final_candidate_ids_absent', nullCode: 'ordered_final_candidate_ids_absent', invalid: 'ordered_final_candidate_ids_absent' },
  { path: 'scorer_context_hmac', origin: 'v25 §3.3', nullable: 'primary_hmac', type: 'nonempty_string', absent: 'scorer_context_hmac_field_absent', nullCode: 'scorer_context_hmac_absent', invalid: 'scorer_context_hmac_invalid', mustBeNullCode: 'scorer_context_hmac_on_non_primary_role' },
  { path: 'retrieval_config', origin: 'D17', nullable: 'never', type: 'object', absent: 'retrieval_config_absent', nullCode: 'retrieval_config_absent', invalid: 'retrieval_config_absent' },
  { path: 'retrieval_config.rerank_temperature', origin: 'v7 §10', nullable: 'always', type: 'finite_number', absent: 'rerank_temperature_field_absent', nullCode: 'rerank_temperature_field_absent', invalid: 'rerank_temperature_invalid' },
  { path: 'retrieval_config.rerank_seed_status', origin: 'v7 §10', nullable: 'never', type: 'enum', values: RERANK_SEED_STATUSES, absent: 'rerank_seed_status_field_absent', nullCode: 'rerank_seed_status_invalid', invalid: 'rerank_seed_status_invalid' },
  { path: 'corpus_version', origin: 'D17', nullable: 'always', type: 'string', absent: 'corpus_version_field_absent', nullCode: 'corpus_version_field_absent', invalid: 'corpus_version_invalid' },
  { path: 'index_version', origin: 'D17', nullable: 'never', type: 'nonempty_string', absent: 'index_version_absent', nullCode: 'index_version_absent', invalid: 'index_version_absent' },
  { path: 'batches', origin: 'D17', nullable: 'never', type: 'array', absent: 'batches_absent', nullCode: 'batches_absent', invalid: 'batches_absent' },
  // v26 §3.2: a member that is not an object is reported, never dereferenced.
  { path: 'batches[]', origin: 'v26 §3.1', nullable: 'never', type: 'object', absent: 'batch_member_invalid', nullCode: 'batch_member_invalid', invalid: 'batch_member_invalid' },
  { path: 'batches[].batch_index', origin: 'D17', nullable: 'never', type: 'finite_number', absent: 'batch_index_absent', nullCode: 'batch_index_absent', invalid: 'batch_index_absent' },
  // Two INDEPENDENT rows (v26 §3.3): each boundary is present, non-null and a finite number on its own;
  // they share the established code, and `bad_candidate_boundaries` below relates the two.
  { path: 'batches[].candidate_start', origin: 'D17', nullable: 'never', type: 'finite_number', absent: 'batch_boundaries_absent', nullCode: 'batch_boundaries_absent', invalid: 'batch_boundaries_absent' },
  { path: 'batches[].candidate_end', origin: 'D17', nullable: 'never', type: 'finite_number', absent: 'batch_boundaries_absent', nullCode: 'batch_boundaries_absent', invalid: 'batch_boundaries_absent' },
  { path: 'batches[].intended_provider', origin: 'D17', nullable: 'never', type: 'nonempty_string', absent: 'batch_intended_provider_absent', nullCode: 'batch_intended_provider_absent', invalid: 'batch_intended_provider_absent' },
  { path: 'batches[].intended_model', origin: 'D17', nullable: 'never', type: 'nonempty_string', absent: 'batch_intended_model_absent', nullCode: 'batch_intended_model_absent', invalid: 'batch_intended_model_absent' },
  // A6: the type permits null on a batch defensively; the CONTRACT does not — a batch record IS a planned request.
  { path: 'batches[].served_route_class', origin: 'D17', nullable: 'never', type: 'enum', values: SERVED_ROUTE_CLASSES, absent: 'batch_served_route_class_absent', nullCode: 'batch_served_route_class_absent', invalid: 'batch_served_route_class_invalid' },
  { path: 'batches[].served_model', origin: 'D17', nullable: 'always', type: 'string', absent: 'batch_served_model_field_absent', nullCode: 'batch_served_model_field_absent', invalid: 'batch_served_model_invalid' },
  { path: 'batches[].attempts', origin: 'D17', nullable: 'always', type: 'attempts', absent: 'batch_attempts_field_absent', nullCode: 'batch_attempts_field_absent', invalid: 'attempt_outcome_absent_or_invalid' },
  { path: 'batches[].outcome', origin: 'D17', nullable: 'never', type: 'enum', values: BATCH_OUTCOME_PRECEDENCE, absent: 'batch_outcome_absent_or_invalid', nullCode: 'batch_outcome_absent_or_invalid', invalid: 'batch_outcome_absent_or_invalid' },
  { path: 'batches[].expected_score_keys', origin: 'D17', nullable: 'never', type: 'nonneg_number', absent: 'expected_score_keys_absent', nullCode: 'expected_score_keys_absent', invalid: 'expected_score_keys_absent' },
  { path: 'batches[].finite_score_keys', origin: 'D17', nullable: 'never', type: 'nonneg_number', absent: 'finite_score_keys_absent', nullCode: 'finite_score_keys_absent', invalid: 'finite_score_keys_absent' },
  // D15: the two independent counts preserved beside the outcome; not in D17's list, in the manifest.
  { path: 'batches[].missing_score_keys', origin: 'D15', nullable: 'never', type: 'nonneg_number', absent: 'missing_score_keys_absent', nullCode: 'missing_score_keys_absent', invalid: 'missing_score_keys_absent' },
  { path: 'batches[].nonnumeric_score_keys', origin: 'D15', nullable: 'never', type: 'nonneg_number', absent: 'nonnumeric_score_keys_absent', nullCode: 'nonnumeric_score_keys_absent', invalid: 'nonnumeric_score_keys_absent' },
  { path: 'batches[].prompt_tokens', origin: 'v25 §3.2', nullable: 'always', type: 'nonneg_number', absent: 'batch_prompt_tokens_field_absent', nullCode: 'batch_prompt_tokens_field_absent', invalid: 'batch_prompt_tokens_invalid' },
  { path: 'batches[].completion_tokens', origin: 'v25 §3.2', nullable: 'always', type: 'nonneg_number', absent: 'batch_completion_tokens_field_absent', nullCode: 'batch_completion_tokens_field_absent', invalid: 'batch_completion_tokens_invalid' },
  // The multi-query section, required on exactly one role (D6/D17). Its presence rule is role-driven and
  // lives in `validateManifest`; these are its members, evaluated only when the section is present.
  { path: 'multi_query.variant_generation', origin: 'D17', nullable: 'never', type: 'object', absent: 'variant_generation_absent', nullCode: 'variant_generation_absent', invalid: 'variant_generation_absent' },
  { path: 'multi_query.variant_generation.status', origin: 'D17', nullable: 'never', type: 'enum', values: VARIANT_STATUSES, absent: 'variant_generation_status_absent_or_invalid', nullCode: 'variant_generation_status_absent_or_invalid', invalid: 'variant_generation_status_absent_or_invalid' },
  { path: 'multi_query.variant_generation.served_route_class', origin: 'D16', nullable: 'always', type: 'enum', values: SERVED_ROUTE_CLASSES, absent: 'variant_generation_served_route_class_field_absent', nullCode: 'variant_generation_served_route_class_field_absent', invalid: 'variant_generation_served_route_class_invalid' },
  { path: 'multi_query.variant_generation.served_model', origin: 'D17', nullable: 'always', type: 'string', absent: 'variant_generation_served_model_field_absent', nullCode: 'variant_generation_served_model_field_absent', invalid: 'variant_generation_served_model_invalid' },
  { path: 'multi_query.variant_generation.attempts', origin: 'D17', nullable: 'always', type: 'attempts', absent: 'variant_generation_attempts_field_absent', nullCode: 'variant_generation_attempts_field_absent', invalid: 'attempt_outcome_absent_or_invalid' },
  { path: 'multi_query.variant_generation.prompt_tokens', origin: 'v26 §3.5', nullable: 'always', type: 'nonneg_number', absent: 'variant_generation_prompt_tokens_field_absent', nullCode: 'variant_generation_prompt_tokens_field_absent', invalid: 'variant_generation_prompt_tokens_invalid' },
  { path: 'multi_query.variant_generation.completion_tokens', origin: 'v26 §3.5', nullable: 'always', type: 'nonneg_number', absent: 'variant_generation_completion_tokens_field_absent', nullCode: 'variant_generation_completion_tokens_field_absent', invalid: 'variant_generation_completion_tokens_invalid' },
  { path: 'multi_query.variant_generation.generated_variant_count', origin: 'D17', nullable: 'never', type: 'nonneg_number', absent: 'generated_variant_count_absent', nullCode: 'generated_variant_count_absent', invalid: 'generated_variant_count_absent' },
  { path: 'multi_query.variants', origin: 'D17', nullable: 'never', type: 'array', absent: 'variants_absent', nullCode: 'variants_absent', invalid: 'variants_absent' },
  { path: 'multi_query.variants[]', origin: 'v26 §3.1', nullable: 'never', type: 'object', absent: 'variant_member_invalid', nullCode: 'variant_member_invalid', invalid: 'variant_member_invalid' },
  { path: 'multi_query.variants[].index', origin: 'D17', nullable: 'never', type: 'nonneg_number', absent: 'variant_index_absent_or_invalid', nullCode: 'variant_index_absent_or_invalid', invalid: 'variant_index_absent_or_invalid' },
  { path: 'multi_query.variants[].outcome', origin: 'D17', nullable: 'never', type: 'enum', values: VARIANT_OUTCOMES, absent: 'variant_outcome_absent_or_invalid', nullCode: 'variant_outcome_absent_or_invalid', invalid: 'variant_outcome_absent_or_invalid' },
  { path: 'multi_query.variants[].candidate_count', origin: 'D17', nullable: 'never', type: 'nonneg_number', absent: 'variant_candidate_count_absent_or_invalid', nullCode: 'variant_candidate_count_absent_or_invalid', invalid: 'variant_candidate_count_absent_or_invalid' },
];

/** The facts a nullability condition reads. Computed once per validation, from the manifest. */
interface D17Context {
  keyAbsent: boolean;
  skipped: boolean;
  noBatches: boolean;
  outcomeIsFailure: boolean;
  role: unknown;
}

type NullVerdict = 'may' | 'must_not' | 'must';

function nullVerdict(rule: D17FieldRule, ctx: D17Context): NullVerdict {
  switch (rule.nullable) {
    case 'never': return 'must_not';
    case 'always': return 'may';
    case 'hmac_key_absent': return ctx.keyAbsent ? 'may' : 'must_not';
    case 'hmac_key_absent_or_skipped': return ctx.keyAbsent || ctx.skipped ? 'may' : 'must_not';
    case 'skipped': return ctx.skipped ? 'may' : 'must_not';
    case 'no_batches': return ctx.noBatches ? 'may' : 'must_not';
    case 'unless_failure': return ctx.outcomeIsFailure ? 'must_not' : 'may';
    case 'primary_hmac':
      // Required on primary (null only under the licence); REQUIRED NULL on the four other roles; a
      // manifest whose role is unreadable gets the field checks only.
      if (ctx.role === 'primary') return ctx.keyAbsent ? 'may' : 'must_not';
      return RETRIEVAL_ROLES.some((r) => r === ctx.role) ? 'must' : 'may';
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Does a present, non-null value satisfy the rule's type? `attempts` members are checked by
 *  `pushAttemptOutcomeDefects` (one implementation for all three locations, review 22 item 4). */
function typeSatisfied(rule: D17FieldRule, v: unknown): boolean {
  switch (rule.type) {
    case 'string': return typeof v === 'string';
    case 'nonempty_string': return isNonEmptyStr(v);
    case 'boolean': return typeof v === 'boolean';
    case 'finite_number': return isFiniteNum(v);
    case 'nonneg_number': return isFiniteNum(v) && v >= 0;
    case 'object': return isPlainObject(v);
    case 'array': return Array.isArray(v);
    case 'id_array': return isIdArray(v);
    case 'string_array': return isStringArray(v);
    case 'attempts': return Array.isArray(v);
    case 'enum': return (rule.values ?? []).some((allowed) => allowed === v);
  }
}

/**
 * The parents a rule's path resolves to: the object(s) that carry the final key. A `[]` segment
 * walks the array's members; a container that is missing or of the wrong shape yields NO parents
 * (its own rule has already reported it), so a defect is reported once and nothing is dereferenced.
 */
function parentsOf(root: Record<string, unknown>, segments: readonly string[]): Record<string, unknown>[] {
  let current: Record<string, unknown>[] = [root];
  for (const seg of segments) {
    const walksArray = seg.endsWith('[]');
    const key = walksArray ? seg.slice(0, -2) : seg;
    const next: Record<string, unknown>[] = [];
    for (const parent of current) {
      const value = get(parent, key);
      if (walksArray) {
        if (Array.isArray(value)) for (const member of value) if (isPlainObject(member)) next.push(member);
      } else if (isPlainObject(value)) {
        next.push(value);
      }
    }
    current = next;
  }
  return current;
}

/** Apply one matrix rule to the manifest, appending codes. Never throws. */
function applyRule(rule: D17FieldRule, root: Record<string, unknown>, ctx: D17Context, v: string[]): void {
  const segments = rule.path.split('.');
  const last = segments[segments.length - 1];
  const parents = parentsOf(root, segments.slice(0, -1));
  if (last.endsWith('[]')) {
    // The MEMBER rule: every element of the array must be an object. Reported per bad member.
    const key = last.slice(0, -2);
    for (const parent of parents) {
      const arr = get(parent, key);
      if (!Array.isArray(arr)) continue;              // the array's own rule reports a missing/invalid array
      for (const member of arr) if (!isPlainObject(member)) v.push(rule.invalid);
    }
    return;
  }
  for (const parent of parents) {
    if (!has(parent, last)) { v.push(rule.absent); continue; }
    const value = parent[last];
    const verdict = nullVerdict(rule, ctx);
    if (value === null) {
      if (verdict === 'must_not') v.push(rule.nullCode);
      continue;
    }
    if (verdict === 'must') { v.push(rule.mustBeNullCode ?? rule.invalid); continue; }
    if (rule.type === 'attempts') {
      // LOCATIONS 1, 2 and 3 of the attempt-outcome branch (v11 §4): the array's members.
      pushAttemptOutcomeDefects(value, rule.invalid, v);
      continue;
    }
    if (!typeSatisfied(rule, value)) v.push(rule.invalid);
  }
}

/**
 * Structural validation of a STAMPED manifest. Returns violation CODES only — never a value, never
 * a fragment, because a validator that echoes what it rejected is a validator that can leak.
 *
 * Takes `unknown` (D17): the row this reads may have been written by an older deployment or by a
 * caller that skipped the type entirely, and a validator whose parameter is already the type it is
 * meant to prove is a validator that proves nothing.
 *
 * TWO PASSES. First the D17 FIELD MATRIX above — presence, null, type, for every field it names,
 * including array members. Then the RELATIONS between fields, which no per-field rule can express:
 * the batch reconciliation §7 never waives, boundary sanity and ordering, the served-model/served-
 * class pairing (§10), passage-HMAC cardinality, the multi-query arity, and the role-conditional
 * presence of the multi-query section itself. Both passes read through own-property lookups only
 * and NEVER throw (v26 §3.2).
 */
export function validateManifest(input: unknown): string[] {
  const v: string[] = [];
  if (!isPlainObject(input)) return ['manifest_absent'];
  const m = input;

  // ── The facts the nullability conditions read ──────────────────────────────────────────────────
  const keyAbsent = m.telemetry_error === TELEMETRY_ERROR_HMAC_KEY_ABSENT;
  const ex = get(m, 'expansion');
  const skipped = isPlainObject(ex) && ex.status === 'skipped';
  const batchesValue = get(m, 'batches');
  const noBatches = !Array.isArray(batchesValue) || batchesValue.length === 0;
  const op = get(m, 'operational');
  const role = isPlainObject(op) ? get(op, 'retrieval_role') : undefined;
  const ctx: D17Context = { keyAbsent, skipped, noBatches, outcomeIsFailure: m.retrieval_outcome === 'retrieval_failure', role };

  // ── PASS 1: the matrix. The multi-query rules only when the role requires the section ──────────
  const mqRequired = role === 'lab_multi_query';
  for (const rule of D17_FIELD_MATRIX) {
    if (rule.path.startsWith('multi_query.') && !mqRequired) continue;
    applyRule(rule, m, ctx, v);
  }

  // ── PASS 2: relations ────────────────────────────────────────────────────────────────────────
  // Passage HMACs: one per HYDRATED row (a dropped row is exactly what the cardinality makes visible).
  const hmacs = get(m, 'pre_rerank_passage_hmacs');
  const hydrated = get(m, 'hydrated_candidate_ids');
  if (isStringArray(hmacs) && Array.isArray(hydrated) && hmacs.length !== hydrated.length) {
    v.push('passage_hmac_cardinality_mismatch');
  }

  if (Array.isArray(batchesValue)) {
    const batches = batchesValue.filter(isPlainObject);   // non-object members were reported by the matrix
    // §7's reconciliation, never waived.
    const recorded = get(m, 'recorded_rerank_batches');
    if (isFiniteNum(recorded) && batchesValue.length !== recorded) v.push('recorded_batch_count_mismatch');
    const expected = get(m, 'expected_batch_count');
    if (isFiniteNum(expected) && batchesValue.length !== expected) v.push('batch_count_mismatch');
    const seen = new Set<number>();
    for (const b of batches) {
      const idx = get(b, 'batch_index');
      if (isFiniteNum(idx)) {
        if (seen.has(idx)) v.push('duplicate_batch_index');
        seen.add(idx);
      }
      const start = get(b, 'candidate_start');
      const end = get(b, 'candidate_end');
      if (isFiniteNum(start) && isFiniteNum(end) && end <= start) v.push('bad_candidate_boundaries');
      // §10: a class that did not serve carries no model.
      const cls = get(b, 'served_route_class');
      const model = get(b, 'served_model');
      if (cls === 'unattributed' && model !== null) v.push('unattributed_with_model');
      if (cls === 'not_served' && model !== null) v.push('not_served_with_model');
      const expectedKeys = get(b, 'expected_score_keys');
      const finiteKeys = get(b, 'finite_score_keys');
      if (isFiniteNum(expectedKeys) && isFiniteNum(finiteKeys) && finiteKeys > expectedKeys) v.push('score_keys_exceed_expected');
    }
    // Batches must be orderable by their boundaries independently of completion order (constraint 7).
    const byIndex = batches
      .map((b) => ({ idx: get(b, 'batch_index'), start: get(b, 'candidate_start'), end: get(b, 'candidate_end') }))
      .filter((b): b is { idx: number; start: unknown; end: unknown } => isFiniteNum(b.idx))
      .sort((a, b) => a.idx - b.idx);
    for (let i = 1; i < byIndex.length; i++) {
      const prevEnd = byIndex[i - 1].end;
      const start = byIndex[i].start;
      if (isFiniteNum(prevEnd) && isFiniteNum(start) && start < prevEnd) v.push('overlapping_batches');
    }
  }

  // The multi-query section: required on exactly one role, forbidden on the others.
  const mq = get(m, 'multi_query');
  if (mqRequired) {
    if (!isPlainObject(mq)) v.push('multi_query_absent');
    else {
      const vg = get(mq, 'variant_generation');
      const variants = get(mq, 'variants');
      const count = isPlainObject(vg) ? get(vg, 'generated_variant_count') : undefined;
      // index 0 is the ORIGINAL expanded arm, so the array is always one longer than the count.
      if (Array.isArray(variants) && isFiniteNum(count) && variants.length !== count + 1) v.push('variant_arity_mismatch');
    }
  } else if (has(m, 'multi_query')) {
    v.push('multi_query_on_non_multi_query_role');
  }

  return v;
}

/**
 * THE ATTEMPT-OUTCOME BRANCH (v11 §4, review 22 items 2 and 4). One implementation, called from all
 * THREE manifest locations — expansion attempts, rerank batch attempts, and multi-query
 * variant-generation attempts — with the same stable defect name at each.
 *
 * ⚠️ NOTHING VALIDATED AN ATTEMPT OUTCOME BEFORE THIS. The two checks that look like validation,
 * `expansion_attempts_field_absent` and `batch_attempts_field_absent`, only ask whether the FIELD is
 * present; the variant-generation block did not reach `attempts` at all. The single line in this
 * file that read `a.outcome` was the 429 counter in `batchCounters`. So a manifest could carry any
 * string — or nothing — where one of the six committed outcomes belongs, and the census that counts
 * 429s would silently miss it.
 *
 * ⚠️ `attempts: null` IS LEGAL HERE AND MUST NOT BE FLAGGED. Since pass 3 (addendum v11 §6.1, landed
 * in commit 13) a skipped stage and absent evidence record `[]`; `manifestAttempts` in
 * `lib/retrieval-capture.ts` returns null for ONE fact only — the transport reported that it did not
 * COLLECT a sequence, which D17 names ("null permitted, meaning not collected"). Validate the members
 * of an array when there is one; say nothing when there is not. The matrix above routes all three
 * attempt locations here through the `attempts` type.
 *
 * ⚠️ A NON-ARRAY, NON-NULL value IS defective. `undefined`, a string or an object is neither "no
 * attempts" nor a list of them, and the field-presence checks beside each call site do not catch a
 * present-but-wrong-shaped value.
 */
function pushAttemptOutcomeDefects(attempts: unknown, defect: string, v: string[]): void {
  if (attempts === null || attempts === undefined) return;          // legal today — see above
  if (!Array.isArray(attempts)) { v.push(defect); return; }
  for (const a of attempts) {
    const outcome = (a as { outcome?: unknown } | null)?.outcome;
    if (!(TRANSPORT_ATTEMPT_OUTCOMES as readonly unknown[]).includes(outcome)) { v.push(defect); return; }
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 7. COUNTERS (§4.3, D15) — the two orphan columns finally get a writer
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The counters the row carries, derived from the manifest so the two can never disagree.
 *
 * ⚠️ THE CLASS ATTRIBUTION WAS A BUG (D15). It was a chain ending in a bare `else` that incremented
 * `unattributed`. Once `not_served` exists — and once a skipped stage can carry a null class — both
 * would have landed in that `else` and been reported as unattributed: three different facts merged
 * into one column, which is exactly what §2 forbids. Every branch now tests EQUALITY, and a null or
 * absent class increments nothing.
 *
 * That a null increments nothing here, while `validateManifest` REJECTS a null on a batch, is not a
 * contradiction: the type is defensive and the validator is the contract (A6). This counter must
 * not be read as permission for a batch to omit its class.
 */
export function batchCounters(m: Pick<RetrievalPayload, 'batches'>): {
  vertex: number; openrouter: number; local: number; not_served: number;
  failed: number; unattributed: number; retries_429: number;
} {
  const c = { vertex: 0, openrouter: 0, local: 0, not_served: 0, failed: 0, unattributed: 0, retries_429: 0 };
  for (const b of m?.batches ?? []) {
    if (b.served_route_class === 'vertex') c.vertex += 1;
    else if (b.served_route_class === 'openrouter') c.openrouter += 1;
    else if (b.served_route_class === 'local') c.local += 1;
    else if (b.served_route_class === 'not_served') c.not_served += 1;
    else if (b.served_route_class === 'unattributed') c.unattributed += 1;
    // a null or absent class increments NOTHING — see the note above
    if (b.outcome !== 'success') c.failed += 1;
    c.retries_429 += (b.attempts ?? []).filter((a) => a.outcome === 'http_429').length;
  }
  return c;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 8. COST (§4.6) — unknown usage stays unknown
// ════════════════════════════════════════════════════════════════════════════════════════════════

export interface RerankUsageBucket {
  provider: string;
  model: string;
  batches: number;
  attempts: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  /** Batches whose provider returned no usage. §4.6: never turn missing token data into zero cost. */
  batches_with_unknown_usage: number;
  /** §4.6: local, not-served and skipped stages are UNPRICED. `unattributed` and `parse_failure`
   *  are priced from their preserved usage — a malformed completion still consumed tokens. */
  priceable: boolean;
}

/** Which served classes cost money. `not_served` bought nothing; `local` is not billed. */
export function isPriceableClass(served: string | null | undefined): boolean {
  return served === 'vertex' || served === 'openrouter' || served === 'unattributed';
}

/**
 * Aggregate rerank usage by served provider/model. The rule that matters: a bucket whose every
 * batch lacked usage reports `null` tokens, NOT 0 — a zero would price as ₹0 and read as "this
 * cost nothing", which is precisely the false statement the cost tracker has been making about
 * every rerank call ever dispatched (they are traceless, so it never saw one).
 *
 * Pricing is deliberately NOT applied here. The existing pricing source and its effective-date
 * discipline live in lib/llm-cost-core.ts; duplicating rates would create a second source of truth
 * for money. This produces the countable inputs that module prices.
 */
export function aggregateRerankUsage(manifests: Array<Pick<RetrievalPayload, 'batches'>>): RerankUsageBucket[] {
  const buckets = new Map<string, RerankUsageBucket>();
  for (const m of manifests ?? []) {
    for (const b of m?.batches ?? []) {
      const provider = b.served_route_class ?? 'unattributed';
      const model = b.served_model ?? provider;
      const key = `${provider} ${model}`;
      let e = buckets.get(key);
      if (!e) {
        e = {
          provider, model, batches: 0, attempts: 0, prompt_tokens: null, completion_tokens: null,
          batches_with_unknown_usage: 0, priceable: isPriceableClass(provider),
        };
        buckets.set(key, e);
      }
      e.batches += 1;
      e.attempts += (b.attempts ?? []).length;
      const known = typeof b.prompt_tokens === 'number' || typeof b.completion_tokens === 'number';
      if (!known) { e.batches_with_unknown_usage += 1; continue; }
      if (typeof b.prompt_tokens === 'number') e.prompt_tokens = (e.prompt_tokens ?? 0) + b.prompt_tokens;
      if (typeof b.completion_tokens === 'number') e.completion_tokens = (e.completion_tokens ?? 0) + b.completion_tokens;
    }
  }
  return [...buckets.values()].sort((a, b) => (a.provider + a.model).localeCompare(b.provider + b.model));
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 9. SETTLEMENT AND TRANSITIONS (D9, D12)
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * What the OWNER of a save observed. Mapped to a state by `stateForSettlement` below, so the
 * mapping exists once rather than at each of the seven save expressions.
 */
export const SETTLEMENT_OUTCOMES = [
  'persisted_clean', 'persisted_dirty', 'losing_conflict', 'persistence_skipped',
  'persistence_refused', 'audit_persistence_failed', 'audit_generation_failed',
  'no_persistence_intended', 'retrieval_not_run',
] as const;
export type SettlementOutcome = typeof SETTLEMENT_OUTCOMES[number];

/**
 * D9's outcome-to-state table, complete and total.
 *
 * ⚠️ `aborted`, `persistence_unknown` and `telemetry_persistence_failed` are ABSENT by design: THIS
 * TABLE never names them. They are produced only through `reconcilerStateFor` below, which is the
 * reconciler's own mapping — and `stateForUnwrittenRun` in `lib/retrieval-settlement.ts` also calls
 * it, for a run still at revision 0 whose outcome D12's transition guard cannot apply. So the honest
 * statement is about the PRODUCER, not about the caller: no settlement mapping produces these three,
 * and a settlement that reaches one has gone through the reconciler's function to do it (D9 as
 * amended by addendum v1 item 2, 13 Aug 2026).
 */
const SETTLEMENT_STATE: Readonly<Record<SettlementOutcome, RetrievalPersistenceState>> = {
  persisted_clean: 'persisted_complete',
  persisted_dirty: 'persisted_partial',
  losing_conflict: 'completed_unpersisted',
  persistence_skipped: 'persistence_skipped',
  persistence_refused: 'persistence_refused',
  audit_persistence_failed: 'audit_persistence_failed',
  audit_generation_failed: 'audit_generation_failed',
  no_persistence_intended: 'no_persistence_intended',
  retrieval_not_run: 'retrieval_not_run',
};

export function stateForSettlement(outcome: SettlementOutcome): RetrievalPersistenceState {
  return SETTLEMENT_STATE[outcome];
}

/**
 * The ONLY allowed transitions (D12). Terminal states never transition.
 *
 * ⚠️ `retrieval_complete -> aborted` IS DELIBERATELY ABSENT. A run that wrote its terminal manifest
 * did not abort; what is unknown is the audit's fate, and that is `persistence_unknown`. Collapsing
 * the two would report a completed retrieval as one that never finished.
 *
 * ⚠️ `started -> audit_generation_failed` IS DELIBERATELY PRESENT. D11 puts the primary terminal
 * write at step 12 and `auditOpdNote` can throw at steps 7, 8 or 9 — so a row that never reached
 * its terminal write is still `started` when the audit fails. Forbidding this would leave the only
 * honest settlement unreachable and hand the row to the reconciler as an `aborted` guess.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<string, readonly RetrievalPersistenceState[]>> = {
  started: [
    'retrieval_complete', 'aborted', 'retrieval_not_run', 'telemetry_persistence_failed',
    'audit_generation_failed',
  ],
  retrieval_complete: [
    'persisted_complete', 'persisted_partial', 'completed_unpersisted', 'persistence_refused',
    'audit_persistence_failed', 'audit_generation_failed', 'persistence_skipped',
    'no_persistence_intended', 'telemetry_persistence_failed', 'persistence_unknown',
  ],
};

export function isAllowedTransition(from: string, to: string): boolean {
  return (ALLOWED_TRANSITIONS[from] as readonly string[] | undefined)?.includes(to) ?? false;
}

/**
 * D13's reconciler mapping. A row's assigned state depends on BOTH where it stalled and whether
 * run-level failure evidence exists — the difference between "telemetry failed and we know it" and
 * "we simply never heard again", which are different remediations.
 */
export function reconcilerStateFor(
  rowState: 'started' | 'retrieval_complete',
  failurePhases: readonly string[],
): RetrievalPersistenceState {
  if (rowState === 'started') {
    return failurePhases.includes('retrieval_terminal') ? 'telemetry_persistence_failed' : 'aborted';
  }
  return failurePhases.includes('persistence_link') ? 'telemetry_persistence_failed' : 'persistence_unknown';
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 10. CANONICALIZATION (D12) — one function, used for both equality and persistence
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Deterministic JSON: keys sorted recursively at EVERY depth, array order preserved, `undefined`
 * omitted in objects and REJECTED in arrays, non-finite numbers rejected.
 *
 * `undefined` in an array is rejected rather than dropped or nulled because dropping changes the
 * length and nulling changes the value — either way two manifests that differ would compare equal,
 * which is the one thing the identical-content no-op check must never do.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
    return value;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((el) => {
      if (el === undefined) throw new Error('canonicalJson: undefined array element');
      return canonicalize(el);
    });
  }
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    const el = (value as Record<string, unknown>)[k];
    if (el === undefined) continue;               // omitted in objects, as JSON.stringify would
    out[k] = canonicalize(el);
  }
  return out;
}

/**
 * The columns compared by the identical-content no-op check (D12), classified so the projection is
 * a stated decision rather than an accident of what someone remembered to list.
 *
 * The manifest's operational TIMESTAMPS are excluded: a retry reuses the originally stamped
 * manifest, so comparing `completed_at` would make every retry look like new content and burn a
 * revision for a write that changed nothing.
 */
export const COLUMN_CLASSIFICATION = {
  /** Written once at declaration; a change here is a bug, not an update. */
  immutable_insert: [
    'retrieval_run_id', 'retrieval_role', 'route', 'invocation_id', 'app_source',
    'telemetry_schema_version', 'started_at',
  ],
  /** Written by the terminal write and by settlement; these are what equality compares. */
  mutable_terminal: [
    'audit_id', 'trace_id', 'uid', 'engine_version', 'deployment_sha', 'persistence_state',
    'retrieval_outcome', 'retrieval_error_class', 'completed_at', 'expansion_status',
    'expansion_route_class', 'expansion_served_model', 'expansion_attempts', 'rerank_route_class',
    'expected_rerank_batches', 'recorded_rerank_batches', 'served_backend',
    'rerank_backend_downgraded', 'rerank_soft_failed', 'fused_candidate_count',
    'hydrated_candidate_count', 'index_version', 'context_hmac', 'retrieval_manifest',
    'telemetry_error', 'experiment_run_id', 'pair_id', 'replicate',
    'active_backfill_run_id', 'active_backfill_target', 'active_backfill_state',
  ],
  /** Bookkeeping about the row itself — never part of its content. */
  revision_metadata: ['row_revision', 'persistence_settled_at'],
  /** Derived from `retrieval_manifest` by `batchCounters`; compared through it, not beside it. */
  derived: [
    'rerank_vertex_batches', 'rerank_openrouter_batches', 'rerank_local_batches',
    'rerank_failed_batches', 'rerank_unattributed_batches', 'rerank_not_served_batches',
    'rerank_429_attempts',
  ],
} as const;

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 11. THE SCHEMA CONTRACT (D1, D2) — the statements the migration route applies
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * ⚠️ WHY THE DDL LIVES IN THE CORE AND NOT IN THE ROUTE.
 *
 * D2 forbids hand-typing any value list into a CHECK: an earlier version of the kickoff hand-typed
 * a count and got it wrong, and the version after it hand-typed thirteen state names two paragraphs
 * after forbidding exactly that. The CHECKs are therefore GENERATED from the constants above — and
 * a generated statement cannot be verified by reading the route's source, because the values are
 * not in it. Putting the builder here makes the emitted SQL importable, so the parity test compares
 * REAL OUTPUT against the `.sql` mirror rather than comparing two pieces of prose.
 *
 * This is not the same thing PRD §4.2 forbids. §4.2 says do not generate the `.sql` FILE from the
 * constant — that file stays hand-typed documentation, held to this output by the parity test.
 * What is generated is the statement the ROUTE executes.
 */
const q = (xs: readonly string[]) => xs.map((s) => `'${s}'`).join(', ');

export interface DdlStatement {
  /** Names this step in the route's `steps` response, so an operator can read what ran. */
  key: string;
  sql: string;
}

/**
 * Every statement the migration route runs, in order. All idempotent.
 *
 * ⚠️ THE CREATE TABLE CARRIES NO INLINE STATE CHECK, deliberately. Migration 0035 declared one
 * inline with the eight old values. Keeping that shape would put the state vocabulary in two places
 * in one migration — the inline copy and the named constraint D2 requires be DROPped and re-ADDed —
 * and a reader would have to check the two agree. There is one home for it: the named constraint
 * below. On a fresh table the DROP is a no-op and the ADD installs it; on an existing table the
 * pair replaces whatever was there. Both paths end identically.
 */
export function retrievalTelemetryDdl(): DdlStatement[] {
  return [
    // ── 1. The retrieval-execution table ────────────────────────────────────────────────────────
    {
      key: 'retrieval_table',
      sql: `CREATE TABLE IF NOT EXISTS opd_audit_retrieval_telemetry (
  retrieval_run_id UUID PRIMARY KEY,
  audit_id UUID NULL REFERENCES opd_note_audits(id) ON DELETE SET NULL,
  trace_id TEXT NULL,
  uid TEXT NULL,
  engine_version TEXT NULL,
  route TEXT NOT NULL,
  invocation_id TEXT NULL,
  app_source TEXT NOT NULL DEFAULT 'standalone',
  deployment_sha TEXT NULL,
  telemetry_schema_version INTEGER NOT NULL,
  experiment_run_id TEXT NULL,
  pair_id TEXT NULL,
  replicate TEXT NULL,
  persistence_state TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NULL,
  expansion_status TEXT NULL,
  expansion_route_class TEXT NULL,
  rerank_route_class TEXT NULL,
  expected_rerank_batches INTEGER NULL,
  recorded_rerank_batches INTEGER NULL,
  rerank_vertex_batches INTEGER NOT NULL DEFAULT 0,
  rerank_openrouter_batches INTEGER NOT NULL DEFAULT 0,
  rerank_local_batches INTEGER NOT NULL DEFAULT 0,
  rerank_failed_batches INTEGER NOT NULL DEFAULT 0,
  rerank_unattributed_batches INTEGER NOT NULL DEFAULT 0,
  rerank_429_attempts INTEGER NOT NULL DEFAULT 0,
  context_hmac TEXT NULL,
  retrieval_manifest JSONB NULL,
  telemetry_error TEXT NULL
)`,
    },
    // ── 2. The on-path additions (D2) ───────────────────────────────────────────────────────────
    {
      key: 'retrieval_columns',
      sql: `ALTER TABLE opd_audit_retrieval_telemetry
  ADD COLUMN IF NOT EXISTS retrieval_role TEXT,
  ADD COLUMN IF NOT EXISTS retrieval_outcome TEXT,
  ADD COLUMN IF NOT EXISTS retrieval_error_class TEXT,
  ADD COLUMN IF NOT EXISTS persistence_settled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS row_revision INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS expansion_served_model TEXT,
  ADD COLUMN IF NOT EXISTS expansion_attempts JSONB,
  ADD COLUMN IF NOT EXISTS rerank_not_served_batches INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rerank_soft_failed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS served_backend TEXT,
  ADD COLUMN IF NOT EXISTS rerank_backend_downgraded BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fused_candidate_count INTEGER,
  ADD COLUMN IF NOT EXISTS hydrated_candidate_count INTEGER,
  ADD COLUMN IF NOT EXISTS index_version TEXT,
  ADD COLUMN IF NOT EXISTS active_backfill_run_id TEXT,
  ADD COLUMN IF NOT EXISTS active_backfill_target TEXT,
  ADD COLUMN IF NOT EXISTS active_backfill_state TEXT,
  ALTER COLUMN app_source SET DEFAULT 'standalone'`,
    },
    // ── 3. The three CHECKs, in ONE statement (v9 §6.1) ─────────────────────────────────────────
    //
    // ⚠️ ONE ALTER, NOT SIX. These were five drop/add pairs across two tables, run by a plain loop
    // with no transaction (`migrate-retrieval-telemetry/route.ts:72-75`,
    // `telemetry-overhead/route.ts:298`). THIS TABLE IS THE DANGEROUS ONE: its CREATE TABLE above
    // carries no inline CHECK at all, deliberately, so this pair was the ONLY source of all three
    // constraints — and a failure between a DROP and its ADD left the table UNCONSTRAINED, with
    // nothing later putting the constraint back.
    //
    // ⚠️ WHY DROPPING AND ADDING THE SAME NAME IN ONE STATEMENT WORKS. PostgreSQL sorts the
    // subcommands of one ALTER TABLE into ordered passes, and drops run before adds. It works
    // because of PASS ORDERING, not because the actions run left to right — do not reason about
    // this statement by reading it top to bottom. The whole statement takes one lock and validates
    // every new CHECK against existing rows inside it, which is the atomicity this is for. It also
    // means one bad row now fails the ENTIRE replacement rather than leaving the table half
    // constrained; that is the intended trade, not a regression.
    //
    // Every value list is still generated from the constants above. Idempotent in both directions:
    // DROP … IF EXISTS tolerates absence on a fresh table, and each ADD names a constraint the same
    // statement has already freed.
    //
    // The role CHECK is UNCONDITIONAL. A NULL role passes a CHECK by SQL's own rules, which is
    // exactly why the NOT NULL below has to be a separate, conditional step.
    //
    // `retrieval_outcome` stays NULLABLE because the worker inserts `started` rows before retrieval
    // starts (D2). The state is what makes it required, so that guard is stateful.
    {
      key: 'retrieval_checks',
      sql: `ALTER TABLE opd_audit_retrieval_telemetry
  DROP CONSTRAINT IF EXISTS opd_audit_retrieval_telemetry_persistence_state_chk,
  DROP CONSTRAINT IF EXISTS opd_audit_retrieval_telemetry_role_chk,
  DROP CONSTRAINT IF EXISTS opd_audit_retrieval_telemetry_outcome_chk,
  ADD CONSTRAINT opd_audit_retrieval_telemetry_persistence_state_chk CHECK (persistence_state IN (${q(RETRIEVAL_PERSISTENCE_STATES)})),
  ADD CONSTRAINT opd_audit_retrieval_telemetry_role_chk CHECK (retrieval_role IN (${q(RETRIEVAL_ROLES)})),
  ADD CONSTRAINT opd_audit_retrieval_telemetry_outcome_chk CHECK (
  (persistence_state = 'started' AND retrieval_outcome IS NULL)
  OR (persistence_state IN (${q(OUTCOME_REQUIRED_STATES)}) AND retrieval_outcome IS NOT NULL)
  OR persistence_state IN (${q(OUTCOME_EITHER_STATES)})
)`,
    },
    // ── 4. Indexes on the retrieval table ───────────────────────────────────────────────────────
    { key: 'idx_started_at', sql: `CREATE INDEX IF NOT EXISTS opd_art_started_at_idx ON opd_audit_retrieval_telemetry (started_at DESC)` },
    { key: 'idx_state_started_at', sql: `CREATE INDEX IF NOT EXISTS opd_art_state_started_at_idx ON opd_audit_retrieval_telemetry (persistence_state, started_at DESC)` },
    { key: 'idx_audit_id', sql: `CREATE INDEX IF NOT EXISTS opd_art_audit_id_idx ON opd_audit_retrieval_telemetry (audit_id) WHERE audit_id IS NOT NULL` },
    { key: 'idx_uid_engine', sql: `CREATE INDEX IF NOT EXISTS opd_art_uid_engine_idx ON opd_audit_retrieval_telemetry (uid, engine_version, started_at DESC)` },
    { key: 'idx_route_invocation', sql: `CREATE INDEX IF NOT EXISTS opd_art_route_invocation_idx ON opd_audit_retrieval_telemetry (route, invocation_id, started_at DESC)` },
    { key: 'idx_experiment', sql: `CREATE INDEX IF NOT EXISTS opd_art_experiment_idx ON opd_audit_retrieval_telemetry (experiment_run_id, pair_id) WHERE experiment_run_id IS NOT NULL` },
    { key: 'idx_role_state', sql: `CREATE INDEX IF NOT EXISTS opd_art_role_state_idx ON opd_audit_retrieval_telemetry (retrieval_role, persistence_state, started_at DESC)` },
    { key: 'idx_nonterminal', sql: `CREATE INDEX IF NOT EXISTS opd_art_nonterminal_idx ON opd_audit_retrieval_telemetry (persistence_state, started_at) WHERE persistence_state IN (${q(NON_TERMINAL_PERSISTENCE_STATES)})` },
    // ── 5. Invocation accounting ────────────────────────────────────────────────────────────────
    {
      key: 'invocation_table',
      sql: `CREATE TABLE IF NOT EXISTS opd_retrieval_invocations (
  invocation_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  route TEXT NOT NULL,
  route_class TEXT NOT NULL,
  app_source TEXT NOT NULL DEFAULT 'standalone',
  deployment_sha TEXT NULL,
  vercel_request_id TEXT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NULL,
  closure_state TEXT NOT NULL DEFAULT 'closure_unknown',
  declared_retrievals INTEGER NOT NULL DEFAULT 0,
  telemetry_write_failures INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT opd_ri_kind_chk CHECK (kind IN (${q(INVOCATION_KINDS)})),
  CONSTRAINT opd_ri_closure_chk CHECK (closure_state IN (${q(INVOCATION_CLOSURE_STATES)}))
)`,
    },
    { key: 'idx_ri_open', sql: `CREATE INDEX IF NOT EXISTS opd_ri_open_idx ON opd_retrieval_invocations (started_at) WHERE closure_state = 'closure_unknown'` },
    { key: 'idx_ri_route_time', sql: `CREATE INDEX IF NOT EXISTS opd_ri_route_time_idx ON opd_retrieval_invocations (route, started_at DESC)` },
    { key: 'idx_ri_kind_time', sql: `CREATE INDEX IF NOT EXISTS opd_ri_kind_time_idx ON opd_retrieval_invocations (kind, started_at DESC)` },
    // ── 6. Per-run telemetry-write failure evidence ─────────────────────────────────────────────
    {
      key: 'failure_table',
      sql: `CREATE TABLE IF NOT EXISTS opd_retrieval_telemetry_failures (
  id BIGSERIAL PRIMARY KEY,
  invocation_id TEXT NOT NULL,
  retrieval_run_id UUID NULL,
  retrieval_role TEXT NULL,
  failed_phase TEXT NOT NULL,
  intended_state TEXT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  error_class TEXT NOT NULL,
  CONSTRAINT opd_rtf_phase_chk CHECK (failed_phase IN (${q(TELEMETRY_FAILURE_PHASES)})),
  CONSTRAINT opd_rtf_run_chk CHECK (
    (failed_phase IN (${q(RUN_SCOPED_FAILURE_PHASES)}) AND retrieval_run_id IS NOT NULL AND retrieval_role IS NOT NULL)
    OR failed_phase IN (${q(TELEMETRY_FAILURE_PHASES.filter((p) => !(RUN_SCOPED_FAILURE_PHASES as readonly string[]).includes(p)))})
  )
)`,
    },
    // ── 6a. THE FAILURE-TABLE CHECKS, RE-APPLIED (pass 0a, kickoff §2.1) ────────────────────────
    //
    // ⚠️ THE INLINE CONSTRAINTS ABOVE REACH A FRESH TABLE ONLY. `CREATE TABLE IF NOT EXISTS` is a
    // NO-OP when the table exists, so on any database that already has
    // `opd_retrieval_telemetry_failures` the OLD CHECKs survive — and the old phase list does not
    // contain `retrieval_terminal_rejected`. The durable evidence addendum v7 §8 exists to produce
    // would then be REJECTED BY THE CONSTRAINT, silently turning a new safety record into a write
    // error on exactly the path that is already failing.
    //
    // Production does not have this table. The measurement branch does, or will. That is enough.
    //
    // The drop-then-add form is the same idiom the `retrieval_checks` statement above uses, so the
    // widened form applies whether the table is new or existing. Idempotent: `DROP … IF EXISTS`
    // tolerates absence, and each ADD names a constraint the same statement has already freed.
    //
    // ⚠️ ONE ALTER, NOT FOUR (v9 §6.1). Unlike the retrieval table, this one DOES carry both CHECKs
    // inline in its CREATE TABLE, so a failure between a drop and an add could not leave a FRESH
    // table unconstrained. The reason to collapse it is the same either way: one lock, one
    // validation pass over existing rows, and no window in which an EXISTING table has lost a
    // constraint that nothing later restores. Drops still run before adds — by ALTER TABLE's pass
    // ordering, not by their left-to-right position.
    {
      key: 'failure_checks',
      sql: `ALTER TABLE opd_retrieval_telemetry_failures
  DROP CONSTRAINT IF EXISTS opd_rtf_phase_chk,
  DROP CONSTRAINT IF EXISTS opd_rtf_run_chk,
  ADD CONSTRAINT opd_rtf_phase_chk CHECK (failed_phase IN (${q(TELEMETRY_FAILURE_PHASES)})),
  ADD CONSTRAINT opd_rtf_run_chk CHECK (
    (failed_phase IN (${q(RUN_SCOPED_FAILURE_PHASES)}) AND retrieval_run_id IS NOT NULL AND retrieval_role IS NOT NULL)
    OR failed_phase IN (${q(TELEMETRY_FAILURE_PHASES.filter((p) => !(RUN_SCOPED_FAILURE_PHASES as readonly string[]).includes(p)))})
  )`,
    },
    { key: 'idx_rtf_run', sql: `CREATE INDEX IF NOT EXISTS opd_rtf_run_idx ON opd_retrieval_telemetry_failures (retrieval_run_id, failed_phase, observed_at DESC) WHERE retrieval_run_id IS NOT NULL` },
    { key: 'idx_rtf_invocation', sql: `CREATE INDEX IF NOT EXISTS opd_rtf_invocation_idx ON opd_retrieval_telemetry_failures (invocation_id, observed_at DESC)` },
    { key: 'idx_rtf_phase_time', sql: `CREATE INDEX IF NOT EXISTS opd_rtf_phase_time_idx ON opd_retrieval_telemetry_failures (failed_phase, observed_at DESC)` },
    // ── 7. Table comments. THE TEXT DIFFERS PER TABLE, because the tables differ (D2) ────────────
    {
      key: 'comment_retrieval',
      sql: `COMMENT ON TABLE opd_audit_retrieval_telemetry IS 'Stage 0a rerank telemetry, one row per retrieval execution. Observation only: no ranking decision reads this table. uid is a re-identification key and carries controls no weaker than opd_note_audits (admin-gated reads only). No clinical text: identifiers, enums, counts, timings and keyed HMACs only. Retention 90 days from started_at; the purge is operator-scheduled and is NOT implemented here.'`,
    },
    {
      key: 'comment_invocations',
      sql: `COMMENT ON TABLE opd_retrieval_invocations IS 'Stage 0a invocation accounting, one row per serverless invocation that declared retrieval work, plus reconciler runs. Observation only. No clinical text and NO PATIENT IDENTIFIER — it joins to the uid-bearing table and inherits its handling. Admin access only. Retention 90 days from started_at; the purge is operator-scheduled and is NOT implemented here.'`,
    },
    {
      key: 'comment_failures',
      sql: `COMMENT ON TABLE opd_retrieval_telemetry_failures IS 'Stage 0a telemetry-write failure evidence, one row per failed write. Observation only. No clinical text and NO PATIENT IDENTIFIER. error_class is a class name and is never a message or a value. Admin access only. Retention 90 days from observed_at — this table has no started_at — and the purge is operator-scheduled and is NOT implemented here.'`,
    },
  ];
}

/**
 * The CONDITIONAL step (D2). Applied only when the table is empty, because an existing row's role
 * cannot be reconstructed and a failed `SET NOT NULL` would abort the migration over history rather
 * than over anything this build wrote. Run as an explicit route step, not a `DO` block, so the
 * decision is visible in the `steps` response instead of buried in a server-side branch.
 */
export const RETRIEVAL_ROLE_NOT_NULL_SQL =
  'ALTER TABLE opd_audit_retrieval_telemetry ALTER COLUMN retrieval_role SET NOT NULL';

/** The three tables this build owns. Used by the non-exposure scan (D3) and by the stop rule. */
export const TELEMETRY_TABLES = [
  'opd_audit_retrieval_telemetry', 'opd_retrieval_invocations', 'opd_retrieval_telemetry_failures',
] as const;
