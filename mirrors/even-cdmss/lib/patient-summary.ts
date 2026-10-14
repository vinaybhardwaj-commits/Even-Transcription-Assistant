/**
 * lib/patient-summary.ts — Patient Summary API (Pulse), WIRED half. 30 Jul 2026.
 *
 * Orchestrates the PRESERVED CCB mechanics into the namespaced package Pulse renders before an
 * encounter: episode assembly → grounded brief → ClinicalState → MemberStateSnapshot → provenance.
 * The pure contract (shape, degraded rules, disclaimer, job ids) lives in patient-summary-core.
 *
 * ⚠️ Everything this module calls is the RETIRED-but-LIVE CCB code. See the header on
 * lib/ccb-brief.ts before deleting anything that looks unused.
 *
 * PHI: identifiers ride the package's episode.keys for join-back only, exactly as CCB's
 * member_ref did — they never enter a model payload. Nothing new is persisted.
 */

import { assembleEpisode } from './ccb-fetch';
import { resolveBriefUid } from './ccb-resolve';
import { generateBrief } from './ccb-brief';
import { CCB_ENGINE_VERSION, type ExtractedReport } from './ccb-brief-core';
import { getMemberSnapshot } from './member-state/member-state';
import {
  deterministicExtract, normalizeWithLlm, mergeLlmFindings, type ChatFn, type ExtractInput,
} from './clinical-state/extract';
import type { ClinicalState } from './clinical-state/schema';
import { governedChat } from './trace';
import { geminiModelFor, geminiUtilityModel, TEXT_MODEL } from './llm';
import { sql } from './db';
import {
  assemblePackage, resolveServed, type PatientSummaryPackage, type ServedObservation,
} from './patient-summary-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export interface SummaryRequest {
  uid?: string; uhid?: string; individual_uid?: string; member_id?: string; date?: string;
}

/**
 * §2.4 — read what ACTUALLY served this trace, from llm_response / llm_stream_usage. NEVER from
 * llm_request, which records intent: that distinction is the whole reason register T-5 existed.
 * Ordered by seq so the LAST observation is the one that produced the final text.
 */
/**
 * What the trace already knows about this package: what served it, AND which legs failed.
 *
 * T-13 (31 Jul 2026) — the failure half is why this reads two kinds of row. When `ccb_clinical`
 * died on the bridge, the response check caught it and wrote BOTH a `provider_error` and an
 * `llm_error` here, and the envelope read neither: the package shipped with an empty clinical
 * section and `degraded: false`. The signal existed and was not read — the same shape as T-11 and
 * as the July incident. Reading it generically (ANY failed leg, named by its stage) rather than
 * per-leg means the NEXT leg to fail is covered without another code change.
 */
async function servedObservations(traceId: string | null): Promise<{ observations: ServedObservation[]; failedLegs: string[] }> {
  if (!traceId) return { observations: [], failedLegs: [] };
  try {
    const rows = await run(
      `SELECT kind, stage, payload->>'provider' AS provider, payload->>'model' AS model
         FROM trace_events
        WHERE trace_id = $1 AND kind IN ('llm_response', 'llm_stream_usage', 'provider_error', 'llm_error')
        ORDER BY seq ASC`,
      [traceId],
    );
    return {
      observations: rows
        .filter((r) => r.kind === 'llm_response' || r.kind === 'llm_stream_usage')
        .map((r) => ({ provider: r.provider as string | null, model: r.model as string | null })),
      failedLegs: rows
        .filter((r) => r.kind === 'provider_error' || r.kind === 'llm_error')
        .map((r) => String(r.stage ?? 'unknown leg')),
    };
  } catch {
    // unknown ⇒ resolveServed marks the package degraded, which is the honest answer
    return { observations: [], failedLegs: [] };
  }
}

/**
 * Stage-2 LLM normalisation over the episode ClinicalState — V's decision, 31 Jul 2026, DEFAULT
 * ON. Without it a physician's pre-encounter summary can report what the patient does NOT have
 * and never what they DO: the deterministic stage has no path for diagnoses, planOfManagement or
 * report impressions. Safe because normalizeWithLlm verifies every claimed span occurs VERBATIM
 * in the named field and rejects the rest — an invented finding is discarded mechanically, and
 * the rejects are surfaced in envelope.state_llm as a hallucination meter.
 */
function stateLlmEnabled(): boolean {
  return process.env.PATIENT_SUMMARY_STATE_LLM !== '0';
}

/**
 * Stage-2 thinking budget (T-11 part 2, 31 Jul 2026). The leg copies spans out of a record and
 * labels them — it does not reason its way to a conclusion — so it does not need Pro's default
 * unbounded deliberation, and that deliberation is what kills the call: Pro emits NO BYTES while
 * it thinks and OpenRouter closes the connection after ~125–155s of silence ("Upstream idle
 * timeout exceeded", 504 inside an HTTP 200).
 *
 * Expressed in the Vertex form, which is the only form Vertex honors; buildOpenrouterParams
 * translates it to OpenRouter's `reasoning.max_tokens` for the bridge (part 1). So ONE field caps
 * the leg on both transports.
 *
 * MEASURED, 20 calls per arm at concurrency 4 (failures/20, p90): uncapped 11, 72.7s · 4096 1,
 * 64.0s · 1024 0, 33.2s · 512 0, 26.0s. The reliability rule alone picks 1024 — V ruled 4096 on
 * the FINDINGS (31 Jul 2026), and the reason is worth keeping here so nobody "optimises" it back:
 * at 1024 the leg kept 2 of 13 reportFindings items, so an entire abdominal ultrasound vanished
 * from the summary; and its negative spans came back as bare nouns ("vegetation") whose source
 * sentence was "No clots, vegetation, or pericardial effusion" — verbatim-verifiable, correctly
 * statused, but the span no longer carries the negation a reader would check. Under-extraction
 * and a degraded evidence trail beat 1 failure in 20, which the package reports as degraded.
 * 1-in-20 is a WEAK estimate (true rate plausibly 1–20%); register T-12 holds the 100-call
 * re-measure and the bounded retry, both parked by V for V1.
 *
 * ⚠️ NEVER 0 — gemini-2.5-pro rejects a zero thinking budget with an HTTP 400 (Pro cannot have
 * thinking disabled). The floor is low but strictly above zero.
 */
export const STATE_LLM_THINKING_BUDGET = Number(process.env.PATIENT_SUMMARY_STATE_LLM_THINKING) || 4096;

/** The stage-2 chat leg, on the SAME trace as the brief so envelope provenance covers it. Model
 *  wiring mirrors ccb-brief's generate() (same engine, same fallback discipline). */
function normaliseChat(traceId: string | null): ChatFn {
  const geminiModel = geminiModelFor('ccb') ?? geminiModelFor('doc_audit') ?? geminiUtilityModel();
  return async (system, user) => {
    const r = await governedChat(traceId ?? undefined, 'clinical_state_normalise', {
      model: TEXT_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.1,
      max_tokens: 900,
      ...({ options: { num_ctx: 8192 }, keep_alive: '15m' } as Record<string, unknown>),
      // Applies ONLY when a Gemini model is resolved; the Ollama path ignores an unknown field.
      ...(geminiModel ? { google: { thinking_config: { thinking_budget: STATE_LLM_THINKING_BUDGET } } } : {}),
    }, { gemini: geminiModel, promptRef: 'extract/NORMALISE_SYSTEM' });
    return r.choices?.[0]?.message?.content ?? '';
  };
}

/**
 * ClinicalState for the episode: stage 1 (deterministic) built here; the input is returned
 * alongside so the flag-gated stage-2 pass can run over the SAME fields. Fail-open —
 * a construction error yields null and the package reports itself degraded rather than lying.
 */
function buildEpisodeClinicalState(
  bundle: Awaited<ReturnType<typeof assembleEpisode>>,
  reports: ExtractedReport[],
): { state: ClinicalState; input: ExtractInput } | null {
  if (!bundle) return null;
  try {
    const p = bundle.prescription;
    // Every field name becomes provenance.sourceField, so they are named for what they ARE — a
    // physician reading the state can see which part of the record each finding came from.
    // The de-identified report content is included because it is the richest clinical text in the
    // episode: without it a rich episode yields almost nothing but `unknowns`.
    const input: ExtractInput = {
      surface: 'other',
      fields: {
        presentingComplaint: p.presentingComplaint || undefined,
        diagnoses: p.diagnoses.length ? p.diagnoses.join('; ') : undefined,
        planOfManagement: p.planOfManagement || undefined,
        investigations: p.investigations.length ? p.investigations.join('; ') : undefined,
        reportImpressions: reports.map((r) => r.impression || '').filter(Boolean).join('; ') || undefined,
        reportFindings: reports.flatMap((r) => r.keyFindings).filter(Boolean).join('; ') || undefined,
        reportAbnormalValues: reports.flatMap((r) => r.abnormalValues).filter(Boolean).join('; ') || undefined,
      },
    };
    return { state: deterministicExtract(input), input };
  } catch {
    return null;
  }
}

export interface BuildResult { package: PatientSummaryPackage | null; error?: string }

/**
 * Build one Patient Summary package. Deliberately UNOPTIMISED (V1 measures first): no precompute,
 * no caching, no parallel speculation beyond what CCB already does.
 */
export async function buildPatientSummary(req: SummaryRequest): Promise<BuildResult> {
  const generatedAt = new Date().toISOString();

  // 1. Resolve to a prescription uid. Pulse calls with a UHID; CCB's own resolver already maps
  //    uhid / individual_uid / member_id (optionally scoped by date) → presc_uid.
  const { uid } = await resolveBriefUid({
    uid: req.uid, uhid: req.uhid, individualUid: req.individual_uid,
    memberId: req.member_id, date: req.date,
  }).catch(() => ({ uid: null, candidates: [] as string[] }));
  if (!uid) return { package: null, error: 'no episode found for the supplied identifier' };

  // 2. Episode.
  const bundle = await assembleEpisode(uid).catch(() => null);
  if (!bundle) return { package: null, error: 'prescription not found' };

  // 3. Grounded brief (the preserved CCB engine). ExtractedReport[] rides the additive sink —
  //    the CcbEnvelope does not carry it.
  let extractedReports: ExtractedReport[] = [];
  const envelope = await generateBrief(bundle, { onExtracted: (r) => { extractedReports = r; } });

  // 4. The two state objects. Both fail-open; a null is reported as degraded, never as "clean".
  const built = buildEpisodeClinicalState(bundle, extractedReports);
  let clinicalState: ClinicalState | null = built?.state ?? null;
  const memberState = await getMemberSnapshot(bundle.keys.individualUid, generatedAt).catch(() => null);

  // 4b. Stage 2 — flag-gated, DEFAULT ON (V, 31 Jul 2026). Additive: a failed pass keeps the
  //     stage-1 state (never discards it) and flags the package degraded instead of throwing.
  //     extractionMethod stays 'llm' on every merged finding — never flattened to look
  //     deterministic (§2.7.1).
  type SpanRef = Array<{ concept: string; rawText: string; field: string }>;
  let stateLlm: { enabled: boolean; rejected: SpanRef; polarityMarked: SpanRef } | null = null;
  let stateLlmFailed = false;
  if (stateLlmEnabled() && built) {
    try {
      const llm = await normalizeWithLlm(built.input, normaliseChat(envelope.trace_id));
      clinicalState = mergeLlmFindings(built.state, llm);
      stateLlm = { enabled: true, rejected: llm.rejected, polarityMarked: llm.polarityMarked };
    } catch {
      stateLlmFailed = true;
    }
  }

  // 5. §2.4 — provenance from the brief's own trace, read AFTER the stage-2 leg so a fallback
  //    there is seen too. T-13: the same read also carries the legs that FAILED, and the
  //    assembled clinical section is checked independently of the trace.
  const trace = await servedObservations(envelope.trace_id);
  const coveragePct = (envelope.grounding_summary as { citation_coverage_pct?: unknown } | null | undefined)
    ?.citation_coverage_pct;
  const served = resolveServed(trace.observations, {
    partial: clinicalState == null || memberState == null,
    stateLlmFailed,
    failedLegs: trace.failedLegs,
    clinical: {
      findings: Array.isArray(envelope.clinical) ? envelope.clinical.length : 0,
      citationCoveragePct: typeof coveragePct === 'number' ? coveragePct : null,
    },
  });

  return {
    package: assemblePackage({
      traceId: envelope.trace_id,
      engineVersion: CCB_ENGINE_VERSION,
      generatedAt,
      served,
      clinicalFindings: envelope.clinical,
      lowValueFlags: envelope.low_value_flags,
      groundingSummary: envelope.grounding_summary,
      retrievalManifest: envelope.retrieval,
      extractedReports,
      sources: envelope.sources,
      clinicalState,
      memberState: memberState as unknown as { asOf?: string; followUps?: unknown[] } | null,
      episode: {
        keys: bundle.keys, prescription: bundle.prescription,
        orders: bundle.orders, reports: bundle.reports, coverage: bundle.coverage,
      },
      // PROM requests: Phase 2 ships the field, empty. The PROM scheduler is member- and
      // programme-scoped (lib/proms/schedule.ts) and wiring it is a separate decision, not an
      // unstated one — the namespace exists so adding them later is additive for Pulse.
      promRequests: [],
      commercial: envelope.commercial,
      stateLlm,
    }),
  };
}

// ── job store ─────────────────────────────────────────────────────────────────────────────────
//
// Deliberately NOT a queue (kickoff §2.1). One row per job in the existing app_settings key/value
// store — the same mechanism the lab batch and quieting config already use. Jobs are small, and
// this keeps the 202/poll contract working with no migration.

const JOB_PREFIX = 'psum_job:';

export async function putJob(job: { job_id: string } & Record<string, unknown>): Promise<void> {
  try {
    await run(
      `INSERT INTO app_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JOB_PREFIX + job.job_id, JSON.stringify(job)],
    );
  } catch { /* a job-store failure must not throw into the request path */ }
}

export async function getJob(jobId: string): Promise<Record<string, unknown> | null> {
  try {
    const rows = await run(`SELECT value FROM app_settings WHERE key = $1`, [JOB_PREFIX + jobId]);
    const v = rows[0]?.value;
    if (v == null) return null;
    return typeof v === 'string' ? JSON.parse(v) : (v as Record<string, unknown>);
  } catch {
    return null;
  }
}
