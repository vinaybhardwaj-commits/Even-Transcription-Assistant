/**
 * GET /api/freescript/day?ist_date=YYYY-MM-DD — stored FreeScript artifacts for one IST day.
 *
 * The optional eta2freescript_offline hook. Read-only. No Pulse write.
 * 404 when ETA_FREESCRIPT is 0 (unset is on). Auth: HMAC over `${ts}.GET ${path}?${query}`
 * (lib/freescript/auth.ts, FREESCRIPT_INGEST_SECRET). Held-out room-days are dropped.
 *   200 { ok, ist_date, n, truncated, withheld_blind, rows }
 *   400 bad_date    401/503 auth    503 db
 */
import { NextRequest, NextResponse } from "next/server";
import { FlagValueError } from "@/lib/flags";
import { checkFreescriptGet } from "@/lib/freescript/auth";
import { freescriptEnabled } from "@/lib/freescript/flag";
import { freescriptDayRead } from "@/lib/mcp/tools/freescript";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  try {
    if (!freescriptEnabled()) return NextResponse.json({ ok: false, error: "disabled" }, { status: 404 });
  } catch (e) {
    if (e instanceof FlagValueError) return NextResponse.json({ ok: false, error: "freescript_flag" }, { status: 500 });
    throw e;
  }
  const url = new URL(req.url);
  const auth = checkFreescriptGet(req.headers, `${url.pathname}${url.search}`);
  if (auth) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const date = url.searchParams.get("ist_date") ?? "";
  const out = await freescriptDayRead(date);
  if (out.ok === false && out.error === "bad_date") return NextResponse.json(out, { status: 400 });
  if (out.ok === false && out.error === "disabled") return NextResponse.json(out, { status: 404 });
  if (out.ok === false) return NextResponse.json(out, { status: 503 });
  return NextResponse.json(out, { headers: { "cache-control": "no-store" } });
}
