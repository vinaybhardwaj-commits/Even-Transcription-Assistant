/**
 * /api/admin/stt-gold-window — the room gold set, readable (Build 3 §D, PRD §1.2b).
 *
 * WHY THIS EXISTS. Build 2 seeded five Cardiology gold rows and there was no way to check them
 * from here: the only pullable database credential is `brain_svc`, which migration 0072
 * deliberately grants nothing on the spine tables, so verifying a seed meant opening the Neon
 * console. That is correct as a grant policy and useless as a verification path, and it would
 * have recurred on every future spine table. This makes the gold set checkable through the same
 * door as the leaderboard and the spend ledger, permanently.
 *
 * READ-ONLY. There is no POST, PUT or PATCH here and there is deliberately no graduation control:
 * graduation is a blind independent re-listen (PRD §1.4, §4), and a route that could flip
 * `status` to 'graduated' would make the most consequential state change in the whole programme a
 * single unlogged HTTP call. Graduation tooling is explicitly out of scope until it can carry its
 * own adjudication trail.
 *
 * REFERENCE TEXT IS LENGTH-ONLY BY DEFAULT. `ref_chars` answers "did the seed land and is it
 * plausible" without spraying five fifteen-minute clinical transcripts through a log, a browser
 * history or a screenshot. `?full=1` returns the text for the one case that needs it — a human
 * actually reading a reference — so the disclosure is a deliberate act rather than the default.
 *
 * ALL SQL IS INFERRED (no live database in the sandbox). The read fails safe to an empty list
 * with a logged reason — never a 500, and never a partial list that looks complete.
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Identical to the two Build 2 admin routes: admin JWT, or Bearer MIGRATION_SECRET. */
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
  const full = req.nextUrl.searchParams.get("full") === "1";
  const errors: string[] = [];
  let rows: Array<Record<string, unknown>> = [];

  try {
    // INFERRED SQL #10. `length(reference_text)` rather than the text itself: the column is NOT
    // NULL, so a length is always answerable and always safe to render.
    const raw = (await sql`
      SELECT window_id, status, source, seed_engine_family,
             covered_ms, window_ms,
             length(reference_text) AS ref_chars,
             reference_text,
             produced_by, verified_by, verified_at, created_at
        FROM stt_gold_window
       ORDER BY window_id
    `) as Array<Record<string, unknown>>;

    rows = raw.map((r) => ({
      window_id: r.window_id,
      status: r.status,
      source: r.source,
      seed_engine_family: r.seed_engine_family,
      covered_ms: r.covered_ms === null || r.covered_ms === undefined ? null : Number(r.covered_ms),
      window_ms: r.window_ms === null || r.window_ms === undefined ? null : Number(r.window_ms),
      ref_chars: r.ref_chars === null || r.ref_chars === undefined ? null : Number(r.ref_chars),
      produced_by: r.produced_by,
      verified_by: r.verified_by,
      verified_at: r.verified_at,
      created_at: r.created_at,
      // Present ONLY when explicitly asked for. Omitted rather than nulled, so a reader cannot
      // mistake "not requested" for "the reference is empty".
      ...(full ? { reference_text: r.reference_text } : {}),
    }));
  } catch (e) {
    const msg = `[gold-window] read failed: ${String((e as Error)?.message ?? e).slice(0, 200)} — degraded to empty list`;
    console.log(msg);
    errors.push(msg);
  }

  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[String(r.status)] = (byStatus[String(r.status)] ?? 0) + 1;

  return respondOk({
    rows,
    totals: {
      n: rows.length,
      by_status: byStatus,
      // The number that actually gates the programme: nothing is scoreable until a reference is
      // graduated, and graduation is human labour nobody has done yet.
      graduated: byStatus.graduated ?? 0,
    },
    full,
    note: rows.length > 0 && (byStatus.graduated ?? 0) === 0
      ? "no reference is graduated, so every (window, engine) pair refuses GOLD_NOT_GRADUATED — correct, not a fault. Graduation needs a blind independent re-listen (PRD §1.4)."
      : null,
    errors,
  });
}
