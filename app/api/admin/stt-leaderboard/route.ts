/**
 * /api/admin/stt-leaderboard — WER, and what it excluded (Build 2 §D).
 *
 * PRD §4: the leaderboard returns `{wer, n_scored, n_refused, refusal_breakdown}` and "no code
 * path renders WER without its refusal rate."
 *
 * THAT IS ENFORCED IN THE SHAPE, NOT IN THE DISCIPLINE OF WHOEVER READS IT. `buildLeaderboard`
 * assembles all four fields together from one pass and there is no branch, no query parameter and
 * no error path that emits a row carrying `wer` without `n_refused` beside it. A caller cannot
 * ask for the headline alone, because the function that could produce it does not exist.
 *
 * WHY THAT MATTERS MORE HERE THAN IT SOUNDS. A WER of 0.11 over two windows out of two hundred is
 * not a better number than a WER of 0.19 over all of them; it is a different and much weaker
 * claim wearing the same units. Every engine comparison this programme will run is a comparison
 * of pairs that survived, so the survival rate IS part of the measurement.
 *
 * ALL SQL IS INFERRED (no live database in the sandbox). Reads fail safe: a broken query yields
 * an empty leaderboard with a logged reason and an `errors` array — never a 500, and never a
 * partial leaderboard that looks complete.
 *
 * NO UI. Build 2 ships JSON only; the operator surfaces come later.
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";
import { buildLeaderboard } from "@/lib/stt/window-leaderboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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

type Logger = (msg: string) => void;

async function safeRead<T>(what: string, fallback: T, log: Logger, run: () => Promise<T>): Promise<{ ok: boolean; value: T }> {
  try {
    return { ok: true, value: await run() };
  } catch (e) {
    log(`[leaderboard] read failed (${what}): ${String((e as Error)?.message ?? e).slice(0, 200)} — degraded to empty`);
    return { ok: false, value: fallback };
  }
}

export async function GET(req: NextRequest) {
  if (!(await adminOrSecret(req))) return respondError("AUTH_REQUIRED", "admin or migration secret required");
  const log: Logger = (m) => console.log(m);
  const errors: string[] = [];

  // INFERRED SQL #5 — the scored side. Reads the metrics Build 2's scorer wrote into Build 1's
  // stt_window_score table; the family comes through the registry so a row can name it without a
  // second round trip.
  const scored = await safeRead<Array<{ engine_key: string; family: string | null; wer: number | null; cer: number | null }>>(
    "stt_window_score", [], log, async () =>
      (await sql`
        SELECT s.engine_key,
               f.family,
               (s.metrics_json->>'wer')::float8 AS wer,
               (s.metrics_json->>'cer')::float8 AS cer
          FROM stt_window_score s
          LEFT JOIN stt_engine_family f ON f.engine_key = s.engine_key
         WHERE s.metrics_json ? 'wer'
      `) as Array<{ engine_key: string; family: string | null; wer: number | null; cer: number | null }>);
  if (!scored.ok) errors.push("stt_window_score read failed");

  // INFERRED SQL #6 — the refusal side.
  const refusals = await safeRead<Array<{ engine_key: string; reason_code: string; n: number }>>(
    "stt_score_refusal", [], log, async () =>
      (await sql`
        SELECT engine_key, reason_code, COUNT(*)::int AS n
          FROM stt_score_refusal
         GROUP BY engine_key, reason_code
      `) as Array<{ engine_key: string; reason_code: string; n: number }>);
  if (!refusals.ok) errors.push("stt_score_refusal read failed");

  const rows = buildLeaderboard(scored.value, refusals.value);
  const totalScored = rows.reduce((a, r) => a + r.n_scored, 0);
  const totalRefused = rows.reduce((a, r) => a + r.n_refused, 0);

  return respondOk({
    engines: rows,
    totals: {
      n_scored: totalScored,
      n_refused: totalRefused,
      refusal_rate: totalScored + totalRefused > 0
        ? Math.round((totalRefused / (totalScored + totalRefused)) * 1000) / 1000
        : null,
    },
    // Said out loud rather than left to be discovered: today this board is expected to be all
    // refusals, and that is the correct reading of the current data, not a fault.
    note: totalScored === 0
      ? "no pair is scoreable yet: the Cardiology seeds are status='seed' (graduation needs a blind re-listen, PRD §1.4) and no adapter reports a provider engine version, so receipt_complete is false everywhere"
      : null,
    errors,
  });
}
