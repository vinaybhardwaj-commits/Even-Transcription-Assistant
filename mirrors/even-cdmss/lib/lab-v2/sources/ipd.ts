/**
 * lib/lab-v2/sources/ipd.ts — freezing ONE IPD episode from a stored audit row
 * (LAB-MCP-V2-PRD-v1.0 §17.5, decisions 48 and 50).
 *
 * ⚠️ WHAT AN IPD CASE IS, AND WHY IT IS NOT AN ENCOUNTER.
 *
 * The case key is the AUDIT ROW ID — a surrogate uuid — and never the encounter id. That is
 * decision 50's rule and it is not cosmetic: an encounter id is a live key into db13, so a
 * research object carrying one is a re-identification path stored forever in a research database.
 * A row id resolves to the episode only for someone who already holds production Neon.
 *
 * ⚠️ THE STRIP (decision 50). IPD Episode's owed item 4 measured a patient's first name in clear
 * inside `extracted_json.verbatimSections` on 954 rows. So `verbatimSections` is REMOVED before
 * anything is frozen, `stripped: ['verbatimSections']` is recorded on the case, and the
 * classification is decided AFTER the strip, never before. If any patient-name key survives the
 * strip anywhere in the frozen case, the freeze refuses with CLASSIFICATION_REQUIRED rather than
 * storing it and labelling it.
 *
 * ⚠️ THE ONE THING THE STRIP DOES NOT REMOVE, stated plainly rather than buried: `real_course`
 * events carry `author_name`, which is the CLINICIAN who wrote the note. The engine keeps it
 * deliberately — it feeds the retrieval query's author-name stripping and the finding
 * attribution — so removing it would change the pipeline's behaviour, which is the one thing
 * this round may not do. It is a person's name in a research object and it is flagged in the
 * build report for a ruling.
 *
 * ⚠️ EVERY STATEMENT BELOW IS INFERRED and is listed verbatim in the build report. The column
 * names were confirmed against production Neon through the v1 `audit_query` connector on
 * 06 Sep 2026 — the 19 `extracted_json` keys, the 2 keys of its `patient` object, and the 11 keys
 * of a `real_course` event — before this file was written. Every read is a SELECT and goes
 * through `boundedRead`, i.e. the v1 read-only guard and decision 31's 15 s deadline.
 */
import { createHash } from 'crypto';
import {
  checkpointPlanFromEvents, type EpisodeEvent,
} from '../../ipd-episode/assemble-core';
import { checkpointEntryRefs } from '../../ipd-episode/checkpoint-core';
import type { CheckpointResult } from '../../ipd-episode/checkpoint';
import type { AssembledEpisode } from '../../ipd-episode/assemble';
import type { EpisodeFinding } from '../../ipd-episode/judge-core';
import { LabError, hash } from '../contracts';
import { boundedRead } from './read';
import { memberKeyOf, memberSalt } from './opd';

/** Decision 48 — the engine version the golden A/B is about. */
export const IPD_ENGINE_VERSION = 'ipd-episode-audit/0.2';

/** The two judge stages, and the label each governed call arrives under. */
export const IPD_STAGE_BY_LABEL: Record<string, string> = {
  ipd_episode_diff: 'divergence',
  ipd_episode_fidelity: 'fidelity',
};

/** A checkpoint's label is `ipd_episode_checkpoint_<id>`; every one of them prices as `checkpoint`. */
export function ipdStageForLabel(label: string): string {
  if (label.startsWith('ipd_episode_checkpoint_')) return 'checkpoint';
  return IPD_STAGE_BY_LABEL[label] ?? 'divergence';
}

// ─────────────────────────────────────────────────────────────────────────────────────
// The three inferred statements
// ─────────────────────────────────────────────────────────────────────────────────────

/** A uuid, refused rather than escaped — the only shape an audit row id ever has. */
function uuidLit(value: string, field: string): string {
  if (!/^[0-9a-fA-F-]{36}$/.test(value)) {
    throw new LabError('INVALID_INPUT', `${field} must be a uuid`);
  }
  return `'${value}'`;
}

/** An encounter id: the same conservative charset sources/audits.ts uses for ids. */
function idLit(value: string, field: string): string {
  if (!/^[A-Za-z0-9._:/-]{1,128}$/.test(value)) {
    throw new LabError('INVALID_INPUT', `${field} contains characters that are not allowed here`);
  }
  return `'${value}'`;
}

export const AUDIT_ROW_SQL = (auditId: string) => `SELECT
  id, engine_version, audited_at, is_current, run_seq,
  encounter_id, ip_uid, member_id,
  facility_name, speciality, admitted_at, discharged_at, los_days, discharge_type, extraction_version,
  divergence_index, divergence_band, band_uncertain, scoring_status, completeness_pct,
  n_findings, n_divergence_pass, n_fidelity_pass, n_omission, n_commission, n_timing, n_sequencing,
  n_divergent, n_context_dependent, n_unassessable, n_concordant, n_low_value,
  n_dropped_invalid, n_parse_failed, n_unassessable_rejected, n_judged_omissions_dropped,
  n_findings_truncated, n_resolver_grouped, n_resolver_ungrouped,
  judge_temperature, resolution_counts, capped_count,
  checkpoint_policy, checkpoint_concurrency, prompt_events, assembled_events,
  diff_prompt_chars, digest_entries, penalty_total, expectations_evaluated,
  checkpoint_count, evidence_tiers, real_course, findings, admission_context,
  model_checkpoint, model_judge, error_detail
FROM ipd_episode_audits WHERE id = ${uuidLit(auditId, 'audit_id')} LIMIT 1`;

export const CHECKPOINT_ROWS_SQL = (auditId: string) => `SELECT
  day_index, checkpoint_type, anchor_kind, input_cutoff_at, input_event_count,
  retrieval_query, retrieval_failed, retrieval_skipped, retrieval_offtopic, offtopic_excerpt_count,
  query_underspecified, day0_query_from_ot, citation_ids, citation_sources, retrieved_titles,
  expected_course, status, error_detail, model, temperature, seed, max_tokens, finish_reason,
  attempts, entries_truncated, uncited_entry_count, entry_count
FROM ipd_episode_checkpoints WHERE episode_audit_id = ${uuidLit(auditId, 'audit_id')}
ORDER BY input_cutoff_at, day_index LIMIT 64`;

export const EXTRACTION_SQL = (ipUid: string) => `SELECT extraction_version, extracted_json
FROM discharge_extracted_cases WHERE ip_uid = ${idLit(ipUid, 'ip_uid')}
ORDER BY (extraction_version = 'doc-extract/2') DESC, (extraction_version = 'doc-extract/1') DESC,
         extracted_at DESC NULLS LAST
LIMIT 1`;

/**
 * §17.6 DECISIONS 74 AND 75 — resolve an audit row to its REAL episode, and ask whether that
 * episode is already at the target version.
 *
 * ⚠️ BOTH HALVES EXIST BECAUSE OF THE SAME FAILURE. Round B3's `reaudit_execute` planned by AUDIT
 * ROW and repaired a case that already had a current row at the target version beside the old one
 * (decision 74), and it repaired a FROZEN handle instead of the episode (decision 75). The
 * `already_at_version` subquery is keyed on `encounter_id`, not on the row: qualification is a
 * property of the EPISODE, and an episode with a current row at the target has nothing to repair.
 *
 * ⚠️ THE ENCOUNTER ID LEAVES THIS FUNCTION, and that is the ruled exception, not an oversight.
 * Decision 50 keeps it out of a research CASE KEY and decision 64 keeps it out of the repository;
 * decision 75 requires the repair to run on the real episode, which cannot happen without it. It
 * travels in the run ITEM's payload, never in the plan object and never in a dataset.
 */
export const EPISODE_QUALIFY_SQL = (auditIds: readonly string[], targetVersion: string) => {
  const ids = auditIds.map((id) => uuidLit(id, 'audit_id')).join(', ');
  if (!ids) throw new LabError('INVALID_INPUT', 'no audit ids to resolve');
  return `SELECT a.id AS audit_id, a.encounter_id, a.ip_uid,
  a.engine_version AS current_engine_version, a.is_current,
  EXISTS (
    SELECT 1 FROM ipd_episode_audits t
    WHERE t.encounter_id = a.encounter_id AND t.is_current
      AND t.engine_version = ${idLit(targetVersion, 'engine_version')}
  ) AS already_at_version
FROM ipd_episode_audits a
WHERE a.id IN (${ids})
ORDER BY a.audited_at
LIMIT ${Math.max(1, Math.min(200, auditIds.length))}`;
};

/** §17.6 decision 74, OPD side: qualification is per uid, not per audit row. */
export const OPD_QUALIFY_SQL = (uids: readonly string[], targetVersion: string) => {
  const list = uids.map((u) => idLit(u, 'uid')).join(', ');
  if (!list) throw new LabError('INVALID_INPUT', 'no uids to resolve');
  return `SELECT o.uid, o.engine_version AS current_engine_version,
  EXISTS (
    SELECT 1 FROM opd_note_audits t
    WHERE t.uid = o.uid AND t.engine_version = ${idLit(targetVersion, 'engine_version')}
  ) AS already_at_version
FROM opd_note_audits o
WHERE o.uid IN (${list})
ORDER BY o.uid
LIMIT ${Math.max(1, Math.min(500, uids.length))}`;
};

export interface EpisodeRef {
  audit_id: string;
  encounter_id: string;
  ip_uid: string;
  current_engine_version: string | null;
  already_at_version: boolean;
}

/** Resolve and qualify, in one read. Used by `reaudit_plan`; never by a dataset freeze. */
export async function resolveEpisodesForRepair(
  auditIds: readonly string[], targetVersion: string,
  read: (sql: string) => Promise<Record<string, unknown>[]> = (q) => boundedRead('ipd_episode_audits', q, [], 200),
): Promise<EpisodeRef[]> {
  const rows = await read(EPISODE_QUALIFY_SQL(auditIds, targetVersion));
  return rows.map((r) => ({
    audit_id: String(r.audit_id),
    encounter_id: String(r.encounter_id),
    ip_uid: String(r.ip_uid ?? r.encounter_id),
    current_engine_version: r.current_engine_version == null ? null : String(r.current_engine_version),
    already_at_version: r.already_at_version === true,
  }));
}

/** The same question for OPD: does this uid already carry a row at the target version? */
export async function resolveOpdForRepair(
  uids: readonly string[], targetVersion: string,
  read: (sql: string) => Promise<Record<string, unknown>[]> = (q) => boundedRead('opd_note_audits', q, [], 500),
): Promise<Map<string, { current_engine_version: string | null; already_at_version: boolean }>> {
  const rows = await read(OPD_QUALIFY_SQL(uids, targetVersion));
  const out = new Map<string, { current_engine_version: string | null; already_at_version: boolean }>();
  for (const r of rows) {
    const uid = String(r.uid);
    const already = r.already_at_version === true;
    const prior = out.get(uid);
    // A uid can have several rows; ANY current row at the target disqualifies the episode.
    out.set(uid, {
      current_engine_version: r.current_engine_version == null ? null : String(r.current_engine_version),
      already_at_version: already || prior?.already_at_version === true,
    });
  }
  return out;
}

export const COHORT_SQL = (engineVersion: string, limit: number) => `SELECT id, encounter_id
FROM ipd_episode_audits
WHERE engine_version = ${idLit(engineVersion, 'engine_version')} AND is_current
ORDER BY audited_at
LIMIT ${Math.max(1, Math.min(200, Math.floor(limit)))}`;

// ─────────────────────────────────────────────────────────────────────────────────────
// Decision 50 — the strip and the classification gate
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A key that names a PATIENT. Deliberately narrower than sources/requests.ts's denylist, and the
 * narrowing is the decision: `author_name` is the clinician who wrote a note, the engine reads it,
 * and a rule broad enough to catch it would refuse every episode there is. What decision 50 asks
 * about is the patient, so this asks about the patient.
 */
export const PATIENT_NAME_KEY =
  /^(patient|member|subject|person)_?(name|first_?name|last_?name|full_?name|surname)$|^(name|first_?name|last_?name|full_?name|surname)$/i;

/** Every key at every depth, arrays walked. */
export function keysOf(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 12 || value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) { for (const v of value) keysOf(v, out, depth + 1); return out; }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) { out.push(k); keysOf(v, out, depth + 1); }
  return out;
}

/** Decision 50 — remove `verbatimSections` wherever it appears, and say that it was removed. */
export function stripVerbatimSections(value: unknown): { value: unknown; stripped: string[] } {
  const stripped: string[] = [];
  const walk = (v: unknown, depth = 0): unknown => {
    if (depth > 12 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'verbatimSections') { if (!stripped.includes(k)) stripped.push(k); continue; }
      out[k] = walk(x, depth + 1);
    }
    return out;
  };
  return { value: walk(value), stripped };
}

// ─────────────────────────────────────────────────────────────────────────────────────
// The frozen case
// ─────────────────────────────────────────────────────────────────────────────────────

export interface FrozenIpdEnvelope {
  encounterId: string;
  memberId: string | null;
  facilityName: string | null;
  speciality: string | null;
  admittedAt: string;
  dischargedAt: string | null;
  losDays: number | null;
  dischargeType: string | null;
  treatingDepartmentName: string | null;
  admissionType: string | null;
  admitSource: string | null;
  remarks: string | null;
  responsibleClinicianId: string | null;
}

export interface FrozenIpd {
  audit_id: string;
  engine_version: string;
  /** The pipeline's own encounter handle. A SYNTHETIC id, never db13's — see the header. */
  episode_ref: string;
  envelope: FrozenIpdEnvelope;
  real_course: EpisodeEvent[];
  sources_present: string[];
  extraction: { extraction_version: string | null; extracted_case: unknown };
  checkpoints: Record<string, CheckpointResult>;
  /** Decision 48 — the stored judge outputs, keyed by the request hash the gateway computes. */
  steps: Record<string, { stage: string; request_hash: string; completion: unknown; text: string; served: { provider: string; model: string | null } | null }>;
  admission_context: string | null;
  models: { checkpoint: string | null; judge: string | null };
  stripped: string[];
  /** The stored row's deterministic fields — the left-hand side of decision 48's comparison. */
  stored: Record<string, unknown>;
}

export interface FrozenIpdCase { case_key: string; member_key: string | null; frozen: FrozenIpd; source_versions: Record<string, unknown> }

/**
 * DECISION 48 — the stored row's DETERMINISTIC fields, and only those.
 *
 * What is in: the findings (every field the pipeline derives), the denominators and counters, the
 * score and its status, and one verdict line per checkpoint. What is out, and why: `audited_at`,
 * every `*_ms`, `trace_id`, `run_seq` and `error_detail` — all of them true of the RUN rather than
 * of the episode, and a comparison that included them would fail for reasons that say nothing
 * about whether the extraction changed the answer.
 */
export function deterministicFields(row: Record<string, unknown>, checkpoints: { checkpointId: string; status: string; entryCount: number; uncitedEntryCount: number; inputEventCount: number; cutoffAt: string }[]): Record<string, unknown> {
  const num = (v: unknown) => (v == null ? null : Number(v));
  return {
    findings: row.findings ?? [],
    scoring_status: row.scoring_status ?? null,
    divergence_index: num(row.divergence_index),
    divergence_band: row.divergence_band ?? null,
    band_uncertain: row.band_uncertain === true,
    penalty_total: num(row.penalty_total),
    expectations_evaluated: num(row.expectations_evaluated),
    completeness_pct: num(row.completeness_pct),
    capped_count: num(row.capped_count),
    counters: {
      n_findings: num(row.n_findings), n_divergence_pass: num(row.n_divergence_pass),
      n_fidelity_pass: num(row.n_fidelity_pass), n_omission: num(row.n_omission),
      n_commission: num(row.n_commission), n_timing: num(row.n_timing),
      n_sequencing: num(row.n_sequencing), n_divergent: num(row.n_divergent),
      n_context_dependent: num(row.n_context_dependent), n_unassessable: num(row.n_unassessable),
      n_concordant: num(row.n_concordant), n_low_value: num(row.n_low_value),
      n_dropped_invalid: num(row.n_dropped_invalid), n_parse_failed: num(row.n_parse_failed),
      n_unassessable_rejected: num(row.n_unassessable_rejected),
      n_judged_omissions_dropped: num(row.n_judged_omissions_dropped),
      n_findings_truncated: num(row.n_findings_truncated),
      n_resolver_grouped: num(row.n_resolver_grouped),
      n_resolver_ungrouped: num(row.n_resolver_ungrouped),
    },
    resolution_counts: row.resolution_counts ?? null,
    checkpoint_count: num(row.checkpoint_count),
    assembled_events: num(row.assembled_events),
    prompt_events: num(row.prompt_events),
    evidence_tiers: row.evidence_tiers ?? null,
    checkpoints: [...checkpoints]
      .sort((a, b) => a.checkpointId.localeCompare(b.checkpointId))
      .map((c) => ({
        checkpoint_id: c.checkpointId, status: c.status, entry_count: c.entryCount,
        uncited_entry_count: c.uncitedEntryCount, input_event_count: c.inputEventCount,
        input_cutoff_at: c.cutoffAt,
      })),
  };
}

/** ISO, or null. Postgres hands back a Date for a timestamptz and a string for jsonb. */
function iso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

/** One stored checkpoint row → the `CheckpointResult` the pipeline would have produced. */
export function checkpointResultFrom(r: Record<string, unknown>): CheckpointResult {
  const type = String(r.checkpoint_type) === 'episode' ? 'episode' : 'daily';
  const dayIndex = Number(r.day_index ?? 0);
  const checkpointId = type === 'episode' ? 'cp-episode' : `cp-d${dayIndex}`;
  const course = (r.expected_course ?? null) as CheckpointResult['expectedCourse'];
  const citationIds = Array.isArray(r.citation_ids) ? (r.citation_ids as unknown[]).map(Number) : [];
  return {
    checkpointId,
    dayIndex,
    checkpointType: type,
    anchorKind: String(r.anchor_kind ?? 'episode'),
    cutoffAt: iso(r.input_cutoff_at) ?? '',
    inputEventCount: Number(r.input_event_count ?? 0),
    retrievalQuery: String(r.retrieval_query ?? ''),
    retrievalFailed: r.retrieval_failed === true,
    retrievalSkipped: r.retrieval_skipped === true,
    citationIds,
    citationSources: (r.citation_sources ?? {}) as Record<string, string>,
    retrievedTitles: Array.isArray(r.retrieved_titles) ? (r.retrieved_titles as string[]) : [],
    retrievalOffTopic: r.retrieval_offtopic === true,
    offTopicExcerptCount: Number(r.offtopic_excerpt_count ?? 0),
    // NOT STORED on the checkpoint row. It feeds one sentence of `error_detail` and nothing the
    // score reads, so a frozen replay reports 0 and the build report says so.
    normativeDropped: 0,
    day0QueryFromOt: r.day0_query_from_ot === true,
    queryUnderspecified: r.query_underspecified === true,
    temperature: Number(r.temperature ?? 0),
    seed: r.seed == null ? null : Number(r.seed),
    model: String(r.model ?? ''),
    maxTokens: Number(r.max_tokens ?? 0),
    finishReason: r.finish_reason == null ? null : String(r.finish_reason),
    attempts: Number(r.attempts ?? 0),
    entriesTruncated: Number(r.entries_truncated ?? 0),
    retrievalMs: 0,
    wallMs: 0,
    promptEvents: Number(r.input_event_count ?? 0),
    inputEventsRaw: Number(r.input_event_count ?? 0),
    expectedCourse: course,
    entryRefs: checkpointEntryRefs(checkpointId, course),
    status: String(r.status ?? 'ok') as CheckpointResult['status'],
    errorDetail: r.error_detail == null ? null : String(r.error_detail),
    uncitedEntryCount: Number(r.uncited_entry_count ?? 0),
    entryCount: Number(r.entry_count ?? 0),
    retriedForCitations: false,
  } as CheckpointResult;
}

/**
 * DECISION 48 — the stored judge output, back in the shape the model returned it.
 *
 * ⚠️ THIS IS AN INVERSION, AND IT IS EXACT FOR THE FIELDS THE PARSER READS. `finalizeFindings`
 * stamps `verdict_before_cap` and `severity_before_cap` from the finding AS PARSED, before any of
 * the four rewrite rules ran, precisely so the caps can be recounted from a stored row. So those
 * two columns ARE the parsed values, and feeding them back re-enters the pipeline at the same
 * point. `citation_ids` are stored as resolved chunk ids and are inverted to ordinals against the
 * referencing checkpoint's own `citation_ids` array, which is the map that produced them.
 *
 * ⚠️ WHAT IT CANNOT INVERT, said out loud: a finding the pipeline DISCARDED is not on the row, so
 * `n_parse_failed` and `n_dropped_invalid` replay as 0. Both are 0 on all 59 stored 0.2 rows, so
 * nothing is being papered over here — but on a row where they are not, the freeze refuses rather
 * than producing a case that would fail the comparison for a reason that is not the extraction.
 */
/**
 * ⚠️ THE TWO RULES THAT REWRITE A STATEMENT BY APPENDING TO IT, and why the inversion must undo
 * them. Measured on production Neon, 06 Sep 2026: two of the 60 current 0.2 rows replayed with a
 * finding whose statement was 204 characters longer than the stored one, and the extra 204 were
 * the escalation-conditional sentence, present twice.
 *
 * `enforceEscalationConditional` (judge-core.ts:424) and `resolveContradictions` (judge-core.ts:888)
 * both emit `${f.statement} …explanation`. The stored statement therefore already CARRIES the
 * explanation; feed it back unchanged and the rule fires a second time and appends a second copy.
 * So the suffix is removed before the reply is rebuilt, and the rule re-adds exactly what it added
 * the first time.
 *
 * ⚠️ THEY ARE COPIES OF A LITERAL IN A FILE THIS ROUND MAY NOT EDIT, so a test pins each pattern
 * against `judge-core.ts`'s own source. A reword there fails the gate instead of silently
 * producing double-suffixed statements on every replay of an escalation finding.
 */
export const STATEMENT_RULE_SUFFIXES: readonly RegExp[] = [
  / This is measured against an escalation trigger — a conditional whose antecedent \(vitals, bedside observation\) this pipeline does not carry — so whether the action was required cannot be established here\.$/,
  / ⚠️ Another finding in this same audit \([^)]*\) reports this on the record, so this absence is contradicted by the engine's own evidence and is not asserted\.$/,
];

/** Remove every rule-appended sentence from the end of a stored statement, however many there are. */
export function unappendRuleSuffixes(statement: string): string {
  let out = statement;
  for (let guard = 0; guard < 8; guard += 1) {
    const before = out;
    for (const re of STATEMENT_RULE_SUFFIXES) out = out.replace(re, '');
    if (out === before) break;
  }
  return out;
}

export function judgeRepliesFrom(
  findings: EpisodeFinding[], checkpoints: Record<string, CheckpointResult>,
): { divergence: string; fidelity: string } {
  const ordinalsFor = (f: EpisodeFinding): number[] => {
    if (!f.checkpoint_ref || !f.citation_ids?.length) return [];
    const cp = checkpoints[f.checkpoint_ref.split('/')[0]];
    if (!cp) return [];
    const out: number[] = [];
    for (const id of f.citation_ids) {
      const at = cp.citationIds.indexOf(Number(id));
      if (at >= 0) out.push(at + 1);
    }
    return out;
  };
  const asReply = (pass: 'divergence' | 'fidelity', prefix: string) => {
    const list = findings
      .filter((f) => f.resolution == null && f.pass === pass)
      .map((f) => ({
        finding_id: String(f.finding_id).startsWith(`${prefix}-`) ? String(f.finding_id).slice(prefix.length + 1) : f.finding_id,
        finding_type: f.finding_type,
        // The PARSED verdict and severity — see the header. `*_before_cap` is null only on a
        // finding no rule ever touched, in which case the emitted value IS the parsed one.
        verdict: f.verdict_before_cap ?? f.verdict,
        severity: f.severity_before_cap ?? f.severity,
        domain: f.domain,
        day_index: f.day_index,
        checkpoint_ref: f.checkpoint_ref,
        // See STATEMENT_RULE_SUFFIXES: the stored statement carries what the rules appended.
        statement: unappendRuleSuffixes(f.statement),
        evidence_tier: f.evidence_tier,
        evidence_basis: f.evidence_basis ?? [],
        lvc_category: f.lvc_category,
        citation_ids: ordinalsFor(f),
      }));
    return JSON.stringify({ findings: list });
  };
  return { divergence: asReply('divergence', 'a1'), fidelity: asReply('fidelity', 'a2') };
}

/** A completion in the shape `contentOf`/`finishReasonOf` read (lib/ipd-episode/model-call.ts). */
export function completionOf(text: string) {
  return { choices: [{ finish_reason: 'stop', message: { content: text } }] };
}

/**
 * The assembled episode a frozen case stands for. `notes` is empty by construction: assembly
 * notes are a property of the READ, not of the episode, and the stored row does not carry them.
 */
export function assembledFrom(f: FrozenIpd): AssembledEpisode {
  return {
    envelope: { ...f.envelope, encounterId: f.episode_ref } as AssembledEpisode['envelope'],
    events: f.real_course,
    sourcesPresent: f.sources_present,
    notes: [],
  };
}

/** The plan the pipeline will build from this frozen course — used to check the freeze is whole. */
export function planIdsFor(f: FrozenIpd): string[] {
  return checkpointPlanFromEvents({
    admittedAt: f.envelope.admittedAt,
    dischargedAt: f.envelope.dischargedAt,
    losDays: f.envelope.losDays,
    events: f.real_course,
  }).map((p) => p.checkpoint_id);
}

/**
 * A stable, non-reversing handle for the episode inside the frozen case.
 *
 * The pipeline threads `encounterId` through every skip, every checkpoint row and the audit row it
 * builds, so it needs SOMETHING. It must not be the real encounter id (decision 50), and it must
 * be stable across freezes of the same row or two freezes would produce two different results for
 * one episode. `sha256(audit_id)`, truncated, is both.
 */
export function episodeRefFor(auditId: string): string {
  return `EPFROZEN${createHash('sha256').update(auditId).digest('hex').slice(0, 16).toUpperCase()}`;
}

export interface IpdFreezeDeps {
  readAudit?: (auditId: string) => Promise<Record<string, unknown>[]>;
  readCheckpoints?: (auditId: string) => Promise<Record<string, unknown>[]>;
  readExtraction?: (ipUid: string) => Promise<Record<string, unknown>[]>;
  /** Supplied by the adapter module so this file never imports the pipeline. */
  recordSteps?: (f: FrozenIpd) => Promise<FrozenIpd['steps']>;
}

const liveDeps: Required<Omit<IpdFreezeDeps, 'recordSteps'>> = {
  readAudit: (auditId) => boundedRead('ipd_episode_audits', AUDIT_ROW_SQL(auditId), [], 1),
  readCheckpoints: (auditId) => boundedRead('ipd_episode_checkpoints', CHECKPOINT_ROWS_SQL(auditId), [], 64),
  readExtraction: (ipUid) => boundedRead('discharge_extracted_cases', EXTRACTION_SQL(ipUid), [], 1),
};

/**
 * Freeze one episode. Three reads, one strip, one classification gate, one inversion.
 *
 * `recordSteps` is the pass that keys the stored judge outputs by the request hash the gateway
 * would compute — it runs the pipeline once against this very case with a recording edge, so the
 * keys are the hashes a replay will actually produce rather than hashes this file guessed at. It
 * is injected because it needs the adapter, and the adapter needs this file.
 */
export async function freezeIpdCase(auditId: string, deps: IpdFreezeDeps = {}): Promise<FrozenIpdCase> {
  const d = { ...liveDeps, ...deps };
  const rows = await d.readAudit(auditId);
  const row = rows[0];
  if (!row) throw new LabError('CASE_NOT_FOUND', `no ipd_episode_audits row ${auditId}`);
  if (row.is_current !== true) {
    throw new LabError('INVALID_INPUT', `audit row ${auditId} is not is_current — a superseded run is not a case`);
  }
  if (Number(row.n_parse_failed ?? 0) > 0 || Number(row.n_dropped_invalid ?? 0) > 0) {
    // See judgeRepliesFrom's header: a discarded finding is not on the row, so it cannot be
    // put back, and a case that cannot be put back whole must not be frozen as though it could.
    throw new LabError('SOURCE_UNAVAILABLE',
      `audit row ${auditId} discarded ${row.n_parse_failed} unparseable and ${row.n_dropped_invalid} invalid finding(s): the stored row is not a complete record of what the judge returned`);
  }

  const cpRows = await d.readCheckpoints(auditId);
  const checkpoints: Record<string, CheckpointResult> = {};
  for (const r of cpRows) {
    const cp = checkpointResultFrom(r);
    checkpoints[cp.checkpointId] = cp;
  }

  const extRows = await d.readExtraction(String(row.ip_uid ?? row.encounter_id));
  if (!extRows.length) {
    throw new LabError('SOURCE_UNAVAILABLE', `no discharge_extracted_cases row for the episode behind audit ${auditId}`);
  }
  const strip = stripVerbatimSections(extRows[0].extracted_json);

  /**
   * ⚠️ AND IT HAS TO REACH `real_course` TOO — decision 50 named the extraction, and the extraction
   * is not the only place it is.
   *
   * Measured on production Neon, 06 Sep 2026: 49 of the 60 current 0.2 rows carry
   * `real_course[].detail.extracted_case.verbatimSections` — an array of `{heading, text}` whose
   * `text` is raw discharge-summary prose. Assembly puts the extracted case on the DISCHARGE event
   * (lib/ipd-episode/assemble.ts), so the stored course carries a second copy of exactly the field
   * IPD Episode's owed item 4 measured a patient's first name inside. A freeze that stripped only
   * the extraction would have copied 49 of them into the research store and called the result
   * de-identified. Stripping both is what makes the classification gate below tell the truth.
   *
   * IT IS SAFE FOR THE COMPARISON. The discharge event is filtered out of every checkpoint and out
   * of the diff pass, so nothing the score reads can see it; only the fidelity PROMPT changes, and
   * that prompt is hashed from the stripped course on both sides of a replay.
   */
  const courseStrip = stripVerbatimSections(row.real_course ?? []);

  const tiers = (row.evidence_tiers ?? { A: [], B: [], C: [] }) as { A?: string[]; B?: string[]; C?: string[] };
  const sourcesPresent = [...(tiers.A ?? []), ...(tiers.B ?? []), ...(tiers.C ?? [])];

  const frozen: FrozenIpd = {
    audit_id: String(row.id),
    engine_version: String(row.engine_version),
    episode_ref: episodeRefFor(String(row.id)),
    envelope: {
      encounterId: episodeRefFor(String(row.id)),
      // The member id is NEVER frozen; only its salted hash travels, on the case (decision 44).
      memberId: null,
      facilityName: row.facility_name == null ? null : String(row.facility_name),
      speciality: row.speciality == null ? null : String(row.speciality),
      admittedAt: iso(row.admitted_at) ?? '',
      dischargedAt: iso(row.discharged_at),
      losDays: row.los_days == null ? null : Number(row.los_days),
      dischargeType: row.discharge_type == null ? null : String(row.discharge_type),
      // NOT STORED on the audit row. The admission context line the pipeline built IS stored, and
      // the adapter feeds it back whole, so these four are unused on a frozen replay.
      treatingDepartmentName: null, admissionType: null, admitSource: null, remarks: null,
      responsibleClinicianId: null,
    },
    real_course: courseStrip.value as EpisodeEvent[],
    sources_present: sourcesPresent,
    extraction: {
      extraction_version: extRows[0].extraction_version == null ? null : String(extRows[0].extraction_version),
      extracted_case: strip.value,
    },
    checkpoints,
    steps: {},
    admission_context: row.admission_context == null ? null : String(row.admission_context),
    models: {
      checkpoint: row.model_checkpoint == null ? null : String(row.model_checkpoint),
      judge: row.model_judge == null ? null : String(row.model_judge),
    },
    stripped: [...new Set([...strip.stripped, ...courseStrip.stripped])],
    stored: deterministicFields(row, Object.values(checkpoints)),
  };

  // ── decision 50's gate, AFTER the strip and over the WHOLE frozen case ────────────────
  const survivors = [...new Set(keysOf(frozen).filter((k) => PATIENT_NAME_KEY.test(k)))];
  if (survivors.length) {
    throw new LabError('CLASSIFICATION_REQUIRED',
      `the frozen case still carries patient-name key(s) after the strip: ${survivors.join(', ')}`);
  }
  if (keysOf(frozen).includes('verbatimSections')) {
    throw new LabError('CLASSIFICATION_REQUIRED', 'verbatimSections survived the strip');
  }

  // The plan the pipeline will build must be exactly the checkpoints that were stored, or the
  // replay would ask for a checkpoint the freeze cannot serve — which is a divergence, not a gap.
  const planned = planIdsFor(frozen);
  const missing = planned.filter((id) => !checkpoints[id]);
  if (missing.length) {
    throw new LabError('SOURCE_UNAVAILABLE',
      `the frozen course re-plans to checkpoint(s) the stored row does not carry: ${missing.join(', ')} (stored: ${Object.keys(checkpoints).join(', ') || 'none'})`);
  }

  if (deps.recordSteps) frozen.steps = await deps.recordSteps(frozen);

  const memberId = row.member_id == null ? '' : String(row.member_id);
  const member_key = memberId ? memberKeyOf(memberId, memberSalt()) : null;

  return {
    case_key: frozen.audit_id,
    member_key,
    frozen,
    source_versions: {
      engine_version: frozen.engine_version,
      audited_at: iso(row.audited_at),
      checkpoints: cpRows.length,
      extraction_version: frozen.extraction.extraction_version,
      stripped: frozen.stripped,
      stored_hash: hash(frozen.stored),
    },
  };
}

/** Decision 48's cohort: every current row at one engine version, oldest first. */
export async function selectIpdCohort(
  engineVersion: string, limit: number,
  read: (sql: string) => Promise<Record<string, unknown>[]> = (s) => boundedRead('ipd_episode_audits', s, [], 200),
): Promise<string[]> {
  const rows = await read(COHORT_SQL(engineVersion, limit));
  return rows.map((r) => String(r.id));
}
