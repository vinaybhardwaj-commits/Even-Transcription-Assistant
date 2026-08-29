/**
 * /api/admin/stt-spend — who spent what, per day (Build 2 §D).
 *
 * PRD §4: "Spend ledger: `initiated_by` × `cost_usd` per operator per day — the audited form of
 * 'paid runs only by operator action.'"
 *
 * ─── WHY NULL COSTS ARE COUNTED SEPARATELY AND NEVER SUMMED AS ZERO ───────────────────────
 * Sarvam returns no cost on any branch and the room drain stores exactly what the adapter
 * returned, so every paid room window to date has `cost_usd = NULL` (grounding §1). SUM() in
 * Postgres ignores NULLs, so a naive ledger would report $0.00 for a day of paid Sarvam calls and
 * an operator would read it as "we spent nothing" when the truth is "we do not know what we
 * spent". Those are opposite statements.
 *
 * So `cost_unreported_runs` sits beside every total. A day with cost_usd_total 0 and
 * cost_unreported_runs 12 is legible; a day with cost_usd_total 0 alone is a lie of omission.
 *
 * ─── WHY UNATTRIBUTED RUNS GET THEIR OWN BUCKET ───────────────────────────────────────────
 * Every run written before migration 0072 has `initiated_by = NULL` and is never backfilled
 * (§4: "Legacy rows get nothing"). Grouping those under an invented name would be the same lie in
 * the other column, so they group under a null initiator and are labelled `unattributed`.
 *
 * ALL SQL IS INFERRED. Reads fail safe to an empty ledger with a logged reason — never a 500.
 * NO UI. JSON only in this build.
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";
import { buildLedger, type SpendRow } from "@/lib/stt/window-leaderboard";

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

export async function GET(req: NextRequest) {
  if (!(await adminOrSecret(req))) return respondError("AUTH_REQUIRED", "admin or migration secret required");
  const errors: string[] = [];
  let rows: SpendRow[] = [];

  try {
    // INFERRED SQL #7. COALESCE(SUM(...), 0) makes an all-null day report 0 rather than NULL, and
    // the FILTER count beside it is what stops that 0 being read as "free". Grouped on the IST
    // clinic date, not UTC: a clinic day is what an operator is accountable for, and a run at
    // 00:15 IST belongs to the day the clinic was open, not to the previous UTC date.
    const raw = (await sql`
      SELECT r.initiated_by,
             r.initiated_via,
             to_char((r.created_at AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS day,
             COUNT(*)::int AS n_runs,
             COALESCE(SUM(r.cost_usd), 0)::float8 AS cost_usd_total,
             COUNT(*) FILTER (WHERE r.cost_usd IS NULL)::int AS cost_unreported_runs
        FROM transcription_run r
       WHERE r.subject_type = 'bench_window'
       GROUP BY r.initiated_by, r.initiated_via, (r.created_at AT TIME ZONE 'Asia/Kolkata')::date
       ORDER BY day DESC, r.initiated_by NULLS LAST
    `) as Array<Record<string, unknown>>;
    rows = buildLedger(raw);
  } catch (e) {
    const msg = `[spend] read failed: ${String((e as Error)?.message ?? e).slice(0, 200)} — degraded to empty ledger`;
    console.log(msg);
    errors.push(msg);
  }

  const unreported = rows.reduce((a, r) => a + r.cost_unreported_runs, 0);
  return respondOk({
    ledger: rows,
    totals: {
      n_runs: rows.reduce((a, r) => a + r.n_runs, 0),
      cost_usd_total: Math.round(rows.reduce((a, r) => a + r.cost_usd_total, 0) * 1e5) / 1e5,
      cost_unreported_runs: unreported,
      unattributed_runs: rows.filter((r) => r.initiated_by === null).reduce((a, r) => a + r.n_runs, 0),
    },
    note: unreported > 0
      ? "cost_usd_total EXCLUDES runs whose engine reported no cost; Sarvam reports none on any branch, so a total of 0 beside a non-zero cost_unreported_runs means unknown spend, never zero spend"
      : null,
    errors,
  });
}
