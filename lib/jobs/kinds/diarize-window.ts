/**
 * lib/jobs/kinds/diarize-window.ts — C2 Part B. Diarize one room window, as a job.
 *
 * ONE STEP, ONE /diarize CALL. Measured on the Mini across four real 900 s windows the service runs
 * at 0.071-0.085x realtime (64-76 s wall), flat in speech density, against a 240 s lease — so a
 * whole window is one comfortable step. The earlier slice/stitch/snap machinery was built around an
 * assumed 1.5x and has been deleted rather than left behind a flag: a dormant second path is how
 * this table ended up with a writer nobody remembered.
 *
 * There is no submit/poll here because /diarize has none — it answers on the same request.
 */
import { randomUUID } from "node:crypto";
import { getObjectBytes } from "@/lib/r2";
import { sql } from "@/lib/db";
import { diarizeWindow, recordDiarizeWindow, repairStaleDiarizeSegments } from "@/lib/stt/diarize-window";
import { windowStart, windowEnd } from "@/lib/stt/window-bounds";
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

    // ONE ID PER RUN, on every turn row and on the window row (0090). A successful re-run gets a new
    // one, so a reader that planned from the old turns can tell they were rewritten.
    const runId = randomUUID();
    const base = { windowId, roomDayId: w.room_day_id, clipR2Key: w.clip_r2_key, runId };

    const bytes = await getObjectBytes(w.clip_r2_key);
    if (!bytes) {
      await recordDiarizeWindow({ ...base, state: "failed", error: `clip_missing:${w.clip_r2_key}`, speakers: null, segments: null, timing: null });
      return failWith(jobError("clip_missing_in_r2", w.clip_r2_key));
    }

    const res = await diarizeWindow({
      windowId,
      roomDayId: w.room_day_id,
      window: { start: windowStart(Number(w.start_ms)), end: windowEnd(Number(w.end_ms)) },
      audio: bytes,
      runId,
    });
    if (!res.ok) {
      // The service's message can describe the audio; the row gets a code. `retryable` means we
      // never reached it (no slot) — no state row, exactly as the pass did, so the window is
      // picked up again rather than recorded as a failure it did not have.
      console.error("[jobs] diarize failed", JSON.stringify({ window: windowId, err: String(res.error).slice(0, 200), retryable: res.retryable }));
      if (!res.retryable) {
        await recordDiarizeWindow({ ...base, state: "failed", error: res.error, speakers: null, segments: null, timing: res.timing });
      }
      return failWith(jobError(res.retryable ? "diarize_unavailable" : "diarize_failed"));
    }

    await recordDiarizeWindow({
      ...base,
      state: res.speakers.length === 0 ? "no_speakers" : "ok",
      error: null,
      speakers: res.speakers,
      segments: res.segments,
      timing: res.timing,
    });
    // E24 R10 — if the emotion job already recorded this window `diarize_stale`, this fresh run is the cure:
    // the named repair path accepts its segments for that window, and only that window. Otherwise it
    // changes nothing and the keep-rule above stands.
    const repaired = await repairStaleDiarizeSegments({ windowId, runId, speakers: res.speakers, segments: res.segments });

    // Counts and ids only — the spans carry no text and neither does this.
    return doneWith({ window_id: windowId, ...res.outcome, ...(repaired ? { stale_segments_repaired: true } : {}) });
  },
};
