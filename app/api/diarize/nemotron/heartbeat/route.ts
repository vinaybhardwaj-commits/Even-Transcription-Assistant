/**
 * POST /api/diarize/nemotron/heartbeat — the Nemotron worker's liveness, every 60 s (PRD §6.1; epic #23 b).
 *
 * Auth: Bearer NEMOTRON_WORKER_TOKEN. 404 `disabled` while DIARIZE_NEMOTRON_SHADOW is off. Body ≤ 16 KB.
 * Allow-listed fields only (lib/diarize-nemotron/validate.ts checkHeartbeat); unknown fields are dropped, not stored.
 * 200 { ok:true } · 400 { ok:false, error } · 503 { ok:false, error:"db" }. Read by the fleet board in ticket (i).
 */
import { NextRequest } from "next/server";
import { gate, readJson, reply } from "@/lib/diarize-nemotron/http";
import { recordHeartbeat } from "@/lib/diarize-nemotron/store";
import { checkHeartbeat } from "@/lib/diarize-nemotron/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

export async function POST(req: NextRequest) {
  const shut = gate(req);
  if (shut) return shut;
  const read = await readJson(req, 16_000);
  if ("fail" in read) return read.fail;
  const v = checkHeartbeat(read.body);
  if (!v.ok) return reply(400, { ok: false, error: v.error });
  try {
    await recordHeartbeat(v.worker_id, v.payload);
    return reply(200, { ok: true });
  } catch (e) {
    console.warn("[nemotron] heartbeat failed:", e instanceof Error ? e.name : "error");
    return reply(503, { ok: false, error: "db" });
  }
}
