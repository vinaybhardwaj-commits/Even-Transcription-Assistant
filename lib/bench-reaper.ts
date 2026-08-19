/**
 * lib/bench-reaper.ts — the Room Bench session sweep, IMPURE half (Kickoff K-A v2, 19 Aug 2026).
 * Called by /api/admin/reap-stuck after the encounter sweep (same cron, same auth). Decisions are
 * in lib/bench-reaper-core.ts (pure, tested); this file reads candidates, writes the honest ending,
 * and records one audit_log row per reaped session — the encounter reaper's actor / shape.
 *
 * Fail-safe to no-op (the bench house style): any error is logged and swallowed — the hourly cron
 * must never 500 because of the bench sweep. Capped per run (REAP_CAP) to stay inside the function
 * budget.
 *
 * SQL — INFERRED against 0041 / 0043 / 0045 (no live DB in the sandbox):
 *
 *   SELECT s.id, s.status, s.started_at,
 *          MAX(c.created_at) FILTER (WHERE c.source = 'primary') AS last_primary_at,
 *          MAX(c.created_at) FILTER (WHERE c.source = 'backup')  AS last_backup_at
 *     FROM bench_session s
 *     LEFT JOIN bench_chunk c ON c.session_id = s.id
 *    WHERE s.status <> 'ended'
 *    GROUP BY s.id, s.status, s.started_at
 *    ORDER BY s.started_at ASC
 *    LIMIT 200
 *
 *   UPDATE bench_session
 *      SET status = 'ended',
 *          ended_at = ${ended_at}::timestamptz,
 *          notes = CASE WHEN notes IS NULL OR notes = '' THEN ${note} ELSE notes || chr(10) || ${note} END
 *    WHERE id = ${id} AND status <> 'ended'
 *    RETURNING id
 *
 *   INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
 *   VALUES ('system', 'reaper', 'bench_session.reap', 'bench_session', ${id}, ${metadata}::jsonb)
 *
 * The UPDATE re-checks `status <> 'ended'` so a session a kiosk ended between the read and the
 * write is never touched; `ended_at` is the honest last-audio time computed by the core, NOT now().
 */
import { sql } from "./db";
import { decideBenchReaps, REAP_CAP, type BenchReapCandidate, type BenchReapDecision } from "./bench-reaper-core";

/** A tagged-template SQL runner with lib/db's `sql` shape — injectable for tests. */
export type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;

export interface BenchReapResult {
  dry_run: boolean;
  candidates: number;
  reaped: Array<BenchReapDecision & { audit: "written" | "failed" }>;
  error?: string;
}

export async function reapBenchSessions(
  opts: { now?: Date; dryRun?: boolean; cap?: number } = {},
  run: SqlTag = sql as unknown as SqlTag,
): Promise<BenchReapResult> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun === true;
  const cap = Math.max(1, Math.min(200, opts.cap ?? REAP_CAP));
  let rows: BenchReapCandidate[] = [];
  try {
    rows = (await run`
      SELECT s.id, s.status, s.started_at,
             MAX(c.created_at) FILTER (WHERE c.source = 'primary') AS last_primary_at,
             MAX(c.created_at) FILTER (WHERE c.source = 'backup')  AS last_backup_at
        FROM bench_session s
        LEFT JOIN bench_chunk c ON c.session_id = s.id
       WHERE s.status <> 'ended'
       GROUP BY s.id, s.status, s.started_at
       ORDER BY s.started_at ASC
       LIMIT 200
    `) as BenchReapCandidate[];
  } catch (e) {
    // Fail-safe: the bench tables may not exist yet, or db13 is away — the cron must not 500.
    console.error("[bench-reaper] candidate read failed — no-op", (e as Error)?.message ?? e);
    return { dry_run: dryRun, candidates: 0, reaped: [], error: String((e as Error)?.message ?? e).slice(0, 150) };
  }
  const decisions = decideBenchReaps(rows ?? [], now, cap);
  if (dryRun) return { dry_run: true, candidates: rows.length, reaped: decisions.map((d) => ({ ...d, audit: "written" as const })) };

  const reaped: BenchReapResult["reaped"] = [];
  for (const d of decisions) {
    try {
      const updated = (await run`
        UPDATE bench_session
           SET status = 'ended',
               ended_at = ${d.ended_at}::timestamptz,
               notes = CASE WHEN notes IS NULL OR notes = '' THEN ${d.note} ELSE notes || chr(10) || ${d.note} END
         WHERE id = ${d.id} AND status <> 'ended'
         RETURNING id
      `) as Array<{ id: string }>;
      if (!Array.isArray(updated) || updated.length === 0) continue;   // ended meanwhile — nothing to record
      let audit: "written" | "failed" = "written";
      try {
        await run`
          INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
          VALUES ('system', 'reaper', 'bench_session.reap', 'bench_session', ${d.id},
                  ${JSON.stringify({ rule: d.rule, note: d.note, ended_at: d.ended_at })}::jsonb)
        `;
      } catch { audit = "failed"; }   // best-effort audit, like the encounter reaper
      reaped.push({ ...d, audit });
    } catch (e) {
      console.error("[bench-reaper] update failed for", d.id, (e as Error)?.message ?? e);
      // keep sweeping the others
    }
  }
  return { dry_run: false, candidates: rows.length, reaped };
}
