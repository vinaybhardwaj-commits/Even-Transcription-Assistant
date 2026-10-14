/**
 * lib/lab-v2/__tests__/fixtures/ipd-stored.ts — a synthetic `ipd_episode_audits` row, produced by
 * running the real pipeline and writing down what it wrote.
 *
 * ⚠️ WHY IT IS GENERATED AND NOT COPIED. A real 0.2 row carries a patient's admission: the
 * assembled course, the progress-note text, the clinician who wrote each note. None of that
 * belongs in a public repository, and this repository has had PHI history rewritten once. So the
 * fixture is MANUFACTURED: `computeEpisodeAudit` is run on the synthetic episode in
 * `episode-fixture.ts` with two judge replies supplied, and the row it hands to
 * `saveEpisodeAudit` is reshaped into the snake_case a stored row has. It is a real row in every
 * respect except that nobody was ever admitted.
 *
 * ⚠️ AND THE JUDGE FINDINGS ARE NOT EMPTY, deliberately. `judgeRepliesFrom` inverts stored
 * findings back into the model reply that produced them; a fixture whose judge returned nothing
 * would exercise none of that. Both passes return findings here, one of them citing a checkpoint
 * excerpt, so the ordinal inversion has something to invert.
 */
import { withLabExecution } from '../../../lab-execution-context';
import { computeEpisodeAudit, type EpisodeComputeDependencies } from '../../../ipd-episode/compute';
import type { EpisodeAuditRow, CheckpointWriteRow } from '../../../ipd-episode/store';
import { fixtureDeps, fixtureLedger, FIXTURE_ENCOUNTER } from './episode-fixture';

export const A1_REPLY = JSON.stringify({
  findings: [
    {
      finding_id: '1', finding_type: 'commission', verdict: 'divergent', domain: 'therapeutics',
      day_index: 1, checkpoint_ref: 'cp-d1/therapeutics/1',
      statement: 'a third-generation cephalosporin was continued for three days after an uncomplicated appendicectomy',
      severity: 'moderate', evidence_tier: 'A',
      evidence_basis: [{ source_table: 'kx_clinical_template_progress_reports', source_record_id: 'fx-src-4', source_timestamp: '2026-08-02T09:15:00.000Z' }],
      lvc_category: 'antibiotic', citation_ids: [2],
    },
    {
      finding_id: '2', finding_type: 'timing', verdict: 'context_dependent', domain: 'diagnostics',
      day_index: 2, checkpoint_ref: 'cp-d2/diagnostics/1',
      statement: 'the repeat full blood count was taken on day 2 rather than day 1',
      severity: 'minor', evidence_tier: 'B', evidence_basis: [], lvc_category: null, citation_ids: [1],
    },
  ],
});

export const A2_REPLY = JSON.stringify({
  findings: [
    {
      finding_id: '1', finding_type: 'commission', verdict: 'divergent', domain: 'documentation',
      day_index: 3, checkpoint_ref: null,
      statement: 'the discharge summary names a procedure the course does not record',
      severity: 'major', evidence_tier: 'C', evidence_basis: [], lvc_category: null, citation_ids: [],
    },
  ],
});

/** The pipeline, run once, with the two judge replies above. Deterministic. */
export async function runFixtureEpisode(): Promise<{ row: EpisodeAuditRow; checkpoints: CheckpointWriteRow[] }> {
  const ledger = fixtureLedger();
  const chat = async (label: string) => {
    const text = label === 'ipd_episode_fidelity' ? A2_REPLY : A1_REPLY;
    return { choices: [{ finish_reason: 'stop', message: { content: text } }] };
  };
  await withLabExecution(
    { chat, retrieve: async () => ({ hits: [], expandedQuery: '', meta: {} }), event: () => {} },
    () => computeEpisodeAudit(
      fixtureDeps(ledger) as unknown as EpisodeComputeDependencies,
      { encounterId: FIXTURE_ENCOUNTER, deadlineAt: null },
    ),
  );
  const saved = ledger.saved[0];
  if (!saved) throw new Error('the fixture episode produced no audit row');
  return saved;
}

export const FIXTURE_AUDIT_ID = '11111111-2222-4333-8444-555555555555';
export const FIXTURE_MEMBER_ID = 'FX-MEMBER-0001';

/** The camelCase row the pipeline wrote, in the snake_case shape `ipd_episode_audits` stores. */
export function storedRowFrom(row: EpisodeAuditRow): Record<string, unknown> {
  const c = row.counters as unknown as Record<string, unknown>;
  return {
    id: FIXTURE_AUDIT_ID,
    engine_version: 'ipd-episode-audit/0.2',
    audited_at: '2026-09-05T15:00:00.000Z',
    is_current: true,
    run_seq: 1,
    encounter_id: FIXTURE_ENCOUNTER,
    ip_uid: FIXTURE_ENCOUNTER,
    member_id: FIXTURE_MEMBER_ID,
    facility_name: row.facilityName,
    speciality: row.speciality,
    admitted_at: row.admittedAt,
    discharged_at: row.dischargedAt,
    los_days: row.losDays,
    discharge_type: row.dischargeType,
    extraction_version: row.extractionVersion,
    divergence_index: row.divergenceIndex,
    divergence_band: row.divergenceBand,
    band_uncertain: row.bandUncertain,
    scoring_status: row.scoringStatus,
    completeness_pct: row.completenessPct,
    ...c,
    judge_temperature: row.judgeTemperature,
    resolution_counts: row.resolutionCounts,
    capped_count: row.cappedCount,
    checkpoint_policy: row.checkpointPolicy,
    checkpoint_concurrency: row.checkpointConcurrency,
    prompt_events: row.promptEvents,
    assembled_events: row.assembledEvents,
    diff_prompt_chars: row.diffPromptChars,
    digest_entries: row.digestEntries,
    penalty_total: row.penaltyTotal,
    expectations_evaluated: row.expectationsEvaluated,
    checkpoint_count: row.checkpointCount,
    evidence_tiers: row.evidenceTiers,
    real_course: row.realCourse,
    findings: row.findings,
    admission_context: row.admissionContext,
    model_checkpoint: row.modelCheckpoint,
    model_judge: row.modelJudge,
    error_detail: row.errorDetail,
  };
}

/** The camelCase checkpoint writes, in the snake_case shape `ipd_episode_checkpoints` stores. */
export function storedCheckpointsFrom(rows: CheckpointWriteRow[]): Record<string, unknown>[] {
  return rows.map((c) => ({
    day_index: c.dayIndex,
    checkpoint_type: c.checkpointType,
    anchor_kind: c.anchorKind,
    input_cutoff_at: c.inputCutoffAt,
    input_event_count: c.inputEventCount,
    retrieval_query: c.retrievalQuery,
    retrieval_failed: c.retrievalFailed,
    retrieval_skipped: c.retrievalSkipped,
    retrieval_offtopic: c.retrievalOffTopic,
    offtopic_excerpt_count: c.offTopicExcerptCount,
    query_underspecified: c.queryUnderspecified,
    day0_query_from_ot: c.day0QueryFromOt,
    citation_ids: c.citationIds,
    citation_sources: c.citationSources,
    retrieved_titles: c.retrievedTitles,
    expected_course: c.expectedCourse,
    status: c.status,
    error_detail: c.errorDetail,
    model: c.model,
    temperature: c.temperature,
    seed: c.seed,
    max_tokens: c.maxTokens,
    finish_reason: c.finishReason,
    attempts: c.attempts,
    entries_truncated: c.entriesTruncated,
    uncited_entry_count: c.uncitedEntryCount,
    entry_count: c.entryCount,
  }));
}

/**
 * The extraction row the freeze reads, WITH a `verbatimSections` block carrying a patient's first
 * name — because that is the exact shape decision 50 exists for (IPD Episode owed item 4 measured
 * it on 954 rows), and a strip that is only ever tested against data without the thing it strips
 * is not tested at all.
 */
export function storedExtractionRow(): Record<string, unknown> {
  return {
    extraction_version: 'doc-extract/2',
    extracted_json: {
      patient: { age: 34, sex: 'F' },
      diagnosis: 'acute appendicitis',
      procedure: 'laparoscopic appendicectomy',
      treatments: ['cefuroxime', 'metronidazole'],
      verbatimSections: {
        // A NAME, in clear, exactly as the extractor leaves it. Nothing downstream may see it.
        header: 'Patient Name: Fixture Testperson   Age/Sex: 34/F',
        courseInHospital: 'Fixture Testperson underwent laparoscopic appendicectomy on day 0.',
      },
    },
  };
}
