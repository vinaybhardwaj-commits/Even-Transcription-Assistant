/**
 * lib/ipd-episode/run.ts — THE PRODUCTION COMPOSITION (LAB-MCP-V2 decision 47).
 *
 * The seven-stage pipeline used to live here. It now lives in `./compute.ts` as
 * `computeEpisodeAudit(deps, input)`, byte-for-byte the same body, and this file is the one place
 * that says what `deps` is in production: the live db13 reads, the live store writes, the live
 * checkpoint. `runEpisodeAudit` is that composition and nothing else.
 *
 * ⚠️ THE PUBLIC SURFACE OF THIS FILE DID NOT CHANGE (LAB-MCP-V2 decision 56). `runEpisodeAudit`,
 * `runEpisodeBatch`, `MAX_CANDIDATES_EXAMINED`, `countsTowardMax`, `SELECTION_SKIP_REASONS` and
 * the two types are exported from here exactly as before, with the same names and the same
 * signatures, so `app/api/ipd-episode/worker/route.ts` and every existing importer are untouched.
 *
 * ⚠️ THE BATCH WALKER STAYS HERE, DELIBERATELY. `runEpisodeBatch` is not part of the pipeline —
 * it takes a `runner` and is already injectable — so moving it would have bought nothing and cost
 * the worker route an import. What moved is exactly what could not run without a database.
 */
import { runCheckpoint } from './checkpoint';
import { assembleEpisode } from './assemble';
import { fetchProgressNotes, fetchDischargeSummary } from './db13';
import { fetchExtractionByIpUid, recordSkip, clearSkip, saveEpisodeAudit } from './store';
import { computeEpisodeAudit, type EpisodeComputeDependencies, type RunEpisodeInput, type RunEpisodeResult } from './compute';

export type { RunEpisodeInput, RunEpisodeResult } from './compute';
export { CHECKPOINT_CONCURRENCY } from './compute';

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
 * THE LIVE EIGHT. Production's answer to `EpisodeComputeDependencies`, and the only place in the
 * engine where the pipeline is bound to a database.
 *
 * Every entry is the real function, passed through unwrapped. A wrapper here would be a second
 * behaviour that no test of `compute.ts` could see, which is precisely the thing the extraction
 * exists to remove.
 */
const LIVE_DEPS: EpisodeComputeDependencies = {
  fetchDischargeSummary,
  fetchProgressNotes,
  fetchExtractionByIpUid,
  assembleEpisode,
  recordSkip,
  clearSkip,
  saveEpisodeAudit,
  checkpoint: runCheckpoint,
};

/**
 * Audit one episode against the live mirror.
 *
 * Selection conditions 1–3 are re-checked inside the pipeline rather than trusted from the caller,
 * because the worker's candidate query and this function can be minutes apart and a skip must
 * record what was true when the episode was actually attempted.
 */
export async function runEpisodeAudit(input: RunEpisodeInput): Promise<RunEpisodeResult> {
  return computeEpisodeAudit(LIVE_DEPS, input);
}
