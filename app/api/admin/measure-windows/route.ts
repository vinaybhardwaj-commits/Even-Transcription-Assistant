/**
 * /api/admin/measure-windows — the nightly measure job (Build 1 §B, §D).
 *
 * Measures every closed window that has no measurement yet, then runs the tuning fork once.
 * Idempotent: a window with a measure row is never rescanned, and the write is an UPSERT on the
 * window's primary key, so two overlapping invocations cannot produce two answers.
 *
 * FREE. Nothing in this endpoint calls a paid engine. It reads levels the kiosk already uploaded
 * and language opinions the drain already wrote, and the only inference it runs is local Whisper
 * on one frozen ~90-second clip. That is why it may be scheduled at all: the standing rule that
 * paid runs happen only when an operator presses a button (PRD §1.6) is untouched, because this
 * spends nothing.
 *
 * AUTH — THE HOUSE PATTERN, WHICH IS NOT ?auto=1. The Build 1 kickoff describes the existing cron
 * endpoints as using a `?auto=1` query flag. There is no such flag anywhere in this repository:
 * both scheduled routes (`/api/admin/reap-stuck`, `/api/admin/resume-processing`) authorise on
 * the un-spoofable `x-vercel-cron` header or a Bearer secret, and neither reads `auto`. This
 * route follows the pattern that actually exists rather than inventing the one described, and
 * the discrepancy is raised in the build report rather than resolved silently.
 *
 *   GET   Vercel Cron (x-vercel-cron), or Bearer CRON_SECRET, or Bearer MIGRATION_SECRET.
 *   POST  Bearer MIGRATION_SECRET, or an admin cookie — the manual door, for an operator who
 *         wants the coverage report now rather than tomorrow morning.
 *
 * `?limit=` bounds one pass (default and ceiling 200). `?dry=1` measures nothing and reports what
 * the pass WOULD do; `?fork=0` skips the canary.
 *
 * IT ALSO CARRIES THE INSTALL REGISTRY'S NIGHTLY CLEANUP (Install and Fleet PRD §4.1). This is
 * the only genuinely nightly cron in vercel.json, so the deletion of abandoned bootstrap install
 * rows rides it rather than adding a second schedule. It runs after the measurement and its
 * failure is reported in `install_cleanup`, never thrown — see runInstallCleanup.
 *
 * NEVER 500s ON A DATA FAULT. Every read inside the job degrades to empty with a logged reason
 * and the pass continues, so a schema surprise on one table cannot take down a scheduled route
 * or, worse, write a measurement built from a partial answer.
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";
import { runMeasureJob, MEASURE_BATCH_LIMIT } from "@/lib/stt/measure-job";
import { cleanupExpiredInstalls } from "@/lib/room-install";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The fork's Whisper call is given 90 s and a pass can measure 200 windows of pure arithmetic.
export const maxDuration = 300;

function cronAuthorized(req: NextRequest): boolean {
  // Vercel Cron sets x-vercel-cron and strips any client-supplied x-vercel-* header, so its
  // presence is a trustworthy "this is our cron" signal. CRON_SECRET is defence in depth — the
  // resume-processing route records that x-vercel-cron is NOT reliably present on this project,
  // so both signals are accepted rather than either alone.
  if (req.headers.get("x-vercel-cron")) return true;
  const auth = req.headers.get("authorization") || "";
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && auth === `Bearer ${cronSecret}`) return true;
  const migrationSecret = process.env.MIGRATION_SECRET;
  // An EMPTY secret must never authorise. `Bearer ` === `Bearer ${undefined}` is false, but an
  // env var set to the empty string would make the comparison a coin toss on the header's shape.
  if (migrationSecret && auth === `Bearer ${migrationSecret}`) return true;
  return false;
}

async function adminOrSecret(req: NextRequest): Promise<boolean> {
  const secret = process.env.MIGRATION_SECRET;
  const auth = req.headers.get("authorization") || "";
  if (secret && auth === `Bearer ${secret}`) return true;
  const cookie = await readAdminCookie();
  if (cookie) {
    try { await verifyAdminJwt(cookie); return true; } catch { /* fall through */ }
  }
  return false;
}

function paramsOf(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const rawLimit = Number(p.get("limit"));
  return {
    limit: Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(MEASURE_BATCH_LIMIT, Math.trunc(rawLimit)) : MEASURE_BATCH_LIMIT,
    dry: p.get("dry") === "1",
    skipFork: p.get("fork") === "0",
  };
}

/**
 * The dry-run answer: how many windows are waiting, without measuring any of them. Fails safe to
 * a null count rather than an error — "I could not count" is a different answer from "none", and
 * a cron that reports zero because a query broke is the exact class of confident falsehood this
 * build exists to stop.
 */
async function pendingCount(): Promise<number | null> {
  try {
    const rows = (await sql`
      SELECT COUNT(*)::int AS n
        FROM bench_window w
       WHERE w.state IN ('closed', 'transcribing', 'transcribed', 'failed', 'silent')
         AND NOT EXISTS (SELECT 1 FROM stt_window_measure m WHERE m.window_id = w.id)
    `) as Array<{ n: number }>;
    return Number(rows[0]?.n) || 0;
  } catch {
    return null;
  }
}

/**
 * INSTALL AND FLEET §4.1 — the nightly deletion of abandoned install rows, riding this job.
 *
 * WHY HERE AND NOT ON ITS OWN CRON. The Build R1 kickoff asks for the existing nightly job unless
 * it cannot host this, and it can: this is the only genuinely nightly entry in vercel.json
 * (`30 20 * * *` — reap-stuck is hourly, resume-processing is every three minutes,
 * diarize-windows every five). A second cron entry would buy nothing and would add a second
 * schedule to reason about.
 *
 * IT CANNOT TAKE THE MEASURE JOB DOWN. The cleanup runs after the measurement, its failure is
 * caught and reported in the response rather than thrown, and it deletes at most 500 rows per
 * pass. The measure job's own answer is returned whether this succeeds or not — a fleet
 * bookkeeping failure must not look like a measurement failure.
 *
 * WHAT IT DELETES, precisely: install rows that were MINTED AND NEVER ENROLLED, whose token
 * expired more than 24 hours ago. An enrolled install is never deleted by a schedule.
 */
async function runInstallCleanup(): Promise<{ deleted: number } | { error: string }> {
  try {
    return await cleanupExpiredInstalls();
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 160);
    console.warn("[measure-windows] install cleanup failed", JSON.stringify({ err: msg }));
    return { error: msg };
  }
}

async function run(req: NextRequest) {
  const { limit, dry, skipFork } = paramsOf(req);
  if (dry) {
    return respondOk({ dry_run: true, pending_windows: await pendingCount(), limit });
  }
  const result = await runMeasureJob({ limit, skipFork });
  return respondOk({ ...result, install_cleanup: await runInstallCleanup() });
}

export async function GET(req: NextRequest) {
  if (!cronAuthorized(req)) return respondError("AUTH_REQUIRED", "cron header or secret required");
  return run(req);
}

export async function POST(req: NextRequest) {
  if (!(await adminOrSecret(req))) return respondError("AUTH_REQUIRED", "admin or migration secret required");
  return run(req);
}
