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
 * 503 { error: "clip_sign" } when a clip URL cannot be signed: every window claimed in that call is given back
 *   (attempt refunded, lease released), so an R2 outage never burns attempts.
 * Ids, times and URLs only. Never audio, never text.
 */
import { NextRequest } from "next/server";
import { signGetUrl } from "@/lib/r2";
import { gate, reply } from "@/lib/diarize-nemotron/http";
import { CLIP_URL_SECONDS, claimPending, countExhausted, releaseClaim } from "@/lib/diarize-nemotron/store";
import { isWorkerId, pendingLimit } from "@/lib/diarize-nemotron/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function GET(req: NextRequest) {
  const shut = gate(req);
  if (shut) return shut;
  const p = req.nextUrl.searchParams;
  const workerId = p.get("worker_id");
  if (!isWorkerId(workerId)) return reply(400, { ok: false, error: "bad_worker_id" });
  try {
    const claimed = await claimPending(workerId, pendingLimit(p.get("limit")));
    let urls: string[];
    try {
      urls = await Promise.all(claimed.map((w) => signGetUrl({ key: w.clip_r2_key, expiresInSeconds: CLIP_URL_SECONDS })));
    } catch (e) {
      console.warn("[nemotron] clip sign failed; giving back", claimed.length, "claim(s):", e instanceof Error ? e.name : "error");
      for (const w of claimed) await releaseClaim(workerId, w.window_id);
      return reply(503, { ok: false, error: "clip_sign" });
    }
    const windows = claimed.map((w, i) => ({
      window_id: w.window_id,
      room_day_id: w.room_day_id,
      start_ms: w.start_ms,
      end_ms: w.end_ms,
      clip_url: urls[i],
      clip_sha256: null,
      attempt: w.attempts,
    }));
    return reply(200, { ok: true, windows, exhausted: await countExhausted() });
  } catch (e) {
    console.warn("[nemotron] pending failed:", e instanceof Error ? e.name : "error");
    return reply(503, { ok: false, error: "db" });
  }
}
