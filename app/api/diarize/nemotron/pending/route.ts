/**
 * GET /api/diarize/nemotron/pending?worker_id=<id>&limit=<1..8> — CLAIM windows for the Nemotron worker (epic #23 b).
 *
 * Auth: Bearer NEMOTRON_WORKER_TOKEN (lib/diarize-nemotron/auth.ts). 404 `disabled` while DIARIZE_NEMOTRON_SHADOW is off.
 * Each returned window is leased to `worker_id` for 15 min (lib/diarize-nemotron/store.ts); after that, or after a
 * reported non-terminal failure, it can be claimed again, up to 3 attempts in all.
 *
 * 200 { ok, windows: [{ window_id, room_day_id, start_ms, end_ms, clip_url, clip_sha256, attempt }], exhausted }
 *   clip_url     a presigned R2 GET, 30 min.
 *   clip_sha256  always null today: bench_window stores no clip hash. The worker hashes what it fetched and posts that.
 *   exhausted    windows that used all 3 attempts with nothing stored.
 *   probs_key / probs_put_url  (0143) where the worker may PUT the window's per-frame probabilities (NLP1) and the key to post back as `probs_r2_key`.
 *                Best effort: if a PUT URL cannot be signed the two fields are simply absent (probabilities never fail a window).
 * machine=hf (optional; default box) is the HF overflow worker (lib/diarize-nemotron/overflow.ts). It is offered windows only while
 *   NEMO_HF_DAILY_USD_CAP > 0 (default 0 = OFF), the day's recorded HF minutes are under the cap, and the backlog exceeds
 *   NEMO_HF_BACKLOG_THRESHOLD; otherwise 200 { windows: [], overflow: { allowed: false, reason } }. A bad env value is 500 bad_flag.
 * PROBS lane (lib/diarize-nemotron/probs-lane.ts): when a BOX worker's claim finds no production window, windows that have turns
 *   but no probability file are offered instead (probs_only: true; never without a probs_put_url). Their ingest only sets the
 *   pointer. Any error in the lane is logged and answered as "no windows", never as a failed claim.
 * 503 { error: "clip_sign" } when a clip URL cannot be signed: every window claimed in that call is given back
 *   (attempt refunded, lease released), so an R2 outage never burns attempts.
 * Ids, times and URLs only. Never audio, never text.
 */
import { NextRequest } from "next/server";
import { signGetUrl, signPutUrl } from "@/lib/r2";
import { windowProbsKey } from "@/lib/diarize-nemotron/lab-keys";
import { gate, reply } from "@/lib/diarize-nemotron/http";
import { CLIP_URL_SECONDS, PROBS_CLAIM_PREFIX, claimPending, claimProbsBackfill, countExhausted, overflowUsage, releaseClaim, type ClaimedWindow } from "@/lib/diarize-nemotron/store";
import { probsBackfillEnabled } from "@/lib/diarize-nemotron/probs-lane";
import { OverflowConfigError, WINDOW_AUDIO_MIN, overflowConfig, overflowDecision, parseMachine } from "@/lib/diarize-nemotron/overflow";
import { isWorkerId, pendingLimit } from "@/lib/diarize-nemotron/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const PROBS_PUT_SECONDS = 3600;

/** The claim row key a window was leased under (the PROBS lane prefixes it). */
const claimKey = (w: ClaimedWindow) => (w.probs_only ? PROBS_CLAIM_PREFIX + w.window_id : w.window_id);

/** PROBS-lane windows for a box worker whose production claim came back empty; [] on any error (the lane never fails a claim). */
async function probsLane(workerId: string, limit: number): Promise<ClaimedWindow[]> {
  try {
    if (!probsBackfillEnabled()) return [];
    return await claimProbsBackfill(workerId, limit, "box");
  } catch (e) {
    console.warn("[nemotron] probs lane skipped:", e instanceof Error ? e.name : "error");
    return [];
  }
}

export async function GET(req: NextRequest) {
  const shut = gate(req);
  if (shut) return shut;
  const p = req.nextUrl.searchParams;
  const workerId = p.get("worker_id");
  if (!isWorkerId(workerId)) return reply(400, { ok: false, error: "bad_worker_id" });
  const machine = parseMachine(p.get("machine"));
  if (!machine) return reply(400, { ok: false, error: "bad_machine" });
  try {
    let limit = pendingLimit(p.get("limit"));
    if (machine === "hf") {
      // HF overflow: claims only above the backlog threshold and under the daily cost cap, decided HERE at claim time.
      // Not allowed is a normal 200 with no windows (and the reason), so the worker idles rather than backing off.
      let cfg;
      try {
        cfg = overflowConfig();
      } catch (e) {
        if (e instanceof OverflowConfigError) return reply(500, { ok: false, error: "bad_flag" });
        throw e;
      }
      // cap 0 = OFF: decided without touching the database
      const u = cfg.capUsd > 0 ? await overflowUsage() : { backlog: 0, hfIngestedMs: 0, hfLiveClaims: 0 };
      const usedMin = u.hfIngestedMs / 60000 + u.hfLiveClaims * WINDOW_AUDIO_MIN;
      const d = overflowDecision(cfg, { usedMin, backlog: u.backlog, limit });
      if (!d.allow) return reply(200, { ok: true, windows: [], exhausted: await countExhausted(), overflow: { allowed: false, reason: d.reason } });
      limit = d.limit;
    }
    let claimed = await claimPending(workerId, limit, machine);
    if (claimed.length === 0 && machine === "box") claimed = await probsLane(workerId, limit);
    let urls: string[];
    try {
      urls = await Promise.all(claimed.map((w) => signGetUrl({ key: w.clip_r2_key, expiresInSeconds: CLIP_URL_SECONDS })));
    } catch (e) {
      console.warn("[nemotron] clip sign failed; giving back", claimed.length, "claim(s):", e instanceof Error ? e.name : "error");
      for (const w of claimed) await releaseClaim(workerId, claimKey(w));
      return reply(503, { ok: false, error: "clip_sign" });
    }
    const probs = await Promise.all(
      claimed.map(async (w) => {
        try {
          const key = windowProbsKey(w.window_id);
          return { probs_key: key, probs_put_url: await signPutUrl({ key, contentType: "application/octet-stream", expiresInSeconds: PROBS_PUT_SECONDS }) };
        } catch {
          return {};
        }
      }),
    );
    // a PROBS-lane window is pointless without somewhere to put the file: give its claim back (attempt refunded) and drop it
    const keep: number[] = [];
    for (let i = 0; i < claimed.length; i++) {
      if (claimed[i].probs_only && !(probs[i] as { probs_put_url?: string }).probs_put_url) await releaseClaim(workerId, claimKey(claimed[i]));
      else keep.push(i);
    }
    const windows = keep.map((i) => ({ w: claimed[i], i })).map(({ w, i }) => ({
      window_id: w.window_id,
      room_day_id: w.room_day_id,
      start_ms: w.start_ms,
      end_ms: w.end_ms,
      clip_url: urls[i],
      clip_sha256: null,
      attempt: w.attempts,
      ...probs[i],
      ...(w.probs_only ? { probs_only: true } : {}),
    }));
    return reply(200, { ok: true, windows, exhausted: await countExhausted() });
  } catch (e) {
    console.warn("[nemotron] pending failed:", e instanceof Error ? e.name : "error");
    return reply(503, { ok: false, error: "db" });
  }
}
