/**
 * lib/mcp-tools.ts — the CDMSS "Lab" MCP tool implementations (pure of transport).
 *
 * Every tool here is MINI-ONLY and data-in/data-out. None can invoke Gemini, change a
 * prompt/engine, or write a production table. Corpus writes are quarantined (labq:) by
 * construction. Consumed by app/api/mcp/route.ts (the JSON-RPC transport).
 */
import { auditOpdNote, opdMiniEngine } from './opd-note-audit';
import { OPD_AUDIT_SYSTEM, buildOpdAuditUser } from './opd-note-audit-core';
import { MINI_MODEL, modelsAgree } from './llm';
import { governedChat } from './trace';
import { fetchOpdNoteByUid } from './metabase';
import { sql } from './db';
import { guardReadOnlySql } from './sql-guard-core';
// LAB-MCP Phase 2 wiring — the pure cores shipped in f720579. REUSED, never reimplemented.
import { decideLabSource } from './lab-source-core';
// F11 (option 3): the ONE provider resolver + the ceiling, shipped and tested in f720579.
import { resolveProvider, checkPaidCeiling, DEFAULT_PAID_CEILING } from './lab-provider-core';
import { LAB_ORIGIN_HEADER, LAB_ORIGIN_VALUE, LAB_ADMIN_HEADER } from './lab-override-core';
import {
  checkCitationFields, parseProposeArgs, parseRatifyArgs, checkPromotable, classifyGaps,
  type ExistingStatement, type GapRow,
} from './lvc-proposal-core';
import { retrieve, clampLabRetrieveTopK, BM25_DEFAULT_DFMAX } from './retrieve';
import { randomUUID } from 'node:crypto';
import {
  telemetryContextFor, routeClassOf, validateManifest,
  type TelemetryRequestContext, type RetrievalRole, type OperationalTelemetry,
} from './retrieval-telemetry-core';
import { createTelemetryCapture, buildRetrievalPayload, errorClassOf as telemetryErrorClassOf } from './retrieval-capture';
import { declareRetrievals, writeRetrievalTerminal, type LifecycleHandle, type ManifestDefectsByRole } from './retrieval-telemetry-store';
import { startInvocation } from './retrieval-invocation-store';
import { settleOwned, outcomeForOwnedSave } from './retrieval-settlement';
import { readRetrievalTelemetry } from './retrieval-telemetry-store';
import { retrieveMultiQuery } from './multi-query';
import { RerankBackendError } from './rerank';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
import { readState, setSetting, MB_KEYS } from './mini-backfill';
import { LB_KEYS, sanitizeUids, clampN, clampEvalConcurrency } from './lab-batch-core';
import { readBatchState, batchProgress, batchTick, readBatchModel, resolveBatchModel, LB_MODEL_KEY } from './lab-batch';
// S2b — the SAME reachability probe the backfill runner and the F11 override gate use. One rule.
import { probeReachable } from './lab-override';
import {
  ensureLabTables, saveLabAnalysis, countPaidRuns, updateLabAnalysis, correctLabAttribution, listLabAnalyses, getLabAnalysis, labLabel,
  corpusAddQuarantined, corpusActivate, corpusDelete, corpusLabList, labStorage,
} from './lab';
import {
  ANSWER_LEGS, attributionErrorOutput, checkAttribution, type ServedCall,
} from './lab-attribution-core';
import {
  parseNdjson, reduceDdxEvents, reduceAskEvents, reduceAppropriatenessEvents,
  reduceDocAuditEvents, labSelfBaseUrl,
} from './lab-clinical-core';
import {
  ADJUDICATION_DDL, buildRollupFindingSql, buildRollupFiredSql, buildRollupMissedSql,
  buildRollupAuditSql, buildRollupReviewerSql, buildRollupReviewerCurrentSql, buildLatestLedgerSql, reduceRollup,
  ADJUDICATION_ENGINE_VERSION_DDL,
  buildDetailSql, shapeDetailRow, parseAdjudicateArgs, buildAdjudicationInsert,
  buildAdjudicationListSql, reduceLedgerList, clampLimit,
  type FindingCountRow, type FiredRow, type MissedRow, type AuditRow as RollupAuditRow,
  type ReviewerRow, type LedgerLatestRow, type DetailRawRow, type LedgerRow, type FeedbackScope,
} from './opd-feedback-rollup-core';
import { DETAIL_SCOPES } from './opd-feedback-rollup-core';

export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const ok = (obj: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const err = (msg: string): ToolResult => ({ content: [{ type: 'text', text: `Error: ${msg}` }], isError: true });
const S = (v: unknown) => (typeof v === 'string' ? v : '');
const APP_SOURCE = process.env.APP_SOURCE || 'standalone';

// ── tool schemas (advertised via tools/list) ────────────────────────────────────
export const LAB_TOOLS = [
  {
    name: 'mini_analyze',
    description: 'Run the CDMSS OPD note-quality audit on the LOCAL Mac-mini (Qwen, ₹0) and store the result in the experimental lab (table lab_analyses, namespaced by `experiment`). Provide EITHER metabase_uid (a db13 OPD note) OR text (a pasted clinical note). Does not touch production audit tables. WRITE-CLASS: lab-write (lab_analyses only).',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: "F11 provider routing. OMIT for the local Mac-mini (₹0, today's behaviour, unchanged). Prefixes: ollama:<name> | openrouter:<id> | vertex:<id>; unprefixed ⇒ the mini. An unknown prefix ERRORS — it never silently falls back. PAID runs (openrouter/vertex) count against a per-experiment ceiling, default 250." },
        ceiling: { type: 'number', description: 'Per-experiment cap on PAID (non-ollama) runs, default 250. Exceeding it STOPS and reports; raise it only by passing this explicitly.' },
        experiment: { type: 'string', description: 'Experiment label to file this under (new or existing).' },
        metabase_uid: { type: 'string', description: 'db13 individuals-prescriptions uid to audit (structured OPD audit).' },
        text: { type: 'string', description: 'Raw clinical note text to audit (used if no metabase_uid).' },
      },
      required: ['experiment'],
    },
  },
  {
    name: 'backfill_control',
    description: 'Control the mini-pipeline OPD backfill autopilot (all mini, ₹0). action: status | start | pause | run_day (audit one specific IST day now). Mirrors the /admin/mini-backfill switches. WRITE-CLASS: PRODUCTION-WRITE — start|pause|run_day drive the mini backfill, which writes real audit rows to opd_note_audits.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'start', 'pause', 'run_day'] },
        day: { type: 'string', description: 'YYYY-MM-DD (IST) — required for run_day.' },
        n: { type: 'number', description: 'run_day: notes to audit this call (1–3).' },
        tag: { type: 'string', description: 'run_day: engine run tag (default mini).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'corpus_add',
    description: 'Add vetted medical content to the CDMSS corpus, QUARANTINED. It is chunked and embedded on the mini (nomic, ₹0) and stored inert as source `labq:<label>` — it does NOT affect production retrieval until you call corpus_activate. Fully reversible. WRITE-CLASS: lab-write (quarantined corpus rows; inert until activated).',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Batch label → source labq:<label>.' },
        book: { type: 'string', description: 'Work/title (dedup is per book+text).' },
        text: { type: 'string', description: 'The content to ingest.' },
        chapter: { type: 'string' }, section: { type: 'string' },
        chunk_type: { type: 'string', description: "e.g. 'guideline','note','abstract' (default 'note')." },
        citation_url: { type: 'string', description: 'F13 provenance — source URL.' },
        citation_doi: { type: 'string', description: 'F13 provenance — DOI.' },
        citation_pmid: { type: 'string', description: 'F13 provenance — PubMed ID.' },
        source_release_year: { type: 'number', description: 'F13 provenance — publication/release year (REQUIRED unless internal-protocol).' },
        license_status: { type: 'string', enum: ['open', 'permission-granted', 'proprietary-cited', 'unknown-blocked'], description: 'F13 provenance — REQUIRED unless internal-protocol. All 44 external society statements are NULL today; that is the real copyright exposure.' },
        provenance: { type: 'string', description: "F13 — set to 'internal-protocol' for Even's own protocol content, which needs no external citation. Any other value still requires a citation." },
      },
      required: ['label', 'book', 'text'],
    },
  },
  {
    name: 'corpus_manage',
    description: 'Manage lab corpus batches. action: list (all lab batches + status) | activate (labq:<label> → live in production retrieval) | delete (remove a batch). ACTIVATE affects the real clinical tool — use deliberately. WRITE-CLASS: PRODUCTION-WRITE for action=activate (puts a batch into live production retrieval); lab-write for delete; read-only for list.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'activate', 'delete'] },
        label: { type: 'string' },
        which: { type: 'string', enum: ['quarantined', 'active', 'both'], description: 'delete scope (default both).' },
        confirm: { type: 'boolean', description: 'REQUIRED and must be true for action=activate — activation is a PRODUCTION WRITE that puts the batch into live clinical retrieval. Ignored for list/delete.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'lab_retrieve',
    description: 'MEASUREMENT SEAM (read-only): run the REAL production retrieve() at served-k through the shipped path (query expansion → nomic embed → vector + BM25 legs → RRF fusion → cross-encoder rerank → source-quality weighting) and return the served hits WITH FULL TEXT and per-stage scores. Diagnoses what retrieval actually serves for a clinical question: which chunks, from which sources, at what vector_rank/bm25_rank/rrf_score/rerank_score/source_quality_weight. useReranker + useSourceWeights default TRUE (every production caller sets them true). multiQuery=true routes through retrieveMultiQuery (the condition Ask/DDx run — variant fan-out fused by RRF, then one rerank over the union) and adds variant_ranks per hit; default false. skipExpand=true holds the query fixed so multi- vs single-query arms are identical. includeQuarantined names ONE quarantined batch (e.g. guidelines-lvc-22jul) to fold in for A/B measurement — that batch ONLY, bound + slugged, never widened; omit it for the exact production condition. topK clamped ≤ 20 (measurement scope, not a bulk export). NB: returns licensed corpus text — do not paste into public docs. No model generation. WRITE-CLASS: read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The clinical question, exactly as served (required).' },
        topK: { type: 'number', description: 'Hits to return (default 8 = served k; max 20).' },
        includeQuarantined: { type: 'string', description: "One quarantined batch label to fold in (e.g. 'guidelines-lvc-22jul'). Omit for the exact production condition." },
        useReranker: { type: 'boolean', description: 'Cross-encoder rerank (default true).' },
        useSourceWeights: { type: 'boolean', description: 'Source-quality weighting (default true).' },
        hybrid: { type: 'boolean', description: 'Run the BM25 leg alongside vector (default true).' },
        multiQuery: { type: 'boolean', description: 'Route through retrieveMultiQuery — the multi-variant fusion Ask/DDx run (default false).' },
        skipExpand: { type: 'boolean', description: 'Skip query expansion so single- vs multi-query arms are held identical (default false).' },
        bm25Mode: { type: 'string', enum: ['off', 'discriminating'], description: "BM25 leg mode (default 'off' = today's plainto-AND). 'discriminating' keeps only low-DF (rare) lexemes, OR-joins them, caps the scan — the R-2 measurement leg. Lab-only; production is always 'off'." },
        dfMax: { type: 'number', description: `Discriminating mode only: keep lexemes whose corpus document frequency (planner estimate) is ≤ this (default ${BM25_DEFAULT_DFMAX}). Sweep it for the Stage-2 A/B.` },
        rerankBackend: { type: 'string', enum: ['default', 'judge', 'cohere'], description: "Rerank backend for this call. 'default' (or omitted) = production default (env-driven, 'judge'). 'judge' = the LLM judge. 'cohere' = the DETERMINISTIC OpenRouter Cohere rerank-v3.5 ruler — health-probed for discrimination first, and errors loud (typed) if unreachable/missing/unhealthy, never falls back. Lab-only; production reranker is unchanged." },
        scoresOnly: { type: 'boolean', description: 'When true, trim each hit to ids + scores (no chunk text, no variant query bodies) — the context-cheap payload for the Stage-2 A/B. Keeps expandedQuery + meta. Default false.' },
        restrictSources: { type: 'array', items: { type: 'string' }, description: "Restrict BOTH retrieval legs to source = ANY(these) — a dedicated normative-source leg (e.g. ['choosing-wisely','labq:guidelines-lvc-22jul']). A NAMED labq: source is admitted through the quarantine guard; un-named ones stay excluded. Omitted/empty ⇒ unrestricted. Lab-only." },
        useNormativeLeg: { type: 'boolean', description: "R-11: add a THIRD vector leg restricted to the normative sources (default ['choosing-wisely']), unioned into the RRF pool so a terse normative statement earns a pool seat instead of being outranked. Off by default. This is the production leg's behaviour — measure it here before/after." },
        normativeSources: { type: 'array', items: { type: 'string' }, description: "Source allowlist for the normative leg (default ['choosing-wisely']; the lab may name a labq:/lab: source to measure it). N_norm from env NORMATIVE_LEG_K (default 5)." },
      },
      required: ['query'],
    },
  },
  {
    name: 'lab_ddx',
    description: 'Runs the REAL /api/ddx differential-diagnosis pipeline end-to-end (retrieval → hypothesis-first → draft → self-critique → revise → demographic guard) on the LOCAL Mac-mini (Qwen, ₹0), storing the full result in lab_analyses. Tests the ACTUAL production route — for pipeline bugs: missing cannot-miss dx, demographic leaks, anchoring, citation/parse failures. cc required. TIMING: ~2–5 min on the mini, which is longer than the MCP client waits (~180s) — so THIS CALL WILL LIKELY TIME OUT, but the run still completes + stores server-side. A `pending` row appears within ~1s and flips to done. After a timeout, POLL `lab_query experiment=<your-experiment>` (newest first) or `id=<run_id>` for output.status pending→done. Run ONE clinical probe at a time (single Mac-mini). Store many under one `experiment` and mine with audit_query / lab_query. NB: THE LOCAL MAC-MINI PATH is a cheaper brain than production Gemini/Vertex — results from it are reliable for pipeline/parse/retrieval bugs and are INDICATIVE, NOT FINAL, for clinical-quality claims. The caveat attaches to that path. This tool has NO model-routing argument (see F11, LAB-MCP Phase 2). WRITE-CLASS: lab-write (lab_analyses only).',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: "F11 provider routing. OMIT for the local Mac-mini (₹0, today's behaviour, unchanged). Prefixes: ollama:<name> | openrouter:<id> | vertex:<id>; unprefixed ⇒ the mini. An unknown prefix ERRORS — it never silently falls back. PAID runs (openrouter/vertex) count against a per-experiment ceiling, default 250." },
        ceiling: { type: 'number', description: 'Per-experiment cap on PAID (non-ollama) runs, default 250. Exceeding it STOPS and reports; raise it only by passing this explicitly.' },
        experiment: { type: 'string', description: 'Experiment label to file this under.' },
        cc: { type: 'string', description: 'Chief complaint (required).' },
        age: { type: 'string', description: 'Patient age, e.g. "54" or "3 months".' },
        sex: { type: 'string', description: 'Patient sex (M/F/…), used as a hard demographic constraint.' },
        history: { type: 'string' }, exam: { type: 'string' }, vitals: { type: 'string' },
        investigations: { type: 'string', description: 'Free-text investigation results, if any.' },
      },
      required: ['experiment', 'cc'],
    },
  },
  {
    name: 'lab_ask',
    description: 'Runs the REAL /api/ask RAG pipeline (retrieve → draft → audit → revise → cite-or-label) on the LOCAL Mac-mini (Qwen, ₹0), storing the answer + citations in lab_analyses. Tests the actual Ask route — grounding bugs: uncited claims (output.uncited), dead/absent citations, retrieval whiffs. TIMING: ~2–5 min > the MCP client wait (~180s), so THIS CALL WILL LIKELY TIME OUT but the run completes + stores; a `pending` row appears within ~1s. After a timeout, POLL `lab_query experiment=<your-experiment>` or `id=<run_id>` for output.status pending→done. ONE probe at a time. Store many under one `experiment` and mine with audit_query / lab_query. WRITE-CLASS: lab-write (lab_analyses only).',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: "F11 provider routing. OMIT for the local Mac-mini (₹0, today's behaviour, unchanged). Prefixes: ollama:<name> | openrouter:<id> | vertex:<id>; unprefixed ⇒ the mini. An unknown prefix ERRORS — it never silently falls back. PAID runs (openrouter/vertex) count against a per-experiment ceiling, default 250." },
        ceiling: { type: 'number', description: 'Per-experiment cap on PAID (non-ollama) runs, default 250. Exceeding it STOPS and reports; raise it only by passing this explicitly.' },
        experiment: { type: 'string', description: 'Experiment label to file this under.' },
        question: { type: 'string', description: 'The clinical question (required).' },
        investigations: { type: 'string', description: 'Optional investigation results to fold in.' },
      },
      required: ['experiment', 'question'],
    },
  },
  {
    name: 'lab_appropriateness',
    description: 'Runs the REAL /api/appropriateness Right-Care order-check (Choosing-Wisely low-value-care matcher + LLM applicability judge + value analysis) on the LOCAL Mac-mini (Qwen, ₹0). Stores which CW statements FIRED per scenario in lab_analyses — the surface for the known ~74% over-flag: build a specificity set of clearly-appropriate scenarios and mine how often a flag fires when it should not (output.n_flags / output.flag_statements). TIMING: ~2–5 min > the MCP client wait (~180s), so THIS CALL WILL LIKELY TIME OUT but the run completes + stores; a `pending` row appears within ~1s. After a timeout, POLL `lab_query experiment=<your-experiment>` or `id=<run_id>` for output.status pending→done. ONE probe at a time. scenario required; optionally proposedActions (the specific orders), age, sex. WRITE-CLASS: lab-write (lab_analyses only). ⚠️ NO `model` PARAMETER: this probe drives a route that has not been wired for F11 provider routing, so it runs on the LOCAL MAC-MINI only. Provider routing is unavailable here — do not infer coverage from lab_ask/lab_ddx/mini_analyze having it.',
    inputSchema: {
      type: 'object',
      properties: {
        experiment: { type: 'string', description: 'Experiment label to file this under.' },
        scenario: { type: 'string', description: 'The clinical scenario / presentation (required).' },
        proposedActions: { type: 'array', items: { type: 'string' }, description: 'Specific orders/tests to check (skips the extraction pass).' },
        age: { type: 'string' }, sex: { type: 'string' },
      },
      required: ['experiment', 'scenario'],
    },
  },
  {
    name: 'lab_pathway',
    description: 'Runs the REAL /api/pathway/skeleton care-pathway pass (stage classification + ordered care-path spine) on the LOCAL Mac-mini (Qwen, ₹0), storing the skeleton in lab_analyses. For router coverage / stage-detection bugs / dead branches. TIMING: a single fast pass — usually returns INLINE within the client wait (result in the response). If it does time out, a `pending` row is stored — poll `lab_query experiment=<your-experiment>` or `id=<run_id>`. ONE probe at a time. scenario required; optionally proposedActions, age, sex. WRITE-CLASS: lab-write (lab_analyses only). ⚠️ NO `model` PARAMETER: this probe drives a route that has not been wired for F11 provider routing, so it runs on the LOCAL MAC-MINI only. Provider routing is unavailable here — do not infer coverage from lab_ask/lab_ddx/mini_analyze having it.',
    inputSchema: {
      type: 'object',
      properties: {
        experiment: { type: 'string', description: 'Experiment label to file this under.' },
        scenario: { type: 'string', description: 'The clinical scenario (required).' },
        proposedActions: { type: 'array', items: { type: 'string' } },
        age: { type: 'string' }, sex: { type: 'string' },
      },
      required: ['experiment', 'scenario'],
    },
  },
  {
    name: 'lab_case_audit',
    description: 'Runs the REAL /api/doc-audit/analyze case-audit + prognosis on the LOCAL Mac-mini (Qwen, ₹0), storing the scored report in lab_analyses. TEXT-ONLY: pass an already-EXTRACTED case (the PDF→OCR extract leg is multimodal Vertex and cannot run on the free mini). `extracted` = an object with docType + case fields (diagnosis, procedure, indication, courseSummary, medications[], investigations[], treatments[], disposition, followUp, patient{age,sex}). For bugs in the appropriateness/foreseeability reasoning independent of OCR. TIMING: ~2–5 min > the MCP client wait (~180s), so THIS CALL WILL LIKELY TIME OUT but the run completes + stores; a `pending` row appears within ~1s. After a timeout, POLL `lab_query experiment=<your-experiment>` or `id=<run_id>` for output.status pending→done. ONE probe at a time. WRITE-CLASS: lab-write (lab_analyses only). ⚠️ NO `model` PARAMETER: this probe drives a route that has not been wired for F11 provider routing, so it runs on the LOCAL MAC-MINI only. Provider routing is unavailable here — do not infer coverage from lab_ask/lab_ddx/mini_analyze having it.',
    inputSchema: {
      type: 'object',
      properties: {
        experiment: { type: 'string', description: 'Experiment label to file this under.' },
        extracted: { type: 'object', description: 'An already-extracted case (ExtractedCase shape). At least one of diagnosis/procedure/courseSummary/medications/investigations must be present.' },
      },
      required: ['experiment', 'extracted'],
    },
  },
  {
    name: 'lab_query',
    description: 'Inspect the experimental lab + POLL async clinical probes (lab_ddx/lab_ask/lab_appropriateness/lab_pathway/lab_case_audit): fetch one run by id (its output.status is pending → done → error; done rows carry the full result), list runs in one experiment (experiment=…), list experiments (no args), or storage stats (stats=true). args: experiment? | id? | stats? WRITE-CLASS: read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        experiment: { type: 'string' }, id: { type: 'string' },
        stats: { type: 'boolean' }, limit: { type: 'number' },
      },
    },
  },
  {
    name: 'audit_query',
    description:
      'Run a READ-ONLY SQL query (SELECT/WITH only) against the CDMSS audit database (Neon) — for mining bug prevalence + building golden sets. Readable tables are DE-IDENTIFIED (no PHI): opd_note_audits (per-note audit: uid, doctor_uid, note_date, note_quality_index, band, score_documentation/note_quality/appropriateness/prescribing_safety/patient_centred, pdqi9 jsonb [{attr,value}], completeness_pct, n_missing_mandatory, n_findings, n_low_value, n_interaction_alerts, findings jsonb [{subject,verdict,domain,source,informational,signal_type,finding_ref,citation_ids,rule_ref,lvc_category}] (lvc_category on low-value findings ∈ antibiotic|imaging|supplement_polypharmacy|therapeutic_duplication|systemic_steroid|gi_ppi_prokinetic|antihistamine_allergy|nsaid_analgesic|cough_cold_fdc|cough_expectorant|unindicated_investigation|other — the 8 overuse sub-tags added in engine 0.81.8), suggestions jsonb, missing_fields jsonb, engine_version), plus opd_audit_triage, opd_gov_signal(_event), doctor_directory, doctor_roster, audit_suppression, doctor_operational_metrics, lvc_recommendations (reference), lab_analyses (your lab_ddx/lab_ask/mini_analyze runs — output jsonb), and the DE-IDENTIFIED pipeline views v_trace_summary (feature/status/severity/timings/model_summary — NO clinical text) + v_appropriateness_summary (mode/doc_type/counts). PHI-bearing raw tables (traces, trace_events, appropriateness_runs, ccb_briefs, care_track_assignments, opd_audit_feedback) are BLOCKED — use the views, and the feedback_* tools for opd_audit_feedback. Enforced: SELECT/WITH only, single statement, no writes/DDL/system-functions, blocked-relation guard, LIMIT ≤ 500 (auto-added), audit-logged. Source-NOTE fields (medications count, followUpType, patient age, specialty) live in db13 — take the uids this returns and join via the Metabase MCP. WRITE-CLASS: read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'A single SELECT/WITH query. Prefer aggregates + specific columns; findings/suggestions jsonb can be large.' },
        limit: { type: 'number', description: 'Row cap (default & max 500).' },
      },
      required: ['sql'],
    },
  },
  {
    name: 'lab_batch_start',
    description: 'Queue a cohort-scoped FREE-mini (qwen, INR 0) eval batch into lab_analyses (experiment-namespaced; NEVER opd_note_audits). Provide EITHER uids[] OR cohort_sql (a read-only SELECT/WITH returning a uid column). The */2 cron drains it, yielding to the prod backfill; poll lab_batch_status, nudge with lab_batch_tick, analyse with lab_query/audit_query. For model-bridge + eval sweeps at scale without firing per-note calls. WRITE-CLASS: lab-write. ⚠️ COST: model routes audit generation to a PAID Bedrock model and evalModel to a PAID OpenRouter one; omitting both runs the local Mac-mini. 87.8% of stored lab volume (4,041 of 4,604 runs) has been paid OpenRouter Gemini, so "the lab is free" is false for this tool — check model AND evalModel before starting a batch.',
    inputSchema: {
      type: 'object',
      properties: {
        experiment: { type: 'string', description: 'label to file runs under (a-z0-9_-).' },
        uids: { type: 'array', items: { type: 'string' }, description: 'cohort of db13 OPD note uids (<=2000).' },
        cohort_sql: { type: 'string', description: 'alternative to uids[]: a read-only SELECT/WITH returning a uid column.' },
        n: { type: 'number', description: 'notes per tick (1-2; default 2).' },
        model: { type: 'string', description: "S2b — grade this cohort on a PAID Bedrock model instead of the Mac-mini, e.g. 'bedrock:global.anthropic.claude-haiku-4-5-20251001-v1:0'. Resolved through the F11 resolver and reachability-checked at start; errors loud, never falls back. Each note is traced, its attribution VERIFIED against that trace (a mismatch refuses the note and writes no row) and its cost priced per note. Mutually exclusive with evalModel. Absent ⇒ the free mini, unchanged. Still writes lab_analyses ONLY." },
        window: { type: 'string', enum: ['night', 'always'], description: "'always' drains all day; default 'night' (00-05 IST). A bedrock batch does not touch the Mac-mini, so 'always' is the usual choice for it." },
        kind: { type: 'string', description: 'reserved; default opd.' },
        evalNormativeLeg: { type: 'boolean', description: 'R-11 Phase-2 eval: force the normative retrieval leg ON for every note in this batch (default false ⇒ today\'s gate). Lab-only; writes lab_analyses only.' },
        evalModel: { type: 'string', description: 'R-11 Phase-2 eval: route audit generation to this OpenRouter model id (e.g. google/gemini-3.1-flash-lite) at temperature 0. Absent ⇒ free mini. Needs OPENROUTER_API_KEY in env. Eval batches drain concurrently (50/tick, pool below) and skip the mini-yield; mini batches stay n≤2 serial.' },
        evalConcurrency: { type: 'number', description: 'Eval batches only: audits in flight per tick (default 10, max 25 — OpenRouter rate-limit safety). Ignored for mini batches.' },
        evalNormativeChannel: { type: 'boolean', description: 'R-11 fix candidate: ADDITIVE normative channel — the 8 literature excerpts stay byte-identical and CW statements are appended as a separate citable [9+] block (no eviction). Independent of evalNormativeLeg (the harmful union). Default false.' },
        evalRerankBackend: { type: 'string', enum: ['judge', 'cohere'], description: "Rerank-flip A/B (Addendum C): run every audit in this batch with the named rerank backend. 'cohere' is the deterministic cross-encoder, STRICT — health-probed, typed errors fail the note rather than silently filling the arm with judge results (measurement honesty). Absent ⇒ today's retrieval path exactly. Lab-only: writes lab_analyses only; the production reranker is untouched. Resolved backend is stamped into each row's eval provenance." },
      },
      required: ['experiment'],
    },
  },
  {
    name: 'lab_batch_status',
    description: 'Progress of the active lab eval batch: done/total/remaining, enabled, window, last error, last tick summary. WRITE-CLASS: read-only.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'lab_batch_stop',
    description: 'Pause the lab eval batch (state kept; lab_batch_start resumes/re-arms). WRITE-CLASS: lab-write (batch control settings).',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'lab_batch_tick',
    description: 'Synchronously drain up to n (<=2) cohort notes NOW and return - a manual nudge that ignores the night window (still yields to the prod mini-backfill + its own lock). Use for immediate progress instead of waiting for the */2 cron. ~72s/note on the mini. WRITE-CLASS: lab-write (drains a lab batch).',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'lab_source',
    description: 'F12b — READ-ONLY code seam: return the text of one repository source file so the orchestrator reads the code it is reasoning about instead of inferring it. Allowlist: paths under lib/ and app/api/ ONLY. A secrets denylist (.env, secret, credential, key, token) is applied AFTER the allowlist, so a secret is unreadable wherever it sits. Any path containing ".." is refused before resolution — traversal is impossible. Every call is audit-logged to lab_sql_audit, the same table audit_query uses. There is no write path of any kind. WRITE-CLASS: read-only.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Repo-relative path, e.g. lib/mcp-tools.ts or app/api/care/concept/status/route.ts.' } },
      required: ['path'],
    },
  },
  {
    name: 'corpus_add_batch',
    description: 'F13 — add MANY vetted chunks in one call, each with its own provenance. Same validation as corpus_add applied per element; if ANY element fails the WHOLE batch is rejected and the failing index is named, so a partial ingest can never leave half a batch quarantined with no provenance. All chunks land QUARANTINED (labq:<label>) and are inert until corpus_manage action=activate confirm:true. WRITE-CLASS: lab-write (quarantined; inert until activated).',
    inputSchema: {
      type: 'object',
      properties: {
        chunks: { type: 'array', description: 'Array of corpus_add-shaped objects (label, book, text + the F13 provenance fields).', items: { type: 'object' } },
      },
      required: ['chunks'],
    },
  },
  {
    name: 'lvc_propose',
    description: "F14 — propose a low-value-care statement into the STAGING table (lvc_recommendation_proposals). lvc_recommendations is NEVER written by this tool. REFUSES an uncited proposal (needs citation_url OR citation_doi OR citation_pmid, AND source_release_year, AND license_status), and REFUSES a near-duplicate of any existing statement or pending proposal unless supersedes_id is supplied — the existing 60 house statements are ~15 concepts in machine-generated variants (11 diagnosis-mismatch, 5 vitamin D, 5 antibiotic-for-viral), and without this check the tool regenerates exactly that. WRITE-CLASS: lab-write (staging only).",
    inputSchema: {
      type: 'object',
      properties: {
        statement: { type: 'string', description: 'The proposed statement.' },
        rationale: { type: 'string' }, evidence_note: { type: 'string' },
        proposed_by: { type: 'string', description: 'Who is proposing this.' },
        supersedes_id: { type: 'string', description: 'REQUIRED to push a near-duplicate through — names the statement this replaces.' },
        citation_url: { type: 'string' }, citation_doi: { type: 'string' }, citation_pmid: { type: 'string' },
        source_release_year: { type: 'number' },
        license_status: { type: 'string', enum: ['open', 'permission-granted', 'proprietary-cited', 'unknown-blocked'] },
      },
      required: ['statement'],
    },
  },
  {
    name: 'lvc_ratify',
    description: "F14 — PROMOTE-ONLY ratification of an existing 'proposed' row, or a first-class rejection. It can NEVER create a statement de novo. Requires confirm:true AND a named ratified_by (the 'cowork-orchestrator' default is REFUSED — the Lab MCP has no user identity, so a ratification must name a real person) AND a rationale. Writes an append-only lvc_ratifications row. Rejection (decision='rejected' + reason) sets status='rejected' and is never a delete. WRITE-CLASS: PRODUCTION-WRITE on ratify — a ratified statement is promoted into the live rulebook.",
    inputSchema: {
      type: 'object',
      properties: {
        proposal_id: { type: 'string', description: 'The staging row to act on (required).' },
        confirm: { type: 'boolean', description: 'Must be true.' },
        ratified_by: { type: 'string', description: 'Named clinician. Must not be the default author.' },
        rationale: { type: 'string' },
        decision: { type: 'string', enum: ['ratified', 'rejected'], description: "Default 'ratified'." },
        reason: { type: 'string', description: 'Required when decision=rejected.' },
      },
      required: ['proposal_id', 'confirm', 'ratified_by', 'rationale'],
    },
  },
  {
    name: 'lvc_gaps',
    description: 'F14 — the rulebook evidence gap list, RANKED BY FIRES (opd_note_audits.findings[].rule_ref joined to lvc_recommendations.id) and classified: license_exposure first (all 44 external society statements carry license_status NULL today — that is the actual copyright exposure, and it sits on the CITED half), then citation_candidate, then retirement_candidate. A NEVER-FIRED rule is a RETIREMENT candidate, not a citation candidate: 33 of 67 house statements have never fired in the 0.81.x era, so citing them is effort with no clinical reach. WRITE-CLASS: read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max rows (default 50).' },
        gap_class: { type: 'string', enum: ['license_exposure', 'citation_candidate', 'retirement_candidate', 'ok'], description: 'Filter to one class.' },
      },
    },
  },
  {
    name: 'feedback_rollup',
    description: 'OPD feedback loop — MEASURED precision from clinician triage of audit findings (opd_audit_feedback), the read path for the feedback instrumentation. Current-state = latest verdict per (audit_id, finding_ref) (earlier rows are history). Returns per (engine_version × signal_type) bucket: fired (findings that fired in opd_note_audits), triaged, coverage_pct = triaged/fired, verdict counts (tp/nitpick/false/contested), precision_strict = tp/(tp+nitpick+false) with contested EXCLUDED (a demand-side dispute, reported separately as contested_rate); plus missed-flag volume by signal_type, audit_scope { n_comments, verdict_counts, n_escalations }, reviewer tally, open_adjudications (clusters with ≥3 false+nitpick and no current non-defer ledger decision), and totals. Zero denominators → null (never NaN). Read-only, fixed parameterized SQL (NOT free SQL — opd_audit_feedback stays blocked from audit_query). Args: engine_version? (default all, grouped), signal_type?, since?/until? (ISO dates on feedback created_at), study? (labelling study — omitted reads production rows ONLY: study IS NULL, NULL-matches-NULL; §8). WRITE-CLASS: read-only (ensures the ledger table exists; writes no rows).',
    inputSchema: {
      type: 'object',
      properties: {
        engine_version: { type: 'string', description: 'Filter to one engine version (default: all, grouped).' },
        signal_type: { type: 'string', description: 'Filter to one signal_type.' },
        since: { type: 'string', description: 'ISO date — feedback created_at ≥ this day.' },
        until: { type: 'string', description: 'ISO date — feedback created_at ≤ this day (inclusive).' },
        study: { type: 'string', description: "Labelling study to read (§8). OMITTED = production rows only (study IS NULL) — the predicate is always applied with NULL matching NULL, so study rows never contaminate a production rollup and vice versa. Pass the study name to roll up that study's rows instead." },
        min_triaged: { type: 'number', description: 'Output filter (default 1): omit buckets with fewer than this many triaged findings. Zero-triaged buckets are still counted in totals as n_buckets_untriaged / fired_untriaged. TOTALS ARE UNAFFECTED — this filters the emitted bucket list only.' },
        mode: { type: 'string', enum: ['summary', 'full'], description: "Output size (default 'summary'). summary = totals + the top 20 buckets by fired + EVERY bucket with triaged >= 5. full = every bucket that passes min_triaged. Either way a 20000-character ceiling applies: if exceeded, buckets are trimmed from the tail and truncated:true + n_buckets_omitted are set. Semantics never change." },
      },
    },
  },
  {
    name: 'feedback_detail',
    description: 'OPD feedback loop — the adjudication feed: individual current-state feedback rows joined to the fired finding (subject/verdict/domain/rationale, located in opd_note_audits.findings by finding_ref; null for missed/audit scope or if the ref no longer resolves, with ref_resolved=false). ⚠️ Returns clinician free-text comments verbatim — treat as potentially containing clinical details; do not paste into public docs. Read-only, fixed parameterized SQL (opd_audit_feedback stays blocked from audit_query). Args: scope? (finding|missed|audit|impact, default finding), verdict?, signal_type?, engine_version?, uid?, history? (default false = current-state only; true also returns superseded rows flagged history=true), study? (labelling study — omitted reads production rows ONLY; §8), limit? (default 50, max 200). WRITE-CLASS: read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: [...DETAIL_SCOPES], description: "default finding. ('impact' admitted per F17 — the live schema previously showed three scopes while the code accepted four; reconciled §8.)" },
        verdict: { type: 'string', description: 'Filter by verdict (whitelisted per scope).' },
        signal_type: { type: 'string' },
        engine_version: { type: 'string' },
        uid: { type: 'string', description: 'db13 note uid.' },
        history: { type: 'boolean', description: 'default false (current-state only).' },
        study: { type: 'string', description: "Labelling study to read (§8). OMITTED = production rows only (study IS NULL); the predicate is always applied, NULL matching NULL." },
        limit: { type: 'number', description: 'default 50, max 200.' },
      },
    },
  },
  {
    name: 'feedback_adjudicate',
    description: 'OPD feedback loop — append-only adjudication ledger (opd_feedback_adjudications). The ONLY write tool here; it touches ONLY the ledger table, never opd_audit_feedback or any production table (the Lab MCP no-production-writes promise holds — the ledger is lab infrastructure). action=log records one cluster decision; action=list returns decisions newest-first, flagging the current status per cluster_key. decision ∈ fix (engine change owed) | suppress (down-tier/silence the check) | accept (noise tolerable, working as intended) | defer (need more labels) | monitor (no action now, keep watching). cluster_key convention <signal_type>@<engine_version> (or a bug id like 0.8-17). Table is ensured at call time (CREATE TABLE IF NOT EXISTS). WRITE-CLASS: lab-write (appends to the opd_feedback_adjudications ledger). NOT the only write tool here — see each tool\u2019s WRITE-CLASS line.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['log', 'list'] },
        cluster_key: { type: 'string', description: 'log: required; list: optional filter.' },
        decision: { type: 'string', enum: ['fix', 'suppress', 'accept', 'defer', 'monitor'], description: 'log: required.' },
        rationale: { type: 'string', description: 'log: required.' },
        prd_ref: { type: 'string', description: 'log: optional PRD/bug reference.' },
        author: { type: 'string', description: 'log: default cowork-orchestrator.' },
        limit: { type: 'number', description: 'list: default 50, max 200.' },
      },
      required: ['action'],
    },
  },
] as const;

// ── dispatch ─────────────────────────────────────────────────────────────────────
/**
 * ⚠️ THE CONTEXT COMES IN, IT IS NOT MADE HERE (D11). `dispatchMcp(body)` used to take only the
 * body, so the two MCP routes had no way to say which invocation a tool call belonged to. It is
 * optional because every non-retrieving tool ignores it, and because the MCP surface has callers
 * (tests, the lab) that legitimately have no request.
 */
export async function callLabTool(name: string, args: Record<string, unknown>, ctx?: TelemetryRequestContext): Promise<ToolResult> {
  try {
    switch (name) {
      case 'mini_analyze': return await miniAnalyze(args, ctx);
      case 'lab_ddx': return await labDdx(args);
      case 'lab_ask': return await labAsk(args);
      case 'lab_appropriateness': return await labAppropriateness(args);
      case 'lab_pathway': return await labPathway(args);
      case 'lab_case_audit': return await labCaseAudit(args);
      case 'backfill_control': return await backfillControl(args, ctx);
      case 'corpus_add': return await corpusAdd(args);
      case 'corpus_manage': return await corpusManage(args);
      case 'corpus_add_batch': return await corpusAddBatch(args);
      case 'lab_source': return await labSource(args);
      case 'lvc_propose': return await lvcPropose(args);
      case 'lvc_ratify': return await lvcRatify(args);
      case 'lvc_gaps': return await lvcGaps(args);
      case 'lab_retrieve': return await labRetrieve(args, ctx);
      case 'lab_query': return await labQuery(args);
      case 'audit_query': return await auditQuery(args);
      case 'lab_batch_start': return await labBatchStart(args);
      case 'lab_batch_status': return await labBatchStatus();
      case 'lab_batch_stop': return await labBatchStop();
      case 'lab_batch_tick': return await labBatchTick();
      case 'feedback_rollup': return await feedbackRollup(args);
      case 'feedback_detail': return await feedbackDetail(args);
      case 'feedback_adjudicate': return await feedbackAdjudicate(args);
      default: return err(`unknown tool: ${name}`);
    }
  } catch (e) {
    return err(String((e as Error).message));
  }
}

async function miniAnalyze(a: Record<string, unknown>, ctx?: TelemetryRequestContext): Promise<ToolResult> {
  await ensureLabTables();
  const experiment = labLabel(a.experiment);
  const uid = S(a.metabase_uid).trim();
  const text = S(a.text).trim();
  const started = Date.now();

  // F11 — mini_analyze routes through the EXISTING evalModel seam (auditOpdNote), which is why it
  // can honour a model today while the three unwired-route probes cannot. evalModel is OpenRouter-
  // only, so a vertex: request is refused here rather than silently downgraded.
  const M = await resolveProbeModel(a, experiment);
  if (!M.ok) return err(M.error);
  // ⚠️ THE REFUSAL COVERS EVERY NON-OPENROUTER PAID PROVIDER, NOT JUST VERTEX (Bedrock S1, 7 Aug
  // 2026). It used to name vertex alone, and the consequence was live: `bedrock:<id>` passed this
  // check, resolved paid, then fell through to `evalModel = undefined` — so the audit ran on the
  // LOCAL MINI while saveLabAnalysis stamped the row provider='bedrock' with a Bedrock model
  // string. An unattributable row is the whole defect class F11 exists to stop, and this one was
  // reachable before this build (nothing here consults probeReachable). Refuse, never
  // accept-and-ignore: the seam is OpenRouter-only until someone widens `defaultGenerate`.
  if (M.provider !== 'ollama' && M.provider !== 'openrouter') {
    return err(`mini_analyze routes via the evalModel seam, which is OpenRouter-only — '${M.provider}:' cannot serve it. Use openrouter:<id>, or omit model for the local mini.`);
  }
  const evalModel = M.provider === 'openrouter' ? M.model : undefined;

  if (uid) {
    const row = await fetchOpdNoteByUid(uid);
    if (!row) return err(`no db13 OPD note for uid ${uid}`);
    // ⚠️ THIS TOOL WRITES `lab_analyses` AND NOTHING ELSE (D9), so `no_persistence_intended` is the
    // honest settlement — and `trace: false` is why `trace_id` stays null on these rows from
    // declaration all the way through the terminal write.
    let handle: LifecycleHandle | null = null;
    let published = false;
    const audit = await auditOpdNote(row, {
      pipeline: 'mini', engineTag: 'lab', trace: false, ...(evalModel ? { evalModel } : {}),
      ...(ctx ? {
        telemetry: { ctx, route: 'mcp_tools' as const, persistenceIntent: 'never_persists' as const },
        onLifecycleHandleUpdated: (h: LifecycleHandle) => { handle = h; published = true; },
      } : {}),
    });
    void published;
    const output = { index: audit.scorecard.headline, band: audit.scorecard.band, scorecard: audit.scorecard, completeness: audit.completeness, findings: audit.findings, suggestions: audit.suggestions };
    const id = await saveLabAnalysis({ experiment, kind: 'opd_note', engine: audit.engineVersion, inputRef: uid, inputPreview: `uid ${uid}`, output, model: M.model, provider: M.provider, latencyMs: Date.now() - started });
    await settleOwned(handle, 'no_persistence_intended');
    return ok({ stored_id: id, experiment, kind: 'opd_note', engine: audit.engineVersion, index: audit.scorecard.headline, band: audit.scorecard.band, findings: audit.findings.length });
  }

  if (text) {
    // F11: text mode is hardwired to the local mini (no evalModel seam, no gemini/openrouter opts),
    // so it CANNOT honour a model. Refuse rather than accept-and-ignore — silently discarding the
    // argument would stamp a row 'mini' while the caller believed otherwise, which is the exact
    // defect this build is fixing.
    if (M.provider !== 'ollama') {
      return err('mini_analyze text mode runs on the local mini only and cannot honour a model — omit `model`, or use metabase_uid mode with openrouter:<id>');
    }
    // Text mode: run the OPD audit SYSTEM prompt on the mini over the pasted note (no retrieval
    // grounding — this is an experimental raw pass; structured uid mode is the grounded one).
    // Governed envelope (Stage 4): traceless + no gemini → byte-identical local call.
    const r = await governedChat(undefined, 'mcp_mini_analyze', {
      model: MINI_MODEL,
      messages: [{ role: 'system', content: OPD_AUDIT_SYSTEM }, { role: 'user', content: buildOpdAuditUser(text, '(no corpus excerpts — experimental raw pass)') }],
      temperature: 0.2, max_tokens: 2200,
      ...({ options: { num_ctx: 8192 }, keep_alive: '15m' } as Record<string, unknown>),
    }, { promptRef: 'opd-note-audit-core/OPD_AUDIT_SYSTEM' });
    const raw = r.choices?.[0]?.message?.content || '';
    const output = { raw, note: 'text mode = ungrounded raw mini pass; use metabase_uid for the full grounded audit' };
    const id = await saveLabAnalysis({ experiment, kind: 'text', engine: `${opdMiniEngine('lab')}-textraw`, inputRef: null, inputPreview: text.slice(0, 300), output, model: MINI_MODEL, provider: 'ollama', latencyMs: Date.now() - started });
    return ok({ stored_id: id, experiment, kind: 'text', chars: raw.length, model: MINI_MODEL, provider: 'ollama' });
  }

  return err('provide metabase_uid or text');
}

/** Self-fetch one of the app's own streaming clinical routes, forcing the FREE mini, and
 *  return the raw NDJSON body. Routes are public (clinician app) → no auth header needed.
 *
 *  F11 (A12): `extraHeaders` was added so this path can carry the lab-origin marker
 *  (x-cdmss-lab-origin) that gate condition 2 requires. Before this the headers were hardcoded to
 *  content-type alone, so condition 2 was unsatisfiable and no override could ever fire. Omitted ⇒
 *  byte-identical to the previous behaviour. */
async function selfPostNdjson(path: string, body: Record<string, unknown>, extraHeaders?: Record<string, string>): Promise<string> {
  const base = labSelfBaseUrl(process.env as Record<string, string | undefined>);
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(extraHeaders ?? {}) },
    body: JSON.stringify({ ...body, providerOverride: 'ollama' }),
  });
  if (!res.ok && res.status >= 400) {
    const t = await res.text().catch(() => '');
    throw new Error(`${path} → HTTP ${res.status} ${t.slice(0, 200)}`);
  }
  return await res.text();   // waits for the whole NDJSON stream to finish
}

/**
 * Lab clinical probe runner. The real pipelines take ~200–285s on the mini — under the /api/mcp
 * function's 300s cap but OVER an MCP client's ~180s wait. Key facts learned live:
 *   • The Vercel function keeps running server-side to 300s even after the client gives up at 180s,
 *     so the DB write is RELIABLE (a client timeout is cosmetic).
 *   • `after()` is NOT reliable for this — Vercel tears the callback down long before a 285s job
 *     finishes (verified: pipeline succeeded @285s but the after() row stayed 'pending'). So we run
 *     the pipeline SYNCHRONOUSLY inside the request-backed function instead.
 * Pattern: write a `pending` row FIRST (visible to a poller within ~1s), run the pipeline, then
 * update the row to done|error. Fast probes (pathway) return inline before 180s; slow ones time the
 * MCP client out but STILL complete + store — poll `lab_query experiment=<exp>` (newest first) or
 * `id=<run_id>`; output.status goes pending → done. One probe at a time (single Mac-mini).
 */
/**
 * F11 (option 3) — resolve a probe tool's `model` argument and enforce the per-experiment paid
 * ceiling. Returns the RESOLVED provider/model, or a typed refusal the caller surfaces as an error.
 *
 * OMITTED `model` ⇒ { provider: 'ollama', model: MINI_MODEL } and NO ceiling check — byte-identical
 * to today's behaviour, and a free local run must never consume paid budget.
 *
 * An unknown prefix ERRORS LOUD and never falls back to the mini: a lab row that says one model while
 * another served it is unattributable, which is exactly the defect F11 exists to fix (87.8% of stored
 * volume turned out to be paid Gemini while the tools advertised "₹0, never Gemini").
 */
/**
 * F11 — the `engine` suffix for a lab row, DERIVED from the resolved provider.
 *
 * `engine` was a hardcoded '<route>/mini' label, so a run that provably executed on Vertex was
 * stamped 'ask-route/mini' — the same defect class as opd_note_audits.model, where a hardcoded
 * literal asserts a fact nobody checked. Found live on experiment f11_vertex_proof.
 *
 * 'ollama' maps back to 'mini' deliberately: every historical row and every free run keeps its exact
 * existing label, so nothing that reads this column has to change. Only the paths that can actually
 * vary get a new value.
 */
function engineSuffix(provider: string): string {
  return provider === 'ollama' ? 'mini' : provider;
}

/**
 * F11 — the gate's lab-origin marker (condition 2) and, since 7 Aug 2026, the admin STANDING it
 * needs for condition 3. Only ever sent on the two WIRED routes, and only when a model was actually
 * requested: a probe with no override carries neither header and its request stays byte-identical.
 *
 * ⚠️ THE CREDENTIAL IS ATTACHED HERE, NOT IN selfPostNdjson, deliberately. This is the narrowest
 * point that still covers every request that needs it: `labHeaders` feeds nothing but the two
 * F11-wired self-posts, and only on the override path. The three UNWIRED probes
 * (appropriateness / pathway / case-audit) call selfPostNdjson too, and their routes never consult
 * the gate — sending them an admin credential would transmit the token for no purpose.
 *
 * ⚠️ ADMIN_TOKEN UNSET ⇒ THE HEADER IS ABSENT, not empty. Refusal stays the default for an
 * unconfigured deployment, on both sides independently (the receiver also fails closed).
 * The value is never logged here or anywhere: it appears in exactly one outgoing header.
 */
function labHeaders(a: Record<string, unknown>): Record<string, string> | undefined {
  if (!S(a.model).trim()) return undefined;
  const adminToken = process.env.ADMIN_TOKEN || '';
  return {
    [LAB_ORIGIN_HEADER]: LAB_ORIGIN_VALUE,
    'x-cdmss-lab-caller': 'lab-mcp',
    ...(adminToken && selfPostCarriesCredential() ? { [LAB_ADMIN_HEADER]: adminToken } : {}),
  };
}

/**
 * May the admin credential ride this self-post? Only over TLS, or to the loopback dev server.
 *
 * ⚠️ THE SELF-POST TARGET IS ENV-DERIVED (`labSelfBaseUrl`: LAB_SELF_BASE_URL, else VERCEL_URL,
 * else localhost). Production and preview both resolve to `https://…`, and dev to
 * `http://localhost:3000`, so this refuses nothing that exists today. What it stops is the one
 * shape that would be silently catastrophic: a misconfigured LAB_SELF_BASE_URL sending ADMIN_TOKEN
 * over plain http to a non-loopback host.
 *
 * It is NOT a full answer — a same-scheme foreign host would still receive it. LAB_SELF_BASE_URL is
 * therefore a trust-sensitive variable and is called out as such in the build report. The credential
 * simply being absent makes the override refuse (typed, silent), which is the correct failure.
 */
function selfPostCarriesCredential(): boolean {
  try {
    const u = new URL(labSelfBaseUrl(process.env as Record<string, string | undefined>));
    if (u.protocol === 'https:') return true;
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1';
  } catch { return false; }
}
/** F11 — add `labModel` ONLY when a model was asked for, so an omitted model leaves the request body
 *  byte-identical to today. The route's own gate still decides; this only carries the request. */
function labBody(base: Record<string, unknown>, a: Record<string, unknown>): Record<string, unknown> {
  const m = S(a.model).trim();
  return m ? { ...base, labModel: m } : base;
}

async function resolveProbeModel(a: Record<string, unknown>, experiment: string): Promise<
  { ok: true; provider: string; model: string; paid: boolean } | { ok: false; error: string }
> {
  const r = resolveProvider(a.model, MINI_MODEL);
  if (!r.ok) return { ok: false, error: r.error };
  if (!r.paid) return { ok: true, provider: r.provider, model: r.model, paid: false };

  const used = await countPaidRuns(experiment);
  if (used === null) {
    // The ceiling is a spend control; if its denominator cannot be read we refuse rather than run
    // ungated, the same way lvc_propose refuses when its dedup set is unreadable.
    return { ok: false, error: 'cannot read this experiment\'s paid-run count — refusing to start a PAID run ungated' };
  }
  const c = checkPaidCeiling(used, a.ceiling);
  if (!c.ok) return { ok: false, error: c.error };
  return { ok: true, provider: r.provider, model: r.model, paid: true };
}

/**
 * What the TRACE says ran, for the legs an override steers (F11 DEC-2, 7 Aug 2026).
 *
 * Reads `call_provider`/`call_model` off the envelope columns rather than the payload: the payload
 * is PHI-bearing (prompt + completion text) and these columns exist precisely so attribution can be
 * read without touching it. Falls back to the payload's two scalar fields when the 0012 envelope
 * columns are null, which is the case for any event written before that migration.
 *
 * Best-effort by construction — a lookup failure returns [] and `checkAttribution` treats an empty
 * result as "no evidence", which REFUSES a paid claim rather than passing it.
 */
async function servedCallsForTrace(traceId: string | null | undefined, legs: readonly string[]): Promise<ServedCall[]> {
  if (!traceId || !legs.length) return [];
  try {
    const rows = await run(
      `SELECT stage,
              COALESCE(call_provider, payload->>'provider') AS provider,
              COALESCE(call_model, payload->>'model')       AS model
         FROM trace_events
        WHERE trace_id = $1
          AND kind IN ('llm_response', 'llm_stream_usage')
          AND stage = ANY($2::text[])
        ORDER BY seq ASC`,
      [traceId, legs as string[]],
    );
    return rows.map((r) => ({
      stage: r.stage == null ? null : String(r.stage),
      provider: r.provider == null ? null : String(r.provider),
      model: r.model == null ? null : String(r.model),
    }));
  } catch { return []; }
}

async function runLabProbe(opts: {
  experiment: string; kind: string; engine: string; inputPreview: string; inputRef?: string | null;
  /** F11 — the RESOLVED provider/model. Omitted ⇒ the local mini, byte-identical to before. */
  provider?: string; model?: string;
  /**
   * F11 DEC-2 (7 Aug 2026) — VERIFY THE CLAIM BEFORE STORING IT.
   *
   * `feature` selects the answer legs (ANSWER_LEGS); `traceIdOf` digs the route's trace id out of
   * the probe output. Omitted ⇒ no check, for the probes whose routes are not F11-wired and cannot
   * therefore misattribute (they have no `model` parameter at all).
   */
  attribution?: { feature: keyof typeof ANSWER_LEGS; traceIdOf: (output: Record<string, unknown>) => string | null };
  run: () => Promise<{ output: Record<string, unknown>; summary: Record<string, unknown> }>;
}): Promise<ToolResult> {
  await ensureLabTables();
  const startedAt = Date.now();
  const requested = { provider: opts.provider ?? 'ollama', model: opts.model ?? MINI_MODEL };
  const runId = await saveLabAnalysis({
    experiment: opts.experiment, kind: opts.kind, engine: opts.engine, inputRef: opts.inputRef ?? null,
    inputPreview: opts.inputPreview, model: requested.model, provider: requested.provider, latencyMs: null,
    output: { status: 'pending', started_at: new Date().toISOString() },
  });
  try {
    const { output, summary } = await opts.run();

    // ══ THE ATTRIBUTION GATE ═════════════════════════════════════════════════════════════════
    // Before this existed, the row was stamped from `resolveProbeModel` — i.e. from what the
    // caller ASKED FOR. On 7 Aug that stored a Bedrock claim over an answer three qwen legs had
    // produced, silently, because the route's override gate had refused the override and a refusal
    // is (by A12 design) invisible to the caller. A resolver can only ever know the ask; only the
    // trace knows the answer.
    if (opts.attribution) {
      const traceId = opts.attribution.traceIdOf(output);
      const served = await servedCallsForTrace(traceId, ANSWER_LEGS[opts.attribution.feature] ?? []);
      const verdict = checkAttribution(requested, served, modelsAgree);
      if (!verdict.ok) {
        // The row keeps the evidence and STOPS ASSERTING THE MODEL IT CANNOT SHOW. On a mismatch
        // the columns become what served (so aggregates, the paid ceiling and lab_query all read
        // the truth); on an unprovable paid claim there is nothing truthful to name, so the
        // columns are nulled rather than left lying.
        const servedLast = verdict.served[verdict.served.length - 1];
        await correctLabAttribution(
          runId,
          attributionErrorOutput({ ...output }, requested, verdict),
          Date.now() - startedAt,
          verdict.reason === 'mismatch' ? (servedLast?.provider ?? null) : null,
          verdict.reason === 'mismatch' ? (servedLast?.model ?? null) : null,
        );
        console.error(`[lab-attribution] run_id=${runId} experiment=${opts.experiment} ${verdict.message}`);
        return err(`${opts.kind} probe REFUSED (run_id ${runId}): ${verdict.message}`);
      }
      // Verified: store what SERVED, which may differ from the request in provider only (a
      // legitimate ladder hop) and must still be recorded as the truth.
      await correctLabAttribution(
        runId,
        { status: 'done', ...output, attribution: { verified: verdict.verified, provider: verdict.provider, model: verdict.model, ...(verdict.reason ? { note: verdict.reason } : {}) } },
        Date.now() - startedAt, verdict.provider, verdict.model,
      );
      return ok({ run_id: runId, experiment: opts.experiment, kind: opts.kind, status: 'done', ...summary, provider: verdict.provider, model: verdict.model, attribution_verified: verdict.verified, ms: Date.now() - startedAt });
    }

    await updateLabAnalysis(runId, { status: 'done', ...output }, Date.now() - startedAt);
    return ok({ run_id: runId, experiment: opts.experiment, kind: opts.kind, status: 'done', ...summary, ms: Date.now() - startedAt });
  } catch (e) {
    await updateLabAnalysis(runId, { status: 'error', error: String((e as Error).message) }, Date.now() - startedAt);
    return err(`${opts.kind} probe failed (run_id ${runId}): ${String((e as Error).message)}`);
  }
}

async function labDdx(a: Record<string, unknown>): Promise<ToolResult> {
  const experiment = labLabel(a.experiment);
  const cc = S(a.cc).trim();
  if (!cc) return err('cc (chief complaint) is required');
  const presentation = {
    cc, age: S(a.age) || undefined, sex: S(a.sex) || undefined,
    history: S(a.history) || undefined, exam: S(a.exam) || undefined,
    vitals: S(a.vitals) || undefined, investigations: S(a.investigations) || undefined,
  };
  const M = await resolveProbeModel(a, experiment);
  if (!M.ok) return err(M.error);
  return runLabProbe({
    experiment, kind: 'ddx', engine: `ddx-route/${engineSuffix(M.provider)}`,
    inputPreview: [presentation.age, presentation.sex, cc].filter(Boolean).join(' / ').slice(0, 300),
    provider: M.provider, model: M.model,
    // DEC-2: the stored provider/model are settled against the trace, not against M.
    attribution: { feature: 'ddx', traceIdOf: (o) => (typeof o.trace_id === 'string' ? o.trace_id : null) },
    run: async () => {
      const probe = reduceDdxEvents(parseNdjson(await selfPostNdjson('/api/ddx', labBody(presentation, a), labHeaders(a))));
      return { output: { presentation, ...probe }, summary: { ok: probe.ok } };
    },
  });
}

async function labAsk(a: Record<string, unknown>): Promise<ToolResult> {
  const experiment = labLabel(a.experiment);
  const question = S(a.question).trim();
  if (!question) return err('question is required');
  const M = await resolveProbeModel(a, experiment);
  if (!M.ok) return err(M.error);
  return runLabProbe({
    experiment, kind: 'ask', engine: `ask-route/${engineSuffix(M.provider)}`, inputPreview: question.slice(0, 300),
    provider: M.provider, model: M.model,
    // DEC-2: the stored provider/model are settled against the trace, not against M.
    attribution: { feature: 'ask', traceIdOf: (o) => (typeof o.trace_id === 'string' ? o.trace_id : null) },
    run: async () => {
      const probe = reduceAskEvents(parseNdjson(await selfPostNdjson('/api/ask', labBody({ question, investigations: S(a.investigations) || undefined }, a), labHeaders(a))));
      return { output: { question, ...probe }, summary: { ok: probe.ok } };
    },
  });
}

async function labAppropriateness(a: Record<string, unknown>): Promise<ToolResult> {
  const experiment = labLabel(a.experiment);
  const scenario = S(a.scenario).trim();
  if (!scenario) return err('scenario is required');
  const proposedActions = Array.isArray(a.proposedActions)
    ? (a.proposedActions as unknown[]).map((x) => S(x).trim()).filter(Boolean) : undefined;
  const patient = { age: S(a.age) || undefined, sex: S(a.sex) || undefined };
  return runLabProbe({
    experiment, kind: 'appropriateness', engine: 'appropriateness-route/mini', inputPreview: scenario.slice(0, 300),
    run: async () => {
      const probe = reduceAppropriatenessEvents(parseNdjson(await selfPostNdjson('/api/appropriateness', { scenario, proposedActions, patient })));
      return { output: { scenario, proposedActions, ...probe }, summary: { ok: probe.ok, n_flags: probe.n_flags } };
    },
  });
}

async function labPathway(a: Record<string, unknown>): Promise<ToolResult> {
  const experiment = labLabel(a.experiment);
  const scenario = S(a.scenario).trim();
  if (!scenario) return err('scenario is required');
  const proposedActions = Array.isArray(a.proposedActions)
    ? (a.proposedActions as unknown[]).map((x) => S(x).trim()).filter(Boolean) : undefined;
  const patient = { age: S(a.age) || undefined, sex: S(a.sex) || undefined };
  return runLabProbe({
    experiment, kind: 'pathway', engine: 'pathway-route/mini', inputPreview: scenario.slice(0, 300),
    run: async () => {
      const base = labSelfBaseUrl(process.env as Record<string, string | undefined>);
      const res = await fetch(`${base}/api/pathway/skeleton`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenario, proposedActions, patient, providerOverride: 'ollama' }),
      });
      const json = (await res.json()) as Record<string, unknown>;
      const skeleton = (json.skeleton && typeof json.skeleton === 'object' ? json.skeleton : null) as Record<string, unknown> | null;
      const stages = skeleton && Array.isArray(skeleton.stages) ? skeleton.stages as Record<string, unknown>[] : [];
      return {
        output: { scenario, ...json },
        summary: {
          ok: json.ok === true && skeleton != null, detected_stage: skeleton?.detectedStage ?? null,
          n_stages: stages.length, stage_ids: stages.map((s) => String(s.id || '')).filter(Boolean),
        },
      };
    },
  });
}

async function labCaseAudit(a: Record<string, unknown>): Promise<ToolResult> {
  const experiment = labLabel(a.experiment);
  const extracted = (a.extracted && typeof a.extracted === 'object') ? a.extracted as Record<string, unknown> : null;
  if (!extracted) return err('extracted (an already-extracted case object) is required — the PDF→OCR leg is multimodal and cannot run on the free mini');
  const preview = S(extracted.diagnosis) || S(extracted.procedure) || S(extracted.courseSummary) || 'case';
  return runLabProbe({
    experiment, kind: 'case_audit', engine: 'doc-audit-route/mini', inputPreview: preview.slice(0, 300),
    run: async () => {
      const probe = reduceDocAuditEvents(parseNdjson(await selfPostNdjson('/api/doc-audit/analyze', { extracted })));
      return { output: { extracted, ...probe }, summary: { ok: probe.ok, headline: probe.headline, band: probe.band } };
    },
  });
}

async function backfillControl(a: Record<string, unknown>, ctx?: TelemetryRequestContext): Promise<ToolResult> {
  const action = S(a.action);
  if (action === 'status') return ok(await readState());
  if (action === 'start') { await setSetting(MB_KEYS.enabled, '1'); return ok({ enabled: true, note: 'autopilot on — runs within its compute window on the next 5-min tick' }); }
  if (action === 'pause') { await setSetting(MB_KEYS.enabled, '0'); return ok({ enabled: false }); }
  if (action === 'run_day') {
    const day = S(a.day);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return err('run_day needs day=YYYY-MM-DD');
    const n = Math.max(1, Math.min(3, Number(a.n) || 1));
    const tag = a.tag ? labLabel(a.tag) : 'mini';
    const { countOpdNotesForDay, fetchOpdNotesForDay } = await import('./metabase');
    const { saveOpdAudit, auditedUidsForDayInLine } = await import('./opd-audit-store');
    const engineStr = opdMiniEngine(tag);
    const total = await countOpdNotesForDay(day);
    // Skip rule: the current ENGINE LINE, tag stripped (BACKFILL-SKIP-RULE PRD, 2 Aug 2026).
    const already = await auditedUidsForDayInLine(day);
    const rows = total > already.length ? await fetchOpdNotesForDay(day, already, n) : [];
    const results: Record<string, unknown>[] = [];
    for (const row of rows) {
      const t0 = Date.now();
      // As the worker (D9): this branch DOES write opd_note_audits, so it settles by the save result.
      let handle: LifecycleHandle | null = null;
      let published = false;
      /** The last map the callback delivered (v10 requirement 4), for the paths that return no audit. */
      let publishedDefects: ManifestDefectsByRole | undefined;
      try {
        const au = await auditOpdNote(row, {
          pipeline: 'mini', engineTag: tag,
          ...(ctx ? {
            telemetry: { ctx, route: 'mcp_tools' as const, persistenceIntent: 'will_persist' as const },
            // ⚠️ `if (d)` IS LOAD-BEARING. The DECLARATION publication passes no map, and letting it
            // overwrite a real one with undefined would throw away the verdict this exists to keep.
            onLifecycleHandleUpdated: (h: LifecycleHandle, d?: ManifestDefectsByRole) => { handle = h; published = true; if (d) publishedDefects = d; },
          } : {}),
        });
        let linked = false;
        // ⚠️ A PERSISTENCE OWNER, SO IT CARRIES THE ROLE MAP (pass 0b). This path passed NO defects
        // at all, which meant every row it settled was `persisted_clean` whatever its manifest said.
        // It is `lab_direct`/`lab_multi_query`-shaped and single-role today, so the map is usually
        // one key — but reading it is what stops a real defect being silently dropped here.
        // ⚠️ NO `?? {}` (v10 requirement 5). An empty map is NOT "no map": under requirement 6 a
        // PROVIDED map carrying no key for a role settles that linkable role partial, so `?? {}` would
        // have made every uninstrumented save partial and left requirement 7 unreachable. The attached
        // map first, then whatever the callback delivered, then undefined — which is a real answer.
        const defectsByRole = readRetrievalTelemetry(au)?.manifestDefectsByRole ?? publishedDefects;
        const st = await saveOpdAudit(au, { model: MINI_MODEL, latencyMs: Date.now() - t0 }, {
          onPersisted: async ({ status, auditId }) => { linked = true; await settleOwned(handle, outcomeForOwnedSave(status), auditId, defectsByRole); },
        });
        if (!linked) await settleOwned(handle, outcomeForOwnedSave(st), null, defectsByRole);
        results.push({ uid: au.keys.uid, index: au.scorecard.headline, band: au.scorecard.band, status: st, ms: Date.now() - t0 });
      }
      catch (e) {
        await settleOwned(handle, published ? 'audit_generation_failed' : 'retrieval_not_run');
        results.push({ error: String((e as Error).message) });
      }
    }
    return ok({ day, engine: engineStr, total, already: already.length, processed: results.length, results });
  }
  return err(`unknown action: ${action}`);
}

async function labBatchStart(a: Record<string, unknown>): Promise<ToolResult> {
  const experiment = labLabel(a.experiment);
  if (!experiment) return err('experiment required');
  let uids = sanitizeUids(a.uids);
  const cohortSql = S(a.cohort_sql).trim();
  if (uids.length === 0 && cohortSql) {
    const g = guardReadOnlySql(cohortSql, 2000);
    if (!g.ok) return err(`cohort_sql: ${g.error}`);
    let rows: Record<string, unknown>[];
    try { rows = await run(g.sql, []); } catch (e) { return err(`cohort_sql failed: ${String((e as Error).message)}`); }
    uids = sanitizeUids(rows.map((r) => (r.uid ?? Object.values(r)[0])));
  }
  if (uids.length === 0) return err('no uids - pass uids[] or a cohort_sql returning a uid column');
  const n = clampN(a.n ?? 2);
  const window = S(a.window) === 'always' ? 'always' : 'night';
  const kind = (S(a.kind) || 'opd').replace(/[^a-z0-9_-]/gi, '').slice(0, 24) || 'opd';
  // R-11 Stage 2 Phase 2 eval config (lab-only): force the normative leg on and/or route generation to
  // an OpenRouter model. Absent ⇒ '0'/'' ⇒ the batch behaves exactly as today (mini path, leg off).
  const evalNormativeLeg = a.evalNormativeLeg === true;
  const evalModel = S(a.evalModel).trim().slice(0, 128);
  const evalConcurrency = clampEvalConcurrency(a.evalConcurrency);
  const evalNormativeChannel = a.evalNormativeChannel === true;
  // Addendum C — EXACT match, and an unrecognised value ERRORS rather than being stored/dropped:
  // a batch silently running judge when the caller asked for a misspelled cohere is the same
  // silent-mismatch class the flip-prep build exists to remove (where a channel exists, be strict).
  const rawRerank = a.evalRerankBackend;
  if (rawRerank != null && rawRerank !== 'judge' && rawRerank !== 'cohere') {
    return err(`evalRerankBackend must be exactly 'judge' or 'cohere' (got ${JSON.stringify(rawRerank)})`);
  }
  const evalRerankBackend: '' | 'judge' | 'cohere' = rawRerank === 'judge' || rawRerank === 'cohere' ? rawRerank : '';
  // ── S2b C1 — the batch's model (BAKEOFF-DESIGN §6 gap 1) ───────────────────────────────────────
  // Resolved and reachability-checked HERE, at the door, so a batch that could never have run does
  // not sit in app_settings looking queued. The tick re-checks both (the rollback for this build is
  // unsetting an env var), but a refusal an operator sees immediately is worth more than one they
  // find in a tick summary two minutes later.
  const rawModel = S(a.model).trim();
  const resolvedModel = resolveBatchModel(rawModel);
  if (!resolvedModel.ok) return err(resolvedModel.error);
  const batchModel = resolvedModel.modelId;
  // TWO PAID DOORS AT ONCE IS A MISTAKE, NOT A PREFERENCE. `evalModel` wins inside defaultGenerate
  // (its branch precedes bedrock's), so the batch would run on OpenRouter while the caller asked for
  // Bedrock, and the summary would name one and the rows the other. Refuse instead of ordering them.
  if (batchModel && evalModel) {
    return err(`model ('${rawModel}') and evalModel ('${evalModel}') are mutually exclusive — one batch, one grader. Pass model for Bedrock or evalModel for OpenRouter, never both.`);
  }
  if (batchModel && !probeReachable('bedrock')) {
    return err('bedrock is not reachable in this deployment (BEDROCK_REGION / BEDROCK_ROLE_ARN / BEDROCK_OIDC_AUDIENCE / GCP_SA_KEY) — refusing to queue a batch that cannot run');
  }
  await ensureLabTables();
  await setSetting(LB_KEYS.experiment, experiment);
  await setSetting(LB_KEYS.uids, JSON.stringify(uids));
  await setSetting(LB_KEYS.n, String(n));
  await setSetting(LB_KEYS.window, window);
  await setSetting(LB_KEYS.kind, kind);
  await setSetting(LB_KEYS.evalNormativeLeg, evalNormativeLeg ? '1' : '0');
  await setSetting(LB_KEYS.evalModel, evalModel);
  await setSetting(LB_KEYS.evalConcurrency, String(evalConcurrency));
  await setSetting(LB_KEYS.evalNormativeChannel, evalNormativeChannel ? '1' : '0');
  await setSetting(LB_KEYS.evalRerankBackend, evalRerankBackend);
  // ⚠️ WRITTEN ON EVERY START, INCLUDING THE EMPTY CASE. This key is sticky app_settings state: left
  // behind, a previous arm's `bedrock:` model would silently make the NEXT free-mini batch a paid
  // one. Clearing it here is what makes "omit model ⇒ free mini" true a second time.
  await setSetting(LB_MODEL_KEY, batchModel ? `bedrock:${batchModel}` : '');
  await setSetting(LB_KEYS.error, '');
  await setSetting(LB_KEYS.enabled, '1');
  const prog = await batchProgress(experiment, uids);
  const note = batchModel
    ? 'queued - PAID BEDROCK batch: serial, no mini-yield, every note traced and its attribution verified against that trace (a mismatch refuses the note). Poll lab_batch_status; nudge with lab_batch_tick. Writes lab_analyses ONLY.'
    : (evalModel
      ? 'queued - eval batch: drains 50/tick with a bounded pool via OpenRouter, skips the mini-yield. Poll lab_batch_status; nudge with lab_batch_tick. Writes lab_analyses ONLY.'
      : 'queued - the */2 cron drains it (mini, INR 0), yielding to the prod backfill. Poll lab_batch_status; nudge with lab_batch_tick. Writes lab_analyses ONLY.');
  return ok({ experiment, kind, n, window, model: batchModel ? `bedrock:${batchModel}` : null, evalNormativeLeg, evalNormativeChannel, evalRerankBackend: evalRerankBackend || null, evalModel: evalModel || null, ...(evalModel ? { evalConcurrency } : {}), ...prog, note });
}

async function labBatchStatus(): Promise<ToolResult> {
  const st = await readBatchState();
  const prog = st.experiment ? await batchProgress(st.experiment, st.uids) : { total: 0, done: 0, remaining: 0 };
  // `model` rides the status because it is the field that says whether this batch is SPENDING. A
  // status view that reports progress without saying who is grading is how a paid arm goes unnoticed.
  const model = await readBatchModel().catch(() => '');
  return ok({ enabled: st.enabled, experiment: st.experiment, kind: st.kind, n: st.n, window: st.window, model: model || null, ...prog, last_error: st.lastError, last: st.last });
}

async function labBatchStop(): Promise<ToolResult> {
  await setSetting(LB_KEYS.enabled, '0');
  return ok({ enabled: false, note: 'paused (state kept; lab_batch_start re-arms/resumes)' });
}

async function labBatchTick(): Promise<ToolResult> {
  const st = await readBatchState();
  if (!st.experiment || st.uids.length === 0) return err('no job - call lab_batch_start first');
  return ok(await batchTick({ ignoreWindow: true }));
}

async function corpusAdd(a: Record<string, unknown>): Promise<ToolResult> {
  const one = await corpusAddOne(a);
  return one.ok ? ok(one.value) : err(one.error);
}

/** F13 — validate + insert ONE chunk. Shared by corpus_add and corpus_add_batch so a single rule
 *  governs both; the batch path must not be a softer door into the same table. */
async function corpusAddOne(a: Record<string, unknown>): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; error: string }> {
  const label = S(a.label), book = S(a.book), text = S(a.text);
  if (!label || !book || !text) return { ok: false, error: 'label, book and text are required' };
  // The SAME gate lvc_propose uses — (url OR doi OR pmid) AND year AND licence, unless
  // provenance='internal-protocol' (decision 10, the 332 Even Clinical Protocol chunks).
  const cit = checkCitationFields(a as Record<string, unknown>);
  if (!cit.ok) return { ok: false, error: cit.error };
  const c = cit.normalized;
  const res = await corpusAddQuarantined({
    label, book, text,
    chapter: S(a.chapter) || undefined, section: S(a.section) || undefined,
    chunkType: S(a.chunk_type) || undefined,
    citationUrl: c.citation_url, citationDoi: c.citation_doi, citationPmid: c.citation_pmid,
    sourceReleaseYear: c.source_release_year, licenseStatus: c.license_status, provenance: c.provenance,
  });
  return { ok: true, value: { ...res, status: 'quarantined', provenance: c, note: `inert until corpus_manage action=activate confirm:true label=${labLabel(label)} — does not affect production retrieval` } };
}

/**
 * F13 — many chunks, one call. ALL-OR-NOTHING BY DESIGN: every element is validated BEFORE any
 * insert, and the first failure rejects the whole batch naming its index. A partial ingest would
 * leave half a batch quarantined with no provenance and no record of which half, which is precisely
 * the state F13 exists to prevent.
 */
async function corpusAddBatch(a: Record<string, unknown>): Promise<ToolResult> {
  const chunks = Array.isArray(a.chunks) ? a.chunks as Record<string, unknown>[] : null;
  if (!chunks || chunks.length === 0) return err('chunks must be a non-empty array');
  if (chunks.length > 200) return err(`batch too large (${chunks.length}); split into batches of ≤200`);
  // PASS 1 — validate everything, write nothing.
  for (const [i, cRaw] of chunks.entries()) {
    const c = (cRaw && typeof cRaw === 'object') ? cRaw : {};
    if (!S(c.label) || !S(c.book) || !S(c.text)) return err(`chunk[${i}] rejected: label, book and text are required — WHOLE BATCH REJECTED, nothing was written`);
    const cit = checkCitationFields(c as Record<string, unknown>);
    if (!cit.ok) return err(`chunk[${i}] rejected: ${cit.error} — WHOLE BATCH REJECTED, nothing was written`);
  }
  // PASS 2 — insert. Validation already passed for every element.
  const results: Record<string, unknown>[] = [];
  for (const [i, c] of chunks.entries()) {
    const r = await corpusAddOne(c as Record<string, unknown>);
    if (!r.ok) return err(`chunk[${i}] failed at insert: ${r.error} — ${results.length} chunk(s) already written; re-run the remainder`);
    results.push(r.value);
  }
  return ok({ chunks: results.length, results });
}

/**
 * F12b — read-only code seam. The path POLICY lives in lib/lab-source-core (pure, tested); this
 * function only performs the read and the audit-log. Reads via fs, never via a URL, so nothing can
 * be fetched from outside the deployment.
 */
async function labSource(a: Record<string, unknown>): Promise<ToolResult> {
  const raw = S(a.path);
  // Belt-and-braces ahead of the core: refuse a literal '..' BEFORE any resolution.
  if (raw.includes('..')) return err("path contains '..' — traversal is refused outright");
  const d = decideLabSource(raw);
  if (!d.ok) return err(`lab_source refused (${d.reason}): ${d.detail}`);
  await ensureSqlAuditLog().catch(() => {});
  const t0 = Date.now();
  let text: string;
  try {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    text = await readFile(join(process.cwd(), d.path), 'utf8');
  } catch (e) {
    // Audit the attempt even when it fails — a miss is as interesting as a hit.
    await run(`INSERT INTO lab_sql_audit (sql, rows, ms) VALUES ($1,$2,$3)`, [`lab_source MISS ${d.path}`, 0, Date.now() - t0]).catch(() => {});
    return err(`cannot read ${d.path}: ${String((e as Error).message).slice(0, 160)}`);
  }
  const lines = text.split('\n').length;
  await run(`INSERT INTO lab_sql_audit (sql, rows, ms) VALUES ($1,$2,$3)`, [`lab_source ${d.path}`, lines, Date.now() - t0]).catch(() => {});
  return ok({ path: d.path, lines, bytes: text.length, text });
}

async function corpusManage(a: Record<string, unknown>): Promise<ToolResult> {
  const action = S(a.action);
  if (action === 'list') return ok({ batches: await corpusLabList() });
  if (action === 'activate') {
    if (!S(a.label)) return err('activate needs label');
    // PRODUCTION WRITE — an explicit confirm:true is required so activation can never be a one-token
    // slip. Declared REQUIRED for this action in the schema and enforced here.
    if (a.confirm !== true) return err('activate requires confirm:true — this is a PRODUCTION write that puts the batch into live clinical retrieval');
    return ok({ ...(await corpusActivate(S(a.label))), note: 'now LIVE in production retrieval (Ask/DDx/Right Care/audits)' }); }
  if (action === 'delete') { if (!S(a.label)) return err('delete needs label'); const which = (['quarantined', 'active', 'both'] as const).includes(a.which as never) ? a.which as 'quarantined' | 'active' | 'both' : 'both'; return ok(await corpusDelete(S(a.label), which)); }
  return err(`unknown action: ${action}`);
}

/** Measurement seam: run production retrieve() (or the multi-query fusion Ask/DDx use) and return
 *  served hits + per-stage scores + full text. Read-only; no model generation. Defaults
 *  useReranker/useSourceWeights TRUE (the production config); diagnostics always populated (R-5). */
async function labRetrieve(a: Record<string, unknown>, ctx?: TelemetryRequestContext): Promise<ToolResult> {
  const query = S(a.query).trim();
  if (!query) return err('query is required');
  const topK = clampLabRetrieveTopK(a.topK);
  const includeQuarantined = S(a.includeQuarantined).trim() || undefined;
  const useReranker = a.useReranker === undefined ? true : a.useReranker === true;
  const useSourceWeights = a.useSourceWeights === undefined ? true : a.useSourceWeights === true;
  const hybrid = a.hybrid === undefined ? true : a.hybrid === true;
  const multiQuery = a.multiQuery === true;
  const skipExpand = a.skipExpand === true;
  // R-2 Stage 1: lab-only discriminating BM25 leg. 'off' (default) ⇒ today's production behaviour.
  const dfMax = Number.isFinite(Number(a.dfMax)) && Number(a.dfMax) > 0 ? Math.floor(Number(a.dfMax)) : BM25_DEFAULT_DFMAX;
  const bm25Mode = S(a.bm25Mode) === 'discriminating' ? { strategy: 'discriminating' as const, dfMax } : undefined;
  // R-10: deterministic rerank ruler for the A/B. 'default'/omitted ⇒ env default (production 'judge').
  const rb = S(a.rerankBackend);
  const rerankBackend = rb === 'cohere' ? 'cohere' : rb === 'judge' ? 'judge' : undefined;
  const scoresOnly = a.scoresOnly === true;
  // Normative-source leg measurement: restrict both legs to these exact sources (labq: admitted if named).
  const restrictList = Array.isArray(a.restrictSources)
    ? a.restrictSources.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
    : [];
  const restrictSources = restrictList.length ? restrictList : undefined;
  // R-11: normative leg measurement.
  const useNormativeLeg = a.useNormativeLeg === true;
  const normList = Array.isArray(a.normativeSources)
    ? a.normativeSources.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
    : [];
  const normativeSources = normList.length ? normList : undefined;

  // ── STEP 9's SIXTH PLACEHOLDER, AND STEP 11's TWO CATCH ARMS ─────────────────────────────────
  // The role is decided by the BRANCH, not by the tool: D6 gives the direct branch `lab_direct` and
  // the fusion branch `lab_multi_query`, and they are different retrievals with different manifests.
  const role: RetrievalRole = multiQuery ? 'lab_multi_query' : 'lab_direct';
  const capture = ctx ? createTelemetryCapture(role) : undefined;
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  let handle: LifecycleHandle | null = null;
  if (ctx) {
    await startInvocation(ctx);
    try {
      handle = await declareRetrievals(ctx, [{ role, runId, uid: null, engineVersion: null }], 'never_persists');
    } catch (e) {
      // Fail-open: this is a measurement seam, not the worker. Its declaration failure already
      // wrote `work_declaration` evidence inside declareRetrievals.
      console.warn('[mcp-tools] lab_retrieve declaration failed, continuing uninstrumented', (e as Error).message);
    }
  }

  /** Write the terminal manifest, then settle. `lab_retrieve` writes NO audit row of any kind, so
   *  its persistence outcome is `no_persistence_intended` on every path including the failing ones —
   *  which is a statement about intent, not about what happened. */
  const finish = async (): Promise<void> => {
    if (!ctx || !handle || !capture) return;
    const operational: OperationalTelemetry = {
      route: ctx.route as OperationalTelemetry['route'], route_class: routeClassOf(ctx.route), retrieval_role: role,
      invocation_id: ctx.invocationId, trace_id: null, deployment_sha: ctx.deploymentSha,
      started_at: startedAt, completed_at: new Date().toISOString(), routing_flags: ctx.routingFlags,
      active_backfill_run_id: null, active_backfill_target: null, active_backfill_state: null,
      active_lab_experiment_id: ctx.labExperimentId ?? null,
    };
    const payload = buildRetrievalPayload(capture, { hmacKey: process.env.CDMSS_TELEMETRY_HMAC_KEY ?? null, scorerContext: null });
    void validateManifest({ ...payload, operational });
    handle = await writeRetrievalTerminal(handle, role, { payload, operational, traceId: null, completedAt: operational.completed_at ?? new Date().toISOString() });
    await settleOwned(handle, 'no_persistence_intended');
  };

  try {
    if (multiQuery) {
      const res = await retrieveMultiQuery(query, { topK, includeQuarantined, useReranker, useSourceWeights, hybrid, skipExpand, bm25Mode, rerankBackend, restrictSources, useNormativeLeg, normativeSources }, {}, capture);
      const full = res.hits.map((h, i) => {
        // rerank_score/backend/source_quality_weight/bm25 provenance are present at runtime but off the
        // exported MultiQueryHit type (see multi-query.ts) — read them via a narrow cast.
        const hx = h as typeof h & { rerank_score?: number; rerank_backend?: string; source_quality_weight?: number; bm25_rank?: number | null; bm25_variant_ranks?: (number | null)[] };
        return {
          final_rank: i + 1,
          id: h.id, source: h.source, book: h.book, chapter: h.chapter, section: h.section, item_number: h.item_number,
          similarity: h.similarity,
          vector_rank: null, bm25_rank: hx.bm25_rank ?? null, bm25_variant_ranks: hx.bm25_variant_ranks ?? null,
          rrf_score: h.rrf_score ?? null, variant_ranks: h.variant_ranks ?? null,
          source_quality_weight: hx.source_quality_weight ?? null, rerank_score: hx.rerank_score ?? null,
          rerank_backend: hx.rerank_backend ?? null,
          text: h.text,
        };
      });
      const hits = scoresOnly ? full.map(pickScoreFields) : full;
      await finish();
      return ok({
        query, mode: 'multi_query', expandedQuery: res.expandedQuery, includeQuarantined: includeQuarantined ?? null,
        restrictSources: restrictSources ?? null,
        topK, count: hits.length, bm25Mode: bm25Mode ? 'discriminating' : 'off', rerankBackend: rerankBackend ?? 'default', scoresOnly,
        perVariantCounts: res.perVariantCounts,
        // scoresOnly drops the variant query bodies (large: the expanded paragraph + variant texts).
        ...(scoresOnly ? {} : { variants: res.variants }),
        hits,
      });
    }

    const res = await retrieve(query, { topK, includeQuarantined, useReranker, useSourceWeights, hybrid, skipExpand, withDiagnostics: true, bm25Mode, rerankBackend, restrictSources, useNormativeLeg, normativeSources }, capture);
    const full = res.hits.map((h, i) => ({
      final_rank: h.final_rank ?? i + 1,
      id: h.id, source: h.source, book: h.book, chapter: h.chapter, section: h.section, item_number: h.item_number,
      similarity: h.similarity,
      vector_rank: h.vector_rank ?? null, bm25_rank: h.bm25_rank ?? null, bm25_variant_ranks: null, normative_rank: h.normative_rank ?? null, rrf_score: h.rrf_score ?? null,
      source_quality_weight: h.source_quality_weight ?? null, rerank_score: h.rerank_score ?? null, rerank_backend: h.rerank_backend ?? null,
      text: h.text,
    }));
    const hits = scoresOnly ? full.map(pickScoreFields) : full;
    await finish();
    return ok({
      query, mode: 'single_query', expandedQuery: res.expandedQuery, includeQuarantined: includeQuarantined ?? null,
      restrictSources: restrictSources ?? null,
      topK, count: hits.length, bm25Mode: bm25Mode ? 'discriminating' : 'off', rerankBackend: rerankBackend ?? 'default', scoresOnly,
      meta: res.meta, hits,
    });
  } catch (e) {
    // ⚠️ BOTH ARMS RECORD `retrieval_failure`, AND NEITHER CHANGES WHAT IT RETURNS. The named
    // RerankBackendError still becomes the same error RESULT and every other error still THROWS —
    // §4.3's whole point is that a retrieval that found nothing and a retrieval that failed are two
    // facts, and until now this seam produced the same empty answer for both.
    if (capture) {
      capture.retrievalOutcome = 'retrieval_failure';
      capture.retrievalErrorClass = capture.retrievalErrorClass ?? telemetryErrorClassOf(e);
    }
    await finish();
    // D3: a requested cohere ruler that is unreachable/missing/unhealthy fails LOUD — surfaced named
    // (RerankBackendUnreachable/Missing/Unhealthy, all RerankBackendError), never a silent fallback.
    if (e instanceof RerankBackendError) return err(`${e.name}: ${e.message}`);
    throw e;
  }
}

/** scoresOnly payload trim (§D2): ids + scores, NO chunk text/section. Pure — exported for tests. */
export function pickScoreFields(h: Record<string, unknown>): Record<string, unknown> {
  return {
    final_rank: h.final_rank ?? null, id: h.id, source: h.source, book: h.book, chapter: h.chapter, item_number: h.item_number,
    similarity: h.similarity, vector_rank: h.vector_rank ?? null, bm25_rank: h.bm25_rank ?? null,
    bm25_variant_ranks: h.bm25_variant_ranks ?? null, normative_rank: h.normative_rank ?? null, rrf_score: h.rrf_score ?? null,
    rerank_score: h.rerank_score ?? null, rerank_backend: h.rerank_backend ?? null,
    source_quality_weight: h.source_quality_weight ?? null,
  };
}

async function labQuery(a: Record<string, unknown>): Promise<ToolResult> {
  if (a.stats === true) return ok(await labStorage());
  if (S(a.id)) { const row = await getLabAnalysis(S(a.id)); return row ? ok(row) : err('not found'); }
  const experiment = a.experiment ? labLabel(a.experiment) : null;
  return ok({ experiment, results: await listLabAnalyses(experiment, Number(a.limit) || 50) });
}

async function ensureSqlAuditLog(): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS lab_sql_audit (
    id bigserial PRIMARY KEY, sql text, rows integer, ms integer, at timestamptz NOT NULL DEFAULT now()
  )`, []);
}

/** READ-ONLY SQL over the de-identified CDMSS audit DB (guarded). For golden-set mining. */
async function auditQuery(a: Record<string, unknown>): Promise<ToolResult> {
  const cap = Math.max(1, Math.min(500, Number(a.limit) || 500));
  const g = guardReadOnlySql(S(a.sql), cap);
  if (!g.ok) return err(g.error);
  await ensureSqlAuditLog().catch(() => {});
  const t0 = Date.now();
  let rows: Record<string, unknown>[];
  try { rows = (await run(g.sql, [])) as Record<string, unknown>[]; }
  catch (e) { return err(`query failed: ${String((e as Error).message)}`); }
  const ms = Date.now() - t0;
  await run(`INSERT INTO lab_sql_audit (sql, rows, ms) VALUES ($1,$2,$3)`, [g.sql.slice(0, 4000), rows.length, ms]).catch(() => {});
  return ok({ sql: g.sql, rows: rows.length, ms, data: rows });
}

// ── F14: lvc_propose / lvc_ratify / lvc_gaps (LAB-MCP Phase 2) ────────────────────
// lvc_recommendations is NEVER written by lvc_propose. Only lvc_ratify promotes, and only from an
// existing 'proposed' staging row. Every statement below is INFERRED (no live DB in the sandbox) and
// is listed verbatim in the build report; all paths fail-safe to an error result, never a wrong write.

const PROPOSALS_DDL = `CREATE TABLE IF NOT EXISTS lvc_recommendation_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  statement text NOT NULL, rationale text, evidence_note text, source text, category text,
  action_type text, specialty text, keywords jsonb,
  citation_url text, citation_doi text, citation_pmid text, source_release_year int,
  license_status text, provenance text,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','ratified','rejected')),
  proposed_by text NOT NULL, proposed_at timestamptz NOT NULL DEFAULT now(),
  supersedes_id text, rejected_reason text, promoted_id text
)`;
const RATIFICATIONS_DDL = `CREATE TABLE IF NOT EXISTS lvc_ratifications (
  id bigserial PRIMARY KEY,
  proposal_id uuid NOT NULL REFERENCES lvc_recommendation_proposals (id),
  decision text NOT NULL CHECK (decision IN ('ratified','rejected')),
  ratified_by text NOT NULL, rationale text NOT NULL, reason text,
  promoted_id text,
  created_at timestamptz NOT NULL DEFAULT now()
)`;
async function ensureLvcProposalTables(): Promise<void> {
  await run(PROPOSALS_DDL, []);
  await run(RATIFICATIONS_DDL, []);
}

/** Existing statements the dedup check runs against: the live rulebook PLUS pending proposals, so
 *  two near-identical proposals cannot both slip through before either is ratified. Fail-safe ⇒ []
 *  would DISABLE the dedup gate, so a read failure is surfaced as an error instead. */
async function loadExistingStatements(): Promise<ExistingStatement[] | null> {
  try {
    // FAULT 1a (corrected 26 Jul): lvc_recommendations has NO `source` column — it is `society`.
    // Aliased to `source` so lvc-proposal-core's ExistingStatement type is unchanged (there, `source`
    // is a display field on the duplicate report, not a schema name). This query naming a
    // non-existent column is what made lvc_propose refuse EVERY proposal: the mandatory dedup gate
    // correctly refuses when the comparison set cannot be read, so the fault failed closed.
    // lvc_recommendation_proposals is OUR table and genuinely has `source`.
    const live = await run(`SELECT id::text AS id, statement, society AS source, 'live' AS status FROM lvc_recommendations`, []);
    const pending = await run(`SELECT id::text AS id, statement, source, status FROM lvc_recommendation_proposals WHERE status = 'proposed'`, []);
    return [...live, ...pending].map((r) => ({
      id: String(r.id), statement: String(r.statement ?? ''),
      source: r.source == null ? null : String(r.source), status: r.status == null ? null : String(r.status),
    }));
  } catch { return null; }
}

async function lvcPropose(a: Record<string, unknown>): Promise<ToolResult> {
  await ensureLvcProposalTables().catch(() => {});
  const existing = await loadExistingStatements();
  if (existing === null) {
    // The dedup gate is MANDATORY (A10.4). If the comparison set cannot be read we refuse rather
    // than proceed ungated — proceeding would recreate the exact duplication problem F14 exists for.
    return err('cannot read the existing rulebook to run the mandatory duplicate check — refusing to propose ungated');
  }
  const parsed = parseProposeArgs(a, existing);
  if (!parsed.ok) {
    return err(parsed.error + (parsed.duplicates?.length ? ` | near-duplicates: ${parsed.duplicates.map((d) => `${d.id} (${d.similarity})`).join(', ')}` : ''));
  }
  const v = parsed.value;
  try {
    const rows = await run(
      `INSERT INTO lvc_recommendation_proposals
         (statement, rationale, evidence_note, citation_url, citation_doi, citation_pmid,
          source_release_year, license_status, provenance, status, proposed_by, supersedes_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'proposed',$10,$11)
       RETURNING id::text AS id, status, proposed_at`,
      [v.statement, v.rationale, v.evidence_note, v.citation.citation_url, v.citation.citation_doi,
       v.citation.citation_pmid, v.citation.source_release_year, v.citation.license_status,
       v.citation.provenance, v.proposed_by, v.supersedes_id]);
    const row = rows[0] ?? {};
    return ok({ proposal_id: row.id ?? null, status: 'proposed', statement: v.statement, supersedes_id: v.supersedes_id,
      note: 'STAGED only — lvc_recommendations is untouched. lvc_ratify (confirm:true + a named ratifier) is the only promotion path.' });
  } catch (e) { return err(`propose failed: ${String((e as Error).message).slice(0, 200)}`); }
}

async function lvcRatify(a: Record<string, unknown>): Promise<ToolResult> {
  await ensureLvcProposalTables().catch(() => {});
  const parsed = parseRatifyArgs(a);
  if (!parsed.ok) return err(parsed.error);
  const v = parsed.value;

  let prop: Record<string, unknown> | undefined;
  try {
    const rows = await run(
      `SELECT id::text AS id, statement, rationale, evidence_note, citation_url, citation_doi, citation_pmid,
              source_release_year, license_status, provenance, status, proposed_by, supersedes_id
       FROM lvc_recommendation_proposals WHERE id = $1::uuid`, [v.proposal_id]);
    prop = rows[0];
  } catch (e) { return err(`cannot read proposal: ${String((e as Error).message).slice(0, 160)}`); }

  // PROMOTE-ONLY: without an existing 'proposed' row there is nothing to promote, and this tool has
  // no path that creates a statement de novo.
  const promotable = checkPromotable(prop ? String(prop.status ?? '') : null);
  if (!promotable.ok) return err(promotable.error);

  if (v.decision === 'rejected') {
    try {
      await run(`UPDATE lvc_recommendation_proposals SET status = 'rejected', rejected_reason = $2 WHERE id = $1::uuid`, [v.proposal_id, v.reason]);
      await run(`INSERT INTO lvc_ratifications (proposal_id, decision, ratified_by, rationale, reason) VALUES ($1::uuid,'rejected',$2,$3,$4)`,
        [v.proposal_id, v.ratified_by, v.rationale, v.reason]);
      return ok({ proposal_id: v.proposal_id, status: 'rejected', ratified_by: v.ratified_by,
        note: 'REJECTION IS FIRST-CLASS — the row is retained with its reason, never deleted. A rejected proposal is evidence about the rulebook.' });
    } catch (e) { return err(`reject failed: ${String((e as Error).message).slice(0, 200)}`); }
  }

  // Promotion: insert into the live rulebook, then mark the staging row and append the ledger entry.
  try {
    // CORRECTED 26 Jul against the live schema. Four faults, all of which failed closed:
    //  1b. `source` does not exist → `society`, and the literal is 'EHRC' UPPERCASE. The existing 67
    //      house rows carry 'EHRC'; inserting lowercase would mis-segment every society comparison
    //      in lvc_gaps and in the dedup set.
    //  2-4. proposed_by / ratified_by / ratified_at did not exist → added by migration 0024. They
    //      live ON THE ROW, not only in the ledger, because lvc_ratify's confirm token is a
    //      convention rather than authentication — the row must carry its own audit trail.
    //  5.  `id` is text, NOT NULL, with NO DEFAULT and was not supplied, so every promotion would
    //      have failed on a null id even with 1-4 fixed. Generated server-side to match the existing
    //      convention exactly: 'ehrc-' || gen_random_uuid()::text.
    //  6.  `region` is NOT NULL with no default and was not supplied — measured after correction 1.
    //      Hardcoded 'IN', the same treatment as 'EHRC'; all 67 existing house rows carry it.
    // The COMPLETE NOT NULL set on lvc_recommendations is exactly four columns — id, region,
    // society, statement — and all four are now supplied. `status` is deliberately NOT supplied
    // (defaults to 'active'); every other column is nullable or defaulted, measured.
    const ins = await run(
      `INSERT INTO lvc_recommendations
         (id, region, society, statement, rationale, citation_url, citation_doi, citation_pmid,
          source_release_year, license_status, provenance, proposed_by, ratified_by, ratified_at)
       VALUES ('ehrc-' || gen_random_uuid()::text, 'IN', 'EHRC', $1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       RETURNING id`,
      [prop!.statement, prop!.rationale, prop!.citation_url, prop!.citation_doi, prop!.citation_pmid,
       prop!.source_release_year, prop!.license_status, prop!.provenance, prop!.proposed_by, v.ratified_by]);
    const promotedId = ins[0]?.id == null ? null : String(ins[0].id);
    await run(`UPDATE lvc_recommendation_proposals SET status = 'ratified', promoted_id = $2 WHERE id = $1::uuid`, [v.proposal_id, promotedId]).catch(() => {});
    await run(`INSERT INTO lvc_ratifications (proposal_id, decision, ratified_by, rationale, promoted_id) VALUES ($1::uuid,'ratified',$2,$3,$4)`,
      [v.proposal_id, v.ratified_by, v.rationale, promotedId]).catch(() => {});
    return ok({ proposal_id: v.proposal_id, status: 'ratified', promoted_id: promotedId, ratified_by: v.ratified_by });
  } catch (e) { return err(`ratify failed: ${String((e as Error).message).slice(0, 200)}`); }
}

/**
 * F14 lvc_gaps. FAULT 7 (corrected): this selected the alias-qualified `source` column, which does not exist — the real column is
 * `society`, the THIRD site of the same mistake. Reading the inferred SQL caught the two write-path
 * sites and missed this one; CALLING the tool against production surfaced it immediately
 * (the column-does-not-exist error). lvc_gaps is read-only, so exercising it cost nothing. Aliased
 * to `source` because lvc-proposal-core's GapRow uses that name as a display field.
 */
async function lvcGaps(a: Record<string, unknown>): Promise<ToolResult> {
  const limit = Math.max(1, Math.min(500, Number(a.limit) || 50));
  const wanted = S(a.gap_class);
  let rows: Record<string, unknown>[];
  try {
    rows = await run(
      `WITH fires AS (
         SELECT f->>'rule_ref' AS rule_ref, count(*)::int AS n
         FROM opd_note_audits a, LATERAL jsonb_array_elements(a.findings) f
         WHERE a.app_source = $1 AND a.engine_version LIKE 'opd-note-audit/0.81%'
           AND f->>'rule_ref' IS NOT NULL
         GROUP BY 1
       )
       SELECT r.id::text AS id, r.statement, r.society AS source,
              r.citation_url, r.citation_doi, r.citation_pmid,
              r.source_release_year, r.license_status,
              COALESCE(fires.n, 0)::int AS fires
       FROM lvc_recommendations r
       LEFT JOIN fires ON fires.rule_ref = r.id::text`, [APP_SOURCE]);
  } catch (e) { return err(`gaps query failed: ${String((e as Error).message).slice(0, 200)}`); }

  const classified = classifyGaps(rows as unknown as GapRow[]);
  const filtered = wanted ? classified.filter((g) => g.gap_class === wanted) : classified;
  const counts = classified.reduce((m, g) => { m[g.gap_class] = (m[g.gap_class] ?? 0) + 1; return m; }, {} as Record<string, number>);
  return ok({
    counts, returned: Math.min(filtered.length, limit), total: classified.length,
    gaps: filtered.slice(0, limit),
    note: 'A NEVER-FIRED rule is a RETIREMENT candidate, not a citation candidate (33 of 67 house statements have never fired). license_exposure ranks FIRST: all 44 external society statements carry license_status NULL, so the copyright exposure sits on the CITED half of the rulebook.',
  });
}

// ── OPD feedback loop (PRD OPD-FEEDBACK-LOOP-MCP §4) ──────────────────────────────
// Fixed parameterized SQL compiled in lib/opd-feedback-rollup-core.ts — NOT routed through
// guardReadOnlySql (opd_audit_feedback stays in BLOCKED_RELATIONS; free SQL can never touch it).
// The only write is the ledger table, ensured at call time (ensureSqlAuditLog pattern).
async function ensureAdjudicationTable(): Promise<void> {
  await run(ADJUDICATION_DDL, []);
  // LAB-MCP Phase 1: additive + idempotent; the ledger is append-only so no row is rewritten.
  // Fail-safe — if the ALTER cannot run, the rollup still works (engine_version is nullable metadata).
  await run(ADJUDICATION_ENGINE_VERSION_DDL, []).catch(() => {});
}

async function feedbackRollup(a: Record<string, unknown>): Promise<ToolResult> {
  await ensureAdjudicationTable().catch(() => {}); // the open-adjudication gate reads this table
  const filters = {
    appSource: APP_SOURCE,
    engineVersion: S(a.engine_version).trim() || null,
    since: S(a.since).trim() || null,
    until: S(a.until).trim() || null,
    signalType: S(a.signal_type).trim() || null,
    // §8: default null ⇒ production rows only (study IS NULL) — never contaminated by a study.
    study: S(a.study).trim().slice(0, 64) || null,
  };
  const [findingQ, firedQ, missedQ, auditQ, reviewerQ, reviewerCurQ, ledgerQ] = [
    buildRollupFindingSql(filters), buildRollupFiredSql(filters), buildRollupMissedSql(filters),
    buildRollupAuditSql(filters), buildRollupReviewerSql(filters), buildRollupReviewerCurrentSql(filters),
    buildLatestLedgerSql(),
  ];
  const [findingRows, firedRows, missedRows, auditRows, reviewerRows, reviewerCurrentRows, ledgerRows] = await Promise.all([
    run(findingQ.text, findingQ.params), run(firedQ.text, firedQ.params), run(missedQ.text, missedQ.params),
    run(auditQ.text, auditQ.params), run(reviewerQ.text, reviewerQ.params),
    // F4 reconciliation query — fail-safe: an error degrades reviewers_current to [] and never a 500.
    run(reviewerCurQ.text, reviewerCurQ.params).catch(() => [] as Record<string, unknown>[]),
    run(ledgerQ.text, ledgerQ.params),
  ]);
  // F2 output budget. These are OUTPUT filters only — reduceRollup computes every total over the
  // complete bucket set before applying them, so semantics cannot move.
  const minTriagedRaw = Number(a.min_triaged);
  const minTriaged = Number.isFinite(minTriagedRaw) ? Math.max(0, Math.floor(minTriagedRaw)) : 1;
  const mode = S(a.mode).trim() === 'full' ? 'full' as const : 'summary' as const;
  const rollup = reduceRollup({
    findingRows: findingRows as unknown as FindingCountRow[],
    firedRows: firedRows as unknown as FiredRow[],
    missedRows: missedRows as unknown as MissedRow[],
    auditRows: auditRows as unknown as RollupAuditRow[],
    reviewerRows: reviewerRows as unknown as ReviewerRow[],
    reviewerCurrentRows: reviewerCurrentRows as unknown as ReviewerRow[],
    ledgerRows: ledgerRows as unknown as LedgerLatestRow[],
  }, { minTriaged, mode });
  return ok({ ok: true, filters: { engine_version: filters.engineVersion, signal_type: filters.signalType, since: filters.since, until: filters.until }, ...rollup });
}

async function feedbackDetail(a: Record<string, unknown>): Promise<ToolResult> {
  const scope = (S(a.scope).trim() || 'finding') as FeedbackScope;
  let q;
  try {
    q = buildDetailSql({
      appSource: APP_SOURCE, scope,
      verdict: S(a.verdict).trim() || null,
      signalType: S(a.signal_type).trim() || null,
      engineVersion: S(a.engine_version).trim() || null,
      uid: S(a.uid).trim() || null,
      history: a.history === true,
      limit: clampLimit(a.limit),
      study: S(a.study).trim().slice(0, 64) || null,   // §8: default null ⇒ production rows only
    });
  } catch (e) { return err(String((e as Error).message)); }
  const rows = await run(q.text, q.params);
  const shaped = (rows as unknown as DetailRawRow[]).map(shapeDetailRow);
  return ok({ ok: true, scope, history: a.history === true, count: shaped.length, note: 'comments are clinician free text — do not paste into public docs', rows: shaped });
}

async function feedbackAdjudicate(a: Record<string, unknown>): Promise<ToolResult> {
  const parsed = parseAdjudicateArgs(a);
  if (!parsed.ok) return err(parsed.error);
  await ensureAdjudicationTable();
  if (parsed.action === 'log') {
    const ins = buildAdjudicationInsert({ cluster_key: parsed.cluster_key, decision: parsed.decision, rationale: parsed.rationale, prd_ref: parsed.prd_ref, author: parsed.author });
    const rows = await run(ins.text, ins.params);
    return ok({ ok: true, action: 'log', logged: rows[0] ?? null });
  }
  const q = buildAdjudicationListSql({ cluster_key: parsed.cluster_key, limit: parsed.limit });
  const rows = await run(q.text, q.params);
  return ok({ ok: true, action: 'list', count: rows.length, rows: reduceLedgerList(rows as unknown as LedgerRow[]) });
}
