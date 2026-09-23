/**
 * lib/room-window-reaper.ts — the "orphaned transcribing" room_window sweep, IMPURE half (23 Sep
 * 2026). Called by /api/admin/reap-stuck after the encounter and bench sweeps (same cron, same
 * auth). Decisions are in lib/room-window-reaper-core.ts (pure, tested); this file reads
 * candidates, applies the recovery write, and records one audit_log row per reaped window.
 *
 * Fail-safe to no-op (the same house style as the bench sweep): any error is logged and
 * swallowed — the hourly cron must never 500 because of this sweep.
 *
 * SQL — INFERRED against the live schema this order measured against (bench_window, scribe_job,
 * stt_subject_job); no live DB in this sandbox, verify against production before trusting it:
 *
 *   SELECT w.id AS window_id, j.finished_at AS job_finished_at, j.status AS job_status,
 *          sj.attempts AS subject_attempts
 *     FROM bench_window w
 *     LEFT JOIN LATERAL (
 *       SELECT status, finished_at FROM scribe_job
 *        WHERE kind = 'room_window' AND args->>'window_id' = w.id
 *        ORDER BY created_at DESC LIMIT 1
 *     ) j ON true
 *     LEFT JOIN stt_subject_job sj
 *       ON sj.subject_type = 'bench_window' AND sj.subject_id = w.id AND sj.tier = 'asr'
 *    WHERE w.state = 'transcribing'
 *    LIMIT 200
 *
 *   UPDATE bench_window SET state = ${next_bench_state}
 *    WHERE id = ${window_id} AND state = 'transcribing'
 *    RETURNING id
 *
 *   UPDATE stt_subject_job
 *      SET state = ${next_subject_state},
 *          finished_at = CASE WHEN ${next_subject_state} = 'failed' THEN NOW() ELSE NULL END
 *    WHERE subject_type = 'bench_window' AND subject_id = ${window_id} AND tier = 'asr'
 *
 *   INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
 *   VALUES ('system', 'reaper', 'room_window.reap_orphaned_transcribing', 'bench_window',
 *           ${window_id}, ${metadata}::jsonb)
 *
 * The bench_window UPDATE re-checks `state = 'transcribing'` so a window a fresh drain claimed
 * between the read and the write is never touched — the SAME race guard the bench sweep uses.
 */
import { sql } from "./db";
import {
  decideRoomWindowReaps,
  ROOM_WINDOW_REAP_CAP,
  type RoomWindowReapCandidate,
  type RoomWindowReapDecision,
} from "./room-window-reaper-core";

/** A tagged-template SQL runner with lib/db's `sql` shape — injectable for tests. */
export type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;

export interface RoomWindowReapResult {
  dry_run: boolean;
  candidates: number;
  reaped: Array<RoomWindowReapDecision & { audit: "written" | "failed" }>;
  error?: string;
}

export async function reapOrphanedRoomWindows(
  opts: { now?: Date; dryRun?: boolean; cap?: number } = {},
  run: SqlTag = sql as unknown as SqlTag,
): Promise<RoomWindowReapResult> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun === true;
  const cap = Math.max(1, Math.min(200, opts.cap ?? ROOM_WINDOW_REAP_CAP));
  let rows: RoomWindowReapCandidate[] = [];
  try {
    rows = (await run`
      SELECT w.id AS window_id, j.finished_at AS job_finished_at, j.status AS job_status,
             sj.attempts AS subject_attempts
        FROM bench_window w
        LEFT JOIN LATERAL (
          SELECT status, finished_at FROM scribe_job
           WHERE kind = 'room_window' AND args->>'window_id' = w.id
           ORDER BY created_at DESC LIMIT 1
        ) j ON true
        LEFT JOIN stt_subject_job sj
          ON sj.subject_type = 'bench_window' AND sj.subject_id = w.id AND sj.tier = 'asr'
       WHERE w.state = 'transcribing'
       LIMIT 200
    `) as RoomWindowReapCandidate[];
  } catch (e) {
    console.error("[room-window-reaper] candidate read failed — no-op", (e as Error)?.message ?? e);
    return { dry_run: dryRun, candidates: 0, reaped: [], error: String((e as Error)?.message ?? e).slice(0, 150) };
  }
  const decisions = decideRoomWindowReaps(rows ?? [], now, cap);
  if (dryRun) return { dry_run: true, candidates: rows.length, reaped: decisions.map((d) => ({ ...d, audit: "written" as const })) };

  const reaped: RoomWindowReapResult["reaped"] = [];
  for (const d of decisions) {
    try {
      const updated = (await run`
        UPDATE bench_window SET state = ${d.next_bench_state}
         WHERE id = ${d.window_id} AND state = 'transcribing'
         RETURNING id
      `) as Array<{ id: string }>;
      if (!Array.isArray(updated) || updated.length === 0) continue;   // claimed meanwhile — nothing to record
      await run`
        UPDATE stt_subject_job
           SET state = ${d.next_subject_state},
               finished_at = CASE WHEN ${d.next_subject_state} = 'failed' THEN NOW() ELSE NULL END
         WHERE subject_type = 'bench_window' AND subject_id = ${d.window_id} AND tier = 'asr'
      `;
      let audit: "written" | "failed" = "written";
      try {
        await run`
          INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
          VALUES ('system', 'reaper', 'room_window.reap_orphaned_transcribing', 'bench_window', ${d.window_id},
                  ${JSON.stringify({ reason: d.reason, next_bench_state: d.next_bench_state, next_subject_state: d.next_subject_state })}::jsonb)
        `;
      } catch { audit = "failed"; }   // best-effort audit, like the encounter and bench reapers
      reaped.push({ ...d, audit });
    } catch (e) {
      console.error("[room-window-reaper] update failed for", d.window_id, (e as Error)?.message ?? e);
      // keep sweeping the others
    }
  }
  return { dry_run: false, candidates: rows.length, reaped };
}
