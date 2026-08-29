/**
 * /api/admin/speaker-calibration — the number that decides how many people were in the room
 * (PRD §7, Build 4 §D).
 *
 * `SPEAKER_MATCH_THRESHOLD` has no default anywhere in this build, deliberately: it is the single
 * most consequential invented number the programme could contain. Set it low and every voice in a
 * clinic day collapses into one cluster; set it high and one person becomes six. Neither failure
 * announces itself — both produce a plausible integer.
 *
 * So this route replays the ACTUAL matcher over ACTUAL room embeddings at a sweep of thresholds
 * and reports what each would have produced. The orchestrator and V read it, pick a line, and
 * freeze the value. Until then the cron refuses to write clusters.
 *
 * IT RUNS THE SHIPPED CODE, NOT A MODEL OF IT. `sweepThreshold` calls the same `matchCluster` and
 * `runningMean` the writer calls. A calibration against a re-implementation would be calibrating
 * a different instrument from the one that ships — which is how a threshold gets frozen against
 * behaviour that never existed.
 *
 * READ-ONLY, AND THAT IS ASSERTED. There is no INSERT, UPDATE or DELETE in this file. It reads
 * stored diarize results; it never calls the Mini, never writes a cluster, and never touches the
 * threshold it exists to inform.
 *
 * WHAT IT NEEDS FIRST. Diarize results have to exist. Run the cron once with `?dry=1`
 * (`SPEAKER_CLUSTERS_ENABLED=1`, threshold still unset) — that diarizes and stores the service's
 * answer without clustering anything. This route then reads those rows. With none stored it says
 * so by name rather than reporting an empty sweep as a finding.
 *
 * ALL SQL IS INFERRED. The read fails safe to empty with a logged reason — never a 500.
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";
import {
  decodeEmbedding,
  sweepThreshold,
  describeDistribution,
  CALIBRATION_THRESHOLDS,
  SPEAKER_MATCH_THRESHOLD_ENV,
  readThreshold,
  // Overridable by ?session_id so a later day can be swept without a deploy.
  CALIBRATION_SESSION_ID,
} from "@/lib/stt/speaker-clusters";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function adminOrSecret(req: NextRequest): Promise<boolean> {
  const secret = process.env.MIGRATION_SECRET;
  const auth = req.headers.get("authorization") || "";
  if (secret && auth === `Bearer ${secret}`) return true;
  const cookie = await readAdminCookie();
  if (cookie) {
    try { await verifyAdminJwt(cookie); return true; } catch { /* fall through */ }
  }
  return false;
}

export async function GET(req: NextRequest) {
  if (!(await adminOrSecret(req))) return respondError("AUTH_REQUIRED", "admin or migration secret required");

  const sessionId = req.nextUrl.searchParams.get("session_id") || CALIBRATION_SESSION_ID;
  const errors: string[] = [];
  let rows: Array<{ window_id: string; speakers_json: unknown }> = [];

  try {
    // INFERRED SQL #8 — the stored diarize answers for this session's windows. Joined through
    // bench_window because room_diarize_window is keyed on the window, not the session.
    rows = (await sql`
      SELECT d.window_id, d.speakers_json
        FROM room_diarize_window d
        JOIN bench_window w ON w.id = d.window_id
       WHERE w.session_id = ${sessionId}
         AND d.state = 'ok'
       ORDER BY w.start_ms ASC
    `) as Array<{ window_id: string; speakers_json: unknown }>;
  } catch (e) {
    const msg = `[speaker-calibration] read failed: ${String((e as Error)?.message ?? e).slice(0, 200)} — degraded to empty`;
    console.log(msg);
    errors.push(msg);
  }

  // Flatten to the embeddings the matcher would actually see, IN WINDOW ORDER — the order the
  // cron would present them in, because a running mean is order-dependent and a sweep over a
  // different order is a sweep of a different instrument.
  const embeddings: Float32Array[] = [];
  let speakersSeen = 0;
  let unusable = 0;
  for (const r of rows) {
    const list = Array.isArray(r.speakers_json) ? r.speakers_json : [];
    for (const sp of list) {
      speakersSeen++;
      const b64 = (sp as Record<string, unknown>)?.embedding_base64;
      const e = decodeEmbedding(typeof b64 === "string" ? b64 : null);
      if (e) embeddings.push(e);
      else unusable++;
    }
  }

  const sweep = CALIBRATION_THRESHOLDS.map((t) => {
    const point = sweepThreshold(embeddings, t);
    return {
      threshold: t,
      clusters: point.clusters,
      // "within" = samples that joined an existing cluster; "between" = the best cosine a sample
      // still fell short of. A threshold sitting inside the overlap of these two distributions is
      // one that cannot separate the voices, whatever integer it produces.
      within: describeDistribution(point.within),
      between: describeDistribution(point.between),
    };
  });

  const current = readThreshold();

  return respondOk({
    session_id: sessionId,
    windows_with_results: rows.length,
    speakers_seen: speakersSeen,
    embeddings_usable: embeddings.length,
    embeddings_unusable: unusable,
    sweep,
    current_threshold: current.ok ? current.threshold : null,
    current_threshold_error: current.ok ? null : current.error,
    threshold_env: SPEAKER_MATCH_THRESHOLD_ENV,
    // Said out loud rather than left to be inferred from an empty sweep.
    note: rows.length === 0
      ? `no stored diarize results for ${sessionId}. Run POST /api/admin/diarize-windows?dry=1 with SPEAKER_CLUSTERS_ENABLED=1 first — it diarizes and stores the service's answer without writing any cluster.`
      : embeddings.length === 0
        ? "diarize results exist but carry no usable embeddings — the Mini returned speakers without embedding_base64, so clustering cannot be calibrated or performed"
        : null,
    read_only: true,
    errors,
  });
}
