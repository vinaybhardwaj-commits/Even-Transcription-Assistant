/**
 * /api/admin/bench/levels-retention — delete bench_level_sample rows older than 7 IST days.
 *
 * WHY (plan §2). The table grows ~850 KB/room-hour with no retention: at fleet scale that is
 * several GB a month with no cap. Raw rows are kept 7 IST days; nothing downsamples yet.
 *
 * SCHEDULED, BUT SAFE UNTIL ENABLED (ETA-LEVEL-LOG-OPS-REFUTER-22-SEP-2026.md PASS). vercel.json
 * now runs this hourly — sized to the fleet's growth (Refuter finding 1: a daily cron falls behind
 * once past ~9-23 rooms posting continuously; hourly keeps one call's 250,000-row cap far ahead of
 * any room's ~1,100 rows/hour). The schedule alone deletes nothing: an actual DELETE only happens
 * when BENCH_LEVEL_RETENTION is enabled per lib/flags.ts's parseFlag (1 | true | yes | on,
 * case-insensitive — an unrecognised value THROWS rather than reading as off); otherwise every
 * call is a dry run regardless of the `dryRun` flag, and says so (`forced_dry_run: true`). A
 * `dryRun: true` request is always a dry run, with or without the flag. See GET
 * /api/admin/bench/levels-retention/report for a per-room breakdown of what turning the flag on
 * would delete, without ever touching a row.
 *
 * POST — Auth: Bearer MIGRATION_SECRET (manual) OR an admin cookie. Body: { dryRun?: boolean }.
 * GET  — Vercel Cron. Auth: the un-spoofable x-vercel-cron header, or Bearer CRON_SECRET if that
 *        env is configured (same pattern as /api/admin/reap-stuck). Runs with dryRun=false, so
 *        whether it deletes anything still depends on BENCH_LEVEL_RETENTION.
 *
 * Batched (LEVEL_RETENTION_BATCH_SIZE rows at a time) and capped (LEVEL_RETENTION_MAX_BATCHES per
 * call) so one invocation cannot hold a long-running statement or run past its own deadline.
 * Idempotent: rows are targeted by `ist_date < cutoff`, so a rerun — including a partial one —
 * deletes only whatever still qualifies (lib/bench-levels.ts purgeOldLevelSamplesBatch).
 *
 * Touches only bench_level_sample. No transcript text, no clinician or patient identity here —
 * the table itself holds none.
 */
import { NextRequest } from "next/server";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";
import { parseFlag } from "@/lib/flags";
import {
  LEVEL_RETENTION_DAYS,
  LEVEL_RETENTION_BATCH_SIZE,
  LEVEL_RETENTION_MAX_BATCHES,
  levelRetentionCutoffIstDate,
  countOldLevelSamples,
  purgeOldLevelSamplesBatch,
} from "@/lib/bench-levels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RETENTION_ENV = "BENCH_LEVEL_RETENTION";

async function adminOrSecret(req: NextRequest): Promise<boolean> {
  const secret = process.env.MIGRATION_SECRET;
  const auth = req.headers.get("authorization") || "";
  if (secret && auth === `Bearer ${secret}`) return true;
  const cookie = await readAdminCookie();
  if (cookie) {
    try {
      await verifyAdminJwt(cookie);
      return true;
    } catch {
      /* fall through */
    }
  }
  return false;
}

function cronAuthorized(req: NextRequest): boolean {
  if (req.headers.get("x-vercel-cron")) return true;
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") || "";
  return Boolean(secret && auth === `Bearer ${secret}`);
}

type RetentionResult = {
  enabled: boolean;
  forced_dry_run: boolean;
  dry_run: boolean;
  cutoff_ist_date: string;
  retention_days: number;
  matched_before: number;
  deleted: number;
  batches_run: number;
  capped: boolean;
};

async function runRetention(dryRunRequested: boolean): Promise<RetentionResult> {
  // ETA-LEVEL-RETENTION-ENABLE-REFUTER-VERDICT-23-SEP-2026.md R2, Fable's ruling: this used to
  // hand-roll `=== "on"`, which read every value the repo's OWN flag convention accepts as true
  // — 1 | true | yes | ON — as OFF. An operator who wrote BENCH_LEVEL_RETENTION=true (the value
  // that works everywhere else in this codebase) got a silent forced dry run while believing
  // deletion was capping the table. parseFlag also THROWS on an unrecognised value instead of
  // reading it as off, which `=== "on"` could never do.
  const enabled = parseFlag(RETENTION_ENV);
  const forcedDryRun = !enabled && !dryRunRequested;
  const dryRun = dryRunRequested || !enabled;
  const cutoff = levelRetentionCutoffIstDate();
  const matchedBefore = await countOldLevelSamples(cutoff);

  let deleted = 0;
  let batches = 0;
  let capped = false;
  if (!dryRun) {
    // `batches` counts iterations, incremented BEFORE the short-batch break — a `for`'s own
    // increment clause never runs on the iteration that breaks, which undercounted by one.
    while (batches < LEVEL_RETENTION_MAX_BATCHES) {
      const n = await purgeOldLevelSamplesBatch(cutoff, LEVEL_RETENTION_BATCH_SIZE);
      deleted += n;
      batches += 1;
      if (n < LEVEL_RETENTION_BATCH_SIZE) break;
    }
    capped = batches >= LEVEL_RETENTION_MAX_BATCHES;
  }

  return {
    enabled,
    forced_dry_run: forcedDryRun,
    dry_run: dryRun,
    cutoff_ist_date: cutoff,
    retention_days: LEVEL_RETENTION_DAYS,
    matched_before: matchedBefore,
    deleted,
    batches_run: batches,
    capped,
  };
}

/** Refuter finding 2: a successful run logged nothing; only failures did. A cron's JSON body is
 * otherwise invisible anywhere. Logged at every outcome, including a forced dry run, so "the flag
 * is off" is visible in the logs too, not just in the response body a cron caller never reads. */
function logResult(source: "POST" | "GET", r: RetentionResult): void {
  console.log(`[bench-levels-retention] ${source}`, JSON.stringify(r));
}

export async function POST(req: NextRequest) {
  if (!(await adminOrSecret(req))) return respondError("AUTH_REQUIRED", "Sign in required");
  let body: { dryRun?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* allow empty body */
  }
  const dryRun = body.dryRun === true;
  try {
    const result = await runRetention(dryRun);
    logResult("POST", result);
    return respondOk(result);
  } catch (e) {
    console.warn("[bench-levels-retention] failed", JSON.stringify({ err: String((e as Error)?.message ?? e).slice(0, 200) }));
    return respondError("PIPELINE_FAILED", "levels_retention_failed");
  }
}

export async function GET(req: NextRequest) {
  if (!cronAuthorized(req)) return respondError("AUTH_REQUIRED", "Sign in required");
  try {
    const result = await runRetention(false);
    logResult("GET", result);
    return respondOk(result);
  } catch (e) {
    console.warn("[bench-levels-retention] failed", JSON.stringify({ err: String((e as Error)?.message ?? e).slice(0, 200) }));
    return respondError("PIPELINE_FAILED", "levels_retention_failed");
  }
}
