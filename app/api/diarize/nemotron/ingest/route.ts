/**
 * POST /api/diarize/nemotron/ingest — the Nemotron worker posts one window's turns (PRD §7.1; epic #23 b).
 *
 * Auth: Bearer NEMOTRON_WORKER_TOKEN. 404 `disabled` while DIARIZE_NEMOTRON_SHADOW is off. Body ≤ 1 MB, checked
 * whole by lib/diarize-nemotron/validate.ts before any SQL.
 *
 *   (0143) an optional body key `probs_r2_key` (must equal lab/nemotron-probs/<window_id>.nlp) is stored when the object exists; the reply then says probs: stored | missing (absent when no pointer was sent).
 *   200 { ok, result: "stored", id, label, job }   new row (label = teacher-label outcome: written | skipped | failed;
 *                                                  job = the diarize_window job it submitted: submitted | deduped | none | refused)
 *   200 { ok, result: "duplicate", job }           identical re-post; nothing written (job only if a first submit was lost)
 *   503 { ok:false, error: "job_submit" }          the row is stored but the job could not be queued: re-post, it is idempotent
 *   200 { ok, result: "failure_recorded", attempts } a non-terminal failure; the window will be offered again
 *   200 { ok, result: "no_live_claim" }            a failure from a worker that no longer holds the lease; nothing changes
 *   400 { ok:false, error }                         the first validation failure (a code, never the value)
 *   404 { ok:false, error: "unknown_window" }       no such bench_window
 *   409 { ok:false, error: "conflict" | "room_day_mismatch" }  a different payload for a stored key; or the window's room-day differs
 *   403 { ok:false, error: "blind_room_day" }       the window's room-day is held out (lib/rubrics/blind-room-days.ts); nothing stored
 *   503 { ok:false, error: "db" }                   retry later
 */
import { NextRequest } from "next/server";
import { gate, readJson, reply } from "@/lib/diarize-nemotron/http";
import { recordIngest, windowNeedsDiarizeJob } from "@/lib/diarize-nemotron/store";
import { DIARIZE_WINDOW_KIND } from "@/lib/jobs/kinds/diarize-window";
import { JobArgsError } from "@/lib/jobs/types";
import { submitJob } from "@/lib/jobs/submit";
import { checkIngest } from "@/lib/diarize-nemotron/validate";
import { headObject } from "@/lib/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const MAX_BODY_CHARS = 1_000_000;

/**
 * THE TRIGGER (D5): a stored Nemotron answer queues the window's `diarize_window` job — this route never writes
 * room_diarize_window / room_turn_speaker itself (the job is their one writer). Only `ok` / `empty` answers
 * queue; the job dedupes on window_id while one is open, and a window that already has an ok / no_speakers row
 * (pyannote-era history, or this engine's own) is never queued again (windowNeedsDiarizeJob).
 */
async function queueDiarize(windowId: string, origin: string): Promise<"submitted" | "deduped" | "none" | "refused"> {
  if (!(await windowNeedsDiarizeJob(windowId))) return "none";
  try {
    const job = await submitJob({ kind: DIARIZE_WINDOW_KIND, args: { window_id: windowId }, actor: "nemotron_ingest", origin, scopes: new Set(["invoke"] as const) });
    return job.deduped ? "deduped" : "submitted";
  } catch (e) {
    // A held-out / unplaceable window is refused at submit: the answer is stored, no job is owed.
    if (e instanceof JobArgsError) return "refused";
    throw e;
  }
}

export async function POST(req: NextRequest) {
  const shut = gate(req);
  if (shut) return shut;
  const read = await readJson(req, MAX_BODY_CHARS);
  if ("fail" in read) return read.fail;
  const v = checkIngest(read.body);
  if (!v.ok) return reply(400, { ok: false, error: v.error });
  // (0143) the probability pointer is stored only if the object is really there; a missing one is dropped, not recorded
  let probs: "none" | "stored" | "missing" = "none";
  if (v.body.probs_r2_key) {
    if ((await headObject(v.body.probs_r2_key)).size === null) {
      v.body.probs_r2_key = null;
      probs = "missing";
    } else probs = "stored";
  }
  try {
    const out = await recordIngest(v.body, v.derived, v.payload_sha256);
    switch (out.result) {
      case "unknown_window":
        return reply(404, { ok: false, error: out.result });
      case "blind_room_day":
        return reply(403, { ok: false, error: out.result });
      case "conflict":
      case "room_day_mismatch":
        return reply(409, { ok: false, error: out.result });
      case "stored":
      case "duplicate": {
        // a stored `failed` row is not an answer; "duplicate" re-checks, so a lost first submit is rescued by a re-post
        let job: Awaited<ReturnType<typeof queueDiarize>> = "none";
        if (v.body.status !== "failed") {
          try {
            job = await queueDiarize(v.body.window_id, req.nextUrl.origin);
          } catch (e) {
            console.warn("[nemotron] job submit failed:", e instanceof Error ? e.name : "error", `window=${v.body.window_id}`);
            return reply(503, { ok: false, error: "job_submit" });
          }
        }
        return reply(200, { ok: true, ...out, job, ...(probs === "none" ? {} : { probs }) });
      }
      default:
        return reply(200, { ok: true, ...out });
    }
  } catch (e) {
    console.warn("[nemotron] ingest failed:", e instanceof Error ? e.name : "error", `window=${v.body.window_id}`);
    return reply(503, { ok: false, error: "db" });
  }
}
