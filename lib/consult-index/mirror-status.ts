/**
 * lib/consult-index/mirror-status.ts — the consult-index mirror clock for /api/health and scribe_health.
 *
 * Two reads, both counts and times only:
 *   - max consult_index.t1_ms against max reb_track_index.t1_ms for layer stt or role (non-shadow);
 *   - the latest index_mirror_run (migration 0162), by the run's own reported_at.
 * A missing index_mirror_run table means the exit has never been ingestable: exit_code stays null,
 * which is not a non-zero exit. Any other read failure is red, with a sqlstate and no message.
 */
import { judgeConsultIndexMirror, sqlState, type MirrorHealth } from "@/lib/consult-index/mirror-staleness";
import { latestMirrorRun, readMirrorClocks } from "@/lib/room-access/consult-index-store";

export async function consultIndexMirrorHealth(now: Date = new Date()): Promise<MirrorHealth> {
  let clocks: { mirror_t1_ms: number | null; reb_t1_ms: number | null };
  try {
    clocks = await readMirrorClocks();
  } catch (e) {
    const st = sqlState(e);
    console.error("[consult-index] mirror clocks unreadable", JSON.stringify({ sqlstate: st }));
    return { ...judgeConsultIndexMirror({ nowMs: now.getTime(), mirrorT1Ms: null, rebT1Ms: null, exitCode: null, exitReason: null }), ok: false, error: `db:${st}` };
  }
  let exitCode: number | null = null;
  let exitReason: string | null = null;
  try {
    const run = await latestMirrorRun();
    if (run) {
      exitCode = run.exit_code;
      exitReason = run.reason;
    }
  } catch (e) {
    const st = sqlState(e);
    if (st !== "42P01") {
      console.error("[consult-index] mirror exit unreadable", JSON.stringify({ sqlstate: st }));
      return { ...judgeConsultIndexMirror({ nowMs: now.getTime(), mirrorT1Ms: clocks.mirror_t1_ms, rebT1Ms: clocks.reb_t1_ms, exitCode: null, exitReason: null }), ok: false, error: `db:${st}` };
    }
  }
  return judgeConsultIndexMirror({ nowMs: now.getTime(), mirrorT1Ms: clocks.mirror_t1_ms, rebT1Ms: clocks.reb_t1_ms, exitCode, exitReason });
}
