/**
 * GET /api/diarize/nemotron/lab/claim?worker_id=<id>&limit=<1..4> — CLAIM nemotron_lab_run items for the box worker. LAB ONLY (migration 0143).
 *
 * Auth: Bearer NEMOTRON_WORKER_TOKEN, the shadow flag, then NEMOTRON_LAB_ENABLED (lib/diarize-nemotron/http.ts labGate): 404 `disabled` / `lab_disabled`.
 *
 * PRODUCTION FIRST. If the production queue would offer ANY window right now (productionPendingExists, the same eligibility as /pending), this answers
 * 200 { ok, items: [], reason: "production_pending" } and claims nothing. The worker also asks /pending first; this is the server's own guard.
 *
 * 200 { ok, items: [{ run_id, idx, clip_url, attempt, spec, spec_hash, probs_put_url?, probs_key?, embeddings_put_url?, embeddings_key? }] }
 *   clip_url   presigned R2 GET (30 min). The *_put_url fields are presigned PUTs for keys THIS SERVER chose under lab/nemotron/.
 * 503 { error: "clip_sign" } when a clip URL cannot be signed: every item claimed in that call is given back (attempt refunded).
 * Ids, times, URLs and the allow-listed spec only. Never audio, never text.
 */
import { NextRequest } from "next/server";
import { signGetUrl, signPutUrl } from "@/lib/r2";
import { labGate, reply } from "@/lib/diarize-nemotron/http";
import { labEmbeddingsKey, labProbsKey } from "@/lib/diarize-nemotron/lab";
import { CLIP_URL_SECONDS, productionPendingExists } from "@/lib/room-access/nemotron-store";
import { claimLabItems, releaseLabClaim } from "@/lib/room-access/nemotron-lab-store";
import { isWorkerId } from "@/lib/diarize-nemotron/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const PUT_SECONDS = 3600;

export async function GET(req: NextRequest) {
  const shut = labGate(req);
  if (shut) return shut;
  const p = req.nextUrl.searchParams;
  const workerId = p.get("worker_id");
  if (!isWorkerId(workerId)) return reply(400, { ok: false, error: "bad_worker_id" });
  const asked = Number(p.get("limit"));
  const limit = Number.isFinite(asked) ? Math.min(4, Math.max(1, Math.trunc(asked))) : 1;
  try {
    if (await productionPendingExists()) return reply(200, { ok: true, items: [], reason: "production_pending" });
    const claimed = await claimLabItems(workerId, limit);
    try {
      const items = await Promise.all(
        claimed.map(async (c) => {
          const probsKey = c.spec.return_probs ? labProbsKey(c.run_id, c.idx) : null;
          const embKey = c.spec.return_embeddings ? labEmbeddingsKey(c.run_id, c.idx) : null;
          return {
            run_id: c.run_id,
            idx: c.idx,
            clip_url: await signGetUrl({ key: c.clip_r2_key, expiresInSeconds: CLIP_URL_SECONDS }),
            attempt: c.attempt,
            spec: c.spec,
            spec_hash: c.spec_hash,
            ...(probsKey ? { probs_key: probsKey, probs_put_url: await signPutUrl({ key: probsKey, contentType: "application/octet-stream", expiresInSeconds: PUT_SECONDS }) } : {}),
            ...(embKey ? { embeddings_key: embKey, embeddings_put_url: await signPutUrl({ key: embKey, contentType: "application/octet-stream", expiresInSeconds: PUT_SECONDS }) } : {}),
          };
        }),
      );
      return reply(200, { ok: true, items });
    } catch (e) {
      console.warn("[nemotron-lab] sign failed; giving back", claimed.length, "claim(s):", e instanceof Error ? e.name : "error");
      for (const c of claimed) await releaseLabClaim(workerId, c.run_id, c.idx);
      return reply(503, { ok: false, error: "clip_sign" });
    }
  } catch (e) {
    console.warn("[nemotron-lab] claim failed:", e instanceof Error ? e.name : "error");
    return reply(503, { ok: false, error: "db" });
  }
}
