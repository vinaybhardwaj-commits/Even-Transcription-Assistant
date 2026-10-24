/**
 * GET /api/cron/spine — the Spine cron: ingest (S1), then merge (P2 writer), then enqueue (P2 shadow jobs), then transcript_final (S7a, server-side executor; only after a clean enqueue). Scheduled every 5 minutes in vercel.json.
 * BEARER, as the other cron routes: `Authorization: Bearer $CRON_SECRET`. CRON_SECRET unset -> 503 and nothing runs; wrong bearer -> 401.
 * Each step is gated separately by spine_config (kill_switch / ingest / merge / jobs + mode.<stage>): off, missing or malformed -> { skipped: "off" } and nothing is written.
 * Failure: an ingest failure does not stop merge (it works on stored signals); a merge failure skips enqueue (fail closed: no jobs from a stale merge). Any step failure -> 500 with the
 * counts of the steps that ran and a generic code; no error text leaves.
 * Response: counts only.
 */
import { NextResponse } from "next/server";
import { bearerMatches } from "@/lib/spine/auth";
import { ingestSpineSignals } from "@/lib/spine/ingest-store";
import { runSpineMerge } from "@/lib/spine/merge-store";
import { runSpineEnqueue } from "@/lib/spine/enqueue-store";
import { runTranscriptFinal } from "@/lib/spine/transcript-final-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_STORE = { headers: { "cache-control": "no-store" } };

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: { code: "NOT_CONFIGURED", message: "CRON_SECRET is not set" } }, { status: 503, ...NO_STORE });
  if (!bearerMatches(req.headers.get("authorization"), secret)) return NextResponse.json({ error: { code: "AUTH_REQUIRED", message: "cron bearer required" } }, { status: 401, ...NO_STORE });
  const now = Date.now();
  const out: Record<string, unknown> = {};
  const failed: string[] = [];
  const step = async (name: "ingest" | "merge" | "enqueue" | "transcript_final", run: () => Promise<unknown>): Promise<boolean> => {
    try { out[name] = await run(); return true; } catch (e) {
      console.error(`spine cron: ${name} failed`, (e as { code?: string }).code ?? "unknown");
      failed.push(name);
      return false;
    }
  };
  await step("ingest", () => ingestSpineSignals(now));
  const merged = await step("merge", () => runSpineMerge(now));
  const enqueued = merged ? await step("enqueue", () => runSpineEnqueue(now)) : false;
  if (enqueued) await step("transcript_final", () => runTranscriptFinal(now, new URL(req.url).origin));
  if (failed.length) {
    const code = failed[0] === "ingest" ? "SPINE_INGEST_FAILED" : failed[0] === "merge" ? "SPINE_MERGE_FAILED" : failed[0] === "enqueue" ? "SPINE_ENQUEUE_FAILED" : "SPINE_TRANSCRIPT_FINAL_FAILED";
    return NextResponse.json({ ok: false, error: { code }, failed, ...out }, { status: 500, ...NO_STORE });
  }
  return NextResponse.json({ ok: true, ...out }, NO_STORE);
}
