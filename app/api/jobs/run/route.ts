/**
 * POST /api/jobs/run — Tier 2 §3. The job runner's only door.
 *
 * TWO CALLERS, ON PURPOSE. `after()` on submit kicks it so a queued job starts in about a second
 * rather than waiting for the minute to turn; `vercel.json`'s cron calls it every minute so a job
 * whose kick was lost — a cold start that dropped the after(), a runner killed mid-step — is still
 * picked up. Neither is sufficient alone: the kick is fast but unreliable, the cron is reliable but
 * up to a minute late.
 *
 * BEARER, NOT COOKIE. This is a machine door and must be callable by Vercel's scheduler, which
 * carries no session. `JOBS_RUNNER_SECRET` absent → 503 and NOTHING runs: a runner that authorised
 * everyone because its secret was unset would let any caller drive the Mini's work queue.
 *
 * It NEVER throws to the caller. The cron reads a non-200 as a failed invocation and retries next
 * minute, which is right for "the database was unreachable" and wrong for "one job's step failed" —
 * so a step failure is reported inside a 200 body and only an unusable runner is a 503.
 */
import { NextResponse } from "next/server";
import { runClaimedBatch } from "@/lib/jobs/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** §3: steps are ~200 s by construction, and three of them must fit under the platform ceiling. */
export const maxDuration = 300;

const NO_STORE = { headers: { "cache-control": "no-store" } };

/**
 * BOTH VERBS, and the reason is the scheduler. Vercel Cron invokes a path with GET; the after()
 * kick and any hand call use POST. One body, one guard — a second implementation is a second set of
 * auth rules to get wrong, which is how the house's other cron routes are written too.
 */
export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}

async function handle(req: Request) {
  const secret = process.env.JOBS_RUNNER_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: { code: "RUNNER_NOT_CONFIGURED", message: "JOBS_RUNNER_SECRET is not set" } },
      { status: 503, ...NO_STORE },
    );
  }
  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`; the kick sends the runner secret.
  // Either is proof, and both are compared whole — no prefix match, no unauthenticated path.
  const auth = req.headers.get("authorization") ?? "";
  const cron = process.env.CRON_SECRET;
  const ok = auth === `Bearer ${secret}` || (Boolean(cron) && auth === `Bearer ${cron}`);
  if (!ok) {
    return NextResponse.json(
      { error: { code: "AUTH_REQUIRED", message: "runner bearer required" } },
      { status: 401, ...NO_STORE },
    );
  }

  try {
    const out = await runClaimedBatch();
    return NextResponse.json({ ok: true, ...out }, NO_STORE);
  } catch (e) {
    // The queue itself is unreachable. 503 so the cron retries; the message is named, not a stack.
    return NextResponse.json(
      { error: { code: "QUEUE_UNAVAILABLE", message: String((e as Error)?.message ?? e).slice(0, 200) } },
      { status: 503, ...NO_STORE },
    );
  }
}
