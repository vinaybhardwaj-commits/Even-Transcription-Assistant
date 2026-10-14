/**
 * lib/ipd-episode/run.ts — the seven-stage pipeline for ONE episode (PRD §2).
 * select → assemble → checkpoints → diff (A1) → fidelity (A2) → comment (B) → persist.
 *
 * TWO PROPERTIES THIS FILE IS RESPONSIBLE FOR.
 *
 * 1. THE BLINDING. There is ONE assembled event list, and every model input below is a FILTER
 *    over it — `eventsBeforeDayStart` for each daily checkpoint, `episodeLevelEvents` for the
 *    episode one, `diffPassEvents` for A1, `fidelityPassEvents` for A2. Nothing here constructs a
 *    second list, and nothing here hands a pass a field its filter removed. The stored
 *    `input_cutoff_at` / `input_event_count` on each checkpoint row is the auditable proof, and
 *    §14 step 8 recomputes both from the stored course.
 *
 * 2. EVERY FAILURE DEGRADES TO A RECORDED NO-OP (§8). A db13 fault aborts this episode with no
 *    audit row and no skip row (it is a transport failure, not a fact about the episode). A
 *    missing summary, missing notes or missing extraction writes a SKIP with its reason. A failed
 *    A1 or A2 writes a skip. A failed B writes the audit row with `commentary = null`. No path
 *    returns a 500 and no path writes a value it did not derive.
 */

import { assertKnownBedrockModel } from '../bedrock-core';
import { startTrace, finishTraceIfRunning, logEvent } from '../trace';
import {
  checkpointPlan, dayStartIso, diffPassEvents, episodeLevelEvents, eventsBeforeDayStart,
  fidelityPassEvents, isDischargeEvent, summariseEventsForPrompt, type EpisodeEvent,
} from './assemble-core';
import { assembleEpisode, type AssembledEpisode } from './assemble';
import { admissionContextLine, renderExpectedCourse, type CheckpointEntryRef } from './checkpoint-core';
import { checkpointModel, normativeSourcesForProvenance, runCheckpoint, type CheckpointResult } from './checkpoint';
import { judgeModel, runDiffPass, runFidelityPass, JUDGE_TEMPERATURE } from './judge';
import {
  buildExpectationDigest, evidenceTiersOf, finalizeFindings, completenessPct, resolveFindingCitations,
  missingDischargeDayNote,
  scoringStatusFor, storedDivergenceIndex, findingsFromResolved, domainForSection,
  divergenceBandFor, bandIsUncertain,
  type EpisodeFinding,
} from './judge-core';
import { ONE_CALL_WORST_CASE_MS } from './model-call';
import { resolveAll, resolutionCounts, ESCALATION_SECTION, type ResolvableEntry } from './resolve-core';
import { fetchProgressNotes, fetchDischargeSummary } from './db13';
import {
  IPD_EPISODE_ENGINE_VERSION, fetchExtractionByIpUid, recordSkip, clearSkip, saveEpisodeAudit,
  type CheckpointWriteRow,
} from './store';

/**
 * How many checkpoints may be in flight at once. Three, not more: each is a Haiku call and the
 * episode still has three Opus passes to pay for after them, so the point is to remove the serial
 * wall time, not to saturate the provider and collect 429s.
 */
export const CHECKPOINT_CONCURRENCY = 3;

/** Bounded-concurrency map that PRESERVES INPUT ORDER — checkpoints are written and rendered in
 *  plan order, and a reordered list would scramble day indices against their expected courses. */
async function mapWithLimit<T, R>(items: T[], limit: number, fn: (it: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

export interface RunEpisodeInput {
  encounterId: string;
  /** From the selection query; used to date a skip row when the episode never assembles. */
  dischargedAtHint?: string | null;
  engineVersion?: string;
  /**
   * ROUND 13 ITEM 1. Epoch ms by which the INVOCATION must be finished — the worker's box, not
   * this episode's share of it. Every model call refuses to start unless a whole worst case still
   * fits before it, so an episode that cannot finish lands as a recorded skip rather than as a
   * killed function that leaves neither an audit row nor a skip row.
   *
   * Absent means unbudgeted. Only a test calls it that way; the worker always passes one.
   */
  deadlineAt?: number | null;
}

export interface RunEpisodeResult {
  encounterId: string;
  status?: 'inserted' | 'updated' | 'skipped';
  skip?: string;
  error?: string;
  divergenceIndex?: number;
  divergenceBand?: string;
  bandUncertain?: boolean;
  /** Round 15 item 1: the absolutes travel with the rate, in the response as well as the row. */
  penaltyTotal?: number;
  expectationsEvaluated?: number;
  nDivergent?: number;
  scoringStatus?: string;
  completenessPct?: number;
  nFindings?: number;
  checkpointCount?: number;
  traceId?: string;
  latencyMs: number;
  notes?: string[];
}

/**
 * The three skip reasons decided BEFORE any model runs (§3.1 conditions 1–3). An episode skipped
 * for one of these cost a db13 read and nothing else.
 *
 * `diff_failed` and `fidelity_failed` are deliberately NOT here: those episodes were assembled,
 * checkpointed and judged: they spent the budget the worker's batch size exists to bound.
 */
export const SELECTION_SKIP_REASONS = ['no_discharge_summary', 'no_notes', 'no_extraction'] as const;

/**
 * Did this episode consume a batch slot? A selection skip did not, and counting it as one was the
 * defect: a tick asked for `max=2` and could return having audited ZERO episodes, because two
 * candidates that turned out to have no extraction filled the batch. The worker then looked
 * caught-up while the cohort stood still.
 */
export function countsTowardMax(r: Pick<RunEpisodeResult, 'skip'>): boolean {
  return !(r.skip && (SELECTION_SKIP_REASONS as readonly string[]).includes(r.skip));
}

/** How many candidates one tick may look at, however many of them turn out to be skips. Bounds
 *  the work a tick can do when a long run of candidates all fail selection — without it, a cohort
 *  where nothing qualifies would walk the entire candidate list on every tick. */
export const MAX_CANDIDATES_EXAMINED = 50;

export interface EpisodeBatchTally {
  candidatesExamined: number;
  audited: number;
  skipped: number;
  skippedByReason: Record<string, number>;
  errors: number;
  exhausted: boolean;
  capReached: boolean;
}

export interface EpisodeBatchOutcome {
  results: RunEpisodeResult[];
  tally: EpisodeBatchTally;
}

/**
 * Walk candidates until `max` episodes have actually ENTERED THE MODEL STAGES, the candidate list
 * runs out, or `examineCap` candidates have been looked at.
 *
 * Sequential on purpose — see the box arithmetic in the worker route. `runner` is injected so this
 * is testable without a database or a model: the worker passes `runEpisodeAudit`.
 */
export async function runEpisodeBatch(
  candidates: { encounterId: string; dischargedAt: string | null }[],
  max: number,
  runner: (input: RunEpisodeInput) => Promise<RunEpisodeResult>,
  examineCap: number = MAX_CANDIDATES_EXAMINED,
): Promise<EpisodeBatchOutcome> {
  const results: RunEpisodeResult[] = [];
  const skippedByReason: Record<string, number> = {};
  let audited = 0;
  let skipped = 0;
  let errors = 0;
  let examined = 0;
  let entered = 0;

  for (const c of candidates) {
    if (entered >= max || examined >= examineCap) break;
    examined++;
    const r = await runner({ encounterId: c.encounterId, dischargedAtHint: c.dischargedAt });
    results.push(r);
    if (r.skip) {
      skipped++;
      skippedByReason[r.skip] = (skippedByReason[r.skip] ?? 0) + 1;
    }
    if (r.error) errors++;
    if (r.status === 'inserted' || r.status === 'updated') audited++;
    if (countsTowardMax(r)) entered++;
  }

  return {
    results,
    tally: {
      candidatesExamined: examined,
      audited,
      skipped,
      skippedByReason,
      errors,
      exhausted: examined >= candidates.length,
      capReached: examined >= examineCap && entered < max,
    },
  };
}

/**
 * Audit one episode.
 *
 * Selection conditions 1–3 are re-checked HERE rather than trusted from the caller, because the
 * worker's candidate query and this function can be minutes apart and a skip must record what was
 * true when the episode was actually attempted.
 */
export async function runEpisodeAudit(input: RunEpisodeInput): Promise<RunEpisodeResult> {
  const t0 = Date.now();
  const encounterId = input.encounterId;
  const engineVersion = input.engineVersion ?? IPD_EPISODE_ENGINE_VERSION;
  // Round 13 item 1. Bound once here and passed to every model call, so one episode cannot spend
  // the box a later episode in the same tick still has to run in.
  const deadlineAt = input.deadlineAt ?? null;

  // MODELS FIRST, BEFORE ANY WORK (§3.7). An unlisted id must cost nothing — not a db13 read, not
  // a retrieval, and certainly not three Opus calls that then land on a row nobody can attribute.
  const modelCheckpoint = checkpointModel(process.env);
  const modelJudge = judgeModel(process.env);
  try {
    assertKnownBedrockModel(modelCheckpoint);
    assertKnownBedrockModel(modelJudge);
  } catch (e) {
    return { encounterId, error: String((e as Error).message), latencyMs: Date.now() - t0 };
  }

  let traceId: string | undefined;
  try {
    // ── 1. select (conditions 1–3; condition 4 is the caller's silent skip) ──
    const [discharge, notes] = await Promise.all([
      fetchDischargeSummary(encounterId),
      fetchProgressNotes(encounterId, 1),
    ]);
    const dischargedAtHint = discharge?.discharge_date_time == null
      ? (input.dischargedAtHint ?? null)
      : String(discharge.discharge_date_time);

    if (!discharge) {
      await recordSkip({ encounterId, reason: 'no_discharge_summary', dischargedAt: dischargedAtHint, engineVersion });
      return { encounterId, skip: 'no_discharge_summary', latencyMs: Date.now() - t0 };
    }
    if (!notes.length) {
      await recordSkip({ encounterId, reason: 'no_notes', dischargedAt: dischargedAtHint, engineVersion });
      return { encounterId, skip: 'no_notes', latencyMs: Date.now() - t0 };
    }
    const extraction = await fetchExtractionByIpUid(encounterId);
    if (!extraction) {
      await recordSkip({ encounterId, reason: 'no_extraction', dischargedAt: dischargedAtHint, engineVersion });
      return { encounterId, skip: 'no_extraction', latencyMs: Date.now() - t0 };
    }

    traceId = await startTrace('ipd_episode_audit', { encounter_id: encounterId, engine_version: engineVersion });

    // ⚠️ THE IN-PROGRESS MARKER, WRITTEN BEFORE ANY MODEL WORK (item 3). IPNO-416 hit the 800 s
    // invocation cap and left NOTHING — no audit row, no skip row — so the episode was
    // indistinguishable from one never attempted, and the next tick would have spent another whole
    // invocation failing the same way. This row survives the process dying. It is cleared on
    // success and overwritten by a real skip reason on a real skip; an `in_progress` row older
    // than IN_PROGRESS_STALE_MS is a dead invocation and becomes retryable again.
    await recordSkip({ encounterId, reason: 'in_progress', dischargedAt: dischargedAtHint, engineVersion });

    // ── 2. assemble: ONE list, built once ──
    const tAssemble = Date.now();
    const assembled: AssembledEpisode | null = await assembleEpisode({
      encounterId,
      extractedCase: extraction.extractedJson,
      extractionVersion: extraction.extractionVersion,
    });
    if (!assembled) {
      await finishTraceIfRunning(traceId, 'error', 'assembly produced no episode');
      return { encounterId, error: 'assembly produced no episode (no admission row, or no readable admission_date_time)', traceId, latencyMs: Date.now() - t0 };
    }
    const assembleMs = Date.now() - tAssemble;
    const { envelope, events, sourcesPresent, notes: assemblyNotes } = assembled;
    const admissionContext = admissionContextLine({
      treatingDepartmentName: envelope.treatingDepartmentName,
      admissionType: envelope.admissionType,
      admitSource: envelope.admitSource,
      speciality: envelope.speciality,
      remarks: envelope.remarks,
    });

    // ── 3. checkpoints (Haiku, blinded) ──
    // ⚠️ THE EXTRACTED CASE IS REACHED IN EXACTLY TWO PLACES IN THIS PIPELINE, and neither is the
    // checkpoint loop below: assembleEpisode puts it on the DISCHARGE event (which every blinded
    // filter removes), and runFidelityPass reads it because A2 is the pass whose whole job is to
    // read it. A revision that fed its diagnosis and procedure into the checkpoint retrieval query
    // was reverted on 2026-09-02 — a discharge summary is written after the fact, so choosing
    // excerpts with it puts hindsight into a blinded pass through the retrieved text. §3.3.3 stands.
    // ⚠️ AUTHOR NAMES, COLLECTED SO THEY CAN BE REMOVED (item 7). A progress note's narrative can
    // carry the RMO's name inside the text, where no field names it, so the query builder is given
    // every author this episode has and strips them all.
    const authorNames = Array.from(new Set(
      events.map((e) => e.author_name).filter((n): n is string => !!n && n.trim().length >= 3),
    ));

    const plan = checkpointPlan(envelope.losDays);
    const admittedAt = envelope.admittedAt as string;
    // ── item 1: CHECKPOINTS RUN CONCURRENTLY, 3 AT A TIME ────────────────────────────────────
    // They are independent BY CONSTRUCTION: each is handed a list produced by filtering the single
    // assembled course to its own cut-off, and none reads another's output. There is no ordering
    // dependency to preserve, so the only reason they ran in series was that nobody had said
    // otherwise — and it cost IPNO-416 the whole invocation.
    //
    // The JUDGE PASSES STAY STRICTLY SEQUENTIAL after every checkpoint completes: A1 reads all the
    // expected courses, A2 reads the summary, B reads A1 and A2's findings. Those genuinely depend
    // on each other and are left alone.
    const buildCheckpoint = (entry: (typeof plan)[number]) => {
      // THE FILTER IS THE BLINDING. Both branches return a subset of `events`; neither can
      // produce an event the other pass would not have had.
      const input_events = entry.checkpoint_type === 'episode'
        ? episodeLevelEvents(events)
        : eventsBeforeDayStart(events, admittedAt, entry.day_index);
      const cutoffAt = entry.checkpoint_type === 'episode'
        ? (input_events.filter((e) => e.occurred_at).slice(-1)[0]?.occurred_at ?? admittedAt)
        : dayStartIso(admittedAt, entry.day_index);

      return runCheckpoint({
        traceId,
        deadlineAt,
        checkpointId: entry.checkpoint_id,
        checkpointType: entry.checkpoint_type,
        dayIndex: entry.day_index,
        cutoffAt,
        admissionContext,
        events: input_events,
        retrievalQueryInput: {
          // The SAME filtered list the checkpoint itself is given. The extracted case is not
          // reachable from the retrieval path, deliberately (see RetrievalQueryInput).
          eventsBeforeCutoff: input_events,
          // Written at admission, so it carries the presenting picture and no hindsight.
          remarks: envelope.remarks,
          authorNames,
          // ⚠️ THE DAY 0 FALLBACK NOW READS THE SAME FILTERED WINDOW AS EVERYTHING ELSE (item 8).
          // It used to be handed the EPISODE's OT names, and on IP-1286 that meant an OT note
          // timestamped 11:53 selecting the evidence for a 03:03 cut-off — day 0 retrieved with
          // knowledge of an operation that had not happened. Sourcing it from `input_events` makes
          // the fallback a deliberate no-op (rule 1 already reads in-window OT notes); it is kept,
          // tested and stamped so the leak cannot return by someone widening this argument again.
          isDayZero: entry.checkpoint_type === 'daily' && entry.day_index === 0,
          episodeSurgeryNames: input_events
            .filter((e) => e.event_type === 'ot_note')
            .map((e) => String((e.detail as Record<string, unknown>)?.surgery_name ?? '').trim())
            .filter(Boolean),
        },
        model: modelCheckpoint,
      });
    };

    const tCheckpoints = Date.now();
    const checkpoints: CheckpointResult[] = await mapWithLimit(plan, CHECKPOINT_CONCURRENCY, buildCheckpoint);
    const checkpointWallMs = Date.now() - tCheckpoints;
    const checkpointMsTotal = checkpoints.reduce((n, c) => n + c.wallMs, 0);
    const checkpointMsMax = checkpoints.reduce((n, c) => Math.max(n, c.wallMs), 0);
    const retrievalMsTotal = checkpoints.reduce((n, c) => n + c.retrievalMs, 0);

    // ── item 4: the diagnostics bundle, available at EVERY failure point below ──────────────
    // Built as a closure so it always reflects what is known at the moment a skip is written,
    // rather than a snapshot taken at a point the failure may never reach.
    const diagnosticsNow = (extra: Record<string, unknown> = {}) => ({
      assemble_ms: assembleMs,
      retrieval_ms: retrievalMsTotal,
      checkpoint_ms: checkpointMsTotal,
      checkpoint_max_ms: checkpointMsMax,
      checkpoint_wall_ms: checkpointWallMs,
      checkpoint_concurrency: CHECKPOINT_CONCURRENCY,
      checkpoint_count: checkpoints.length,
      assembled_events: events.length,
      prompt_events: summariseEventsForPrompt(diffPassEvents(events)).length,
      deadline_at: deadlineAt,
      budget_remaining_ms: deadlineAt == null ? null : deadlineAt - Date.now(),
      checkpoints: checkpoints.map((c) => ({
        id: c.checkpointId, status: c.status, entries: c.entryCount,
        finish_reason: c.finishReason, attempts: c.attempts, wall_ms: c.wallMs,
        retrieval_ms: c.retrievalMs, prompt_events: c.promptEvents, max_tokens: c.maxTokens,
      })),
      ...extra,
    });

    // Every checkpoint errored ⇒ there is no expected course to diff against (§8).
    if (checkpoints.length && checkpoints.every((c) => c.status === 'error')) {
      await recordSkip({ encounterId, reason: 'diff_failed', dischargedAt: envelope.dischargedAt, engineVersion,
        diagnostics: diagnosticsNow(), detail: 'every checkpoint errored' });
      await finishTraceIfRunning(traceId, 'error', 'every checkpoint errored');
      return { encounterId, skip: 'diff_failed', error: 'every checkpoint errored', traceId, latencyMs: Date.now() - t0, notes: assemblyNotes };
    }

    // ROUND 13 ITEM 3. The DIGEST goes to the diff pass — item text, deduplicated across
    // checkpoints, grouped by category, earliest by_day, one resolvable entry ref. The fully
    // rendered courses are still built, because pass B reads them on the detail page and the
    // resolver reads the courses themselves; only A1's input changes.
    const digest = buildExpectationDigest(
      checkpoints.map((c) => ({ checkpointId: c.checkpointId, dayIndex: c.dayIndex, course: c.expectedCourse })),
    );
    const checkpointBlocks = checkpoints
      .filter((c) => c.expectedCourse)
      .map((c) => renderExpectedCourse(c.checkpointId, c.dayIndex, c.checkpointType, c.expectedCourse, c.citationIds));
    const entryRefs = new Map<string, CheckpointEntryRef>();
    for (const c of checkpoints) for (const r of c.entryRefs) entryRefs.set(r.ref, r);
    // Each checkpoint's OWN ordered excerpt ids, keyed by checkpoint id. A1 cites by ordinal
    // against the checkpoint it names, so the ceiling and the mapping are per checkpoint — a single
    // max across the episode would let an ordinal from the widest checkpoint survive on the
    // narrowest and resolve to a passage that checkpoint never showed.
    const checkpointChunkIds = new Map<string, readonly number[]>(
      checkpoints.map((c) => [c.checkpointId, c.citationIds] as const),
    );
    // chunk id → source, pooled across every checkpoint. One episode's checkpoints can retrieve the
    // same chunk more than once; the source is a property of the chunk, so a flat map is right.
    const sourceById = new Map<number, string>();
    for (const c of checkpoints) {
      for (const [id, src] of Object.entries(c.citationSources)) sourceById.set(Number(id), src);
    }
    const normativeSources = normativeSourcesForProvenance();

    // ── 3b. RESOLVE THE EXPECTATIONS DETERMINISTICALLY (decision 33) ──────────────────────────
    // Every expected entry becomes a finding by LOOKUP, not by judgement. This is the whole of the
    // omission analysis now: code asks whether a matching event exists, and the four answers are
    // fixed. Nothing here can differ between two runs on the same checkpoints.
    const resolvableEntries: ResolvableEntry[] = [];
    for (const c of checkpoints) {
      const course = c.expectedCourse;
      if (!course) continue;
      const push = (section: string, idx: number, item: string, rationale: string, byDay: number | null,
                    citationIds: number[], matcher: ResolvableEntry['matcher'], sev: ResolvableEntry['proposedSeverity']) => {
        resolvableEntries.push({
          ref: `${c.checkpointId}/${section}/${idx + 1}`,
          checkpointId: c.checkpointId, dayIndex: c.dayIndex, section,
          item, rationale, byDay, citationIds, matcher, proposedSeverity: sev,
        });
      };
      course.expected_diagnostics.forEach((e, i) => push('diagnostics', i, e.item, e.rationale, e.by_day, e.citation_ids, e.matcher, e.proposed_severity));
      course.expected_therapeutics.forEach((e, i) => push('therapeutics', i, e.item, e.rationale, e.by_day, e.citation_ids, e.matcher, e.proposed_severity));
      course.expected_monitoring.forEach((e, i) => push('monitoring', i, e.item, e.rationale, null, e.citation_ids, e.matcher, e.proposed_severity));
      // ROUND 17 ITEM 1: the section string is what the resolver's conditional gate keys on, so it
      // comes from the constant rather than a literal repeated here.
      course.escalation_triggers.forEach((e, i) => push(ESCALATION_SECTION, i, `${e.trigger} → ${e.action}`, e.action, null, e.citation_ids, e.matcher, e.proposed_severity));
    }
    // Resolved against the SAME filtered list the diff pass sees — no discharge event, so an
    // expectation cannot be satisfied by something recorded only in the discharge summary.
    const resolverEvents = diffPassEvents(events);
    const resolved = resolveAll(resolvableEntries, resolverEvents);
    const resolverFindings = findingsFromResolved(resolved, domainForSection);
    const resolution_counts = resolutionCounts(resolved);

    // ── 4. diff (A1) — blind: the discharge event is filtered out ──
    const tDiff = Date.now();
    const a1 = await runDiffPass({
      traceId, admissionContext, deadlineAt,
      // PROMPT SHAPING: the judge reads the rolled-up order stream too (item 2)
      events: summariseEventsForPrompt(diffPassEvents(events)),
      digest, model: modelJudge,
    });
    const diffMs = Date.now() - tDiff;
    if (!a1.ok) {
      await recordSkip({ encounterId, reason: 'diff_failed', dischargedAt: envelope.dischargedAt, engineVersion,
        // The round 13 item 3 measurement belongs on the FAILURE path too: an episode whose diff
        // could not run is exactly the one whose prompt size someone will want to know.
        diagnostics: diagnosticsNow({
          diff_ms: diffMs, diff_finish_reason: a1.finishReason, diff_truncated: a1.truncated,
          diff_prompt_chars: a1.promptChars, digest_entries: digest.entries.length,
          digest_ungrouped: digest.ungroupedCount,
          diff_refused_for_budget: a1.budget.refusedForBudget,
          diff_remaining_ms: a1.budget.remainingMsAtAttempt,
        }),
        detail: a1.error ?? 'diff pass failed' });
      await finishTraceIfRunning(traceId, 'error', a1.error ?? 'diff pass failed');
      return { encounterId, skip: 'diff_failed', error: a1.error ?? 'diff pass failed', traceId, latencyMs: Date.now() - t0, notes: assemblyNotes };
    }

    // ── 5. fidelity (A2) — the only pass that reads the summary ──
    const tFid = Date.now();
    const a2 = await runFidelityPass({
      traceId, admissionContext, deadlineAt,
      events: summariseEventsForPrompt(fidelityPassEvents(events)),
      extractedCase: extraction.extractedJson, extractionVersion: extraction.extractionVersion, model: modelJudge,
    });
    const fidelityMs = Date.now() - tFid;
    if (!a2.ok) {
      await recordSkip({ encounterId, reason: 'fidelity_failed', dischargedAt: envelope.dischargedAt, engineVersion,
        diagnostics: diagnosticsNow({ diff_ms: diffMs, fidelity_ms: fidelityMs, fidelity_finish_reason: a2.finishReason, fidelity_truncated: a2.truncated }),
        detail: a2.error ?? 'fidelity pass failed' });
      await finishTraceIfRunning(traceId, 'error', a2.error ?? 'fidelity pass failed');
      return { encounterId, skip: 'fidelity_failed', error: a2.error ?? 'fidelity pass failed', traceId, latencyMs: Date.now() - t0, notes: assemblyNotes };
    }

    // ── code-enforced rules, then the score ──
    // Ordinals → real chunk ids FIRST, per referencing checkpoint, so everything downstream (the
    // uncited cap, the stored findings, the UI) speaks one vocabulary.
    // ROUND 14 ITEM 2, SECOND HALF. Raised by code, not by an expectation: day-scoping class
    // presence turns a silent day into `unassessable`, and the discharge day going silent is
    // exactly the gap worth reporting rather than excusing. Nothing expected it, so nothing else
    // could have found it.
    const dischargeNoteGap = missingDischargeDayNote(events, envelope.losDays);
    const raw: EpisodeFinding[] = [
      // the deterministic half: already carries its entry's citations, so it bypasses the
      // ordinal resolution the judged findings need
      ...resolverFindings,
      ...(dischargeNoteGap ? [dischargeNoteGap] : []),
      ...resolveFindingCitations([...a1.findings, ...a2.findings], checkpointChunkIds, entryRefs),
    ];

    // Findings discarded after the repair pass. These now COUNT (item 5): they join the A2 domain
    // drops in n_dropped_invalid and are reported alone in n_parse_failed, so no discard can leave
    // every counter reading 0 the way IP-1286's five did.
    const unparseable = a1.unparseable + a2.unparseable;
    const final = finalizeFindings(raw, entryRefs, events, unparseable, sourceById, normativeSources);
    final.counters.n_findings_truncated = a1.findingsTruncated + a2.findingsTruncated;
    const repaired = a1.repaired + a2.repaired;
    // Every discarded fragment, tagged with the pass that produced it. This is the record that did
    // not exist when IP-1286 lost 5 of its 15 A1 findings with nothing written down anywhere.
    const failures = [
      ...a1.failures.map((x) => ({ pass: 'divergence' as const, ...x })),
      ...a2.failures.map((x) => ({ pass: 'fidelity' as const, ...x })),
    ];
    const errorDetail: string[] = [];
    if (repaired > 0) {
      errorDetail.push(`${repaired} finding(s) kept after repairing one bad enum value (A1 ${a1.repaired}, A2 ${a2.repaired})`);
    }
    if (unparseable > 0) {
      errorDetail.push(`${unparseable} finding(s) discarded as unparseable after the repair pass (A1 ${a1.unparseable}, A2 ${a2.unparseable})`);
      if (traceId) {
        await logEvent(traceId, 'ipd_episode_unparseable_findings', 'judge', {
          encounter_id: encounterId,
          a1_unparseable: a1.unparseable, a2_unparseable: a2.unparseable,
          a1_repaired: a1.repaired, a2_repaired: a2.repaired,
          failures,
        }).catch(() => {});
      }
    }
    // ── item 5: is this episode scorable at all? ──
    // A divergence_index of 100 on an episode where no expectation was ever formed is the most
    // dangerous thing this engine can emit: it reads as "ran perfectly" and means "nothing was
    // measured". The status is computed BEFORE the row is built so the stored index can be null.
    // A checkpoint that errored, or produced no entries at all, means part of the expected course
    // does not exist — and an episode cannot be scored against a course with a hole in it.
    const incompleteCheckpoints = checkpoints.filter((c) => c.status === 'error' || c.entryCount === 0).length;
    const scoringStatus = scoringStatusFor({
      totalExpectedEntries: checkpoints.reduce((n, c) => n + c.entryCount, 0),
      findings: final.findings,
      cappedFindingIds: final.capped_finding_ids,
      incompleteCheckpoints,
    });
    if (scoringStatus !== 'ok') {
      errorDetail.push(
        scoringStatus === 'incomplete_checkpoints'
          ? `${incompleteCheckpoints} of ${checkpoints.length} checkpoint(s) errored or produced no entries — the expected course is incomplete and this episode is not scorable`
          : scoringStatus === 'no_expectations'
            ? 'no checkpoint produced a single expected entry — this episode is not scorable'
            : 'every finding was capped — the index is arithmetically high but nothing survived at full weight');
      if (traceId) {
        await logEvent(traceId, 'ipd_episode_not_scorable', 'score', {
          encounter_id: encounterId, scoring_status: scoringStatus,
          expected_entries: checkpoints.reduce((n, c) => n + c.entryCount, 0),
          findings: final.findings.length,
        }).catch(() => {});
      }
    }
    const offTopic = checkpoints.filter((c) => c.retrievalOffTopic).length;
    const offTopicExcerpts = checkpoints.reduce((n, c) => n + c.offTopicExcerptCount, 0);
    if (offTopic > 0) {
      errorDetail.push(`${offTopic} of ${checkpoints.length} checkpoint(s) flagged retrieval_offtopic (${offTopicExcerpts} off-topic excerpt(s) in total)`);
    }
    const normativeDropped = checkpoints.reduce((n, c) => n + c.normativeDropped, 0);
    if (normativeDropped > 0) {
      errorDetail.push(`${normativeDropped} normative chunk(s) dropped for failing the similarity floor`);
    }
    const day0FromOt = checkpoints.filter((c) => c.day0QueryFromOt).length;
    if (day0FromOt > 0) {
      errorDetail.push('the day 0 query was empty and fell back to the episode OT surgery name');
    }

    // Checkpoint grounding, surfaced on the audit row too: 42 of 42 uncited was invisible until
    // someone read the jsonb.
    const uncitedEntries = checkpoints.reduce((n, c) => n + c.uncitedEntryCount, 0);
    const totalEntries = checkpoints.reduce((n, c) => n + c.entryCount, 0);
    if (totalEntries > 0 && uncitedEntries === totalEntries) {
      errorDetail.push(`every expected-course entry (${totalEntries}) came back uncited`);
      if (traceId) {
        await logEvent(traceId, 'ipd_episode_all_entries_uncited', 'checkpoint', {
          encounter_id: encounterId, entries: totalEntries,
          checkpoints_with_excerpts: checkpoints.filter((c) => c.citationIds.length > 0).length,
          retried: checkpoints.filter((c) => c.retriedForCitations).length,
        }).catch(() => {});
      }
    }
    if (final.n_fidelity_normalized > 0) {
      errorDetail.push(`${final.n_fidelity_normalized} fidelity finding(s) had finding_type or checkpoint_ref normalised to the values §3.5 fixes`);
    }

    // ── 6. comment (B) — NO LONGER IN THIS PIPELINE (V, 2026-09-03: PRD decision 35) ─────────
    // Pass B used to run here. It cost 107 s of IPNO-416's 314 s — a third of the run — for output
    // that scores nothing, it failed on both of the last two episodes, and it is only ever read by
    // someone who has opened one episode's detail page. So it moved out: the pipeline now ENDS at
    // the fidelity pass, the audit row is written with `commentary` NULL, and pass B runs on demand
    // the first time that page is opened (app/api/ipd-episode/commentary).
    //
    // ⚠️ A NULL COMMENTARY IS NOT A FAILURE AND NEVER BLOCKS SCORING. Every episode below is
    // complete and scorable without it. Nothing here may push a commentary error into errorDetail
    // any more, because there is no longer a commentary attempt at this point to have failed.
    const commentaryMs = 0;

    // ── 7. persist ──
    const checkpointRows: CheckpointWriteRow[] = checkpoints.map((c) => ({
      dayIndex: c.dayIndex,
      checkpointType: c.checkpointType,
      inputCutoffAt: c.cutoffAt,
      inputEventCount: c.inputEventCount,
      retrievalQuery: c.retrievalQuery || null,
      retrievalFailed: c.retrievalFailed,
      retrievalSkipped: c.retrievalSkipped,
      citationIds: c.citationIds,
      expectedCourse: c.expectedCourse,
      status: c.status,
      errorDetail: c.errorDetail,
      model: c.model,
      traceId: traceId ?? null,
      uncitedEntryCount: c.uncitedEntryCount,
      entryCount: c.entryCount,
      citationSources: c.citationSources,
      retrievedTitles: c.retrievedTitles,
      retrievalOffTopic: c.retrievalOffTopic,
      offTopicExcerptCount: c.offTopicExcerptCount,
      day0QueryFromOt: c.day0QueryFromOt,
      temperature: c.temperature,
      seed: c.seed,
      maxTokens: c.maxTokens,
      finishReason: c.finishReason,
      attempts: c.attempts,
      entriesTruncated: c.entriesTruncated,
    }));

    const tPersist = Date.now();
    const storedIndex = storedDivergenceIndex(final.divergence_index, scoringStatus);
    const saved = await saveEpisodeAudit({
      engineVersion,
      encounterId,
      // Same value, two column names — see the store's header. Never transformed.
      ipUid: encounterId,
      memberId: envelope.memberId ?? extraction.memberId,
      facilityName: envelope.facilityName,
      speciality: envelope.speciality,
      admittedAt: envelope.admittedAt,
      dischargedAt: envelope.dischargedAt,
      losDays: envelope.losDays,
      dischargeType: envelope.dischargeType,
      extractionVersion: extraction.extractionVersion,
      divergenceIndex: storedIndex,
      // The band is derived from the STORED index, so an unscorable episode has no band either —
      // "not scorable" must not acquire a reassuring word through a null slipping into a bucket.
      divergenceBand: divergenceBandFor(storedIndex),
      bandUncertain: bandIsUncertain(storedIndex, final.penalty_total, final.expectations_evaluated),
      // ROUND 15 ITEM 1. The absolutes travel WITH the rate, always: the rate bands the episode
      // and these say how much there is to read, and a worklist needs both.
      penaltyTotal: final.penalty_total,
      expectationsEvaluated: final.expectations_evaluated,
      scoringStatus,
      completenessPct: completenessPct(sourcesPresent),
      counters: final.counters,
      cappedCount: final.capped_finding_ids.size,
      judgeTemperature: JUDGE_TEMPERATURE,
      resolutionCounts: resolution_counts,
      checkpointPolicy: 'standard',
      checkpointConcurrency: CHECKPOINT_CONCURRENCY,
      checkpointWallMs,
      promptEvents: summariseEventsForPrompt(diffPassEvents(events)).length,
      assembledEvents: events.length,
      // ROUND 13 ITEM 3, THE MEASUREMENT. Both halves, for the same reason round 12 stores both
      // resolver counts: `diff_prompt_chars` alone cannot say whether a smaller prompt came from
      // the digest or from a quieter episode, and `digest_entries` alone cannot say what it saved.
      diffPromptChars: a1.promptChars,
      digestEntries: digest.entries.length,
      timings: {
        assemble_ms: assembleMs, retrieval_ms: retrievalMsTotal,
        checkpoint_ms: checkpointMsTotal, checkpoint_max_ms: checkpointMsMax,
        checkpoint_wall_ms: checkpointWallMs,
        diff_ms: diffMs, fidelity_ms: fidelityMs, commentary_ms: commentaryMs,
        // ROUND 13 ITEM 1. The deadline this invocation ran against, and what each judge pass had
        // left when it was considered. A budget that never bound still records that it did not.
        budget: {
          deadline_at: deadlineAt,
          worst_case_one_call_ms: ONE_CALL_WORST_CASE_MS,
          diff_remaining_ms: a1.budget.remainingMsAtAttempt,
          fidelity_remaining_ms: a2.budget.remainingMsAtAttempt,
        },
      },
      checkpointCount: checkpoints.length,
      evidenceTiers: evidenceTiersOf(sourcesPresent),
      realCourse: events,
      findings: final.findings,
      // NULL by construction now — filled in later, on demand, by the commentary route.
      commentary: null,
      // Pass B's one input that cannot be rebuilt from the stored row (decision 35).
      admissionContext,
      modelCheckpoint,
      modelJudge,
      traceId: traceId ?? null,
      errorDetail: errorDetail.length ? errorDetail.join(' · ') : null,
      rawJudgeError: failures.length ? failures : null,
    }, checkpointRows);
    const persistMs = Date.now() - tPersist;
    if (saved.failedCheckpoints > 0) {
      // The checkpoint rows carry the blinding proof, so a write that failed is worth a trace
      // event even though the audit row itself landed.
      if (traceId) {
        await logEvent(traceId, 'ipd_episode_checkpoint_write_failed', 'persist', {
          encounter_id: encounterId, failed: saved.failedCheckpoints, of: checkpointRows.length,
        }).catch(() => {});
      }
    }

    if (saved.status !== 'skipped') await clearSkip(encounterId, engineVersion);
    await finishTraceIfRunning(traceId, saved.status === 'skipped' ? 'partial' : 'success');

    return {
      encounterId,
      status: saved.status,
      // ⚠️ THE SAME THREE VALUES THE ROW GOT, FROM THE SAME VARIABLES. This block used to recompute
      // them, and round 15 proved why that is not a harmless duplication: `bandUncertain` was
      // recomputed WITHOUT the denominator, fell back to the fixed ±5 window, and reported `true`
      // for all five episodes while the stored column — computed once, correctly — said `false` for
      // four of them. A response that disagrees with the row it just wrote is worse than no
      // response, because it is the one a person reads first.
      divergenceIndex: storedIndex ?? undefined,
      divergenceBand: divergenceBandFor(storedIndex) ?? undefined,
      bandUncertain: bandIsUncertain(storedIndex, final.penalty_total, final.expectations_evaluated),
      penaltyTotal: final.penalty_total,
      expectationsEvaluated: final.expectations_evaluated,
      nDivergent: final.counters.n_divergent,
      scoringStatus,
      completenessPct: completenessPct(sourcesPresent),
      nFindings: final.counters.n_findings,
      checkpointCount: checkpoints.length,
      traceId,
      latencyMs: Date.now() - t0,
      notes: [
        ...assemblyNotes,
        ...(final.n_tier_c_rewritten ? [`${final.n_tier_c_rewritten} finding(s) rewritten to unassessable by the Tier C rule`] : []),
        ...(final.n_uncited_capped ? [`${final.n_uncited_capped} finding(s) capped — neither a citation nor Tier A evidence (item 10)`] : []),
        ...(final.n_uncited_entries ? [`${final.n_uncited_entries} finding(s) measured against an uncited expectation (no longer a cap)`] : []),
        ...(final.n_billing_only_capped ? [`${final.n_billing_only_capped} commission finding(s) held to minor — billing-only evidence on an uncorroborated day (item 1)`] : []),
        ...(final.n_escalation_unassessable ? [`${final.n_escalation_unassessable} judged finding(s) rewritten to unassessable — measured against an escalation trigger, whose antecedent this pipeline cannot evaluate`] : []),
        ...(final.n_fidelity_normalized ? [`${final.n_fidelity_normalized} fidelity finding(s) normalised to commission / no checkpoint`] : []),
        ...(final.n_literature_capped ? [`${final.n_literature_capped} finding(s) stand on literature only, no normative citation (counted, not capped)`] : []),
        ...(scoringStatus !== 'ok' ? [`scoring_status ${scoringStatus} — this episode is not presented as scored`] : []),
        ...(offTopic ? [`${offTopic} checkpoint(s) flagged retrieval_offtopic (${offTopicExcerpts} off-topic excerpt(s))`] : []),
        ...(normativeDropped ? [`${normativeDropped} normative chunk(s) dropped below the similarity floor`] : []),
        ...(day0FromOt ? ['day 0 retrieval fell back to the OT surgery name'] : []),
        `${final.capped_finding_ids.size} of ${final.counters.n_findings} finding(s) capped`,
        `citations by provenance: ${Object.entries(final.provenance_counts).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`,
        `resolver: ${Object.entries(resolution_counts).map(([k, n]) => `${k} ${n}`).join(', ')}`,
        `pass contribution: resolver ${resolverFindings.length}, diff ${a1.findings.length}, fidelity ${a2.findings.length}`,
        // ROUND 12 ITEM 2: both halves, always. The ratio is the measurement.
        `resolver findings grouped: ${final.counters.n_resolver_grouped} class(es) standing for ${final.counters.n_resolver_ungrouped} expected-course entr(ies)`,
        ...(final.counters.n_resolver_ungrouped > final.counters.n_resolver_grouped
          ? [`largest group: ${Math.max(...final.findings.filter((f) => f.resolution != null).map((f) => f.group_size), 1)} checkpoint(s) of the same expectation class`]
          : []),
        'commentary: not generated in the pipeline (decision 35) — it is written on first open of the detail page',
        ...(a1.findingsTruncated + a2.findingsTruncated ? [`${a1.findingsTruncated + a2.findingsTruncated} finding(s) dropped by the per-pass output cap`] : []),
        `judge finish_reason: diff=${a1.finishReason ?? 'none'}, fidelity=${a2.finishReason ?? 'none'}`,
        ...(final.counters.n_judged_omissions_dropped ? [`${final.counters.n_judged_omissions_dropped} omission finding(s) from the diff pass dropped — code owns omissions now`] : []),
        ...(final.counters.n_unassessable_rejected ? [`${final.counters.n_unassessable_rejected} unassessable verdict(s) rewritten to context_dependent — evidence did not support the claim`] : []),
        ...(checkpoints.filter((c) => c.retrievalSkipped).length ? [`${checkpoints.filter((c) => c.retrievalSkipped).length} checkpoint(s) generated with NO retrieval — the query was empty`] : []),
        `finish_reason by checkpoint: ${checkpoints.map((c) => `${c.checkpointId}=${c.finishReason ?? 'none'}`).join(', ')}`,
        `entries by checkpoint: ${checkpoints.map((c) => `${c.checkpointId}=${c.entryCount}`).join(', ')}`,
        ...(checkpoints.reduce((n, c) => n + c.entriesTruncated, 0) ? [`${checkpoints.reduce((n, c) => n + c.entriesTruncated, 0)} entry(ies) truncated by the per-category cap`] : []),
        ...(repaired ? [`${repaired} finding(s) kept by the enum repair pass`] : []),
        ...(unparseable ? [`${unparseable} finding(s) discarded — see raw_judge_error and the trace`] : []),
        ...(totalEntries && uncitedEntries === totalEntries ? [`all ${totalEntries} expected-course entries are uncited`] : []),
        ...(saved.failedCheckpoints ? [`${saved.failedCheckpoints} of ${checkpointRows.length} checkpoint row(s) failed to write`] : []),
      ],
    };
  } catch (e) {
    // A db13 or transport fault: abort this episode, write NO audit row and NO skip row (§8), and
    // let the next tick try again. A skip would record a fact about the episode that is not true.
    if (traceId) await finishTraceIfRunning(traceId, 'error', String((e as Error).message));
    return { encounterId, error: String((e as Error).message), traceId, latencyMs: Date.now() - t0 };
  }
}
