/**
 * lib/lab-v2/sources/ipd-discharge.ts — freeze ONE discharge document as a case
 * (LAB-MCP-V2-PRD-v1.0 §17.9 round D2b, decisions 118, 102, 99 and 87).
 *
 * ⚠️ THE IDENTIFIER IS USED AND NEVER STORED, as in D1. The caller sends a `documentId`, this
 * function READS with it, and what comes back carries a salted `member_key` and no id column at
 * all. There is no retention policy because nothing is retained.
 *
 * ⚠️⚠️ AND IT NEVER READS A PDF. DECISION 102, AND IT IS THE LOAD-BEARING SENTENCE OF THIS FILE.
 * `runIpdAudit` starts by fetching the discharge PDF over HTTP and handing it to
 * `generateFromDocument` (`lib/gemini-multimodal.ts:132`), which now throws `LAB_IO_FORBIDDEN`
 * inside a lab context. This freeze does not route around that: it requires a STORED extract at
 * the current `DOC_EXTRACT_VERSION` and refuses the document otherwise. A document whose extract
 * is missing is a document this platform declines to study, not a document it re-reads — because
 * re-reading it means pulling a named person's discharge summary through a multimodal model on a
 * research key, which is the exact thing decision 102 exists to stop.
 *
 * ⚠️ AND SINCE ROUND D2c IT ALSO RECORDS A REPLAY (§17.10, decisions 132 to 136). The freeze runs
 * the engine ONCE against production's stored replies — six labels answered from `trace_events`,
 * the cite gate answered locally with a keep, the skeleton by throwing — and stores the request
 * hashes and the corpus hits a run will need. A document whose audit trace cannot answer the legs
 * is EXCLUDED at `dataset_create`, never frozen without `steps`: a case with no steps runs fresh at
 * the arm's expense and reports itself as a replay, which is the one outcome this round exists to
 * make impossible to arrive at by accident.
 *
 * ⚠️ THE FREEZE RUNS OUTSIDE THE FENCE, deliberately, as D1's does. The extract store reads
 * `discharge_extracted_cases` through `sql` and the two envelopes read db13 through
 * `metabaseQuery`; both throw inside a lab execution context by design (§7). `dataset_create` runs
 * outside any context and `exitLabExecution` makes that a property of THIS function rather than an
 * assumption about its caller.
 *
 * ⚠️ WHAT IS DROPPED, AND WHY IT IS DROPPED RATHER THAN SCRUBBED. `IpdAdmissionHeader`
 * (`lib/ipd-audit/db13.ts:46-59`) carries `patientName`, `uhid` and `ageGender` — its own comment
 * calls two of them "PHI — render-only, never persisted". `BillingEnvelope` carries `ipUid`. The
 * run-level input carries `documentId`, `ipUid`, `memberId` and `pdfUrl`. NONE of them is copied
 * forward: this file names the four header scalars `run.ts:191-203` actually passes into
 * `buildIpdAuditRow` and the ten billing scalars, and constructs a body out of those. A frozen case
 * cannot leak a field it was never built from.
 */
import { createHash } from 'crypto';
import { exitLabExecution, withLabExecution } from '../../lab-execution-context';
import { LabError, hash } from '../contracts';
import { dependencyHash } from '../gateway';
import { computeIpdDischargeAudit } from '../../ipd-audit/compute';
import { retrieve as productionRetrieve, type RetrieveOptions, type RetrieveResult } from '../../retrieve';
import { identifyingKeys } from './requests';
import { memberKeyOf, memberSalt } from './opd';
import { stripVerbatimSections } from './ipd';
import { sql } from '../../db';
import {
  DOC_EXTRACT_VERSION, readExtractedCaseAcrossVersions, type StoredExtractedCase,
} from '../../discharge-extract-store';
import { fetchIpdAdmissionHeader } from '../../ipd-audit/db13';
import { fetchBillingEnvelope, fetchBilledTotal } from '../../ipd-audit/billing';
import { IPD_ENGINE_VERSION } from '../../ipd-audit/store';
import type { ExtractedCase } from '../../doc-audit-core';
// §17.11 decision 147 — the trace read's deadline is `boundedRead`'s own constant, imported
// rather than copied, so the two can never drift to different numbers.
import { SOURCE_TIMEOUT_MS } from './read';

/**
 * ⚠️ THE VERSION PROBE. INFERRED (decision 87) — no live database was available to the builder —
 * and it exists for one sentence in decision 118: a refusal must NAME THE VERSION FOUND.
 *
 * `readExtractedCaseAcrossVersions` (`discharge-extract-store.ts:173`) is the read that matters,
 * and it is the store's own — this file does not restate it. But its `absent` outcome deliberately
 * carries no detail, and "no row at `doc-extract/2`" is a different fact from "no row at all": the
 * store's own comment records that 560 of 843 documents held only `doc-extract/1` on 29 Aug 2026
 * (`:158-163`), so the commonest refusal this platform will issue is "this document was extracted,
 * under an older version". An operator who is told only "unavailable" cannot tell those apart, and
 * the fix for one (run the re-extract backfill) is not the fix for the other.
 *
 * Bounded: one document, one column, and a `LIMIT` well above the two versions that exist.
 */
export const EXTRACT_VERSIONS_SQL = `SELECT extraction_version,
       to_char(extracted_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS extracted_at
  FROM discharge_extracted_cases
 WHERE document_id = $1
 ORDER BY extraction_version DESC
 LIMIT 20`;

/**
 * ⚠️ THE GOLDEN COMPARISON'S B SIDE. INFERRED (decision 87), and modelled on `store.ts:216`
 * (`fetchIpdAuditByDocument`), which is production's own selection for exactly this row.
 *
 * ⚠️ AND IT SELECTS SIX COLUMNS, NOT `*`. `ipd_discharge_audits` carries `ip_uid`, `member_id` and
 * the whole `report` jsonb; `SELECT *` would pull two identifiers and a de-identified but very
 * large body into this process to read two numbers. Only `engine_version` and `model` reach the
 * frozen case; `care_value_index`, `band` and `trace_id` are read for the round's golden table and
 * are returned to the caller, never stored (decision 118).
 */
export const IPD_AUDIT_ROW_SQL = `SELECT engine_version, care_value_index, band, model, provider, trace_id
  FROM ipd_discharge_audits
 WHERE document_id = $1 AND engine_version = $2
 LIMIT 1`;

/**
 * ⚠️ THE REPLAY'S A SIDE. INFERRED (decision 87) — no live database was available to the builder —
 * and it is D2a's `READMISSION_TRACE_SQL` (`sources/readmission.ts`) pointed at this engine's
 * labels. `trace_events` rows are written by `lib/trace.ts`: an `llm_request` carrying the params
 * (`:348-352`) and an `llm_response` carrying `payload.content`, `payload.model` and
 * `payload.provider` (`:682-686`), both stamped with the calling stage.
 *
 * ⚠️ IT READS THE RESPONSES ONLY, AND IT EXCLUDES THE CITE GATE. A stored request cannot be
 * re-hashed — `trace.ts:348-352` writes the SERVED model in place of `params.model`, drops the cite
 * gate's `response_format`, and adds `provider` and `stream` — so the request rows say nothing a
 * replay can match on and are not selected. The cite gate is excluded for a harder reason: its
 * fifteen calls share one label, fire concurrently (`doc-audit.ts:345`), and their request and
 * response rows interleave with NO CORRELATION KEY, so a stored cite-gate reply cannot be paired
 * with the claim it judged. Decision 132 therefore runs that stage live at the arm's own model, and
 * this statement does not pretend otherwise by returning rows nobody can align.
 *
 * Bounded by one trace id, which is one audit of one document.
 */
export const IPD_DISCHARGE_TRACE_SQL = `SELECT stage, seq,
       payload->>'content'  AS content,
       payload->>'model'    AS model,
       payload->>'provider' AS provider
  FROM trace_events
 WHERE trace_id = $1 AND kind = 'llm_response' AND stage LIKE 'doc_audit_%'
   AND stage <> 'doc_audit_cite_gate'
 ORDER BY seq`;

/**
 * ⚠️ THE SIX LEGS A TRACE CAN ANSWER, and the two it cannot. `analyzeCase` emits eight labels
 * (decision 124); `doc_audit_cite_gate` is unpairable (see above) and `pathway_skeleton` is
 * untraced by construction (`lib/pathway.ts:58` passes no trace id and `doc-audit.ts:525` soft-fails
 * it to `null`), so neither is ever in `steps` and both run live in exact mode.
 */
export const REPLAYED_STAGES = [
  'doc_audit_analyze', 'doc_audit_critique_llm', 'doc_audit_revise',
  'doc_audit_prognosis', 'doc_audit_prognosis_critique', 'doc_audit_prognosis_revise',
] as const;

/**
 * ⚠️ THE TWO STAGES THAT ARE NOT A REFUSAL WHEN ABSENT. Both fire only on their critique's
 * `needs_revision` (`doc-audit.ts:603` and `:441`), so a trace without them is an audit whose
 * critique was satisfied — the commonest healthy outcome, not a broken trace. Every other member of
 * `REPLAYED_STAGES` is unconditional given its flag.
 */
export const CONDITIONAL_STAGES = ['doc_audit_revise', 'doc_audit_prognosis_revise'] as const;

/**
 * ⚠️ THE LITERAL THE RECORDING PASS ANSWERS THE CITE GATE WITH, AND WHY IT IS THIS ONE.
 *
 * The freeze must make NO model call, and the cite gate is not replayable, so at freeze it is
 * answered locally with the one reply that changes nothing. `verifyCitation` (`doc-audit.ts:311-318`)
 * parses the reply with `parseVerdict` (`corpus-eval/verify-core.ts:78-92`) and drops a citation on
 * `not_supported` or `contradicts` ALONE:
 *
 *     return (verdict === 'not_supported' || verdict === 'contradicts') ? 'drop' : 'keep';
 *
 * `directly_supports` is therefore a KEEP, and a keep leaves `applyCitationGate` with an empty drop
 * list and the findings byte-identical. The recording pass exists to reproduce production's PROMPTS,
 * and a gate that dropped citations here would change every downstream prompt to something
 * production never sent.
 *
 * ⚠️ AND IT CARRIES NO `model`, DELIBERATELY. `verifyCitation:313-315` compares the served model to
 * the intended one and returns `'keep'` when they disagree; an empty `res.model` skips that branch
 * (`if (served && …)`) and reaches the parse, so the keep is the PARSER's and not a fallback's.
 */
export const CITE_GATE_KEEP_LITERAL = JSON.stringify({
  verdict: 'directly_supports',
  supporting_span: null,
  why: 'frozen at dataset creation: decision 132 runs this stage live at the arm\'s model',
});

/**
 * §17.11 DECISION 147 — THE THREE PHASE DEADLINES, AND WHY A FREEZE NEEDED THEM.
 *
 * Two of the twenty documents V froze on 06 Sep never returned (decision 139). Both traces carried
 * all seven stages once and every event kind, the same shape as the eighteen that froze, so the
 * cause is INSIDE the recording pass on those cases and is not measurable from a hang: a process
 * that never comes back produces no error, no elapsed time and no phase name. A deadline converts
 * the hang into all three.
 *
 * ⚠️ THE TRACE READ'S NUMBER IS `boundedRead`'s, IMPORTED. Decision 147 names `boundedRead` for
 * this phase; the read itself keeps the injected `run` seam the freeze supplies (and D2c's decision
 * 87 exercise binds to), so what is adopted here is the DEADLINE — 15 s, the same constant, from
 * the same file — rather than the wrapper. The guard is not needed: this statement is a constant in
 * this module, not a generated one.
 *
 * ⚠️ AND THEY NEST INSIDE THE LEASE, NOT BESIDE IT. `LEASE_MS` is 120 s and the heartbeat renews it
 * every 30 s (`contracts.ts:394-395`), so a 240 s pass is covered by renewals rather than by one
 * long lease; the freeze adapter's per-attempt ceiling (300 s) sits above the sum a single case can
 * legitimately spend.
 */
export const TRACE_READ_DEADLINE_MS = SOURCE_TIMEOUT_MS;
export const RETRIEVAL_DEADLINE_MS = 30_000;
export const RECORDING_PASS_DEADLINE_MS = 240_000;

/** What a phase reports as it starts and as it ends. The freeze adapter turns these into events. */
export type FreezePhaseReporter = (phase: string, state: 'started' | 'done' | 'over_deadline', ms: number) => void;

/**
 * Run one phase under its own deadline. A breach is `SOURCE_UNAVAILABLE` NAMING THE PHASE AND THE
 * ELAPSED MILLISECONDS, which decision 147 makes the dataset's exclusion text — so the two
 * documents of decision 139 stop being "the freeze hung" and become a line an operator can read.
 *
 * ⚠️ IT DOES NOT CANCEL THE WORK. `Promise.race` bounds how long this process WAITS; the underlying
 * query or fetch runs on until it or its own socket gives up. That is `withDeadline`'s posture in
 * `sources/read.ts:54-78` and it is stated here for the same reason: the observable contract is the
 * deadline, and pretending the backend was cancelled would be a claim this code cannot make.
 */
export async function withPhaseDeadline<T>(
  phase: string, ms: number, fn: () => Promise<T>, report?: FreezePhaseReporter,
): Promise<T> {
  const startedAt = Date.now();
  report?.(phase, 'started', 0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const out = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const elapsed = Date.now() - startedAt;
          report?.(phase, 'over_deadline', elapsed);
          reject(new LabError('SOURCE_UNAVAILABLE',
            `the ipd_discharge freeze phase '${phase}' exceeded its ${ms} ms deadline (elapsed ${elapsed} ms)`));
        }, ms);
      }),
    ]);
    report?.(phase, 'done', Date.now() - startedAt);
    return out;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One replayed leg: production's stored reply, under the hash the recording pass was asked for. */
export interface IpdDischargeStep {
  stage: string;
  request_hash: string;
  text: string;
  served: { model: string | null; provider: string | null };
}

/**
 * One frozen retrieval, WHOLE. B1's `FrozenSource` keeps a 400-character preview
 * (`sources/opd.ts:143`) because its cases are read for a human; these hits are re-fed into six
 * prompts verbatim, so a preview would change every prompt downstream of it. Every
 * `ChunkHitWithMeta` field is kept, `text` at full length.
 */
export interface FrozenRetrieval {
  query_hash: string;
  opts: Record<string, unknown>;
  hits: unknown[];
  expandedQuery: string;
  meta: unknown;
}

/** The three `process.env` reads `analyzeCase:486-488` makes, as they stood at freeze. */
export interface FrozenFlags {
  DOC_AUDIT_AUDIT: string | null;
  PROGNOSIS_AUDIT: string | null;
  DOC_AUDIT_CITE_GATE: string | null;
}

export interface IpdDischargeRecording {
  steps: Record<string, IpdDischargeStep>;
  retrieval: Record<string, FrozenRetrieval>;
  /** `params.model` as the recording edge saw it — `TEXT_MODEL` (`lib/llm.ts:503`). */
  text_model: string | null;
}

export interface RecordIpdDischargeStepsArgs {
  /** The audit's trace id, from `IPD_AUDIT_ROW_SQL`. Null means there is nothing to replay. */
  traceId: string | null;
  /** Exactly the case the adapter will run on — `frozen.extracted`, verbatim. */
  extracted: ExtractedCase;
  run: (statement: string, params: unknown[]) => Promise<Record<string, unknown>[]>;
  retrieve?: (query: string, opts: RetrieveOptions) => Promise<RetrieveResult>;
  /** Why there is no trace id, when there is none — a missing audit reads differently from a fault. */
  reason?: string | null;
  /** Decision 147 — each phase as it starts and ends. The freeze adapter turns these into events. */
  onPhase?: FreezePhaseReporter;
  /** Decision 147's three numbers, overridable so a test can drive a breach in milliseconds. */
  deadlines?: { traceReadMs?: number; retrievalMs?: number; recordingMs?: number };
}

/** The key both sides of the replay compute for one retrieval: the query AND the options. */
export function retrievalKey(query: string, opts: unknown): string {
  return hash({ query, opts: opts ?? {} });
}

/**
 * DECISIONS 132, 134, 135 and 136 — the recording pass.
 *
 * ⚠️ THE ENGINE IS RE-RUN, AND IT HAS TO BE. Production stores its `llm_request` payload with the
 * SERVED model substituted for `params.model` and without the cite gate's `response_format`
 * (`trace.ts:348-352`), so the request hash a replay will produce cannot be recomputed from
 * anything production wrote down. The only way to learn the hashes is to build the prompts again —
 * which is `recordIpdSteps`' mechanism exactly (`adapters/ipd-episode.ts:509-565`), against six
 * legs instead of two.
 *
 * ⚠️ AND IT MAKES NO MODEL CALL. Six labels are answered from `trace_events`, the cite gate from
 * `CITE_GATE_KEEP_LITERAL`, and `pathway_skeleton` by THROWING — `doc-audit.ts:525` catches it to
 * `{skeleton: null}`, which is what a skeleton failure has always meant. The retrieve edge is the
 * one thing that touches the world, and decision 136 names that as the freeze's cost: it runs
 * production's OWN options outside the fence, so `expandQuery` and the rerank judge fire once per
 * query here and never again in a run.
 *
 * ⚠️ EVERY FAILURE IS `SOURCE_UNAVAILABLE`, as D2a's is. A document whose trace cannot answer the
 * legs is EXCLUDED at `dataset_create` with a reason (`service.ts:234`); it is never frozen without
 * `steps`, because such a case would silently run fresh at the arm's own expense and be reported as
 * a replay.
 */
export async function recordIpdDischargeSteps(
  a: RecordIpdDischargeStepsArgs,
): Promise<IpdDischargeRecording> {
  const traceId = a.traceId == null ? '' : String(a.traceId);
  if (!traceId) {
    throw new LabError('SOURCE_UNAVAILABLE',
      'an exact ipd_discharge replay needs production\'s stored replies and this document has no '
      + `audit trace to read (${a.reason ?? 'no audit row at this engine version'})`);
  }

  const traceReadMs = a.deadlines?.traceReadMs ?? TRACE_READ_DEADLINE_MS;
  const retrievalMs = a.deadlines?.retrievalMs ?? RETRIEVAL_DEADLINE_MS;
  const recordingMs = a.deadlines?.recordingMs ?? RECORDING_PASS_DEADLINE_MS;

  let rows: Record<string, unknown>[];
  try {
    // Decision 147, phase one. The deadline is boundedRead's own; see TRACE_READ_DEADLINE_MS.
    rows = await withPhaseDeadline('trace_read', traceReadMs, () => a.run(IPD_DISCHARGE_TRACE_SQL, [traceId]), a.onPhase);
  } catch (e) {
    // FAIL-SAFE. A read fault is never a frozen case without steps — and a deadline breach is
    // already a `SOURCE_UNAVAILABLE` naming its phase, so it is passed through rather than reworded.
    if (e instanceof LabError) throw e;
    throw new LabError('SOURCE_UNAVAILABLE',
      `the trace_events read for this document's audit failed: ${String((e as Error).message).slice(0, 200)}`);
  }

  /**
   * Newest `seq` wins, which is `servedReadmitCall`'s posture and D2a's. The rows arrive in
   * ascending `seq`, so the last write per stage is the highest one; `(trace_id, stage)` is one row
   * per leg on every trace the survey measured, so this only decides a case that should not arise.
   */
  const byStage = new Map<string, IpdDischargeStep>();
  for (const r of rows) {
    const stage = r.stage == null ? '' : String(r.stage);
    if (!stage) continue;
    byStage.set(stage, {
      stage,
      request_hash: '',
      text: r.content == null ? '' : String(r.content),
      served: {
        model: r.model == null ? null : String(r.model),
        provider: r.provider == null ? null : String(r.provider),
      },
    });
  }

  // ⚠️ THE ONE UNCONDITIONAL LEG. `doc_audit_analyze` fires on every audit that produced a row, so
  // its absence means this trace is not the audit's — or is not readable — and no count of the
  // others can make it replayable. The conditional legs are NOT checked here: see CONDITIONAL_STAGES.
  if (!byStage.has('doc_audit_analyze')) {
    throw new LabError('SOURCE_UNAVAILABLE',
      'this document\'s audit trace carries no stored reply at doc_audit_analyze, which every audit '
      + `emits, so it cannot be replayed (found: ${[...byStage.keys()].sort().join(', ') || 'no doc_audit_* response at all'})`);
  }

  const retrieveImpl = a.retrieve ?? productionRetrieve;
  const steps: Record<string, IpdDischargeStep> = {};
  const retrieval: Record<string, FrozenRetrieval> = {};
  let textModel: string | null = null;
  let held: LabError | null = null;

  const chat = async (label: string, params: unknown): Promise<unknown> => {
    // Untraced by construction and soft-failed by its caller — never recorded, never replayed.
    if (label === 'pathway_skeleton') {
      throw new Error('pathway_skeleton is not replayable and is not called at freeze (decision 132)');
    }
    if (label === 'doc_audit_cite_gate') {
      return { choices: [{ message: { content: CITE_GATE_KEEP_LITERAL } }] };
    }
    const stored = byStage.get(label);
    if (!stored) {
      // Held as well as thrown: `analyzeCase` catches at five sites and would otherwise turn this
      // into a thin report with no idea which leg the trace was missing.
      held = held ?? new LabError('SOURCE_UNAVAILABLE',
        `the engine asked for leg '${label}' and this document's audit trace carries no stored reply `
        + `at that stage (it carries: ${[...byStage.keys()].sort().join(', ') || 'none'}); an exact `
        + 'replay needs every leg the engine reaches');
      throw held;
    }
    const model = (params as { model?: unknown })?.model;
    if (textModel == null && typeof model === 'string' && model) textModel = model;
    const request_hash = dependencyHash(params);
    steps[request_hash] = { ...stored, request_hash };
    return { choices: [{ message: { content: stored.text } }] };
  };

  /**
   * DECISION 136 — production's own options, ONCE per (query, options) pair, outside the fence.
   * The engine passes three different option sets (pooled `doc-audit.ts:244`, enrichment `:259`,
   * prognosis through the pooled closure `:419`); none is overridden here, because the point of the
   * freeze is that a run reproduces what production would retrieve, not what the lab prefers.
   */
  const retrieveEdge = async (query: string, opts?: unknown): Promise<RetrieveResult> => {
    const o = (opts ?? {}) as RetrieveOptions;
    const key = retrievalKey(query, o);
    const already = retrieval[key];
    if (already) {
      return { hits: already.hits as RetrieveResult['hits'], expandedQuery: already.expandedQuery, meta: already.meta as RetrieveResult['meta'] };
    }
    /**
     * Decision 147, phase two — ONE deadline per retrieval, not one for all of them. A case makes
     * three or four of these (pooled, prognosis, enrichment) and they are sequential; a single
     * budget over the set would let one slow read eat the others' time and report the wrong phase.
     *
     * ⚠️ A BREACH IS HELD, NOT ONLY THROWN. `analyzeCase` catches everything at five sites
     * (`doc-audit.ts:718`, `:610`, `:625`, `:581`, `:316`), so a thrown deadline here would be
     * swallowed into an empty hit list and the pass would go on to produce a case whose prompts
     * were built without the corpus. The held error is re-thrown after the pass, which is the same
     * idiom the missing-leg refusal above uses and for the same reason.
     */
    let out: RetrieveResult;
    try {
      out = await withPhaseDeadline('retrieval', retrievalMs, () => exitLabExecution(() => retrieveImpl(query, o)), a.onPhase);
    } catch (e) {
      if (e instanceof LabError) { held = held ?? e; throw e; }
      throw e;
    }
    retrieval[key] = {
      query_hash: hash(query),
      opts: o as Record<string, unknown>,
      hits: out?.hits ?? [],
      expandedQuery: out?.expandedQuery ?? '',
      meta: out?.meta ?? null,
    };
    return out;
  };

  try {
    // Decision 147, phase three — the whole engine pass, inside the lease's renewals.
    await withPhaseDeadline('recording_pass', recordingMs, () => withLabExecution(
      {
        chat,
        retrieve: retrieveEdge as unknown as (q: string, o?: unknown) => Promise<unknown>,
        event: () => {},
      },
      () => computeIpdDischargeAudit({
        extracted: a.extracted,
        // ⚠️ AN EMPTY ENVELOPE, ON PURPOSE. `meta` reaches `buildIpdAuditRow` and NOTHING ELSE
        // (`compute.ts:88-97`), so it cannot touch a prompt or a hash — and the row this pass
        // builds is discarded. Passing the real `documentId` here would put an identifier into a
        // pass whose only product is written to `lab_v2`.
        meta: { documentId: '' },
        deps: {},
        opts: {},
      }),
    ), a.onPhase);
  } catch (e) {
    if (held) throw held as LabError;
    if (e instanceof LabError) throw e;
    throw new LabError('SOURCE_UNAVAILABLE',
      `the recording pass over this document's stored replies failed: ${String((e as Error).message).slice(0, 200)}`);
  }
  if (held) throw held as LabError;

  if (!Object.keys(steps).length) {
    throw new LabError('SOURCE_UNAVAILABLE',
      'the recording pass reached no governed leg at all, so this document cannot be replayed exactly');
  }
  return { steps, retrieval, text_model: textModel };
}

/** The four `IpdAdmissionHeader` scalars `run.ts:191-203` passes into `buildIpdAuditRow`. */
export const ENVELOPE_FIELDS = ['speciality', 'dischargeType', 'losDays', 'dischargeDate'] as const;

/** Every `BillingEnvelope` scalar except `ipUid`, plus the ₹ total the row itself carries. */
export const BILLING_FIELDS = [
  'netTotal', 'saleTotal', 'refundTotal', 'lineCount', 'billCount',
  'categories', 'wardClasses', 'pharmacyItems', 'pharmacyClasses',
] as const;

/**
 * ⚠️ DECISION 118'S NEVER-STORED LIST, DECLARED SO A TEST CAN WALK IT BY NAME.
 * `documentId`, `ipUid`, `memberId` and `pdfUrl` are the run-level identifiers; `patientName`,
 * `uhid` and `ageGender` are db13's three PHI header fields; `trace_id` names one production audit
 * of one person and is read for the golden table and dropped.
 */
export const NEVER_STORED_KEYS = [
  'documentId', 'document_id', 'ipUid', 'ip_uid', 'memberId', 'member_id',
  'pdfUrl', 'pdf_url', 'patientName', 'uhid', 'ageGender', 'traceId', 'trace_id',
] as const;

export interface FrozenIpdDischargeEnvelope {
  speciality: string | null;
  dischargeType: string | null;
  losDays: number | null;
  dischargeDate: string | null;
}

export interface FrozenIpdDischargeBilling {
  netTotal: number | null;
  saleTotal: number | null;
  refundTotal: number | null;
  lineCount: number | null;
  billCount: number | null;
  categories: unknown[];
  wardClasses: unknown[];
  pharmacyItems: string[];
  pharmacyClasses: string[];
  /** `fetchBilledTotal`'s ₹ scalar — the one `buildIpdAuditRow` stores (`assemble.ts:72`). */
  billedTotal: number | null;
}

export interface FrozenIpdDischarge {
  engine: 'ipd_discharge';
  /** `ExtractedCase` with `verbatimSections` stripped (decision 50). */
  extracted: unknown;
  /** Which keys the strip removed, so the removal is visible rather than assumed. */
  stripped: string[];
  extraction_version: string;
  envelope: FrozenIpdDischargeEnvelope;
  billing: FrozenIpdDischargeBilling;
  /**
   * DECISION 134 — the four keys D2c adds.
   *
   * `steps` is keyed by the request hash the recording pass was asked for and read back BY STAGE
   * (decision 135): production's prompts embed retrieved text production never stored, so the hash
   * is evidence about drift, not the lookup. `retrieval` is keyed by `retrievalKey(query, opts)`.
   * `text_model` is `params.model` as the recording edge saw it, and a replay whose edge sees a
   * different value is `REPLAY_DIVERGED`. `flags` is what `analyzeCase:486-488` read at freeze.
   *
   * ⚠️ ALL FOUR ARE OPTIONAL ON THE TYPE, and that is not laziness: datasets frozen by D2b are on
   * production and carry none of them. A body without `steps` runs FRESH and a body without
   * `retrieval` retrieves live, exactly as D2b did.
   */
  steps?: Record<string, IpdDischargeStep>;
  retrieval?: Record<string, FrozenRetrieval>;
  text_model?: string | null;
  flags?: FrozenFlags;
}

export interface FrozenIpdDischargeCase {
  case_key: string;
  member_key: string | null;
  frozen: FrozenIpdDischarge;
  source_versions: Record<string, unknown>;
  /**
   * The stored audit's headline, for the round's golden table. A SIBLING of `frozen`, returned to
   * the caller and never written into the case body — decision 118 keeps `trace_id` out of
   * `lab_v2` entirely and the two numbers are the comparison, not an input to the replay.
   */
  stored_audit: {
    engine_version: string | null; care_value_index: number | null;
    band: string | null; model: string | null; provider: string | null;
  } | null;
}

export interface IpdDischargeSourceDeps {
  run?: (statement: string, params: unknown[]) => Promise<Record<string, unknown>[]>;
  readExtract?: typeof readExtractedCaseAcrossVersions;
  fetchHeader?: typeof fetchIpdAdmissionHeader;
  fetchBilling?: typeof fetchBillingEnvelope;
  fetchTotal?: typeof fetchBilledTotal;
  salt?: string;
  engineVersion?: string;
  /**
   * ⚠️ THE REAL RECORDER IS THE DEFAULT, not something a caller opts into — `service.ts:216`
   * constructs this freeze with no deps and cannot be edited this round, so a seam that had to be
   * SUPPLIED would leave production freezing cases with no steps. D2a's `recordSteps` made the same
   * choice for the same reason (`sources/readmission.ts`).
   */
  recordSteps?: (a: RecordIpdDischargeStepsArgs) => Promise<IpdDischargeRecording>;
  /** The corpus read the recording pass makes outside the fence (decision 136). */
  retrieve?: (query: string, opts: RetrieveOptions) => Promise<RetrieveResult>;
  /**
   * §17.11 decision 147 — each phase as it starts and ends, so the freeze adapter can emit them as
   * item events. Absent on the synchronous path, where there is no item to hang an event on.
   */
  onPhase?: FreezePhaseReporter;
  /** Decision 147's three deadlines, overridable so a test can drive a breach in milliseconds. */
  deadlines?: { traceReadMs?: number; retrievalMs?: number; recordingMs?: number };
}

const liveRun = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/** Decision 99's gate, on what is about to be stored. A hit is a REFUSAL, never a scrub. */
export function refuseIdentifying(body: unknown, what: string): void {
  const hits = identifyingKeys(body);
  if (hits.length) {
    throw new LabError('CLASSIFICATION_REQUIRED',
      `${what} carries identifying key(s) ${hits.join(', ')} after de-identification. `
      + 'Decision 99: nothing identifying is written to lab_v2, so this case is refused rather than scrubbed — '
      + 'a scrub would hide a change in the upstream engine.');
  }
}

const num = (v: unknown): number | null => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/**
 * ⚠️ FAIL-SAFE, AND IT IS THE OPPOSITE OF THE STORE'S OWN POSTURE.
 *
 * `fetchExtractedCase` collapses "absent" and "the database faulted" into `null` because its
 * original caller's answer to both is "extract it myself" (`discharge-extract-store.ts:139-141`).
 * This platform CANNOT extract anything — decision 102 forbids it — so the two must stay apart:
 * an absence is a fact about the document and a fault is a fact about the deployment, and freezing
 * a case with a default in place of either would put an invented input into a research object.
 * Every path below therefore ends in `SOURCE_UNAVAILABLE` with the cause, and none ends in a case.
 */
async function readExtract(
  documentId: string,
  read: typeof readExtractedCaseAcrossVersions,
  run: (statement: string, params: unknown[]) => Promise<Record<string, unknown>[]>,
): Promise<StoredExtractedCase> {
  const outcome = await read(documentId, [DOC_EXTRACT_VERSION]);
  if (outcome.outcome === 'found') return outcome.stored;
  if (outcome.outcome === 'fetch_failed') {
    throw new LabError('SOURCE_UNAVAILABLE',
      `the discharge_extracted_cases read faulted, so this document's extract is unreachable rather than absent: ${outcome.error}`);
  }
  // Absent AT THIS VERSION. Say which versions the document does hold — see EXTRACT_VERSIONS_SQL.
  let found: string[] = [];
  try {
    const rows = await run(EXTRACT_VERSIONS_SQL, [documentId]);
    found = rows.map((r) => String(r.extraction_version ?? '')).filter(Boolean);
  } catch {
    // The probe is a courtesy, not the answer. A fault here still refuses, and says less.
    found = [];
  }
  throw new LabError('SOURCE_UNAVAILABLE',
    `no stored extract at ${DOC_EXTRACT_VERSION} for that document `
    + `(found: ${found.length ? found.join(', ') : 'no extract at any version'}). `
    + 'Decision 102: the lab never re-reads the discharge PDF, so a document must already have been '
    + 'extracted at the current version before it can be studied.');
}

export async function freezeIpdDischargeDocument(
  documentId: string, deps: IpdDischargeSourceDeps = {},
): Promise<FrozenIpdDischargeCase> {
  const key = String(documentId ?? '').trim();
  if (!key) throw new LabError('INVALID_INPUT', 'an ipd_discharge case is one document, named by its documentId');
  const run = deps.run ?? liveRun;
  const read = deps.readExtract ?? readExtractedCaseAcrossVersions;
  const header = deps.fetchHeader ?? fetchIpdAdmissionHeader;
  const billing = deps.fetchBilling ?? fetchBillingEnvelope;
  const total = deps.fetchTotal ?? fetchBilledTotal;
  const engineVersion = deps.engineVersion ?? IPD_ENGINE_VERSION;
  const recordSteps = deps.recordSteps ?? recordIpdDischargeSteps;

  // ⚠️ OUTSIDE THE FENCE. See the header: every read below throws inside a lab context by design.
  return exitLabExecution(async () => {
    const stored = await readExtract(key, read, run);
    const ipUid = stored.ipUid ?? null;

    /**
     * ⚠️ THE TWO db13 JOINS DEGRADE, THE EXTRACT READ DOES NOT, and the asymmetry is production's
     * own. `run.ts:179-184` wraps both in `.catch(() => null)` and its comment says why: ~8% of
     * audited documents have no linked bill at all, so a null envelope is a normal value here. The
     * audit runs without them — `buildIpdAuditRow` falls back to the extract's own
     * `lengthOfStayDays` (`assemble.ts:70`) — so refusing the case would refuse documents
     * production audits every day. The extract is different: it IS the engine's input.
     */
    const [head, bill, billed] = ipUid
      ? await Promise.all([
        header(ipUid).catch(() => null),
        billing(ipUid).catch(() => null),
        total(ipUid).catch(() => null),
      ])
      : [null, null, null];

    /**
     * ⚠️ THE GOLDEN COMPARISON'S B SIDE, AND A MISSING ROW IS NOT A REFUSAL. A document may be
     * eligible (it has a current extract) and never yet audited at this engine version, which is
     * precisely the cohort a lab run is most interesting on. `null` says so.
     */
    let storedAudit: FrozenIpdDischargeCase['stored_audit'] = null;
    /**
     * ⚠️ THE TRACE ID IS READ AND NEVER STORED, and it is the round's whole input. `IPD_AUDIT_ROW_SQL`
     * already selected it in D2b and D2b dropped it on the floor; D2c hands it to the recording pass
     * and it still reaches neither `frozen` nor `source_versions` (decision 118).
     */
    let auditTraceId: string | null = null;
    let traceReason: string | null = 'no audit row at this engine version';
    try {
      const rows = await run(IPD_AUDIT_ROW_SQL, [key, engineVersion]);
      const r = rows[0];
      if (r) {
        auditTraceId = r.trace_id == null ? null : String(r.trace_id);
        if (!auditTraceId) traceReason = 'the audit row at this engine version carries no trace_id';
        storedAudit = {
          engine_version: r.engine_version == null ? null : String(r.engine_version),
          care_value_index: num(r.care_value_index),
          band: r.band == null ? null : String(r.band),
          model: r.model == null ? null : String(r.model),
          provider: r.provider == null ? null : String(r.provider),
        };
      }
    } catch (e) {
      // The golden side is evidence about the ROUND, not an input to the replay, so a fault here
      // leaves it null. The TRACE ID is different now: without it there is no replay, so the reason
      // is carried forward and the recording pass refuses with the fault rather than with "absent".
      storedAudit = null;
      auditTraceId = null;
      traceReason = `the ipd_discharge_audits read faulted: ${String((e as Error).message).slice(0, 120)}`;
    }

    // ⚠️ DECISION 50 — `verbatimSections` is raw discharge prose and is REMOVED, and the removal
    // is recorded. `sources/ipd.ts:227-240` is the same function, imported rather than restated.
    const { value: extracted, stripped } = stripVerbatimSections(stored.extracted as unknown as ExtractedCase);

    const frozen: FrozenIpdDischarge = {
      engine: 'ipd_discharge',
      extracted,
      stripped,
      extraction_version: stored.extractionVersion,
      // ⚠️ FOUR SCALARS, NAMED ONE BY ONE. Spreading the header would carry `patientName`, `uhid`,
      // `ageGender` and `ipUid` straight into the body; these are the four `run.ts:195-198` passes.
      envelope: {
        speciality: head?.speciality ?? null,
        dischargeType: head?.dischargeType ?? null,
        losDays: head?.losDays ?? null,
        dischargeDate: head?.dischargeDate ?? null,
      },
      // Ten scalars, named one by one for the same reason: `BillingEnvelope` carries `ipUid`.
      billing: {
        netTotal: bill ? bill.netTotal : null,
        saleTotal: bill ? bill.saleTotal : null,
        refundTotal: bill ? bill.refundTotal : null,
        lineCount: bill ? bill.lineCount : null,
        billCount: bill ? bill.billCount : null,
        categories: bill ? bill.categories : [],
        wardClasses: bill ? bill.wardClasses : [],
        pharmacyItems: bill ? bill.pharmacyItems : [],
        pharmacyClasses: bill ? bill.pharmacyClasses : [],
        billedTotal: billed ?? null,
      },
    };

    /**
     * ⚠️ DECISIONS 132 AND 134 — THE RECORDING PASS, ON THE BODY THE ADAPTER WILL RUN ON.
     *
     * It is handed `frozen.extracted` and not `stored.extracted`: the strip has already happened, so
     * the prompts this pass builds are the prompts a run will build, and the hashes it records are
     * the hashes a run will produce. Handing it the unstripped case would have recorded hashes no
     * replay could ever match, and the divergence would have said nothing about the engine.
     *
     * ⚠️ AND IT RUNS BEFORE `refuseIdentifying`, so decision 99's walk covers `steps` and
     * `retrieval` too — every replayed reply and every corpus chunk this case will feed back into
     * six prompts. Chunk text is a textbook's (`book`, `chapter`); a corpus that ever carried
     * patient text would be refused here rather than stored.
     */
    const recorded = await recordSteps({
      traceId: auditTraceId,
      extracted: extracted as unknown as ExtractedCase,
      run,
      retrieve: deps.retrieve,
      reason: traceReason,
      // §17.11 decision 147 — the three phase deadlines and their reporter, passed straight
      // through. On the synchronous path both are undefined and the constants apply.
      onPhase: deps.onPhase,
      deadlines: deps.deadlines,
    });
    frozen.steps = recorded.steps;
    frozen.retrieval = recorded.retrieval;
    frozen.text_model = recorded.text_model;
    // Decision 123 — READ, never decided. What this deployment had set when the case was frozen.
    frozen.flags = {
      DOC_AUDIT_AUDIT: process.env.DOC_AUDIT_AUDIT ?? null,
      PROGNOSIS_AUDIT: process.env.PROGNOSIS_AUDIT ?? null,
      DOC_AUDIT_CITE_GATE: process.env.DOC_AUDIT_CITE_GATE ?? null,
    };

    refuseIdentifying(frozen, 'the frozen ipd_discharge case');

    const salt = deps.salt ?? memberSalt();
    return {
      /**
       * ⚠️ A HASH OF THE documentId, NEVER THE documentId. A case key is stored on the dataset, on
       * every item and in every report; `documentId` resolves to a person (`requests.ts:218`).
       * Hashing keeps two runs of the same document comparable — which is all a case key is for.
       */
      case_key: `ipddoc:${createHash('sha256').update(`${salt}|${key}`).digest('hex').slice(0, 32)}`,
      member_key: stored.memberId ? memberKeyOf(String(stored.memberId), salt) : null,
      frozen,
      source_versions: {
        origin: 'discharge_extracted_cases + db13',
        extraction_version: stored.extractionVersion,
        engine_version: engineVersion,
        // Whether the golden side exists, WITHOUT the document it belongs to.
        stored_audit: storedAudit ? storedAudit.engine_version : null,
        stored_audit_model: storedAudit ? storedAudit.model : null,
        billing_present: bill != null,
        envelope_present: head != null,
        stripped,
        // Decision 134 — the shape of the replay this case supports, WITHOUT the trace it came from.
        recorded_steps: Object.keys(recorded.steps).length,
        recorded_stages: [...new Set(Object.values(recorded.steps).map((st) => st.stage))].sort(),
        recorded_retrievals: Object.keys(recorded.retrieval).length,
        text_model: recorded.text_model,
        frozen_at: new Date().toISOString(),
      },
      stored_audit: storedAudit,
    };
  });
}
