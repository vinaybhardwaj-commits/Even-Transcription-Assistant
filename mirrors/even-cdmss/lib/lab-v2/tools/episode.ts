/**
 * lib/lab-v2/tools/episode.ts — `episode_checkpoint_inspect` and `episode_replay`
 * (LAB-MCP-V2-PRD-v1.0 §17.5, decision 49).
 *
 * ⚠️ WHY A CHECKPOINT NEEDS ITS OWN TOOL. An IPD episode's score is a rate over expectations, and
 * every expectation was authored by ONE checkpoint from ONE blinded slice of the course. When an
 * index looks wrong, the question is never "what did the model say" — it is "what was this
 * checkpoint shown, what did it expect, which of those expectations resolved, and against how
 * many". Answering that from the stored jsonb means reading four columns of two tables and
 * recomputing the arithmetic by hand, which is exactly the kind of work that does not get done.
 *
 * ⚠️ IT READS THE FROZEN CASE AND THE ITEM'S STEPS, NEVER db13. Decision 49 says "from the stored
 * row or the replayed item"; both are already in the v2 store once a case is frozen, because the
 * freeze copied the stored row's checkpoints into the case and the adapter wrote each one as a
 * `steps` row. So this tool makes no production read at all — which is also what lets it stay
 * `research_read` and free.
 *
 * `episode_replay` is `run_replay` with the engine named, and nothing else: decision 49 is
 * explicit about that, so it delegates rather than reimplementing, and the one thing it adds is a
 * REFUSAL when the run it is pointed at is not an ipd_episode run — a replay that silently
 * replayed an OPD run under an IPD name would be a worse answer than an error.
 */
import { z } from 'zod';
import { LabError } from '../contracts';
import { getObject, getRun, itemsOf, stepsOf } from '../store';
import { runReplay } from './replay';
import type { Db } from '../db';

export const EPISODE_SCHEMAS = {
  episode_checkpoint_inspect: {
    input: z.object({
      /** The dataset case key — an `ipd_episode_audits.id` — or an item id from a run. */
      case_key: z.string().min(1).optional(),
      item_id: z.string().uuid().optional(),
      dataset_id: z.string().uuid().optional(),
      /** `cp-d3`, `cp-episode`, or the day index as a number. Omitted lists every checkpoint. */
      checkpoint: z.union([z.string().min(1), z.number().int()]).optional(),
    }),
    output: z.object({
      case_key: z.string(),
      source: z.enum(['dataset', 'item']),
      engine_version: z.string().nullable(),
      checkpoints: z.array(z.object({
        checkpoint_id: z.string(),
        day_index: z.number().int(),
        checkpoint_type: z.string(),
        anchor_kind: z.string(),
        /** THE BLINDING PROOF: the cut-off and how many events fell before it. */
        input_cutoff_at: z.string(),
        input_event_count: z.number().int(),
        /** What the checkpoint expected, by section, and how much of it was cited. */
        expectation: z.object({
          diagnostics: z.number().int(),
          therapeutics: z.number().int(),
          monitoring: z.number().int(),
          escalation: z.number().int(),
          total: z.number().int(),
          uncited: z.number().int(),
          expected_los_days: z.number().nullable(),
          expected_disposition: z.string().nullable(),
        }),
        /** Which of the episode's events this checkpoint was allowed to see, by type. */
        matched_events: z.record(z.number().int()),
        /** The retrieval that grounded it, and whether it was on topic. */
        class_availability: z.object({
          retrieval_query: z.string(),
          citation_ids: z.array(z.number().int()),
          sources: z.record(z.string()),
          retrieved_titles: z.array(z.string()),
          retrieval_failed: z.boolean(),
          retrieval_skipped: z.boolean(),
          retrieval_offtopic: z.boolean(),
          offtopic_excerpt_count: z.number().int(),
        }),
        /** The caps that could have bitten, and the ones that did. */
        caps: z.object({
          max_tokens: z.number().int(),
          entries_truncated: z.number().int(),
          finish_reason: z.string().nullable(),
          attempts: z.number().int(),
          temperature: z.number(),
          seed: z.number().int().nullable(),
        }),
        /** The arithmetic, spelled out, so nobody has to recompute it from jsonb. */
        arithmetic: z.object({
          entries: z.number().int(),
          uncited_entries: z.number().int(),
          cited_pct: z.number().int(),
          status: z.string(),
          error_detail: z.string().nullable(),
          /** Present when this came from a replayed item: the request hash of the served step. */
          request_hash: z.string().nullable(),
        }),
      })),
    }),
  },
  episode_replay: {
    input: z.object({
      run_id: z.string().uuid(),
      mode: z.literal('exact').default('exact'),
      idempotency_key: z.string().min(1),
    }),
    output: z.object({
      engine: z.literal('ipd_episode'),
      source_run_id: z.string().uuid(),
      replay_run_id: z.string().uuid(),
      mode: z.literal('exact'),
      deduplicated: z.boolean(),
      items: z.number().int(),
      equal: z.number().int(),
      not_equal: z.number().int(),
      diverged: z.number().int(),
      model_calls: z.number().int(),
      replayed_stages: z.number().int(),
      per_item: z.array(z.object({
        case_key: z.string(),
        source_item_id: z.string().uuid(),
        replay_item_id: z.string().uuid(),
        source_result_hash: z.string().nullable(),
        replay_result_hash: z.string().nullable(),
        equal: z.boolean(),
        state: z.string(),
        error: z.string().nullable(),
      })),
    }),
  },
} as const;

type CourseEvent = { event_type?: unknown; occurred_at?: unknown };
type Course = {
  expected_diagnostics?: unknown[]; expected_therapeutics?: unknown[];
  expected_monitoring?: unknown[]; escalation_triggers?: unknown[];
  expected_los_days?: unknown; expected_disposition?: unknown;
};

/** One checkpoint's stored result → decision 49's five blocks. Pure; the tool is the plumbing. */
export function inspectCheckpoint(
  cp: Record<string, unknown>, course: EventWindow, requestHash: string | null,
): Record<string, unknown> {
  const c = (cp.expectedCourse ?? null) as Course | null;
  const n = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  const entries = Number(cp.entryCount ?? 0);
  const uncited = Number(cp.uncitedEntryCount ?? 0);
  return {
    checkpoint_id: String(cp.checkpointId ?? ''),
    day_index: Number(cp.dayIndex ?? 0),
    checkpoint_type: String(cp.checkpointType ?? ''),
    anchor_kind: String(cp.anchorKind ?? ''),
    input_cutoff_at: String(cp.cutoffAt ?? ''),
    input_event_count: Number(cp.inputEventCount ?? 0),
    expectation: {
      diagnostics: n(c?.expected_diagnostics),
      therapeutics: n(c?.expected_therapeutics),
      monitoring: n(c?.expected_monitoring),
      escalation: n(c?.escalation_triggers),
      total: entries,
      uncited,
      expected_los_days: c?.expected_los_days == null ? null : Number(c.expected_los_days),
      expected_disposition: c?.expected_disposition == null ? null : String(c.expected_disposition),
    },
    matched_events: course.countsBefore(String(cp.cutoffAt ?? '')),
    class_availability: {
      retrieval_query: String(cp.retrievalQuery ?? ''),
      citation_ids: (Array.isArray(cp.citationIds) ? cp.citationIds : []).map(Number),
      sources: (cp.citationSources ?? {}) as Record<string, string>,
      retrieved_titles: (Array.isArray(cp.retrievedTitles) ? cp.retrievedTitles : []).map(String),
      retrieval_failed: cp.retrievalFailed === true,
      retrieval_skipped: cp.retrievalSkipped === true,
      retrieval_offtopic: cp.retrievalOffTopic === true,
      offtopic_excerpt_count: Number(cp.offTopicExcerptCount ?? 0),
    },
    caps: {
      max_tokens: Number(cp.maxTokens ?? 0),
      entries_truncated: Number(cp.entriesTruncated ?? 0),
      finish_reason: cp.finishReason == null ? null : String(cp.finishReason),
      attempts: Number(cp.attempts ?? 0),
      temperature: Number(cp.temperature ?? 0),
      seed: cp.seed == null ? null : Number(cp.seed),
    },
    arithmetic: {
      entries,
      uncited_entries: uncited,
      // ⚠️ 100 % ON ZERO ENTRIES WOULD READ AS "fully grounded" AND MEAN "nothing was expected".
      // A checkpoint with no entries has no grounding rate, and 0 is the honest floor here
      // because `entries` sits beside it and says why.
      cited_pct: entries > 0 ? Math.round((100 * (entries - uncited)) / entries) : 0,
      status: String(cp.status ?? ''),
      error_detail: cp.errorDetail == null ? null : String(cp.errorDetail),
      request_hash: requestHash,
    },
  };
}

/** The frozen course, answering "how many events of each type fell before this cut-off". */
export class EventWindow {
  constructor(private readonly events: CourseEvent[]) {}
  countsBefore(cutoffIso: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const e of this.events) {
      const at = e.occurred_at == null ? null : String(e.occurred_at);
      if (at != null && cutoffIso && at >= cutoffIso) continue;
      const k = String(e.event_type ?? 'unknown');
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  }
}

export interface EpisodeToolDeps { db: Db; principal: string }

/** `cp-d3`, `3`, or `episode` — all three name the same checkpoint a reader would name. */
function matchesCheckpoint(want: string | number | undefined, id: string, dayIndex: number): boolean {
  if (want === undefined) return true;
  if (typeof want === 'number') return dayIndex === want;
  const w = String(want).trim();
  return w === id || w === `cp-${w}` || id === `cp-${w}` || (w === 'episode' && id === 'cp-episode');
}

export async function episodeCheckpointInspect(
  deps: EpisodeToolDeps, args: { case_key?: string; item_id?: string; dataset_id?: string; checkpoint?: string | number },
) {
  const { db } = deps;
  if (!args.case_key && !args.item_id) {
    throw new LabError('INVALID_INPUT', 'episode_checkpoint_inspect needs a case_key or an item_id');
  }

  // ── an ITEM: the checkpoints this replay actually served, with their request hashes ──
  if (args.item_id) {
    const rows = await db.query<{ id: string; case_key: string; payload: unknown; run_id: string }>(
      `SELECT id, case_key, payload, run_id FROM lab_v2.items WHERE id = $1`, [args.item_id]);
    const item = rows[0];
    if (!item) throw new LabError('NOT_FOUND', `no item ${args.item_id}`);
    const frozen = ((item.payload as { frozen?: Record<string, unknown> })?.frozen ?? {}) as Record<string, unknown>;
    const window = new EventWindow((frozen.real_course ?? []) as CourseEvent[]);
    const steps = await stepsOf(db, item.id);
    const out: Record<string, unknown>[] = [];
    for (const [name, step] of steps) {
      if (!name.startsWith('checkpoint:')) continue;
      const artifact = await getObject(db, step.artifact_id);
      const cp = (artifact?.body ?? {}) as Record<string, unknown>;
      if (!matchesCheckpoint(args.checkpoint, String(cp.checkpointId ?? ''), Number(cp.dayIndex ?? -1))) continue;
      out.push(inspectCheckpoint(cp, window, step.dependency_hash));
    }
    return {
      case_key: item.case_key,
      source: 'item' as const,
      engine_version: frozen.engine_version == null ? null : String(frozen.engine_version),
      checkpoints: out.sort((a, b) => String(a.checkpoint_id).localeCompare(String(b.checkpoint_id))),
    };
  }

  // ── a CASE: the checkpoints the freeze copied out of the stored audit row ────────────
  const datasets = await db.query<{ id: string; body: unknown }>(
    args.dataset_id
      ? `SELECT id, body FROM lab_v2.objects WHERE kind = 'dataset' AND id = $1`
      : `SELECT id, body FROM lab_v2.objects WHERE kind = 'dataset' ORDER BY created_at DESC LIMIT 200`,
    args.dataset_id ? [args.dataset_id] : [],
  );
  for (const d of datasets) {
    const body = d.body as { engine?: string; cases?: { case_key: string; frozen?: Record<string, unknown> }[] };
    if (body?.engine !== 'ipd_episode') continue;
    const found = (body.cases ?? []).find((c) => c.case_key === args.case_key);
    if (!found?.frozen) continue;
    const frozen = found.frozen;
    const window = new EventWindow((frozen.real_course ?? []) as CourseEvent[]);
    const checkpoints = (frozen.checkpoints ?? {}) as Record<string, Record<string, unknown>>;
    const out = Object.values(checkpoints)
      .filter((cp) => matchesCheckpoint(args.checkpoint, String(cp.checkpointId ?? ''), Number(cp.dayIndex ?? -1)))
      .map((cp) => inspectCheckpoint(cp, window, null))
      .sort((a, b) => String(a.checkpoint_id).localeCompare(String(b.checkpoint_id)));
    return {
      case_key: String(args.case_key),
      source: 'dataset' as const,
      engine_version: frozen.engine_version == null ? null : String(frozen.engine_version),
      checkpoints: out,
    };
  }
  throw new LabError('CASE_NOT_FOUND', `no frozen ipd_episode case ${args.case_key} in any visible dataset`);
}

/** Decision 49 — `run_replay` with the engine named, and a refusal when it is not that engine. */
export async function episodeReplay(deps: EpisodeToolDeps, args: { run_id: string; mode: 'exact'; idempotency_key: string }) {
  const { db } = deps;
  const run = await getRun(db, args.run_id);
  if (!run) throw new LabError('NOT_FOUND', `no run ${args.run_id}`);
  const items = await itemsOf(db, run.id, 1, 0);
  const engine = (items[0]?.payload as { engine?: string } | undefined)?.engine ?? null;
  if (engine !== 'ipd_episode') {
    throw new LabError('INVALID_INPUT',
      `run ${args.run_id} is a '${engine ?? 'unknown'}' run; episode_replay is ipd_episode only — use run_replay`);
  }
  const out = await runReplay({ db, principal: deps.principal }, args);
  return { engine: 'ipd_episode' as const, ...out };
}
