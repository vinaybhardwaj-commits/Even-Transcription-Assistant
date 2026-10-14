/**
 *   node --experimental-strip-types lib/patient-summary-core.ts
 *
 * Patient Summary API (Pulse) — PURE core. 30 Jul 2026.
 *
 * CCB was retired as a care-manager product; its mechanics are re-exposed as a microservice that
 * feeds the physician's pre-encounter Patient Summary in Pulse (the OPD HIS). This core owns the
 * package SHAPE, the degraded/provenance rules, the job-state machine and the disclaimer — no I/O,
 * no db, no LLM, so the contract is unit-testable without touching a patient record.
 *
 * FOUR PROPERTIES THAT MUST NOT BE FLATTENED (kickoff §2.7). A JSON contract destroys these by
 * default, so they are stated here and asserted in tests:
 *   1. FACT vs INFERENCE. `latestDocumentedStatus` is fact, `course` is derived,
 *      `currentStatusConfidence` is inference; every `provenance` carries extractionMethod
 *      (deterministic | llm | reported) + confidence. The payload passes these through verbatim.
 *   2. `negatives[]` ≠ `unknowns[]`. "Explicitly absent" and "not assessed" are different clinical
 *      statements — likewise instability.assessedInputs vs missingInputs. Never merged, never
 *      dropped when empty (an empty negatives[] is itself information).
 *   3. CONFLICTS SURFACE, NEVER RESOLVE. Discrepancy.resolutionStatus is always 'open' and
 *      severity may be 'safety_critical'. Never filtered, never collapsed, never sorted away.
 *   4. `asOf` already exists on MemberStateSnapshot — used as given, never recomputed.
 *
 * The package is NAMESPACED and Pulse takes what it wants. `commercial` is a SIBLING of
 * `clinical`, never nested inside it (kickoff §2.5).
 */

export const PATIENT_SUMMARY_API_VERSION = 'patient-summary/1.0' as const;

/**
 * Rewritten for this contract (kickoff §2.6). The CCB disclaimer described "a care-management
 * conversation… not a clinician performance assessment" — the wrong scope for a physician reading
 * before an encounter. Emitted IN THE JSON because CCB's UI no longer exists to carry it.
 */
export const PATIENT_SUMMARY_DISCLAIMER =
  'Advisory, non-diagnostic decision support prepared before the encounter. This is a machine-assembled ' +
  'summary of what prior records state — it is not a diagnosis, not a treatment recommendation, and not a ' +
  'substitute for your own history, examination and judgement. Clinical claims are grounded in the CDMSS ' +
  'corpus where cited and are otherwise labelled general reasoning. Items marked absent were explicitly ' +
  'documented as absent; items marked unknown were never assessed — the two are different, and neither ' +
  'means normal. Conflicts between sources are surfaced unresolved, by design, for you to adjudicate.';

/** Ships in its own namespace, with its own inline definition, so a reader who is not V knows
 *  exactly what it is and what gated it (kickoff §2.5). */
export const COMMERCIAL_DEFINITION =
  'NON-CLINICAL. This layer is a care-management/commercial prompt, produced by a separate pass behind a ' +
  'deterministic wall: it may fire ONLY when the clinical engine emitted a corpus-CITED surgical or ' +
  'specialist-indication finding, and `gated_on` names the finding ids that permitted it. It is NOT a ' +
  'clinical recommendation, it did not influence any clinical finding, and it must never be rendered as ' +
  'clinical content or attributed to the clinical engine.';

// ── job state ─────────────────────────────────────────────────────────────────────────────────

export type JobStatus = 'running' | 'done' | 'error';

export interface JobRecord {
  job_id: string;
  status: JobStatus;
  created_at: string;
  updated_at: string;
  /** Echo of what was asked for — never widened, never a second lookup key. */
  request: { uid?: string; uhid?: string; individual_uid?: string; member_id?: string; date?: string };
  package?: PatientSummaryPackage;
  error?: string;
}

/** Deterministic-shaped job id. The random part is supplied by the caller (this core stays pure
 *  and reproducible — no Date.now, no Math.random inside). */
export function makeJobId(nowIso: string, rand: string): string {
  const stamp = nowIso.replace(/[-:.TZ]/g, '').slice(0, 14);
  return `psum_${stamp}_${rand.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase()}`;
}

export function isJobId(s: unknown): boolean {
  return typeof s === 'string' && /^psum_\d{8,14}_[a-z0-9]{4,8}$/.test(s);
}

// ── the package ───────────────────────────────────────────────────────────────────────────────

export interface SummaryEnvelope {
  api_version: string;
  trace_id: string | null;
  engine_version: string;
  generated_at: string;
  /** From MemberStateSnapshot.asOf — the freshness of the longitudinal spine. NEVER recomputed
   *  here (§2.7.4); null when there is no snapshot. */
  as_of: string | null;
  /** What ACTUALLY answered, read from llm_response/llm_stream_usage — never what the code
   *  intended (§2.4). Null when nothing could be established. */
  served_model: string | null;
  served_provider: string | null;
  /** TRUE whenever the package was produced on a fallback path. Pulse is REQUIRED to render a
   *  degraded package differently — see degradedReason for what to show. */
  degraded: boolean;
  degraded_reason: string | null;
  /**
   * TRUE when grounding_summary.citation_coverage_pct is 0 — NO clinical claim in this package is
   * backed by the CDMSS corpus. Measured 31 Jul 2026: two of six briefs came back grounded 0, and
   * nothing obliged Pulse to render citation_coverage_pct, so at the point of care a zero-grounded
   * summary was indistinguishable from a well-grounded one while the disclaimer read as an
   * assurance. Same shape, same reasoning, same obligation as `degraded`: Pulse is REQUIRED to
   * render an ungrounded package differently.
   */
  ungrounded: boolean;
  /**
   * Stage-2 LLM finding normalisation over state.clinical_state (flag-gated, default ON — see the
   * wired half). `rejected` lists findings the model asserted whose claimed source span did NOT
   * occur verbatim in the named field: they are discarded mechanically (anti-fabrication at the
   * schema boundary), and surfaced here because the rejection rate is a free hallucination meter.
   * `rejected_count` is null when the stage did not run (flag off, or no stage-1 state to enrich).
   *
   * POLARITY (31 Jul 2026): span verification proves PROVENANCE, NOT POLARITY. A negated span
   * copied verbatim and labelled 'present' passes it cleanly — observed live, e.g. "no PAH" and
   * "No obvious regional wall motion abnormalities" arriving as positives. Such findings are now
   * MARKED with `polaritySuspect` on the finding itself and counted here as
   * `polarity_marked_count`. They are NOT removed: a cue-based guard using the identical detection
   * was built and rejected on bank evidence, because it dropped "absent distal pulses" and "absent
   * bowel sounds" — cannot-miss signs in red-flag cases that trip the same cue. Pulse must render
   * a caution on a marked finding and must never suppress it. An unmarked finding is not
   * thereby verified; the mark is a prompt to check, not a verdict.
   */
  state_llm: {
    enabled: boolean;
    rejected_count: number | null;
    rejected: Array<{ concept: string; rawText: string; field: string }>;
    /** Accepted findings carrying `polaritySuspect`. Never merged with `rejected` — a rejected
     *  finding is GONE (fabricated span); a marked one is PRESENT and annotated. */
    polarity_marked_count: number | null;
  };
  /**
   * Concepts appearing in BOTH state.clinical_state.positives and .negatives (normalised exact
   * match) — the package would otherwise render a patient who simultaneously has and does not
   * have a finding, silently. Surfaced, never resolved (§2.7.3 posture); empty when no state.
   */
  state_conflicts: { count: number; concepts: string[] };
}

export interface PatientSummaryPackage {
  envelope: SummaryEnvelope;
  clinical: {
    findings: unknown[];
    low_value_flags: unknown[];
    grounding_summary: unknown;
    retrieval_manifest: unknown;
    extracted_reports: unknown[];
    sources: unknown[];
  };
  state: {
    clinical_state: unknown | null;
    member_state: unknown | null;
  };
  episode: {
    keys: unknown;
    prescription: unknown;
    orders: unknown[];
    reports: unknown[];
    coverage: string | null;
  };
  actions: {
    follow_ups: unknown[];
    prom_requests: unknown[];
  };
  commercial: {
    definition: string;
    disclaimer: string;
    layer: unknown | null;
  };
  disclaimer: string;
}

// ── §2.4 · provenance ─────────────────────────────────────────────────────────────────────────

/** One llm_response/llm_stream_usage observation, as read back off the trace. */
export interface ServedObservation { provider?: string | null; model?: string | null }

/**
 * Establish what actually served, and whether the package is degraded.
 *
 * This is not theoretical. Between 26 and 30 Jul 2026 CDMSS served confident output from a
 * fallback model while every dashboard reported gemini-2.5-pro, because llm_request logs INTENT
 * and opd_note_audits.model was a hardcoded literal (register T-5). Had that fed Pulse, Pulse
 * would have rendered degraded inference as chart.
 *
 * Rules:
 *   · the LAST observation wins (it is the one that produced the final text);
 *   · `degraded` is TRUE when ANY observation fell back to the local Ollama bridge, when nothing
 *     was observed at all (we cannot prove what served), when the caller reports a partial
 *     assembly (a state/brief leg failed), or when the flag-on stage-2 state normalisation
 *     failed (the state shipped thinner than the default contract promises).
 *   · a bare "we don't know" is degraded. Never assume the happy path.
 *
 * ═══ T-13 (31 Jul 2026) — TWO INDEPENDENT ADDITIONS, EACH SUFFICIENT ON ITS OWN ═══
 * MEASURED defect: the `ccb_clinical` leg died on the bridge (empty 200 after 133s), the response
 * check caught it, the trace recorded BOTH a provider_error and an llm_error — and the package
 * came back with `clinical.findings: []`, `citation_coverage_pct: 0` and `degraded: FALSE`. None
 * of the four rules above can see it: the array is empty but PRESENT, clinical_state built
 * independently and was fine, and other legs supplied observations. The one field Pulse is told
 * to gate on could not see a wholesale failure of the section it gates.
 *
 *   `failedLegs` — read off the SAME trace the observations come from. Deliberately NOT a
 *     per-leg boolean: any provider_error/llm_error row means A leg failed, whichever leg it was,
 *     so the next leg to fail is covered without another code change. This is the signal that
 *     already existed and was not read.
 *   `clinical` — the content check, independent of the trace, because a failure that never
 *     writes an event must still be visible. No findings AND zero citation coverage means the
 *     package holds no clinical content; a thin note may yield FEW findings, never none with
 *     zero coverage, and even if it legitimately could, a summary with no clinical content is
 *     not a normal chart and must not be rendered as one.
 */
export function resolveServed(
  observations: ServedObservation[],
  opts: {
    partial?: boolean;
    stateLlmFailed?: boolean;
    /** Trace stages that recorded a provider_error / llm_error on this package (T-13). */
    failedLegs?: string[];
    /** The assembled clinical section, for the content check (T-13). */
    clinical?: { findings: number; citationCoveragePct: number | null };
  } = {},
): Pick<SummaryEnvelope, 'served_model' | 'served_provider' | 'degraded' | 'degraded_reason'> {
  const seen = observations.filter((o) => o && (o.provider || o.model));
  const last = seen.length ? seen[seen.length - 1] : null;
  const providers = seen.map((o) => String(o.provider || '').toLowerCase());
  const fellBack = providers.some((p) => p === 'ollama' || p === 'mini');
  const reasons: string[] = [];
  if (!seen.length) reasons.push('no served-model observation was recorded for this package — the serving provider could not be established');
  if (fellBack) reasons.push('at least one leg was served by the local fallback model, not the intended frontier model');
  if (opts.partial) reasons.push('part of the package could not be assembled and is null');
  if (opts.stateLlmFailed) reasons.push('the LLM state-normalisation leg failed — state.clinical_state is deterministic-only, thinner than the default contract');
  const legs = (opts.failedLegs ?? []).filter(Boolean);
  if (legs.length) {
    const named = [...new Set(legs.map((s) => String(s)))].sort().join(', ');
    reasons.push(`a model leg failed while building this package (${named}) — the section it produces may be empty or incomplete`);
  }
  if (opts.clinical && opts.clinical.findings === 0 && opts.clinical.citationCoveragePct === 0) {
    reasons.push('the package carries NO clinical content — zero findings and zero citation coverage; this is not a thin chart, it is an empty one');
  }
  return {
    served_model: last?.model ? String(last.model) : null,
    served_provider: last?.provider ? String(last.provider) : null,
    degraded: reasons.length > 0,
    degraded_reason: reasons.length ? reasons.join('; ') : null,
  };
}

// ── assembly ──────────────────────────────────────────────────────────────────────────────────

export interface AssembleInput {
  traceId: string | null;
  engineVersion: string;
  generatedAt: string;
  served: Pick<SummaryEnvelope, 'served_model' | 'served_provider' | 'degraded' | 'degraded_reason'>;
  clinicalFindings: unknown[];
  lowValueFlags: unknown[];
  groundingSummary: unknown;
  retrievalManifest: unknown;
  extractedReports: unknown[];
  sources: unknown[];
  clinicalState: unknown | null;
  memberState: { asOf?: string; followUps?: unknown[] } | null;
  episode: { keys?: unknown; prescription?: unknown; orders?: unknown[]; reports?: unknown[]; coverage?: string } | null;
  promRequests: unknown[];
  commercial: unknown | null;
  /** Stage-2 state-normalisation outcome for the envelope. Omitted ⇒ the stage did not run. */
  stateLlm?: {
    enabled: boolean;
    rejected: Array<{ concept: string; rawText: string; field: string }>;
    polarityMarked: Array<{ concept: string; rawText: string; field: string }>;
  } | null;
}

/** Same normalisation the extractor uses for concept identity — dependency-free copy (this core
 *  imports nothing, by design). */
function normConcept(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Concepts present in BOTH positives and negatives of a ClinicalState (normalised exact match).
 * `seen` in mergeLlmFindings dedupes on concept|STATUS, so a deterministic 'absent' and an LLM
 * 'present' for the same concept both survive — this makes that contradiction visible instead of
 * silent. Pure and defensive: any non-state shape returns [].
 */
export function findStateConflicts(state: unknown): string[] {
  const s = state as { positives?: Array<{ concept?: unknown }>; negatives?: Array<{ concept?: unknown }> } | null | undefined;
  if (!s || !Array.isArray(s.positives) || !Array.isArray(s.negatives)) return [];
  const negated = new Set(
    s.negatives.map((f) => normConcept(String(f?.concept ?? ''))).filter(Boolean),
  );
  const out: string[] = [];
  const emitted = new Set<string>();
  for (const f of s.positives) {
    const concept = String(f?.concept ?? '');
    const n = normConcept(concept);
    if (n && negated.has(n) && !emitted.has(n)) { emitted.add(n); out.push(concept); }
  }
  return out;
}

/**
 * The zone this system's wall-clock timestamps are written in. `MemberStateSnapshot.asOf` arrives
 * either as a bare date ('2026-07-29') or as a full IST instant ('2026-07-27T11:29:11+05:30'),
 * depending on which source watermark won — same field, same api_version, two formats on the wire
 * (measured across fixture-rich and fixture-showcase, 31 Jul 2026). A consumer that parses one
 * breaks on the other.
 */
const IST_OFFSET = '+05:30';

/**
 * §4 (T-13 kickoff) — normalise `as_of` to full ISO 8601 AT THE BOUNDARY. The snapshot's own
 * `asOf` is NOT touched: CDMSS never recomputes member-state freshness, it only formats it on the
 * way out.
 *
 * A bare date is anchored to IST midnight rather than converted to UTC deliberately: 00:00 IST is
 * 18:30 the PREVIOUS DAY in UTC, so a naive consumer slicing the first ten characters would see
 * the date move by one. Preserving the offset keeps the calendar date the source meant.
 * An unparseable value is passed through untouched — never invent a timestamp.
 */
export function normaliseAsOf(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00${IST_OFFSET}`;
  if (Number.isNaN(Date.parse(s.replace(' ', 'T')))) return s;
  // A wall-clock timestamp with no zone is IST by this system's convention.
  if (!/([zZ]|[+-]\d{2}:?\d{2})$/.test(s)) return `${s.replace(' ', 'T')}${IST_OFFSET}`;
  return s;
}

/**
 * Compose the namespaced package. Deliberately a PASS-THROUGH for every clinical structure: the
 * schemas are disciplined in ways this contract must not flatten (§2.7), so nothing here filters,
 * sorts, collapses, defaults-away or "tidies" a state object. `as_of` is taken from the snapshot.
 */
export function assemblePackage(i: AssembleInput): PatientSummaryPackage {
  // Zero-grounding is a first-class state (31 Jul 2026). Strictly === 0: the flag fires on a
  // MEASURED zero, never on a missing/unreadable summary (that is `degraded` territory).
  const coverage = (i.groundingSummary as { citation_coverage_pct?: unknown } | null | undefined)
    ?.citation_coverage_pct;
  return {
    envelope: {
      api_version: PATIENT_SUMMARY_API_VERSION,
      trace_id: i.traceId,
      engine_version: i.engineVersion,
      generated_at: i.generatedAt,
      // §2.7.4 — the snapshot's own asOf, never a second freshness figure. Formatted to one ISO
      // shape on the way out (T-13 §4); the snapshot itself is not recomputed.
      as_of: normaliseAsOf(i.memberState?.asOf),
      ...i.served,
      ungrounded: coverage === 0,
      state_llm: {
        enabled: i.stateLlm?.enabled ?? false,
        rejected_count: i.stateLlm ? i.stateLlm.rejected.length : null,
        rejected: i.stateLlm?.rejected ?? [],
        polarity_marked_count: i.stateLlm ? i.stateLlm.polarityMarked.length : null,
      },
      state_conflicts: (() => {
        const concepts = findStateConflicts(i.clinicalState);
        return { count: concepts.length, concepts };
      })(),
    },
    clinical: {
      findings: i.clinicalFindings,
      low_value_flags: i.lowValueFlags,
      grounding_summary: i.groundingSummary,
      retrieval_manifest: i.retrievalManifest,
      extracted_reports: i.extractedReports,
      sources: i.sources,
    },
    state: {
      clinical_state: i.clinicalState,
      member_state: i.memberState,
    },
    episode: {
      keys: i.episode?.keys ?? null,
      prescription: i.episode?.prescription ?? null,
      orders: i.episode?.orders ?? [],
      reports: i.episode?.reports ?? [],
      coverage: i.episode?.coverage ?? null,
    },
    actions: {
      // The snapshot's own followUps — carried, never re-derived.
      follow_ups: i.memberState?.followUps ?? [],
      prom_requests: i.promRequests,
    },
    commercial: {
      definition: COMMERCIAL_DEFINITION,
      disclaimer: PATIENT_SUMMARY_DISCLAIMER,
      layer: i.commercial,
    },
    disclaimer: PATIENT_SUMMARY_DISCLAIMER,
  };
}
