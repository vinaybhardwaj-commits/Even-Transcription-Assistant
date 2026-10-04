/**
 * lib/encounter-windows/cron.ts — the shared handler behind the two cron doors:
 *   GET /api/cron/encounter-windows         recent mode by default (every 5 min, last 3 h); ?mode=sweep|recent for manual calls
 *   GET /api/cron/encounter-windows/sweep   sweep mode (hourly, last 48 h), no query string needed
 * Both call handleCron; the sweep door passes forcedMode = "sweep", which overrides any ?mode=. `?hours=N` (manual
 * backfill, 1..720, optional ?from=<ISO> to resume) works on either door.
 *
 * Kept out of the route files because a Next route module may export only handlers and route config.
 * See app/api/cron/encounter-windows/route.ts for the full contract (auth, modes, response, failure behaviour).
 */
import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { refreshWindowsByDay } from "@/lib/encounter-windows";

const NO_STORE = { headers: { "cache-control": "no-store" } };
const HOUR = 3_600_000;
const HOURS_BY_MODE: Record<string, number> = { recent: 3, sweep: 48 };
const BUDGET_MS = 50_000;
const bad = (message: string) => NextResponse.json({ error: { code: "VALIDATION_FAILED", message } }, { status: 400, ...NO_STORE });

export async function handleCron(req: Request, forcedMode?: "recent" | "sweep"): Promise<NextResponse> {
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
    mode = forcedMode ?? p.get("mode") ?? "recent";
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
