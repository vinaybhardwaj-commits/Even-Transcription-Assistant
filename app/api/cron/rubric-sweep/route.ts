/**
 * /api/cron/rubric-sweep — the per-consult rubric runner (RUBRIC-SWEEP). Every 10 minutes it queues at most one capped `rubric_run` job per PRODUCTION consult rubric for the
 * consults that have no result yet (lib/rubrics/sweep.ts has the rules).
 *
 * SHIPS DARK. RUBRIC_SWEEP_MODE missing or "off" answers `skipped: "sweep_off"` having read NOTHING; "dry" counts and submits nothing; "live" submits. An unknown value is a 500, never "off".
 * GET only; Bearer CRON_SECRET only (a bare x-vercel-cron header does not authorise). This code never sets env.
 */
import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { respondError, respondOk } from "@/lib/respond";
import { runRubricSweep, sweepMode, SweepModeError, SweepReadError } from "@/lib/rubrics/sweep";

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
  let mode;
  try {
    mode = sweepMode(process.env.RUBRIC_SWEEP_MODE);
  } catch (e) {
    return respondError("PIPELINE_FAILED", e instanceof SweepModeError ? e.message : "RUBRIC_SWEEP_MODE is not readable");
  }
  if (mode === "off") return respondOk({ skipped: "sweep_off" });
  try {
    const out = await runRubricSweep(mode, { origin: new URL(req.url).origin });
    return respondOk("summary" in out ? out.summary : out);
  } catch (e) {
    return respondError("PIPELINE_FAILED", `rubric sweep failed: ${e instanceof SweepReadError ? e.code : "unexpected"}`);
  }
}
