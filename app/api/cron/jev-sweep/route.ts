/**
 * /api/cron/jev-sweep — the Jev worker's sweeper (PRD §3.2, P1.5). Every 5 minutes it syncs the question-set files into the DB
 * (idempotent), then queues at most one capped `jev_ask` job per enabled use and, once per IST day, the previous day's drift report.
 *
 * SHIPS DARK. Unless JEV_WORKER_ENABLED is on it answers `skipped: "worker_disabled"` having read NOTHING (no DB, no Jev). A use also needs its own
 * flag (JEV_USE_*) and ETA_JEV_ENABLED for the job to make a call. GET only; Bearer CRON_SECRET only (a bare x-vercel-cron header does not authorise).
 */
import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { respondError, respondOk } from "@/lib/respond";
import { workerEnabled } from "@/lib/jev/worker/flags";
import { syncQuestionSets } from "@/lib/jev/worker/sync";
import { sweepJev } from "@/lib/jev/worker/sweeper";
import { classifyDbError } from "@/lib/jev/worker/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function cronAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const got = Buffer.from(req.headers.get("authorization") ?? "", "utf8");
  const want = Buffer.from(`Bearer ${secret}`, "utf8");
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function GET(req: NextRequest) {
  if (!cronAuthorized(req)) return respondError("AUTH_REQUIRED", "cron secret required");
  let enabled: boolean;
  try {
    enabled = workerEnabled();
  } catch {
    return respondError("PIPELINE_FAILED", "JEV_WORKER_ENABLED has an unrecognised value");
  }
  if (!enabled) return respondOk({ skipped: "worker_disabled" });
  try {
    const sync = await syncQuestionSets();
    const sweep = await sweepJev();
    return respondOk({
      synced: sync.map((s) => ({ id: s.id, version: s.version, result: s.result })),
      uses: sweep.uses, drift_enqueued: sweep.drift_enqueued,
    });
  } catch (e) {
    return respondError("PIPELINE_FAILED", `jev sweep failed: ${classifyDbError(e)}`);
  }
}
