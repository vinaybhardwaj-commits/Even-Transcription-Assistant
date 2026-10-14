/**
 * lib/lab-v2/tools/queue.ts — `review_queue` (LAB-MCP-V2-PRD-v1.0 §17.7 round C3, decision 97).
 *
 * WHAT A REVIEWER NEEDS IS TWO LISTS, AND THEY ARE NOT THE SAME KIND OF THING. One is work waiting
 * on this key — releases prepared and not applied. The other is evidence worth a human's attention
 * — cases whose band moved between two arms. The first is a queue; the second is a reading list,
 * and the output says so rather than letting a reviewer read the second as a ranking.
 *
 * ⚠️ THE PENDING LIST IS `release_status`'s OWN, CALLED. `releaseStatus` already decides WHY a
 * release waits — unreviewed, rejected, expired, hash_superseded, approved_not_applied — and that
 * decision is a small state machine over reviews, expiry and artifact hashes. A second query here
 * with its own idea of "pending" would be a second state machine, and the first time the two
 * disagreed a reviewer would be told a release was waiting that was not, or worse, not told about
 * one that was. This file calls the function and adds only what the release OBJECT carries.
 *
 * ⚠️⚠️ THE BAND LIST IS RE-DERIVED, AND THAT IS A GROUNDING FINDING, NOT A CHOICE.
 *
 * §17.7's C3 grounding says `experiment_compare` persists "with per-cluster `band_before`,
 * `band_after`, `band_changed`". Measured on `4224e152`, it does not. `compare.ts:328` stores
 * `putObject(db, principal, 'report', report, …)` — object kind `report`, with `kind:
 * 'experiment_compare'` as a FIELD OF THE BODY — and the per-arm summary carries
 * `band_changed: <count>` and nothing else. `band_before` and `band_after` exist at `compare.ts:63`
 * and `:227`, but they belong to `run_diff`'s per-case output, which is not persisted at all.
 *
 * So the stored compare cannot answer decision 97, and `compare.ts` is not in this round's file
 * contract. What the stored compare DOES carry is its experiment id, its baseline arm and its arm
 * ids — enough to re-read the same items it was computed over and re-pair them the same way. That
 * is what this file does, and it does three things to keep the reconstruction honest:
 *
 *   1. it uses `compare.ts`'s OWN pairing predicate, restated once with the line it came from, and
 *      a test pins the restatement against that file's source;
 *   2. it CROSS-CHECKS: the number of band changes it re-derives per arm must equal the
 *      `band_changed` count the stored object recorded. A mismatch is reported per compare as
 *      `consistent: false` with both numbers, never smoothed over;
 *   3. it says `basis` in words on every response, so nobody reads these rows as something the
 *      compare object contained.
 */
import { z } from 'zod';
import { getObject, itemsOf, type Item } from '../store';
import { releaseStatus } from './release';
import type { Db } from '../db';

export const QUEUE_SCHEMAS = {
  review_queue: {
    input: z.object({
      window_hours: z.number().int().min(1).max(2160).default(168),
      limit: z.number().int().min(1).max(500).default(100),
    }),
    output: z.object({
      window_hours: z.number().int(),
      model_calls: z.number().int(),
      /** ⚠️ One sentence, on every response: these are listed, never scored. */
      basis: z.string(),
      pending_releases: z.array(z.object({
        release_id: z.string().uuid(),
        target: z.string(),
        label: z.string().nullable(),
        artifact_hash: z.string(),
        impact_ref: z.string().nullable(),
        prepared_by: z.string(),
        prepared_at: z.string().nullable(),
        reviews: z.number().int(),
        /** `release_status`'s own word for why this waits. Not re-derived here. */
        waiting_because: z.string(),
      })),
      band_changes: z.array(z.object({
        case_key: z.string(),
        compare_object_id: z.string().uuid(),
        experiment_id: z.string(),
        band_before: z.string().nullable(),
        band_after: z.string().nullable(),
        baseline_arm_hash: z.string().nullable(),
        arm_hash: z.string().nullable(),
        compared_at: z.string(),
      })),
      compares: z.array(z.object({
        compare_object_id: z.string().uuid(),
        experiment_id: z.string(),
        created_at: z.string(),
        band_changes_found: z.number().int(),
        band_changed_recorded: z.number().int(),
        /** False when the re-derivation disagrees with the stored count. See the header. */
        consistent: z.boolean(),
        note: z.string().nullable(),
      })),
      totals: z.object({
        pending_releases: z.number().int(),
        compares_read: z.number().int(),
        band_changes: z.number().int(),
        inconsistent_compares: z.number().int(),
      }),
    }),
  },
} as const;

export const QUEUE_BASIS =
  'Two lists, and neither is a ranking. The pending releases are release_status’s own rows, with '
  + 'its own word for why each one waits. The band changes are CASES TO READ, not cases that are '
  + 'wrong and not cases ordered by importance: a band moving between two arms is a reason for a '
  + 'clinician to look, and this tool scores nothing. The band rows are re-derived from the run '
  + 'items each stored experiment_compare was computed over, because the stored object records a '
  + 'per-arm band_changed COUNT and no per-case rows; each compare reports whether the '
  + 're-derivation matched that count.';

/**
 * ⚠️ `compare.ts:301`, RESTATED ONCE. Pairs are formed only over cases assessable-and-verified on
 * BOTH sides, and a re-derivation that used a looser predicate would report band changes the
 * compare never counted — which is precisely what the cross-check below would then catch, loudly
 * and for the wrong reason. `c3-queue.test.ts` pins this against `compare.ts`'s own source.
 */
export const USABLE_PREDICATE =
  "i.execution_status === 'succeeded' && i.assessment_status === 'assessed' && i.attribution_status === 'verified'";
const usable = (i: Item) =>
  i.execution_status === 'succeeded' && i.assessment_status === 'assessed' && i.attribution_status === 'verified';

const bandOf = (i: Item): string | null => {
  const s = (i.result as { summary?: Record<string, unknown> } | null)?.summary ?? {};
  return s.band == null ? null : String(s.band);
};

/**
 * THE TWO READS. `lab_v2` only.
 *
 * ⚠️ `kind = 'report' AND body->>'kind' = 'experiment_compare'`, AND BOTH HALVES ARE LOAD-BEARING.
 * `OBJECT_KINDS` has no `experiment_compare` member — `compare.ts` stores its report under the
 * generic `report` kind and puts the discriminator in the body. Selecting on the object kind alone
 * would return every `run_report`, every `rule_simulation` and every corpus report as well.
 */
export const COMPARE_OBJECTS_SQL = `SELECT id::text AS id, owner, hash, body, created_at
FROM lab_v2.objects
WHERE kind = 'report'
  AND body->>'kind' = 'experiment_compare'
  AND created_at > now() - make_interval(hours => $1)
ORDER BY created_at DESC
LIMIT $2`;

/** `compare.ts:258`'s own selection, so the re-derivation reads the same runs the compare read. */
export const EXPERIMENT_RUNS_SQL = `SELECT id::text AS id
FROM lab_v2.runs
WHERE experiment_id = $1 AND operation = 'experiment_run'
ORDER BY created_at`;

/** How many compares one call will open. A reviewer reads cases, not a corpus of comparisons. */
export const MAX_COMPARES = 25;

interface CompareBody {
  kind?: string; experiment_id?: string; baseline_arm_id?: string;
  arms?: { arm_id?: string; is_baseline?: boolean; band_changed?: number }[];
}

export async function reviewQueue(
  db: Db, principal: string, args: { window_hours?: number; limit?: number },
) {
  const windowHours = Math.floor(args.window_hours ?? 168);
  const limit = Math.floor(args.limit ?? 100);

  // ── (a) the pending releases — release_status's own rows ─────────────────────────────
  const status = await releaseStatus({ db, principal }, { limit: 5 });
  const pending_releases = [];
  for (const p of status.pending_approval) {
    // `approved_not_applied` is still waiting — on the release key rather than on a reviewer — so it
    // stays in the queue. Filtering it out would hide the one state where someone can act now.
    const object = await getObject(db, p.release_id);
    const body = (object?.body ?? {}) as { impact_ref?: string | null };
    pending_releases.push({
      release_id: p.release_id,
      target: p.target,
      label: p.label,
      artifact_hash: p.artifact_hash,
      impact_ref: body.impact_ref == null ? null : String(body.impact_ref),
      prepared_by: p.preparer,
      prepared_at: object ? String(object.created_at) : null,
      reviews: p.reviews,
      // ⚠️ release_status's own word, passed through. Not a second vocabulary.
      waiting_because: p.state,
    });
  }

  // ── (b) decision 97 — the band changes ──────────────────────────────────────────────
  const compareRows = await db.query<{ id: string; body: unknown; created_at: string }>(
    COMPARE_OBJECTS_SQL, [windowHours, MAX_COMPARES]);

  const band_changes: {
    case_key: string; compare_object_id: string; experiment_id: string;
    band_before: string | null; band_after: string | null;
    baseline_arm_hash: string | null; arm_hash: string | null; compared_at: string;
  }[] = [];
  const compares: {
    compare_object_id: string; experiment_id: string; created_at: string;
    band_changes_found: number; band_changed_recorded: number; consistent: boolean; note: string | null;
  }[] = [];

  for (const row of compareRows) {
    const body = (row.body ?? {}) as CompareBody;
    const experimentId = String(body.experiment_id ?? '');
    const createdAt = String(row.created_at);
    const recorded = (body.arms ?? []).reduce((n, a) => n + Number(a.band_changed ?? 0), 0);
    if (!experimentId) {
      compares.push({
        compare_object_id: row.id, experiment_id: '', created_at: createdAt,
        band_changes_found: 0, band_changed_recorded: recorded, consistent: false,
        note: 'the stored compare names no experiment; its cases cannot be re-read',
      });
      continue;
    }

    // The same runs, the same items, the same arm grouping `compare.ts` used.
    const runs = await db.query<{ id: string }>(EXPERIMENT_RUNS_SQL, [experimentId]);
    const items: Item[] = [];
    for (const r of runs) items.push(...await itemsOf(db, r.id, 1000, 0));

    const armHashById = new Map<string, string>();
    for (const a of body.arms ?? []) {
      if (!a.arm_id) continue;
      const o = await getObject(db, a.arm_id);
      if (o) armHashById.set(a.arm_id, o.hash);
    }
    const baselineHash = body.baseline_arm_id ? armHashById.get(body.baseline_arm_id) ?? null : null;
    const byArmHash = new Map<string, Item[]>();
    for (const i of items) {
      const arr = byArmHash.get(i.arm_hash);
      if (arr) arr.push(i); else byArmHash.set(i.arm_hash, [i]);
    }
    const baselineByCase = new Map((baselineHash ? byArmHash.get(baselineHash) ?? [] : []).map((i) => [i.case_key, i]));

    let found = 0;
    for (const a of body.arms ?? []) {
      if (!a.arm_id || a.arm_id === body.baseline_arm_id) continue;
      const armHash = armHashById.get(a.arm_id) ?? null;
      for (const i of armHash ? byArmHash.get(armHash) ?? [] : []) {
        const base = baselineByCase.get(i.case_key);
        if (!base || !usable(i) || !usable(base)) continue;
        const before = bandOf(base);
        const after = bandOf(i);
        // `pairCase`'s own rule: a change, not a difference from null. Two nulls are not a move, and
        // one null is — a case that stopped having a band is exactly what a reviewer should see.
        if (before === after) continue;
        found += 1;
        if (band_changes.length < limit) {
          band_changes.push({
            case_key: i.case_key,
            compare_object_id: row.id,
            experiment_id: experimentId,
            band_before: before,
            band_after: after,
            baseline_arm_hash: baselineHash,
            arm_hash: armHash,
            compared_at: createdAt,
          });
        }
      }
    }

    const consistent = found === recorded;
    compares.push({
      compare_object_id: row.id, experiment_id: experimentId, created_at: createdAt,
      band_changes_found: found, band_changed_recorded: recorded, consistent,
      // ⚠️ REPORTED, NOT RESOLVED. The items are terminal once finished, so the two numbers should
      // agree; if they do not, something moved after the compare was stored and the right response
      // is to re-run experiment_compare, not to trust either number.
      note: consistent ? null
        : `re-derived ${found} band change(s) and the stored compare recorded ${recorded}; the run items have moved since it was computed — re-run experiment_compare before reading these rows`,
    });
  }

  return {
    window_hours: windowHours,
    model_calls: 0,
    basis: QUEUE_BASIS,
    pending_releases,
    band_changes,
    compares,
    totals: {
      pending_releases: pending_releases.length,
      compares_read: compares.length,
      band_changes: band_changes.length,
      inconsistent_compares: compares.filter((c) => !c.consistent).length,
    },
  };
}
