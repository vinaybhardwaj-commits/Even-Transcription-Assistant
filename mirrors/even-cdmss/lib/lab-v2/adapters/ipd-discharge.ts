/**
 * lib/lab-v2/adapters/ipd-discharge.ts — the `ipd_discharge` engine behind the fence
 * (LAB-MCP-V2-PRD-v1.0 §17.9 round D2b, decisions 117, 118, 122, 123, 124, 125).
 *
 * ⚠️ IT CALLS `compute.ts`, NEVER `runIpdAudit`. Decision 117(a): the two phases that are the
 * engine — `analyzeCase` and `buildIpdAuditRow` — are composed in `lib/ipd-audit/compute.ts`, and
 * the other ten phases of `run.ts` are I/O this adapter must not perform: a PDF fetch, the
 * multimodal extract (fenced, decision 102), two db13 joins (frozen at `dataset_create`), a
 * `trace_events` read and FOUR WRITERS. Reaching `runIpdAudit` from here would write a production
 * clinical row from a research key.
 *
 * ⚠️ NO SEAM IS INJECTED, AND THAT IS DELIBERATE. `analyzeCase` takes `deps.generate`,
 * `deps.retrieveHits` and `deps.enrichHits`; this adapter supplies NONE of them, so the engine
 * runs its own closures — and inside `withLabExecution` those closures land on the lab's edges:
 *   · every `generate` leg goes `tracedAnalyzeGenerate` → `tracedChat` → `labExecution().chat(label, params)`
 *     (`lib/trace.ts:333-334`), so THE LABEL THE ENGINE PASSES IS THE STAGE THE GATEWAY METERS;
 *   · the cite gate bypasses the `generate` seam and calls `tracedChat` directly
 *     (`doc-audit.ts:308-310`) — it reaches the same edge, under `doc_audit_cite_gate`;
 *   · `pathway_skeleton` goes through `governedChat` (`lib/pathway.ts:58`) to the same edge;
 *   · all three retrievals reach `retrieve()`, which the fence's retrieve edge serves live
 *     (decision 125).
 * Injecting a `generate` here would have collapsed six differently-priced legs onto one closure
 * that cannot see the label, which is exactly the mistake decision 124 exists to prevent.
 *
 * ⚠️ AND `opts.trace` IS LEFT UNSET, WHICH IS NOT WHAT IT LOOKS LIKE. Inside the fence
 * `startTrace` returns the inert sentinel `'lab-v2-untraced'` and writes nothing (`lib/trace.ts:75`),
 * and every `logEvent`/`finishTrace` is a no-op (`:96`, `:150`). So a truthy `traceId` inside
 * `analyzeCase` costs NOTHING in production terms and buys the only thing that matters: the
 * `traceId ? …` arm of the `generate` closure (`doc-audit.ts:504-506`) is the arm that FORWARDS
 * THE LABEL. Passing `trace: false` would take the other arm, `analyzeGenerate` (`:195-199`), which
 * hard-codes `'doc_audit_analyze'` for all six legs. FLAGGED in the round report: the kickoff's
 * item 4 asks for both "opts.trace false" and "its labels reach the gateway", and only one of those
 * can hold. The labels win, because decision 124's eight stages and §35a's pricing rule both rest
 * on them, and because the trace this creates does not exist.
 *
 * ⚠️ SINCE ROUND D2c IT REPLAYS SIX OF THE EIGHT (§17.10, decisions 132 to 136). A case that carries
 * `steps` answers `doc_audit_analyze`, the two critiques, the two revises and `doc_audit_prognosis`
 * from production's own stored replies at ZERO cost, BY STAGE rather than by hash (decision 135);
 * `doc_audit_cite_gate` and `pathway_skeleton` reach the gateway and are metered, which is why this
 * engine's replay exactness stays `mutable_source` and why the cite gate is isolated as the only
 * source of divergence against production's verdict. A case with no `steps` — every dataset frozen
 * by D2b — runs exactly as it did.
 *
 * ⚠️ THE FLAGS COME FROM THE DEPLOYMENT, NOT FROM THE ARM (decision 123). `DOC_AUDIT_AUDIT`,
 * `PROGNOSIS_AUDIT` and `DOC_AUDIT_CITE_GATE` are `process.env` reads inside `analyzeCase`
 * (`:486-488`) and `lib/doc-audit.ts` is not edited this round. So the summary REPORTS the three
 * values it read and the per-stage leg counts, and a reader can see what actually fired instead of
 * inferring it from a flag they cannot check.
 */
import { LabError, hash } from '../contracts';
import { dependencyHash } from '../gateway';
import { computeIpdDischargeAudit, IpdComputeError } from '../../ipd-audit/compute';
import { IPD_ENGINE_VERSION } from '../../ipd-audit/store';
import { PSEUDONYM_PREFIX } from '../sources/preop';
import { withLabExecution, exitLabExecution } from '../../lab-execution-context';
import { retrieve as productionRetrieve, type RetrieveOptions, type RetrieveResult } from '../../retrieve';
import { REPLAYED_STAGES, retrievalKey } from '../sources/ipd-discharge';
import type { Adapter, AdapterContext, AdapterOutcome } from './types';
import type { FrozenIpdDischarge, IpdDischargeStep } from '../sources/ipd-discharge';
import type { ExtractedCase } from '../../doc-audit-core';

/**
 * DECISION 124 — the eight labels this engine's call tree can emit, measured in source and
 * confirmed against production traces (V's console read, 07 Sep: one request/response pair at each
 * of six labels and fifteen pairs at the cite gate, on the three newest `0.2` traces).
 */
export const IPD_DISCHARGE_STAGES = [
  'doc_audit_analyze', 'doc_audit_critique_llm', 'doc_audit_revise', 'doc_audit_cite_gate',
  'doc_audit_prognosis', 'doc_audit_prognosis_critique', 'doc_audit_prognosis_revise',
  'pathway_skeleton',
] as const;

/**
 * DECISION 132 — the two stages that stay LIVE in an exact replay, and the reason each does.
 * `doc_audit_cite_gate` fires fifteen concurrent calls under one label whose stored request and
 * response rows cannot be paired (`doc-audit.ts:345`); `pathway_skeleton` is untraced by
 * construction (`lib/pathway.ts:58`). Both reach the gateway and are METERED, and because they do,
 * this engine's replay exactness stays `mutable_source` and the cite gate is isolated as the only
 * source of divergence against production's verdict.
 */
export const LIVE_STAGES = ['doc_audit_cite_gate', 'pathway_skeleton'] as const;

/** The six a trace can answer — re-exported from the source so both sides read one list. */
export { REPLAYED_STAGES };

/** `bandFor` (`lib/value-score-core.ts:129-135`) — the whole vocabulary, and nothing else. */
export const CARE_VALUE_BANDS = ['A', 'B', 'C', 'D', 'E'] as const;

/**
 * The analyze chain's own ceiling. `runIpdAudit` sizes its route against three analyze legs
 * (`doc-audit.ts:189`), and a lab item may fire eight labels including a fifteen-call cite gate, so
 * the PER-ATTEMPT bound here is one leg's, not the chain's — the gateway applies it per call.
 */
export const IPD_DISCHARGE_PER_ATTEMPT_MS = 380_000;

export interface IpdDischargeAdapterDeps {
  retrieve?: (query: string, opts: RetrieveOptions) => Promise<RetrieveResult>;
}

/**
 * DECISION 118's addition. `IpdAuditMeta` (`assemble.ts:33-52`) REQUIRES `documentId` and takes
 * `ipUid`, `memberId` and `traceId`; `buildIpdAuditRow` copies all four onto the row it returns
 * (`:65-67`, `:92`). A lab run has none of them — the freeze stored none — so it passes per-case
 * surrogates in decision 106's shape and an empty trace id, and strips all four back off the row
 * before it becomes the item's result.
 *
 * ⚠️ THE SURROGATE IS DERIVED FROM THE CASE KEY, which is itself already a salted hash of the
 * document id (`sources/ipd-discharge.ts`). So it is stable for one case across repetitions — two
 * runs of the same document produce the same row — and it resolves to nothing.
 */
export function surrogateFor(caseKey: string, field: string): string {
  return `${PSEUDONYM_PREFIX}${hash(`${caseKey}|${field}`).slice(0, 24)}`;
}

/** The four `IpdAuditMeta` fields decision 118 strips from the row before it is stored. */
export const STRIPPED_ROW_KEYS = ['documentId', 'ipUid', 'memberId', 'traceId'] as const;

export function stripRowIdentifiers(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if ((STRIPPED_ROW_KEYS as readonly string[]).includes(k)) continue;
    out[k] = v;
  }
  return out;
}

export function makeIpdDischargeAdapter(deps: IpdDischargeAdapterDeps = {}): Adapter {
  const retrieveImpl = deps.retrieve ?? productionRetrieve;
  return {
    engine: 'ipd_discharge',
    stages: IPD_DISCHARGE_STAGES,
    engineVersion: () => IPD_ENGINE_VERSION,
    frozenInputs: ['extracted', 'envelope', 'billing', 'extraction_version', 'steps', 'retrieval'],
    perAttemptTimeoutMs: IPD_DISCHARGE_PER_ATTEMPT_MS,

    async run(ctx: AdapterContext): Promise<AdapterOutcome> {
      const frozen = (ctx.frozen ?? {}) as Partial<FrozenIpdDischarge>;
      if (!frozen.extracted || typeof frozen.extracted !== 'object') {
        return {
          result: { error: 'frozen inputs did not match the ipd_discharge shape', keys: Object.keys(frozen) },
          summary: { engine: 'ipd_discharge', error: 'bad_frozen_inputs' },
          execution_status: 'failed', assessment_status: 'not_reached',
        };
      }

      /**
       * ⚠️ A REFUSED STAGE MUST NOT ARRIVE AS A THIN REPORT, and without this it would.
       *
       * `analyzeCase` catches EVERYTHING. Its outer `catch` returns `{report: null}` (`:718-722`),
       * the audit loop keeps the draft on any failure (`:610-612`), the cite gate keeps the
       * citations (`:625-627`), enrichment keeps the pooled sources (`:581-583`), and
       * `verifyCitation` soft-fails to `'keep'` (`:316-317`). So a `MODEL_UNSUPPORTED` from the
       * gateway — the arm priced no model for this label — would be swallowed at whichever of
       * those five catches saw it, and the item would land as an ordinary audit with one chain
       * quietly missing, or as a bare "no report" with no idea which stage was unpriced.
       *
       * §35a is explicit that an arm prices every stage. So the FIRST LabError this edge sees is
       * held and re-thrown after the engine returns — the `ipd-episode.ts:197-224` shape, for the
       * same reason and against five catches instead of one.
       */
      let refused: LabError | null = null;
      const legs: Record<string, number> = {};
      const liveStages: Record<string, number> = {};
      let retrievalReads = 0;
      let retrievalHits = 0;
      let retrievalMisses = 0;
      let replayedStages = 0;
      let promptDrift = 0;

      /**
       * DECISIONS 132 AND 135 — EXACT MODE, AND IT IS KEYED BY STAGE.
       *
       * `steps` is a hash-keyed map because that is how a step is stored everywhere on this
       * platform, but this engine READS IT BY STAGE and the difference is the whole of decision 135:
       * production's analyze prompt embeds the retrieved chunk text (`buildCitedContext`, 700
       * characters per chunk) and production stored no chunks, so the hash the recording pass
       * computed is not the hash production would have had. Matching on it would diverge every case
       * for a reason that says nothing about the engine. The hash is still COMPARED — a mismatch is
       * counted as `prompt_drift` and reported — but it does not decide the lookup.
       *
       * ⚠️ AND A BODY WITH NO `steps` RUNS FRESH. Datasets frozen by D2b are on production and carry
       * none; they behave exactly as they did.
       */
      const storedSteps = frozen.steps ?? {};
      const exact = Object.keys(storedSteps).length > 0;
      const byStage = new Map<string, IpdDischargeStep>();
      for (const step of Object.values(storedSteps)) {
        if (step && typeof step.stage === 'string') byStage.set(step.stage, step);
      }
      const frozenRetrieval = frozen.retrieval ?? {};
      const hasFrozenRetrieval = Object.keys(frozenRetrieval).length > 0;

      /**
       * ⚠️ HELD AND RE-THROWN, for the same five catch sites the D2b header names. A
       * `REPLAY_DIVERGED` thrown from this edge would otherwise be swallowed by `analyzeCase` and
       * the item would land as an ordinary audit built on ONE production reply and five fresh ones —
       * which is the single worst outcome this round can produce, because it looks like a success.
       */
      let diverged: LabError | null = null;

      const chatEdge = async (label: string, params: unknown): Promise<unknown> => {
        // The label IS the stage (decision 35). An unrecognised one is passed through unchanged so
        // the gateway refuses it BY NAME — a new governed leg must surface as "the arm prices no
        // stage 'x'", never as a silent charge to a neighbouring stage.
        legs[label] = (legs[label] ?? 0) + 1;

        if (exact && (REPLAYED_STAGES as readonly string[]).includes(label)) {
          // DECISION 134 — the answerer, not the question. `dependencyHash` excludes provider and
          // model deliberately, so a replay served by a different text model would otherwise pass
          // silently; the case records what the recording edge saw and this compares against it.
          const model = (params as { model?: unknown })?.model;
          if (frozen.text_model && typeof model === 'string' && model && model !== frozen.text_model) {
            diverged = diverged ?? new LabError('REPLAY_DIVERGED',
              `stage '${label}' was recorded against text model '${frozen.text_model}' and this run's `
              + `edge was asked for '${model}': the stored replies answer a different question`);
            throw diverged;
          }
          const step = byStage.get(label);
          if (!step) {
            // A conditional leg the trace never carried, that this run's critique then asked for
            // (`doc_audit_revise`, `doc_audit_prognosis_revise`), lands here — and it is a real
            // divergence: the engine took a branch production did not.
            diverged = diverged ?? new LabError('REPLAY_DIVERGED',
              `the engine asked for stage '${label}' and this case carries no stored reply at it `
              + `(it carries: ${[...byStage.keys()].sort().join(', ')})`);
            throw diverged;
          }
          replayedStages += 1;
          const want = dependencyHash(params);
          const drifted = want !== step.request_hash;
          if (drifted) promptDrift += 1;
          ctx.event('stage_replayed', { stage: label, request_hash: want, prompt_drift: drifted });
          return { choices: [{ message: { content: step.text } }] };
        }

        liveStages[label] = (liveStages[label] ?? 0) + 1;
        try {
          const staged = await ctx.gateway.call(label, params as Record<string, unknown>);
          return staged.completion;
        } catch (e) {
          if (e instanceof LabError && !refused) refused = e;
          throw e;
        }
      };

      const retrieveEdge = async (query: string, opts?: unknown): Promise<RetrieveResult> => {
        const started = Date.now();
        const o = (opts ?? {}) as RetrieveOptions;
        retrievalReads += 1;

        if (hasFrozenRetrieval) {
          const stored = frozenRetrieval[retrievalKey(query, o)];
          if (stored) {
            retrievalHits += 1;
            ctx.event('retrieval_read', {
              query_hash: stored.query_hash, chunks: stored.hits?.length ?? 0,
              ms: Date.now() - started, frozen: true,
            });
            return {
              hits: (stored.hits ?? []) as RetrieveResult['hits'],
              expandedQuery: stored.expandedQuery ?? '',
              meta: stored.meta as RetrieveResult['meta'],
            };
          }
          /**
           * ⚠️ A MISS RUNS LIVE WITH TWO OPTIONS FORCED, AND THAT IS THE FENCE HOLE CLOSING.
           *
           * Decision 133: the retrieve edge exits the fence, and three model calls ride out with it —
           * `expandQuery` (`retrieve.ts:405`), the rerank judge (`rerank.ts:311`) and the embedding
           * (`llm.ts:512`). `skipExpand` and `useReranker: false` kill the first two, so the only
           * egress left on a lab replay is the embedding read, which decision 133 accepts and names:
           * a network READ, never a production write, and never a governed model call escaping the
           * gateway's meter.
           */
          retrievalMisses += 1;
          const forced: RetrieveOptions = { ...o, skipExpand: true, useReranker: false };
          const out = await exitLabExecution(() => retrieveImpl(query, forced));
          ctx.event('retrieval_read', {
            query_hash: hash(query), chunks: out?.hits?.length ?? 0, ms: Date.now() - started,
            frozen: false, forced_no_model: true,
          });
          return out;
        }

        // DECISION 125 — a D2b case, unchanged. All three retrieval seams (pooled `:523`, prognosis
        // `:419`, per-finding enrichment `:563-569`) land here and run live at production's options.
        const out = await exitLabExecution(() => retrieveImpl(query, o));
        ctx.event('retrieval_read', {
          query_hash: hash(query), chunks: out?.hits?.length ?? 0, ms: Date.now() - started, frozen: false,
        });
        return out;
      };

      // Decision 123 — READ, not decided. `analyzeCase` reads these three at `:486-488`; the
      // summary reports what this deployment had set so a reader can see what could have fired.
      const flags = {
        DOC_AUDIT_AUDIT: process.env.DOC_AUDIT_AUDIT ?? null,
        PROGNOSIS_AUDIT: process.env.PROGNOSIS_AUDIT ?? null,
        DOC_AUDIT_CITE_GATE: process.env.DOC_AUDIT_CITE_GATE ?? null,
      };

      return withLabExecution(
        { chat: chatEdge, retrieve: retrieveEdge as unknown as (q: string, o?: unknown) => Promise<unknown>, event: ctx.event },
        async (): Promise<AdapterOutcome> => {
          try {
            const out = await computeIpdDischargeAudit({
              extracted: frozen.extracted as ExtractedCase,
              meta: {
                // Decision 118 — surrogates in, and stripped out again below.
                documentId: surrogateFor(ctx.caseKey, 'documentId'),
                ipUid: surrogateFor(ctx.caseKey, 'ipUid'),
                memberId: surrogateFor(ctx.caseKey, 'memberId'),
                speciality: frozen.envelope?.speciality ?? null,
                dischargeType: frozen.envelope?.dischargeType ?? null,
                losDays: frozen.envelope?.losDays ?? null,
                // `run.ts:198` builds the ISO timestamp from db13's date the same way.
                dischargedAt: frozen.envelope?.dischargeDate ? `${frozen.envelope.dischargeDate}T00:00:00+05:30` : null,
                billedTotal: frozen.billing?.billedTotal ?? null,
                engineVersion: IPD_ENGINE_VERSION,
                // The gateway attributes the models; a lab run has no served-model trace to ask.
                model: null,
                traceId: '',
              },
              // No seams — see the file header. The engine's own closures reach the lab's edges.
              deps: {},
              opts: {},
            });
            // Held, not swallowed — see the notes above the chat edge. A divergence outranks a
            // refusal: an item that replayed the wrong reply is a worse fact than an unpriced stage.
            if (diverged) throw diverged as LabError;
            if (refused) throw refused as LabError;

            const row = stripRowIdentifiers(out.row as unknown as Record<string, unknown>);
            /**
             * ⚠️ THE ROW'S VALUE, NOT A SECOND COMPUTATION OF IT. `careValueIndex` is
             * `Math.round(report.valueScore.headline)` and `assemble.ts:73` is the one place that
             * arithmetic lives; recomputing it here would create a second definition that could
             * drift from the column production stores, which is precisely what the golden table
             * compares against.
             */
            const careValueIndex = typeof out.row.careValueIndex === 'number' ? out.row.careValueIndex : null;
            const band = out.row.band == null ? null : String(out.row.band);
            const assessed = careValueIndex != null && band != null
              && (CARE_VALUE_BANDS as readonly string[]).includes(band);

            return {
              result: row,
              summary: {
                engine: 'ipd_discharge',
                engine_version: IPD_ENGINE_VERSION,
                case_key: ctx.caseKey,
                // ⚠️ THE HEADLINE, AND NOT THE documentId. A summary is returned inline by
                // `run_result` and copied into every report; decision 99 reaches it too.
                care_value_index: careValueIndex,
                band,
                n_findings: typeof out.row.nFindings === 'number' ? out.row.nFindings : null,
                n_low_value: typeof out.row.nLowValue === 'number' ? out.row.nLowValue : null,
                completeness_pct: out.row.completenessPct ?? null,
                excerpt_count: out.excerptCount,
                // Decision 123 — what fired, per label, and what the deployment had set.
                legs,
                flags,
                retrieval_reads: retrievalReads,
                // ⚠️ DECISION 132's EQUALITY CLAIM, REPORTED RATHER THAN ASSERTED. Six of production's
                // own replies through this engine's arithmetic, the cite gate and skeleton live, and
                // the count of prompts that did not hash to what the freeze recorded.
                exact_replay: exact,
                replayed_stages: replayedStages,
                live_stages: liveStages,
                prompt_drift: promptDrift,
                retrieval: { hits: retrievalHits, misses: retrievalMisses },
                text_model: frozen.text_model ?? null,
              },
              execution_status: 'succeeded',
              assessment_status: assessed ? 'assessed' : 'unassessable',
            };
          } catch (e) {
            // ⚠️ A REFUSED STAGE LEAVES THE ADAPTER BY NAME. `MODEL_UNSUPPORTED` and
            // `BUDGET_EXHAUSTED` are statements about the ARM, not about the document, and the
            // worker classifies them (`worker.ts:226-229`). Everything else is this document's
            // own failure and is returned as an outcome.
            if (diverged) throw diverged as LabError;
            if (refused) throw refused as LabError;
            if (e instanceof LabError) throw e;
            const err = e as IpdComputeError & { code?: string };
            return {
              result: { error: String(err.message).slice(0, 500), code: err.code ?? null, legs, flags },
              summary: {
                engine: 'ipd_discharge', engine_version: IPD_ENGINE_VERSION, case_key: ctx.caseKey,
                error: err.code ?? 'compute_failed',
                message: String(err.message).slice(0, 300),
                legs, flags, retrieval_reads: retrievalReads,
                exact_replay: exact, replayed_stages: replayedStages, live_stages: liveStages,
                prompt_drift: promptDrift, retrieval: { hits: retrievalHits, misses: retrievalMisses },
                text_model: frozen.text_model ?? null,
              },
              execution_status: 'failed', assessment_status: 'not_reached',
            };
          }
        },
      );
    },
  };
}
