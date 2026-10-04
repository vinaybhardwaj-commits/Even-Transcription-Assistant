/**
 * GET /api/cron/encounter-windows — recompute eta_encounter_windows.
 *
 * ONE ROUTE, THREE MODES (vercel.json carries two cron entries, same path, different `mode`):
 *   ?mode=recent   (default; every 5 minutes)  the last 3 h: a consult is final within 90 min of opening (the cap) plus
 *                  the 60 s pairing window, so 3 h is every window that can still change.
 *   ?mode=sweep    (hourly, minute 7)          the last 48 h: catches events that arrived late (retry queues).
 *   ?hours=N       (manual backfill, 1..720)   the last N hours; optional ?from=<ISO> restarts a stopped backfill.
 * Every mode refreshes through refreshWindowsByDay: the range is cut at IST midnights and each day is its own fetch and
 * its own transaction. A run stops starting new days after 50 s and reports complete=false with next_from; call again
 * with ?hours=N&from=<next_from> to continue.
 *
 * BEARER, NOT COOKIE — same shape as app/api/admin/room-watchdog/route.ts: Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET` and carries no session. CRON_SECRET unset -> 503 and NOTHING runs; wrong
 * bearer -> 401. Unknown mode or a bad `hours` / `from` -> 400.
 *
 * Each refresh is idempotent (delete rows with t_open in range, insert fresh, one transaction per day), so a retried or
 * overlapping run converges on the same rows.
 *
 * Response: counts only — consults, unpaired_refs, by_quality, by_attribution, by_close_reason. No ids, no names.
 * A failure returns 500 { error: { code: "REFRESH_FAILED" } } and logs a generic reason; days already committed stay.
 */
import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { refreshWindowsByDay } from "@/lib/encounter-windows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_STORE = { headers: { "cache-control": "no-store" } };
const HOUR = 3_600_000;
const HOURS_BY_MODE: Record<string, number> = { recent: 3, sweep: 48 };
const BUDGET_MS = 50_000;
const bad = (message: string) => NextResponse.json({ error: { code: "VALIDATION_FAILED", message } }, { status: 400, ...NO_STORE });

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: { code: "NOT_CONFIGURED", message: "CRON_SECRET is not set" } }, { status: 503, ...NO_STORE });
  }
  if ((req.headers.get("authorization") ?? "") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: { code: "AUTH_REQUIRED", message: "cron bearer required" } }, { status: 401, ...NO_STORE });
  }

  const p = new URL(req.url).searchParams;
  const startedAt = Date.now();
  const now = startedAt;
  let mode: string;
  let hours: number;
  let from: number;
  if (p.has("hours")) {
    mode = "backfill";
    const raw = Number(p.get("hours"));
    if (!Number.isFinite(raw) || raw < 1) return bad("hours must be a positive number");
    hours = Math.min(Math.trunc(raw), 720);
    from = now - hours * HOUR;
    const fromParam = p.get("from");
    if (fromParam) {
      const t = new Date(fromParam).getTime();
      if (Number.isNaN(t)) return bad("from is not a timestamp");
      from = t;
    }
  } else {
    mode = p.get("mode") ?? "recent";
    const h = HOURS_BY_MODE[mode];
    if (h === undefined) return bad("mode must be recent or sweep");
    hours = h;
    from = now - hours * HOUR;
  }
  const to = now + 5 * 60_000;
  if (from >= to) return bad("from is in the future");

  try {
    const r = await refreshWindowsByDay(sql, { from, to }, { asOf: now, deadlineMs: startedAt + BUDGET_MS });
    return NextResponse.json(
      {
        ok: true,
        mode,
        hours,
        range: r.range,
        chunks: r.chunks,
        complete: r.complete,
        next_from: r.next_from,
        events: r.events,
        deleted: r.deleted,
        inserted: r.inserted,
        consults: r.summary.consults,
        unpaired_refs: r.summary.unpaired_refs,
        by_quality: r.summary.by_quality,
        by_attribution: r.summary.by_attribution,
        by_close_reason: r.summary.by_close_reason,
      },
      NO_STORE,
    );
  } catch (e) {
    console.error(`[encounter-windows] refresh failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    return NextResponse.json({ error: { code: "REFRESH_FAILED", message: "refresh failed" } }, { status: 500, ...NO_STORE });
  }
}
