/**
 * lib/retrieval-capture.ts — the IN-MEMORY capture, and the only place raw bytes exist.
 * On-path kickoff D5, D8, D15, D16, D17. PRD v2.1 §4.3, §4.5 step 2.
 *
 * ⚠️ WHY THIS IS A SEPARATE MODULE FROM lib/retrieval-telemetry-core.ts.
 *
 * The core's header promises that no clinical text ever reaches a field defined in it, and a test
 * slices its two field-bearing declarations to hold that promise. `TelemetryCapture` breaks the
 * promise BY DESIGN: it holds raw candidate passages, because something has to hold them between
 * hydration and the moment they become keyed HMACs. Declaring it in the core would make the header
 * false and the pin misleading. It lives here instead, and a source assertion pins its absence
 * from the core.
 *
 * ⚠️ THE CAPTURE NEVER LEAVES THIS MODULE'S OUTPUT PATH. `buildRetrievalPayload` is the only exit,
 * it returns a text-free `RetrievalPayload`, and nothing else may serialize, log or store a
 * capture. Constraint 3 also applies: batch facts are collected in memory and the terminal
 * manifest is built after all batches settle — no telemetry input or output inside a rerank batch.
 *
 * ⚠️ INVOCATION-SCOPED (§4.1). A capture is created per retrieval and threaded explicitly. There is
 * no module-level state here, and there must never be: two concurrent retrievals in one serverless
 * process would interleave into one record.
 */

import {
  MANIFEST_SCHEMA_VERSION, HMAC_KEY_VERSION, TELEMETRY_ERROR_HMAC_KEY_ABSENT,
  telemetryHmac, batchCounters, RERANK_SEED_STATUSES,
  type RetrievalRole, type RetrievalPayload, type ManifestBatch, type ManifestAttempt,
  type ExpansionStatus, type VariantStatus, type VariantOutcome, type RetrievalOutcome,
  type ServedRouteClass, type BatchOutcome, type MultiQuerySection, type RerankSeedStatus,
} from './retrieval-telemetry-core';

/**
 * ⚠️ RE-EXPORTED, NOT RE-DECLARED (v11 §7, review 22 item 5). This file declared its own identical
 * copy of `RERANK_SEED_STATUSES` because pass 0a's contract could not touch core and capture
 * together. It can now, so core owns the vocabulary beside the manifest contract it belongs to and
 * this is the SAME OBJECT, not an equal one — `strictEqual` on the reference is what the test pins,
 * because deep equality would pass against a re-declared copy and let the drift back in.
 *
 * The re-export exists so every consumer that imports these from capture — `lib/rerank.ts:21` among
 * them — keeps working without an import change.
 */
export { RERANK_SEED_STATUSES, type RerankSeedStatus };
import {
  readTransportAttribution, readTransportFailureAttribution,
  type TransportAttempt,
} from './transport-attribution-core';

/**
 * What one dispatch told us. Assembled from the transport's own evidence — the success attribution
 * on a completion, or the failure attribution on a thrown error — and never from the requested
 * model, the environment or timing (§4.4).
 */
export interface TransportEvidence {
  /** Null when nothing served. `proven` distinguishes that from "we could not tell". */
  servedProvider: 'vertex' | 'openrouter' | 'ollama' | 'bedrock' | null;
  servedModel: string | null;
  attempts: TransportAttempt[] | null;
  /**
   * TRUE only when the transport PROVED no completion arrived — i.e. a failure attribution was
   * present on the error. This is the single fact that licenses `not_served` over `unattributed`,
   * and §4.4 forbids merging the two.
   */
  provenNotServed: boolean;
}

/**
 * A class NAME, never a message and never a value — the same discipline `error_class` carries in
 * the failure table. Shared by all five sites that record a swallowed retrieval exception, so the
 * rule has one home rather than five nearly-identical copies that drift into logging a message.
 */
export function errorClassOf(e: unknown): string {
  const name = (e as { name?: unknown })?.name;
  if (typeof name === 'string' && name.length > 0) return name;
  const ctor = (e as { constructor?: { name?: unknown } })?.constructor?.name;
  return typeof ctor === 'string' && ctor.length > 0 ? ctor : 'UnknownError';
}

/** Read dispatch evidence off a returned completion. */
export function evidenceFromCompletion(result: unknown): TransportEvidence | null {
  const a = readTransportAttribution(result);
  if (!a) return null;
  return {
    servedProvider: a.dispatched_provider,
    servedModel: a.dispatched_model,
    attempts: a.attempts ?? null,
    provenNotServed: false,
  };
}

/** Read dispatch evidence off a thrown error. Absent evidence is `null`, NOT a synthesised
 *  "nothing served" — an unattributed failure and a proven one are different facts. */
export function evidenceFromError(err: unknown): TransportEvidence | null {
  const f = readTransportFailureAttribution(err);
  if (!f) return null;
  return { servedProvider: null, servedModel: null, attempts: f.attempts, provenNotServed: true };
}

/**
 * D16's stage mapping, in one function so the rule cannot be re-derived differently at each site.
 *
 *   provider success                      → that provider's class
 *   proven terminal failure               → 'not_served'  (and only with proof)
 *   a completion may have arrived         → 'unattributed'
 *
 * ⚠️ REATTACHED (v11 §7). A duplicate `RERANK_SEED_STATUSES` and a second JSDoc sat between this
 * comment and the function it describes, so it documented the constant instead. The duplicate is
 * gone — core is authoritative and this file re-exports it above — and the comment is back on
 * `servedClassOf`.
 *
 * ⚠️ AND ITS FOURTH ROW WAS A PROMISE THIS FUNCTION CANNOT KEEP. It read "stage skipped, no request
 * made → null, the explicit STAGE-LEVEL null (A6)". `servedClassOf` returns `ServedRouteClass`,
 * which does not include null, and it never receives the skip decision at all. The stage-level null
 * is produced by the two CALLERS, each of which decides skip-ness before calling:
 *
 *   `buildRetrievalPayload`      `expansionSkipped ? null : servedClassOf(...)`
 *   `buildMultiQuerySection`     `vg ? servedClassOf(ev) : null`   (pass 3, v11 §6.2: the stage RAN)
 *
 * ⚠️ NAMED, NOT NUMBERED (v13 §6). These two citations carried line numbers that were stale the day
 * they were written — the same commit that added them shifted the lines. A symbol reference survives
 * an edit above it; a line number is a future stale reference by construction.
 *
 * Given evidence, this function's own honest floor is 'unattributed', never null.
 */
export function servedClassOf(ev: TransportEvidence | null): ServedRouteClass {
  if (!ev) return 'unattributed';
  if (ev.provenNotServed) return 'not_served';
  switch (ev.servedProvider) {
    case 'vertex': return 'vertex';
    case 'openrouter': return 'openrouter';
    case 'ollama': return 'local';
    // Bedrock cannot serve the rerank judge (governedChat gates it on an option the judge does not
    // pass). If one appears here, telemetry is wrong about the world — recorded as `unattributed`
    // and flagged as a hard defect by the caller, never quietly mapped to a plausible class.
    case 'bedrock': return 'unattributed';
    default: return 'unattributed';
  }
}

/**
 * The attempts as they reach the manifest. ⚠️ CORRECTED IN PASS 3 (addendum v11 §6.1, carried by v23
 * §3): ABSENT evidence records `[]`, never null. No evidence means no dispatch was recorded, so
 * there is nothing to list — an empty array says exactly that. `null` is kept for ONE case only: the
 * transport itself reported `attempts: null`, meaning it did not COLLECT a sequence, which D17 names
 * ("null permitted, meaning not collected") and §4.4 forbids reconstructing. Before this correction
 * an absent evidence object and a not-collected sequence were both `null` — the same value for two
 * different facts.
 */
function manifestAttempts(ev: TransportEvidence | null): ManifestAttempt[] | null {
  if (!ev) return [];
  if (ev.attempts == null) return null;
  return ev.attempts.map((a) => ({
    provider: a.tier, attempt: a.attempt, outcome: a.outcome, status: a.status,
  }));
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// THE CAPTURE
// ════════════════════════════════════════════════════════════════════════════════════════════════

export interface CapturedBatch {
  index: number;
  start: number;
  end: number;
  evidence: TransportEvidence | null;
  outcome: BatchOutcome;
  expectedScoreKeys: number;
  finiteScoreKeys: number;
  missingScoreKeys: number;
  nonnumericScoreKeys: number;
  intendedProvider: string;
  intendedModel: string;
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface TelemetryCapture {
  readonly role: RetrievalRole;

  expansion?: { status: ExpansionStatus; inputText: string; evidence: TransportEvidence | null };
  variantGeneration?: {
    status: VariantStatus; evidence: TransportEvidence | null;
    promptTokens: number | null; completionTokens: number | null; generatedCount: number;
  };
  variants?: Array<{ index: number; outcome: VariantOutcome; candidateCount: number }>;

  /** The pool after the cap. */
  fusedCandidateIds: number[];
  /** What the re-read actually returned. `<=` the fused count, and the difference is a dropped row. */
  hydratedCandidateIds: number[];
  /** RAW. Parallel to `hydratedCandidateIds`. NEVER leaves this object. */
  passageTexts: string[];

  orderedFinalCandidateIds: number[];

  intendedBackend: string;
  intendedModel: string;
  /** What actually ran. Null only if no rerank request was made (A10). */
  servedBackend: string | null;
  /** The Cohere-to-judge fall-through (D16). */
  rerankBackendDowngraded: boolean;
  /** Derived from `servedBackend`, NEVER from `intendedBackend`. */
  expectedBatchCount: number;
  batches: CapturedBatch[];
  rerankSoftFailed: boolean;

  retrievalOutcome: RetrievalOutcome;
  retrievalErrorClass: string | null;
  retrievalConfig: Record<string, string | number | boolean>;

  /**
   * RERANKER DECODE SETTINGS, AS THEY ACTUALLY APPLIED (addendum v7 §10).
   *
   * ⚠️ STATUS, NOT AN ASSUMED SEED, AND THAT DISTINCTION IS THE WHOLE POINT. The finding that
   * started this workstream names an UNSEEDED judge, and no persisted row would have shown a
   * seeding change: neither seed nor temperature was captured anywhere. Worse, a seed set in code
   * does not necessarily reach the provider — the Ollama options bag that carries it is stripped
   * before every cloud call, at `lib/llm.ts:404`, `lib/llm.ts:474`, `lib/trace.ts:440` and
   * `lib/trace.ts:516`. `lib/expand.ts:33` is a live example of a seed living in that bag. So the
   * manifest records what APPLIED, never what was requested.
   *
   * Null temperature means no rerank decode happened (no reranker, or a single candidate).
   */
  rerankTemperature: number | null;
  rerankSeedStatus: RerankSeedStatus;
  corpusVersion: string | null;
  indexVersion: string | null;

  /** Multi-query variant captures. Present only on `lab_multi_query`. */
  children?: TelemetryCapture[];
}

/**
 * A fresh capture. The defaults are the ZERO-CANDIDATE shape, deliberately: a retrieval that
 * returns before the rerank block ever exists must produce a valid, honest manifest without any
 * code having run to make it so. `'none'` rather than null on the two backend names because D17
 * forbids null there — a backend of "none" is a statement; a null is an absence.
 */
export function createTelemetryCapture(role: RetrievalRole): TelemetryCapture {
  return {
    role,
    fusedCandidateIds: [],
    hydratedCandidateIds: [],
    passageTexts: [],
    orderedFinalCandidateIds: [],
    intendedBackend: 'none',
    intendedModel: 'none',
    servedBackend: null,
    rerankBackendDowngraded: false,
    expectedBatchCount: 0,
    batches: [],
    rerankSoftFailed: false,
    retrievalOutcome: 'success',
    retrievalErrorClass: null,
    retrievalConfig: {},
    // No rerank decode has happened yet. If none ever does, these are the honest values.
    rerankTemperature: null,
    rerankSeedStatus: 'not_applicable',
    corpusVersion: null,
    indexVersion: null,
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// THE ONE EXIT — capture in, text-free payload out
// ════════════════════════════════════════════════════════════════════════════════════════════════

export interface BuildPayloadOptions {
  /** Null means the key is ABSENT, which can only happen outside production (D8). */
  hmacKey: string | null;
  /** The exact rendered `citedContext`. Supplied ONLY for role `primary`. */
  scorerContext: string | null;
}

/**
 * Build the durable, text-free payload.
 *
 * ⚠️ WHEN THE KEY IS ABSENT, NOTHING THROWS AND NOTHING IS OMITTED (D8). Four fields become
 * EXPLICIT nulls and `telemetry_error` says why. An omitted field and a declared null are different
 * claims: absence reads as "this stage did not happen", null-with-a-reason reads as "it happened
 * and we could not key it". The validator accepts those four nulls when and only when the error is
 * set, so the licence cannot be borrowed by a row that simply forgot to compute one.
 */
export function buildRetrievalPayload(
  capture: TelemetryCapture,
  opts: BuildPayloadOptions,
): RetrievalPayload {
  const keyed = typeof opts.hmacKey === 'string' && opts.hmacKey.trim().length > 0;
  const hmac = (v: string) => telemetryHmac(opts.hmacKey as string, v);

  const batches: ManifestBatch[] = capture.batches
    .slice()
    .sort((a, b) => a.index - b.index)   // constraint 7: boundary order, never completion order
    .map((b) => {
      const served = servedClassOf(b.evidence);
      return {
        batch_index: b.index,
        candidate_start: b.start,
        candidate_end: b.end,
        intended_provider: b.intendedProvider,
        intended_model: b.intendedModel,
        served_route_class: served,
        // §10: a requested model is never reported as a served model. A class that did not serve
        // carries no model at all, which the validator enforces from the other side.
        served_model: served === 'unattributed' || served === 'not_served' ? null : (b.evidence?.servedModel ?? null),
        attempts: manifestAttempts(b.evidence),
        outcome: b.outcome,
        expected_score_keys: b.expectedScoreKeys,
        finite_score_keys: b.finiteScoreKeys,
        missing_score_keys: b.missingScoreKeys,
        nonnumeric_score_keys: b.nonnumericScoreKeys,
        prompt_tokens: b.promptTokens,
        completion_tokens: b.completionTokens,
      };
    });

  const expansion = capture.expansion;
  const expansionSkipped = !expansion || expansion.status === 'skipped';

  return {
    manifest_schema_version: MANIFEST_SCHEMA_VERSION,
    hmac_key_version: keyed ? HMAC_KEY_VERSION : null,
    telemetry_error: keyed ? null : TELEMETRY_ERROR_HMAC_KEY_ABSENT,

    retrieval_outcome: capture.retrievalOutcome,
    retrieval_error_class: capture.retrievalErrorClass,

    expansion: {
      status: expansion?.status ?? 'skipped',
      // A skipped stage has no input to key, so its null is structural rather than a key failure.
      input_hmac: expansionSkipped ? null : (keyed ? hmac(expansion!.inputText) : null),
      // A stage that made NO REQUEST declares the explicit stage-level null (A6). This is what
      // stops every normative_channel row being partial by construction: that leg sets skipExpand
      // unconditionally, so its expansion stage never dispatches.
      served_route_class: expansionSkipped ? null : servedClassOf(expansion!.evidence),
      served_model: expansionSkipped ? null : (expansion!.evidence?.servedModel ?? null),
      // ⚠️ CORRECTED IN PASS 3 (v11 §6.1 / v23 §3, D16 row 5): a SKIPPED stage records `attempts: []`,
      // never null. The stage made no request, so the honest list of attempts is EMPTY — not "not
      // collected". Only the served class carries the stage-level null above.
      attempts: expansionSkipped ? [] : manifestAttempts(expansion?.evidence ?? null),
    },

    ...(capture.role === 'lab_multi_query' ? { multi_query: buildMultiQuerySection(capture) } : {}),

    fused_candidate_ids: [...capture.fusedCandidateIds],
    hydrated_candidate_ids: [...capture.hydratedCandidateIds],
    fused_candidate_count: capture.fusedCandidateIds.length,
    hydrated_candidate_count: capture.hydratedCandidateIds.length,
    // ONE PER HYDRATED ROW. Pinned to the hydrated list rather than the fused one: a row the
    // re-read dropped has no passage to key, and keying the fused count would invent one.
    pre_rerank_passage_hmacs: keyed ? capture.passageTexts.map(hmac) : null,

    intended_backend: capture.intendedBackend,
    intended_model: capture.intendedModel,
    served_backend: capture.servedBackend,
    rerank_backend_downgraded: capture.rerankBackendDowngraded,
    expected_batch_count: capture.expectedBatchCount,
    recorded_rerank_batches: batches.length,
    rerank_soft_failed: capture.rerankSoftFailed,

    ordered_final_candidate_ids: [...capture.orderedFinalCandidateIds],
    // Role-sensitive (A2). Required on `primary`, null on the other four, and that null is not a
    // defect. Never null because reranking was skipped or failed: assembleAuditContext always
    // renders a context, and the HMAC of the empty string is a defined value.
    scorer_context_hmac: capture.role === 'primary' && opts.scorerContext !== null && keyed
      ? hmac(opts.scorerContext)
      : null,

    retrieval_config: {
      ...capture.retrievalConfig,
      // ⚠️ EMITTED UNCONDITIONALLY (addendum v7 §10). A field that appears only when a reranker ran
      // cannot distinguish "no rerank" from "field not implemented yet", and guardrail 3 measures
      // serialized bytes — so these land BEFORE the size baseline, not after it.
      rerank_temperature: capture.rerankTemperature,
      rerank_seed_status: capture.rerankSeedStatus,
    },
    corpus_version: capture.corpusVersion,
    index_version: capture.indexVersion,

    batches,
  };
}

function buildMultiQuerySection(capture: TelemetryCapture): MultiQuerySection {
  const vg = capture.variantGeneration;
  const ev = vg?.evidence ?? null;
  return {
    variant_generation: {
      // A seam that cannot report its own status records `not_collected` (A11). Never a guess:
      // from a bare string array, `parsed_empty` and `failed_open` are indistinguishable, and
      // inferring either would put a fabricated fact in a provenance record.
      status: vg?.status ?? 'not_collected',
      // `parse_failure` PRESERVES its provider, model and usage — a completion arrived, cost
      // tokens and did not parse. Only a stage that made no request declares null.
      // ⚠️ CORRECTED IN PASS 3 (v11 §6.2 / v23 §3). This read `vg && ev ? servedClassOf(ev) : null`,
      // and `ev` is null on the failed-open path without transport proof (`evidenceFromError`
      // returns null without attribution) — so a stage that genuinely RAN and failed was recorded
      // identically to a stage that never ran. Now: the stage RAN (`vg` is present) → its class is
      // `servedClassOf(ev)`, whose honest floor without evidence is `unattributed`; the stage did
      // NOT run (`vg` absent) → the explicit stage-level null. `not_served` still requires proof.
      served_route_class: vg ? servedClassOf(ev) : null,
      served_model: ev?.servedModel ?? null,
      attempts: manifestAttempts(ev),
      prompt_tokens: vg?.promptTokens ?? null,
      completion_tokens: vg?.completionTokens ?? null,
      generated_variant_count: vg?.generatedCount ?? 0,
    },
    // index 0 is the ORIGINAL expanded arm, so the array is always one longer than the count.
    variants: (capture.variants ?? []).map((v) => ({
      index: v.index, outcome: v.outcome, candidate_count: v.candidateCount,
    })),
  };
}

/**
 * The two columns that had no writer in any earlier on-path version, plus the third D15 adds.
 * Derived from the manifest so the row and the payload can never disagree.
 */
export function counterColumns(payload: Pick<RetrievalPayload, 'batches'>): {
  rerank_vertex_batches: number; rerank_openrouter_batches: number; rerank_local_batches: number;
  rerank_failed_batches: number; rerank_unattributed_batches: number;
  rerank_not_served_batches: number; rerank_429_attempts: number;
} {
  const c = batchCounters(payload);
  return {
    rerank_vertex_batches: c.vertex,
    rerank_openrouter_batches: c.openrouter,
    rerank_local_batches: c.local,
    rerank_failed_batches: c.failed,
    rerank_unattributed_batches: c.unattributed,
    rerank_not_served_batches: c.not_served,
    rerank_429_attempts: c.retries_429,
  };
}
