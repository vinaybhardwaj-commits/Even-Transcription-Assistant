/**
 * lib/lab-v2/tools/cluster.ts — `failure_cluster` (LAB-MCP-V2-PRD-v1.0 §17.7 round C3).
 *
 * WHAT IT IS FOR. A run reports how many items failed. It does not report whether they failed for
 * ONE reason twelve times or twelve reasons once, and those are opposite situations: the first is a
 * bug to fix, the second is a platform behaving as designed under a bad week. Clustering is the
 * cheapest thing that tells them apart, so it is a read and it is free.
 *
 * ⚠️ THREE FAILURE VOCABULARIES, NOT ONE, AND THE TOOL TAKES ALL THREE. §9's statuses are
 * independent: `execution_status: 'failed'` is "the engine did not finish", `assessment_status:
 * 'unassessable'` is "it finished and declared the case unanswerable", and `attribution_status:
 * 'invalid'` is "a model call cannot be attributed to a provider receipt". An item can be exactly
 * one of these and be the interesting one, so the filter is a disjunction, and each item carries
 * its three statuses into the output rather than being flattened to "failed".
 *
 * ⚠️ AN ITEM WITH NO ERROR OBJECT IS COUNTED, NEVER DROPPED. Measured on `4224e152`: `store.ts`'s
 * `finish` is the ONLY writer of `items.error` (`:352`), and an adapter that RETURNS
 * `execution_status: 'failed'` without throwing leaves `error` null — the OPD adapter does exactly
 * that when the frozen inputs do not parse. `reap` never writes `error` either, so an expired item
 * has none. Those items are the ones a cluster report would most easily lose, so they group under
 * a null category and appear in their own total.
 *
 * ⚠️ AND `lab_v2.items` HAS NO TIMESTAMP. Measured: the table carries no `created_at` (round B2 hit
 * the same wall on `queueWait`). The window is therefore over the item's LAST ENDED ATTEMPT —
 * `lab_v2.attempts.ended_at`, which is when the work actually stopped — falling back to the run's
 * `created_at` for an item that never ran. One expression, used for the window, for `first_seen`,
 * for `last_seen` and for the ordering, so all four mean the same thing.
 */
import { z } from 'zod';
import type { Db } from '../db';

/** A hard ceiling on rows read, independent of how many GROUPS are returned. See `truncated`. */
export const SCAN_CEILING = 2000;
/** The first line of an error message, trimmed. Long enough to separate causes, short enough to group. */
export const MESSAGE_HEAD_CHARS = 120;

export const CLUSTER_SCHEMAS = {
  failure_cluster: {
    input: z.object({
      window_hours: z.number().int().min(1).max(168).default(24),
      engine: z.string().max(64).optional(),
      /** The number of GROUPS returned, not of items scanned. */
      limit: z.number().int().min(1).max(200).default(50),
    }),
    output: z.object({
      window_hours: z.number().int(),
      engine: z.string().nullable(),
      /** Structural: this module reads and does nothing else. */
      model_calls: z.number().int(),
      /** ⚠️ Read this before the groups. */
      basis: z.string(),
      totals: z.object({
        items_considered: z.number().int(),
        items_grouped: z.number().int(),
        /** Counted, never dropped — see the header. */
        items_without_error: z.number().int(),
        groups: z.number().int(),
        groups_returned: z.number().int(),
        runs: z.number().int(),
        scan_ceiling: z.number().int(),
        /** True when the window held more failures than the ceiling; the report is then partial. */
        truncated: z.boolean(),
      }),
      groups: z.array(z.object({
        key: z.object({
          engine: z.string().nullable(),
          /** The stage of the item's LAST model call; null when it never made one. */
          stage: z.string().nullable(),
          category: z.string().nullable(),
          message_head: z.string().nullable(),
        }),
        items: z.number().int(),
        runs: z.number().int(),
        first_seen: z.string().nullable(),
        last_seen: z.string().nullable(),
        /** Three, so a reader can open one without the tool returning a list of everything. */
        examples: z.array(z.object({
          item_id: z.string(), run_id: z.string(), case_key: z.string(),
          execution_status: z.string().nullable(),
          assessment_status: z.string().nullable(),
          attribution_status: z.string().nullable(),
        })),
      })),
    }),
  },
} as const;

export const CLUSTER_BASIS =
  'Items whose execution_status is failed, or whose assessment_status is unassessable, or whose '
  + 'attribution_status is invalid — the three are independent (§9) and an item may be only one of '
  + 'them. Grouped by engine, the stage of the last model call, the error category and the first '
  + 'line of the error message. `lab_v2.items` carries no timestamp, so every time here is the '
  + 'item’s last ended attempt, or its run’s creation when it never ran. A group is a shape, not a '
  + 'diagnosis: two items with the same first line can still have different causes.';

/**
 * THE ONE READ. `lab_v2` only — no production table is touched by this tool.
 *
 * The two LATERALs are `LIMIT 1` each on an indexed `item_id`, so they are lookups rather than
 * scans. `payload->>'engine'` is where the engine lives on an item; there is no engine column.
 *
 * ⚠️ "LAST CALL" IS BY `created_at`, AND `lab_v2.calls` OFFERS NO TIEBREAK FINER THAN THAT. There is
 * no sequence column and `id` is a random uuid, so two calls written in the same instant order
 * arbitrarily; `lease_token DESC` breaks the tie between ATTEMPTS, which is the case that actually
 * arises. In production a stage is a model call and two of them are seconds apart, so this is a
 * limit of the fixture rather than of the data — but it is a limit, and the stage is reported as
 * "the last call" rather than "the stage it failed in", which the error does not carry.
 */
export const FAILED_ITEMS_SQL = `SELECT
  i.id::text            AS item_id,
  i.run_id::text        AS run_id,
  i.case_key            AS case_key,
  i.execution_status    AS execution_status,
  i.assessment_status   AS assessment_status,
  i.attribution_status  AS attribution_status,
  i.error               AS error,
  i.payload->>'engine'  AS engine,
  last_call.stage       AS last_stage,
  COALESCE(last_attempt.ended_at, r.created_at) AS seen_at
FROM lab_v2.items i
JOIN lab_v2.runs r ON r.id = i.run_id
LEFT JOIN LATERAL (
  SELECT c.stage FROM lab_v2.calls c WHERE c.item_id = i.id
   ORDER BY c.created_at DESC, c.lease_token DESC LIMIT 1
) last_call ON true
LEFT JOIN LATERAL (
  SELECT a.ended_at FROM lab_v2.attempts a
   WHERE a.item_id = i.id AND a.ended_at IS NOT NULL ORDER BY a.ended_at DESC LIMIT 1
) last_attempt ON true
WHERE (i.execution_status = 'failed'
    OR i.assessment_status = 'unassessable'
    OR i.attribution_status = 'invalid')
  AND ($2::text IS NULL OR i.payload->>'engine' = $2)
  AND COALESCE(last_attempt.ended_at, r.created_at) > now() - make_interval(hours => $1)
ORDER BY COALESCE(last_attempt.ended_at, r.created_at) DESC
LIMIT $3`;

interface FailedRow {
  item_id: string; run_id: string; case_key: string;
  execution_status: string | null; assessment_status: string | null; attribution_status: string | null;
  error: unknown; engine: string | null; last_stage: string | null; seen_at: string | Date | null;
}

/**
 * The first line of an error message, trimmed.
 *
 * ⚠️ THE FIRST LINE, NOT THE WHOLE MESSAGE, AND THE REASON IS THE STACK. `worker.ts` stores
 * `String(err.message).slice(0, 500)`, and several of this platform's messages carry a second line
 * with an id, a count or a hash in it — exactly the parts that differ between two instances of the
 * same fault. Grouping on the whole message would put every occurrence in its own group of one,
 * which is the failure mode this tool exists to avoid.
 */
export function messageHead(message: unknown): string | null {
  if (message == null) return null;
  const first = String(message).split('\n')[0].trim();
  return first.length ? first.slice(0, MESSAGE_HEAD_CHARS) : null;
}

const iso = (v: string | Date | null): string | null =>
  (v == null ? null : (v instanceof Date ? v.toISOString() : String(v)));

export async function failureCluster(
  db: Db, args: { window_hours?: number; engine?: string; limit?: number },
) {
  const windowHours = Math.floor(args.window_hours ?? 24);
  const limit = Math.floor(args.limit ?? 50);
  const engine = args.engine ?? null;

  const rows = await db.query<FailedRow>(FAILED_ITEMS_SQL, [windowHours, engine, SCAN_CEILING]);

  interface Group {
    key: { engine: string | null; stage: string | null; category: string | null; message_head: string | null };
    items: number; runs: Set<string>; first: string | null; last: string | null;
    examples: { item_id: string; run_id: string; case_key: string; execution_status: string | null; assessment_status: string | null; attribution_status: string | null }[];
  }
  const groups = new Map<string, Group>();
  const runs = new Set<string>();
  let withoutError = 0;

  for (const r of rows) {
    runs.add(r.run_id);
    const err = (r.error ?? null) as { category?: unknown; message?: unknown } | null;
    if (err == null) withoutError += 1;
    const key = {
      engine: r.engine ?? null,
      stage: r.last_stage ?? null,
      // ⚠️ NULL, NOT 'unknown'. Absence is a fact about the item and `Number(null) === 0` thinking
      // has cost this platform a round already; a label that reads like a category would hide it.
      category: err?.category == null ? null : String(err.category),
      message_head: messageHead(err?.message),
    };
    const id = JSON.stringify([key.engine, key.stage, key.category, key.message_head]);
    let g = groups.get(id);
    if (!g) {
      g = { key, items: 0, runs: new Set(), first: null, last: null, examples: [] };
      groups.set(id, g);
    }
    g.items += 1;
    g.runs.add(r.run_id);
    const at = iso(r.seen_at);
    if (at != null) {
      if (g.first == null || at < g.first) g.first = at;
      if (g.last == null || at > g.last) g.last = at;
    }
    if (g.examples.length < 3) {
      g.examples.push({
        item_id: r.item_id, run_id: r.run_id, case_key: r.case_key,
        execution_status: r.execution_status, assessment_status: r.assessment_status,
        attribution_status: r.attribution_status,
      });
    }
  }

  const ordered = [...groups.values()].sort((a, b) => b.items - a.items || (b.last ?? '').localeCompare(a.last ?? ''));
  const returned = ordered.slice(0, limit);

  return {
    window_hours: windowHours,
    engine,
    model_calls: 0,
    basis: CLUSTER_BASIS,
    totals: {
      items_considered: rows.length,
      // Equal to items_considered by construction — every item lands in a group, including the ones
      // with no error. Reported separately anyway, so "grouped" is never something to take on trust.
      items_grouped: ordered.reduce((n, g) => n + g.items, 0),
      items_without_error: withoutError,
      groups: ordered.length,
      groups_returned: returned.length,
      runs: runs.size,
      scan_ceiling: SCAN_CEILING,
      // ⚠️ SAID OUT LOUD. At the ceiling the report describes the most recent SCAN_CEILING failures
      // in the window and not the window; a caller who reads a partial picture as a whole one draws
      // the wrong conclusion from the right numbers.
      truncated: rows.length >= SCAN_CEILING,
    },
    groups: returned.map((g) => ({
      key: g.key, items: g.items, runs: g.runs.size,
      first_seen: g.first, last_seen: g.last, examples: g.examples,
    })),
  };
}
