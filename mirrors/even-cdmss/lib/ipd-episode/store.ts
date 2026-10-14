/**
 * lib/ipd-episode/store.ts — Neon reads and writes for the IPD Episode Audit engine
 * (`ipd_episode_audits`, `ipd_episode_checkpoints`, `ipd_episode_skips`; migrations/0052).
 *
 * ⚠️ EVERY SQL STRING HERE IS INFERRED against the DDL this build ships in the same commit. It has
 * not been run against Neon — the sandbox has no database. Every path is therefore FAIL-SAFE: a
 * reader returns [] or null on any fault (including "the migration has not run yet"), and a writer
 * returns a status rather than throwing. Nothing here can turn a completed audit into a 500.
 *
 * PHI POSTURE. The only identifying columns written are `encounter_id`, `ip_uid` and `member_id` —
 * link-back keys, the same posture as `ipd_discharge_audits`. No uhid, name, age, gender or
 * contact value is written by any statement in this file. `real_course`, `findings` and
 * `commentary` hold text that has already been through the de-identifier at assembly time.
 *
 * `ip_uid` AND `encounter_id` HOLD THE SAME VALUE, and that is deliberate rather than redundant:
 * `encounter_id` is this engine's own key, and `ip_uid` is the column name the sibling discharge
 * engine and `discharge_extracted_cases` use for the same namespace — so the join in
 * `dischargeEngineScores` below is a column-name match, not a transformation. Neither is ever
 * rewritten.
 */

import { sql } from '../db';
import type { EpisodeFinding, FindingCounters } from './judge-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/** Every degraded path in this file says so. A reader of the logs can tell "no rows" from
 *  "this query has been failing since someone renamed a column", which a bare `.catch(() => [])`
 *  cannot. Truncated: an error string is a log line, not a payload. */
/**
 * A counted column is never null. `0` and `unknown` are different claims about an episode, and a
 * nullable counter is the one that quietly corrupts a cohort: SUM and AVG skip nulls, so a single
 * unwritten column changes the denominator of every aggregate over the table without saying so.
 *
 * The DDL carries DEFAULT 0 as well. Both halves are needed — the default covers a column added to
 * the schema before the INSERT names it, this covers the columns the INSERT already names.
 *
 * NB: `losDays` is deliberately NOT run through this. A missing length of stay IS unknown, and
 * writing 0 would assert a same-day discharge that nothing in the record supports.
 */
function num(v: number | null | undefined): number {
  return Number.isFinite(v as number) ? (v as number) : 0;
}

function warn(label: string, e: unknown): void {
  console.warn(`[ipd-episode/store] ${label} failed (degraded): ${String((e as Error)?.message ?? e).slice(0, 300)}`);
}

/** Which deployment wrote a row. Preview and production share a database (decision 31). */
const APP_SOURCE = process.env.APP_SOURCE || 'standalone';

/** Engine version (decision 27). A bump audits an admission again BESIDE its old row, never over it. */
export const IPD_EPISODE_ENGINE_VERSION = 'ipd-episode-audit/0.1';

/** The sibling engine whose score the UI shows beside this one, labelled as its own (decision 14). */
export const IPD_DISCHARGE_ENGINE_VERSION_FOR_JOIN = 'ipd-discharge-audit/0.2';

/** Skip reasons (§3.1). A closed set — a reason outside it is a bug, not a new category. */
/**
 * ⚠️ `in_progress` AND `timed_out` EXIST BECAUSE A TIMEOUT LEFT NOTHING BEHIND. IPNO-416 hit the
 * 800 s invocation cap and wrote NO audit row and NO skip row — the episode simply vanished, and
 * the next tick would have picked it up as never-attempted and burned another invocation the same
 * way. An `in_progress` row is written BEFORE the model work starts, so if the invocation dies the
 * row survives and says so.
 */
export const SKIP_REASONS = [
  'no_discharge_summary', 'no_notes', 'no_extraction', 'diff_failed', 'fidelity_failed',
  'in_progress', 'timed_out',
] as const;

/** An `in_progress` row older than this is a dead invocation, not a running one, and is retryable.
 *  Comfortably above the 800 s function cap so a LIVE episode is never treated as abandoned. */
export const IN_PROGRESS_STALE_MS = 30 * 60 * 1000;

/** True when an in_progress marker is stale enough to retry. */
export function inProgressIsStale(lastSeen: string | null, now: Date = new Date()): boolean {
  if (!lastSeen) return true;
  const t = Date.parse(lastSeen);
  if (!Number.isFinite(t)) return true;
  return now.getTime() - t > IN_PROGRESS_STALE_MS;
}
export type SkipReason = (typeof SKIP_REASONS)[number];

/** A skipped episode is retried each tick until this many days after discharge, then left alone. */
export const SKIP_RETRY_DAYS = 14;

// ── selection support ────────────────────────────────────────────────────────────────────────

/** Encounter ids already audited at this engine version — condition 4's silent skip (§3.1). */
export async function auditedEncounterIds(engineVersion = IPD_EPISODE_ENGINE_VERSION): Promise<string[]> {
  const rows = await run(
    `SELECT DISTINCT encounter_id FROM ipd_episode_audits WHERE engine_version = $1 AND is_current = TRUE`, [engineVersion],
  ).catch((e: unknown) => { warn('auditedEncounterIds', e); return [] as Record<string, unknown>[]; });
  return rows.map((r) => String(r.encounter_id));
}

export interface SkipRow { encounter_id: string; reason: string; attempts: number; discharged_at: string | null; last_seen: string | null }

export async function skipRows(engineVersion = IPD_EPISODE_ENGINE_VERSION): Promise<SkipRow[]> {
  const rows = await run(
    `SELECT encounter_id, reason, attempts, discharged_at, last_seen FROM ipd_episode_skips WHERE engine_version = $1`, [engineVersion],
  ).catch((e: unknown) => { warn('skipRows', e); return [] as Record<string, unknown>[]; });
  return rows.map((r) => ({
    encounter_id: String(r.encounter_id),
    reason: String(r.reason),
    attempts: Number(r.attempts ?? 0),
    discharged_at: r.discharged_at == null ? null : String(r.discharged_at),
    last_seen: r.last_seen == null ? null : String(r.last_seen),
  }));
}

/**
 * §3.1's retry window, as a PURE decision so it can be tested without a database: a skipped
 * episode is retried until 14 days after its discharge, and then never again. An unknown
 * discharge date is retried — the engine does not stop looking at something it cannot date.
 */
export function skipIsRetryable(dischargedAt: string | null, now: Date = new Date()): boolean {
  if (!dischargedAt) return true;
  const d = Date.parse(dischargedAt);
  if (!Number.isFinite(d)) return true;
  return (now.getTime() - d) < SKIP_RETRY_DAYS * 86_400_000;
}

/**
 * Upsert a skip (§7.3): reason refreshed, `last_seen` bumped, `attempts` incremented.
 *
 * ⚠️ IT CARRIES THE DIAGNOSTICS TOO (round 11 item 4). Stage timings, the checkpoint summary and
 * the prompt/assembled event counts used to live ONLY on the audit row — so they existed on every
 * run that succeeded and on none that failed, which is exactly backwards. IPNO-416 failed twice and
 * left nothing to diagnose but a wall-clock reading taken outside the process.
 *
 * The SKIP ROW was chosen over writing a half-finished audit row: an audit row is what the UI
 * renders and what `is_current` points at, and inventing a partial one risks a surface showing an
 * episode as audited when it was not. A skip row is already the record of "this episode did not
 * produce an audit", so attaching the evidence to it puts the diagnosis where the failure is.
 */
export async function recordSkip(a: {
  encounterId: string; reason: SkipReason; dischargedAt: string | null; engineVersion?: string;
  /** Per-stage wall times, checkpoint summary, event counts — whatever exists when the skip is written. */
  diagnostics?: unknown;
  detail?: string | null;
}): Promise<'recorded' | 'skipped'> {
  try {
    await run(
      `INSERT INTO ipd_episode_skips (encounter_id, engine_version, reason, discharged_at, diagnostics, detail)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (encounter_id, engine_version) DO UPDATE SET
         reason = EXCLUDED.reason, last_seen = NOW(), attempts = ipd_episode_skips.attempts + 1,
         discharged_at = COALESCE(EXCLUDED.discharged_at, ipd_episode_skips.discharged_at),
         -- keep whatever the caller had when it failed; never overwrite evidence with a null
         diagnostics = COALESCE(EXCLUDED.diagnostics, ipd_episode_skips.diagnostics),
         detail = COALESCE(EXCLUDED.detail, ipd_episode_skips.detail)`,
      [a.encounterId, a.engineVersion ?? IPD_EPISODE_ENGINE_VERSION, a.reason, a.dischargedAt,
       a.diagnostics == null ? null : JSON.stringify(a.diagnostics), a.detail ?? null],
    );
    return 'recorded';
  } catch (e) {
    // A skip that cannot be recorded means this episode is retried forever with no trace of why.
    warn('recordSkip', e);
    return 'skipped';
  }
}

/** An episode that now qualifies has no business keeping a skip row. Best-effort. */
export async function clearSkip(encounterId: string, engineVersion = IPD_EPISODE_ENGINE_VERSION): Promise<void> {
  await run(`DELETE FROM ipd_episode_skips WHERE encounter_id = $1 AND engine_version = $2`, [encounterId, engineVersion])
    .catch((e: unknown) => { warn('clearSkip', e); return [] as Record<string, unknown>[]; });
}

// ── the stored extraction (§3.1 condition 3) ─────────────────────────────────────────────────

export interface StoredExtraction { extractionVersion: string; extractedJson: unknown; memberId: string | null; extractedAt: string | null }

/**
 * The extraction for one episode, from `discharge_extracted_cases` keyed on `ip_uid`. Preference
 * order is `doc-extract/2`, then `doc-extract/1`, then the latest `extracted_at` — expressed as an
 * ORDER BY rather than three queries so one round trip settles it.
 *
 * READ-ONLY. This engine never writes to `discharge_extracted_cases` and never extracts a PDF:
 * the nightly discharge worker owns that table and grows this engine's cohort (decision 13).
 */
export async function fetchExtractionByIpUid(ipUid: string): Promise<StoredExtraction | null> {
  const rows = await run(
    `SELECT extraction_version, extracted_json, member_id, extracted_at
     FROM discharge_extracted_cases
     WHERE ip_uid = $1
     ORDER BY (extraction_version = 'doc-extract/2') DESC,
              (extraction_version = 'doc-extract/1') DESC,
              extracted_at DESC NULLS LAST
     LIMIT 1`, [ipUid],
  ).catch((e: unknown) => { warn('fetchExtractionByIpUid', e); return [] as Record<string, unknown>[]; });
  const r = rows[0];
  if (!r) return null;
  return {
    extractionVersion: String(r.extraction_version ?? ''),
    extractedJson: r.extracted_json ?? null,
    memberId: r.member_id == null ? null : String(r.member_id),
    extractedAt: r.extracted_at == null ? null : String(r.extracted_at),
  };
}

// ── the sibling score (decision 14) ──────────────────────────────────────────────────────────

export interface DischargeEngineScore { care_value_index: number | null; band: string | null }

/**
 * The discharge engine's score for a set of encounters, joined on `ip_uid = encounter_id` at the
 * pinned engine version. Read-only, one batched query, and absent rows simply do not appear — the
 * UI renders "not audited by discharge engine" for those rather than a zero.
 */
export async function dischargeEngineScores(encounterIds: string[]): Promise<Record<string, DischargeEngineScore>> {
  const ids = Array.from(new Set(encounterIds.filter((v) => typeof v === 'string' && v.length > 0)));
  if (!ids.length) return {};
  const rows = await run(
    `SELECT DISTINCT ON (ip_uid) ip_uid, care_value_index, band
     FROM ipd_discharge_audits
     WHERE engine_version = $1 AND ip_uid = ANY($2::text[])
     ORDER BY ip_uid, audited_at DESC`, [IPD_DISCHARGE_ENGINE_VERSION_FOR_JOIN, ids],
  ).catch((e: unknown) => {
    // NOT a silent catch. This read is decoration — the surface renders "not audited by discharge
    // engine" without it — but a query that has been failing since a schema change would look
    // exactly the same as a cohort the discharge engine has genuinely never audited, and the
    // second is a fact while the first is a bug. Say which one it is.
    warn('dischargeEngineScores', e);
    return [] as Record<string, unknown>[];
  });
  const out: Record<string, DischargeEngineScore> = {};
  for (const r of rows) {
    out[String(r.ip_uid)] = {
      care_value_index: r.care_value_index == null ? null : Number(r.care_value_index),
      band: r.band == null ? null : String(r.band),
    };
  }
  return out;
}

// ── writes ───────────────────────────────────────────────────────────────────────────────────

export interface EpisodeAuditRow {
  engineVersion: string;
  encounterId: string;
  ipUid: string;
  memberId: string | null;
  facilityName: string | null;
  speciality: string | null;
  admittedAt: string | null;
  dischargedAt: string | null;
  losDays: number | null;
  dischargeType: string | null;
  extractionVersion: string | null;
  divergenceIndex: number | null;
  /** The reported figure. The index is internal — see judge-core's note on the ±5 spread. */
  divergenceBand?: string | null;
  bandUncertain?: boolean;
  /** 'ok' | 'no_expectations' | 'all_capped'. Anything but 'ok' means the number beside it is not
   *  a score, and the UI must not render one. */
  scoringStatus?: string | null;
  completenessPct: number | null;
  counters: FindingCounters;
  /** How many findings any cap touched — recountable from `findings[].capped`. */
  cappedCount: number;
  /** The diff pass's temperature, recorded so the claim is checkable from the row. */
  judgeTemperature?: number | null;
  checkpointPolicy?: string | null;
  checkpointConcurrency?: number | null;
  checkpointWallMs?: number | null;
  /** Events the PROMPTS carried, against what assembly produced — the roll-up ratio. */
  promptEvents?: number | null;
  assembledEvents?: number | null;
  /** ROUND 13 ITEM 3. The A1 user message's size, and how many distinct expectations it carried. */
  diffPromptChars?: number | null;
  digestEntries?: number | null;
  /** ROUND 15 ITEM 1. The absolute penalty and the denominator the rate divides it by. */
  penaltyTotal?: number | null;
  expectationsEvaluated?: number | null;
  /** Per-stage wall times, so the next investigation does not have to guess which stage is slow. */
  timings?: unknown;
  /** Pass B's one un-rederivable input, persisted for the on-demand run (decision 35). */
  admissionContext?: string | null;
  /** present / absent_class_present / absent_class_missing / ambiguous_confounded counts. */
  resolutionCounts?: unknown;
  checkpointCount: number;
  evidenceTiers: unknown;
  realCourse: unknown;
  findings: EpisodeFinding[];
  commentary: unknown;
  modelCheckpoint: string | null;
  modelJudge: string | null;
  traceId: string | null;
  /** Integration facts about an episode that still produced a row: discarded findings, a
   *  rejected commentary, a normalised fidelity shape. */
  errorDetail?: string | null;
  /** Per discarded finding: the raw fragment (truncated) and the validation error that killed it.
   *  A silent loss on the divergence pass is how a third of an episode's findings disappear. */
  rawJudgeError?: unknown;
}

export interface CheckpointWriteRow {
  dayIndex: number;
  checkpointType: 'daily' | 'episode';
  inputCutoffAt: string;
  inputEventCount: number;
  retrievalQuery: string | null;
  retrievalFailed: boolean;
  /** No retrieval was attempted — the query was empty. Not the same as a failure. */
  retrievalSkipped: boolean;
  citationIds: number[];
  expectedCourse: unknown;
  status: 'ok' | 'error';
  errorDetail: string | null;
  model: string | null;
  traceId: string | null;
  /** Entries that cited nothing, and how many there were — scalars, so the grounding failure the
   *  IP-1286 run exposed is queryable without parsing expected_course. */
  uncitedEntryCount: number;
  entryCount: number;
  /** Cited chunk id → its `source`. Records the FACT; the normative/literature split is derived
   *  from it at finalise time, so a later change to the source list can be re-applied to old rows. */
  citationSources: Record<string, string>;
  /** First 100 chars of each retrieved excerpt — what came back, without opening jsonb. */
  retrievedTitles: string[];
  /** A majority of excerpts shared no clinical term with the query. */
  retrievalOffTopic: boolean;
  offTopicExcerptCount: number;
  day0QueryFromOt: boolean;
  /** The generation settings this checkpoint ran with — recorded so a variance investigation has
   *  them rather than trusting that they were what someone said. */
  temperature: number;
  seed: number | null;
  maxTokens: number;
  /** Recorded on EVERY row, not only on failure — `length` means a truncated answer. */
  finishReason: string | null;
  attempts: number;
  entriesTruncated: number;
}

/**
 * Write one audit and its checkpoints. EVERY RUN IS KEPT (V, 2026-09-02).
 *
 * ⚠️ THIS WAS AN UPSERT, AND THE UPSERT WAS DESTROYING THE EVIDENCE. Re-running an episode
 * overwrote its previous row, so the run that scored 88 and the run that scored 96 could not be
 * compared — and comparing them is the only way to see a reproducibility problem at all. Each run
 * is now an INSERT with its own `run_seq`; `is_current` marks exactly one row per
 * (encounter_id, engine_version), and worker selection and the UI list read only that.
 *
 * ⚠️ THE CHECKPOINT FOREIGN KEY NEEDED NO CHANGE, which is worth stating rather than assuming.
 * `ipd_episode_checkpoints.episode_audit_id` references `ipd_episode_audits(id)` — the surrogate
 * uuid, not the (encounter_id, engine_version) pair — so a new run gets a new audit id and its
 * checkpoints attach to it. Previous runs keep their own checkpoint rows intact, and ON DELETE
 * CASCADE still means deleting a run takes its checkpoints with it. The old DELETE-then-insert of
 * checkpoints is gone with the upsert: there is nothing to clear, because the rows it would have
 * cleared belong to a different run.
 *
 * The two writes are sequenced — demote the current row, then insert the new one as current. These
 * are separate statements on the Neon HTTP driver, so a fault between them leaves NO current row
 * rather than two; the UI renders that as an absent episode and the next run repairs it. Two rows
 * claiming to be current would be worse, and the partial unique index makes it impossible anyway.
 *
 * Returns 'skipped' on any fault. The caller logs it; nothing throws.
 */
export async function saveEpisodeAudit(row: EpisodeAuditRow, checkpoints: CheckpointWriteRow[]): Promise<{ status: 'inserted' | 'updated' | 'skipped'; auditId: string | null; failedCheckpoints: number }> {
  try {
    const c = row.counters;
    const seqRows = await run(
      `SELECT COALESCE(MAX(run_seq), 0) + 1 AS next FROM ipd_episode_audits
       WHERE encounter_id = $1 AND engine_version = $2`,
      [row.encounterId, row.engineVersion],
    ).catch((e: unknown) => { warn('saveEpisodeAudit run_seq', e); return [] as Record<string, unknown>[]; });
    const runSeq = Number(seqRows[0]?.next ?? 1) || 1;

    // Demote whatever is current BEFORE inserting, so the partial unique index never sees two.
    await run(
      `UPDATE ipd_episode_audits SET is_current = FALSE
       WHERE encounter_id = $1 AND engine_version = $2 AND is_current = TRUE`,
      [row.encounterId, row.engineVersion],
    ).catch((e: unknown) => { warn('saveEpisodeAudit demote', e); return [] as Record<string, unknown>[]; });

    const res = await run(
      `INSERT INTO ipd_episode_audits (
         run_seq, is_current,
         engine_version, encounter_id, ip_uid, member_id, facility_name, speciality,
         admitted_at, discharged_at, los_days, discharge_type, extraction_version,
         divergence_index, divergence_band, band_uncertain, scoring_status, completeness_pct,
         n_findings, n_divergence_pass, n_fidelity_pass, n_omission, n_commission, n_timing,
         n_sequencing, n_divergent, n_context_dependent, n_unassessable, n_concordant,
         n_low_value, n_dropped_invalid, n_parse_failed,
         n_unassessable_rejected, n_judged_omissions_dropped, n_findings_truncated,
         n_resolver_grouped, n_resolver_ungrouped,
         judge_temperature, resolution_counts,
         checkpoint_policy, checkpoint_concurrency, checkpoint_wall_ms,
         prompt_events, assembled_events, stage_timings,
         capped_count, checkpoint_count, evidence_tiers, real_course, findings, admission_context, commentary,
         model_checkpoint, model_judge, trace_id, error_detail, raw_judge_error,
         diff_prompt_chars, digest_entries, penalty_total, expectations_evaluated, app_source)
       VALUES ($1,TRUE,$2,$3,$4,$5,
               $6,$7,$8,$9,$10,$11,
               $12,$13,$14,$15,$16,$17,
               $18,$19,$20,$21,$22,$23,
               $24,$25,$26,$27,$28,$29,
               $30,$31,$32,$33,$34,$35,
               $36,$37,$38::jsonb,$39,$40,$41,
               $42,$43,$44::jsonb,$45,$46,$47::jsonb,
               $48::jsonb,$49::jsonb,$50,$51::jsonb,$52,$53,
               $54,$55,$56::jsonb,
               $57,$58,$59,$60,$61)
       RETURNING id`,
      [
        runSeq,
        row.engineVersion, row.encounterId, row.ipUid, row.memberId, row.facilityName, row.speciality,
        row.admittedAt, row.dischargedAt, row.losDays, row.dischargeType, row.extractionVersion,
        // NEVER NULL. The DDL defaults these to 0, but a DEFAULT only applies to a column the
        // INSERT omits — and this INSERT names all of them, so a null here would be written as a
        // null. `num` is the half of the guarantee that actually holds on this statement.
        // ⚠️ divergence_index is the ONE counted column that may legitimately be null: under
        // scoring_status 'no_expectations' there is no score, and 0 would read as a catastrophic
        // episode while null reads as "not scorable", which is what actually happened.
        row.divergenceIndex, row.divergenceBand ?? null, row.bandUncertain ?? false,
        row.scoringStatus ?? 'ok', num(row.completenessPct),
        num(c.n_findings), num(c.n_divergence_pass), num(c.n_fidelity_pass), num(c.n_omission),
        num(c.n_commission), num(c.n_timing), num(c.n_sequencing), num(c.n_divergent),
        num(c.n_context_dependent), num(c.n_unassessable), num(c.n_concordant),
        num(c.n_low_value), num(c.n_dropped_invalid), num(c.n_parse_failed),
        num(c.n_unassessable_rejected), num(c.n_judged_omissions_dropped), num(c.n_findings_truncated),
        num(c.n_resolver_grouped), num(c.n_resolver_ungrouped),
        row.judgeTemperature ?? null, JSON.stringify(row.resolutionCounts ?? null),
        row.checkpointPolicy ?? 'standard', row.checkpointConcurrency ?? null, row.checkpointWallMs ?? null,
        row.promptEvents ?? null, row.assembledEvents ?? null, JSON.stringify(row.timings ?? null),
        num(row.cappedCount), num(row.checkpointCount), JSON.stringify(row.evidenceTiers ?? null), JSON.stringify(row.realCourse ?? null),
        JSON.stringify(row.findings ?? []), row.admissionContext ?? null,
        row.commentary == null ? null : JSON.stringify(row.commentary),
        row.modelCheckpoint, row.modelJudge, row.traceId, row.errorDetail ?? null,
        row.rawJudgeError == null ? null : JSON.stringify(row.rawJudgeError),
        // APPENDED, NOT INSERTED. Round 11 renumbered this statement to add a column and left two
        // casts on their old placeholders; the episode ran 314 s and persisted nothing. Adding at
        // the end moves no existing $n, so the diff is two columns and two parameters.
        row.diffPromptChars ?? null, row.digestEntries ?? null,
        // Round 15: NEVER NULL when the episode scored. `num` because a null here would make
        // SUM() and AVG() skip the row in exactly the cohort query these two exist to serve.
        num(row.penaltyTotal), num(row.expectationsEvaluated),
        // ROUND 17 ITEM 5. Written, not defaulted: preview and production share one DATABASE_URL
        // (decision 31), so which deployment produced a row is a real question about the data. The
        // idiom is the repo's own — lib/db.ts, appropriateness-runs.ts, audit-suppression-store.ts.
        // APPENDED, like every addition since round 13. The first attempt put it third in the
        // column list against $59, and the round-12 placeholder gate failed it immediately: that
        // gate requires $1..$N sequential precisely so a renumber cannot go unnoticed.
        APP_SOURCE,
      ],
    );
    const first = res[0];
    const auditId = first?.id == null ? null : String(first.id);
    if (!auditId) return { status: 'skipped', auditId: null, failedCheckpoints: checkpoints.length };

    // No DELETE here any more: this audit id is brand new, so it owns no checkpoint rows, and the
    // previous run's belong to the previous run.
    let failedCheckpoints = 0;
    for (const cp of checkpoints) {
      // $8::int[] — the driver sends a JS array as a Postgres array literal, and without the cast
      // an empty one is ambiguous enough for the server to reject the whole statement. A checkpoint
      // row that vanishes takes input_cutoff_at and input_event_count with it, and those two ARE
      // the blinding proof (§14 step 8) — so this insert must never fail quietly.
      await run(
        `INSERT INTO ipd_episode_checkpoints (
           episode_audit_id, day_index, checkpoint_type, input_cutoff_at, input_event_count,
           retrieval_query, retrieval_failed, citation_ids, expected_course, status, error_detail,
           model, trace_id, uncited_entry_count, entry_count, citation_sources,
           retrieved_titles, retrieval_offtopic, offtopic_excerpt_count, day0_query_from_ot,
           temperature, seed, retrieval_skipped, max_tokens, finish_reason, attempts,
           entries_truncated)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::int[],$9::jsonb,$10,$11,$12,$13,$14,$15,$16::jsonb,
                 $17::text[],$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)`,
        [
          auditId, cp.dayIndex, cp.checkpointType, cp.inputCutoffAt, cp.inputEventCount,
          cp.retrievalQuery, cp.retrievalFailed, cp.citationIds,
          cp.expectedCourse == null ? null : JSON.stringify(cp.expectedCourse),
          cp.status, cp.errorDetail, cp.model, cp.traceId,
          num(cp.uncitedEntryCount), num(cp.entryCount), JSON.stringify(cp.citationSources ?? {}),
          cp.retrievedTitles ?? [], cp.retrievalOffTopic ?? false,
          num(cp.offTopicExcerptCount), cp.day0QueryFromOt ?? false,
          cp.temperature, cp.seed, cp.retrievalSkipped ?? false,
          num(cp.maxTokens), cp.finishReason ?? null, num(cp.attempts), num(cp.entriesTruncated),
        ],
      ).catch((e: unknown) => {
        warn(`saveEpisodeAudit checkpoint day ${cp.dayIndex} (${cp.checkpointType})`, e);
        failedCheckpoints++;
        return [] as Record<string, unknown>[];
      });
    }
    return { status: 'inserted', auditId, failedCheckpoints };
  } catch (e) {
    warn('saveEpisodeAudit (no row written)', e);
    return { status: 'skipped', auditId: null, failedCheckpoints: checkpoints.length };
  }
}

// ── surface reads ────────────────────────────────────────────────────────────────────────────

export type EpisodeListRow = Record<string, unknown>;

/** The list surface. Sortable on divergence index and the sibling discharge score (§10). */
export async function episodeWorklist(a: { limit?: number; sort?: 'divergence' | 'discharge' | 'recent' } = {}): Promise<EpisodeListRow[]> {
  const lim = Math.max(1, Math.min(400, Math.floor(a.limit ?? 200)));
  const rows = await run(
    // ⚠️ EVERY COLUMN THE LIST PAGE READS MUST BE NAMED HERE, and three of them were not.
    // `dbf07b9a` added divergence_band / band_uncertain / scoring_status to the INSERT and to the
    // page, and never to this SELECT — so `r.divergence_band` was undefined on every row and
    // DivergenceChip took its own "no band was stored" branch. The worklist has read
    // "not scorable" for every episode since round 9, on a table full of scored ones. A source
    // -read test now holds this query and the page's field accesses together.
    `SELECT id, encounter_id, ip_uid, speciality, facility_name, admitted_at, discharged_at,
            los_days, discharge_type, divergence_index, divergence_band, band_uncertain,
            scoring_status, completeness_pct,
            n_findings, n_divergent, n_unassessable, n_low_value, n_divergence_pass, n_fidelity_pass,
            n_concordant, capped_count, run_seq,
            penalty_total, expectations_evaluated,
            checkpoint_count, audited_at
     FROM ipd_episode_audits
     WHERE engine_version = $1 AND is_current = TRUE
     ORDER BY discharged_at DESC NULLS LAST
     LIMIT ${lim}`, [IPD_EPISODE_ENGINE_VERSION],
  ).catch((e: unknown) => { warn('episodeWorklist', e); return [] as Record<string, unknown>[]; });
  return rows;
}

export async function episodeAuditById(id: string): Promise<EpisodeListRow | null> {
  if (!/^[0-9a-fA-F-]{10,64}$/.test(id)) return null;
  // ⚠️ ROUND 17 ITEM 6 — NAMED, NOT `SELECT *`. Not a PHI risk on this table (no name, uhid, age,
  // gender or mobile column exists on it by §7.4), but it is the same pattern whose ABSENCE in
  // `episodeWorklist` made the list surface read "not scorable" for every episode for six rounds:
  // a query and a page that disagree about which fields exist, with nothing to fail when they do.
  // Naming them means the detail page's reads are checkable against this list.
  const rows = await run(
    `SELECT id, audited_at, app_source, engine_version, run_seq, is_current,
            encounter_id, ip_uid, member_id, facility_name, speciality,
            admitted_at, discharged_at, los_days, discharge_type, extraction_version,
            divergence_index, divergence_band, band_uncertain, scoring_status, completeness_pct,
            penalty_total, expectations_evaluated,
            n_findings, n_divergence_pass, n_fidelity_pass, n_omission, n_commission, n_timing,
            n_sequencing, n_divergent, n_context_dependent, n_unassessable, n_concordant,
            n_low_value, n_dropped_invalid, n_parse_failed,
            n_unassessable_rejected, n_judged_omissions_dropped, n_findings_truncated,
            n_resolver_grouped, n_resolver_ungrouped,
            judge_temperature, resolution_counts,
            checkpoint_policy, checkpoint_concurrency, checkpoint_wall_ms,
            prompt_events, assembled_events, diff_prompt_chars, digest_entries, stage_timings,
            capped_count, checkpoint_count, evidence_tiers, real_course, findings,
            admission_context, commentary,
            model_checkpoint, model_judge, trace_id, error_detail, raw_judge_error
     FROM ipd_episode_audits WHERE id = $1 LIMIT 1`, [id])
    .catch((e: unknown) => { warn('episodeAuditById', e); return [] as Record<string, unknown>[]; });
  return rows[0] ?? null;
}

/**
 * ROUND 12 / DECISION 35 — the on-demand commentary pair.
 *
 * `commentaryInputsFor` reads back everything pass B needs and NOTHING else, so the route cannot
 * quietly acquire a wider view of the episode than the pipeline gave it. `checkpoint_id` is
 * rebuilt from the stored day_index/type rather than stored twice.
 *
 * The `commentary` column comes back too, because "already generated" is the idempotency check and
 * it must be read in the same statement that reads the inputs — checking in one query and writing
 * after another is how two concurrent page-opens both decide they are the first.
 */
export async function commentaryInputsFor(auditId: string): Promise<{
  auditId: string; encounterId: string; admissionContext: string | null;
  losDays: number | null; findings: unknown; realCourse: unknown;
  commentary: unknown; modelJudge: string | null;
} | null> {
  if (!/^[0-9a-fA-F-]{10,64}$/.test(auditId)) return null;
  const rows = await run(
    `SELECT id, encounter_id, admission_context, los_days, findings, real_course, commentary, model_judge
     FROM ipd_episode_audits WHERE id = $1 LIMIT 1`, [auditId],
  ).catch((e: unknown) => { warn('commentaryInputsFor', e); return [] as Record<string, unknown>[]; });
  const r = rows[0];
  if (!r) return null;
  return {
    auditId: String(r.id), encounterId: String(r.encounter_id),
    admissionContext: r.admission_context == null ? null : String(r.admission_context),
    losDays: r.los_days == null ? null : Number(r.los_days),
    findings: r.findings, realCourse: r.real_course, commentary: r.commentary,
    modelJudge: r.model_judge == null ? null : String(r.model_judge),
  };
}

/**
 * Write the generated commentary back. `WHERE commentary IS NULL` makes the write itself the
 * idempotency guard: if another request got there first its text stands, and this one reports
 * `already` rather than overwriting a good commentary with a second, differently-worded one.
 */
export async function saveCommentary(auditId: string, commentary: unknown): Promise<'saved' | 'already' | 'failed'> {
  if (!/^[0-9a-fA-F-]{10,64}$/.test(auditId)) return 'failed';
  try {
    const rows = await run(
      `UPDATE ipd_episode_audits SET commentary = $2::jsonb
       WHERE id = $1 AND commentary IS NULL RETURNING id`,
      [auditId, JSON.stringify(commentary)],
    );
    return rows.length ? 'saved' : 'already';
  } catch (e) { warn('saveCommentary', e); return 'failed'; }
}

export async function checkpointsForAudit(auditId: string): Promise<EpisodeListRow[]> {
  if (!/^[0-9a-fA-F-]{10,64}$/.test(auditId)) return [];
  return run(
    `SELECT day_index, checkpoint_type, generated_at, input_cutoff_at, input_event_count,
            retrieval_query, retrieval_failed, citation_ids, expected_course, status, error_detail, model,
            uncited_entry_count, entry_count, citation_sources, retrieved_titles, retrieval_offtopic,
            offtopic_excerpt_count, day0_query_from_ot, temperature, seed, retrieval_skipped,
            max_tokens, finish_reason, attempts, entries_truncated
     FROM ipd_episode_checkpoints
     WHERE episode_audit_id = $1
     ORDER BY (checkpoint_type = 'episode'), day_index ASC`, [auditId],
  ).catch((e: unknown) => { warn('checkpointsForAudit', e); return [] as Record<string, unknown>[]; });
}
