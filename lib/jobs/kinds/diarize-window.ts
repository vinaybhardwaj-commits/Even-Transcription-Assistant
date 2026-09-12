/**
 * lib/jobs/kinds/diarize-window.ts — C2 Part B. Diarize one room window, as a job.
 *
 * ONE STEP, and it is allowed to be: the service runs at ~1.5x realtime, so the admission check
 * below is what keeps that inside a lease rather than a hope. There is no submit/poll here because
 * /diarize has none — it answers on the same request — which is why this is a step and not a
 * two-phase machine like the router's.
 *
 * NOT the SPEAKER_CLUSTERS_ENABLED cron path. That path still exists, still ships dark behind two
 * env gates, and is not revived or read by anything here; this is a job an operator submits.
 */
import { getObjectBytes } from "@/lib/r2";
import { sql } from "@/lib/db";
import { diarizeWindow } from "@/lib/stt/diarize-window";
import { DIARIZE_REALTIME_FACTOR, diarizeFits } from "@/lib/stt/diarize-budget";
import { JobArgsError, doneWith, failWith, type JobKind, type StepContext } from "../types";
import { jobError } from "../errors";

export const DIARIZE_WINDOW_KIND = "diarize_window";

export const diarizeWindowKind: JobKind = {
  name: DIARIZE_WINDOW_KIND,
  first: "diarize",
  scope: "invoke",

  parseArgs(raw) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const window_id = typeof o.window_id === "string" ? o.window_id.trim() : "";
    if (!window_id) throw new JobArgsError("window_id is required");
    return { window_id };
  },

  async run(ctx: StepContext) {
    if (ctx.step !== "diarize") return failWith(jobError("unknown_step", ctx.step));
    const windowId = String(ctx.args.window_id ?? "");

    const rows = (await sql`
      SELECT id, room_day_id, start_ms, end_ms, clip_r2_key
        FROM bench_window WHERE id = ${windowId} LIMIT 1
    `) as Array<{ id: string; room_day_id: string | null; start_ms: string | number; end_ms: string | number; clip_r2_key: string | null }>;
    const w = rows[0];
    if (!w) return failWith(jobError("progress_incomplete", "no such window"));
    if (!w.room_day_id) return failWith(jobError("progress_incomplete", "window has no room_day"));
    if (!w.clip_r2_key) return failWith(jobError("clip_missing_in_r2", "window has no clip"));

    const startMs = Number(w.start_ms);
    const endMs = Number(w.end_ms);
    const audioSeconds = Math.max(0, (endMs - startMs) / 1000);

    // ── PRE-FLIGHT, the same rule the transcription step honours ─────────────────────────────
    // ~1.5x realtime means a 900 s window is ~1350 s of service time — five times the lease. The
    // refusal is named and happens before the clip is downloaded, so an oversized window is a
    // clear answer at admission instead of a lease expiry and a silently repeated call to a Mini
    // that serialises this work behind a depth-1 gate.
    const fit = diarizeFits(audioSeconds);
    if (!fit.fits) {
      return failWith(jobError("diarize_would_exceed_budget",
        `projected ${Math.round(fit.projected_ms / 1000)}s > ${Math.round(fit.budget_ms / 1000)}s for ${audioSeconds}s at ${DIARIZE_REALTIME_FACTOR()}x`));
    }

    const bytes = await getObjectBytes(w.clip_r2_key);
    if (!bytes) return failWith(jobError("clip_missing_in_r2", w.clip_r2_key));

    const res = await diarizeWindow({
      windowId, roomDayId: w.room_day_id, startMs, endMs, audio: bytes,
    });
    if (!res.ok) {
      // The service's message can describe the audio; the row gets a code. `retryable` means we
      // never reached it (no slot), which is a different fact from the service refusing.
      console.error("[jobs] diarize failed", JSON.stringify({ window: windowId, err: String(res.error).slice(0, 200), retryable: res.retryable }));
      return failWith(jobError(res.retryable ? "diarize_unavailable" : "diarize_failed"));
    }

    // Counts and ids only — the spans carry no text and neither does this.
    return doneWith({ window_id: windowId, ...res.outcome });
  },
};
