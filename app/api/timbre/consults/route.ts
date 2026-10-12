/**
 * GET /api/timbre/consults?date=YYYY-MM-DD — the consults the nightly Timbre job scores for one IST day (Architecture #79).
 *
 * Auth: HMAC over `${ts}.GET ${path}?${query}` (lib/timbre/auth.ts::checkTimbreGet, TIMBRE_INGEST_SECRET). 404 `disabled`
 * while TIMBRE_INGEST is not "1" (the same switch as the ingest route). Held-out room-days are dropped before the answer
 * (lib/timbre/consults.ts). Read-only.
 *   200 { ok, date, consults: [...], withheld_blind, skipped, total }    400 bad_date    401/503 auth    503 db:<sqlstate>
 */
import { NextRequest, NextResponse } from "next/server";
import { checkTimbreGet } from "@/lib/timbre/auth";
import { timbreConsultsForDay } from "@/lib/timbre/consults";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  if (process.env.TIMBRE_INGEST !== "1") return NextResponse.json({ ok: false, error: "disabled" }, { status: 404 });
  const url = new URL(req.url);
  const auth = checkTimbreGet(req.headers, `${url.pathname}${url.search}`);
  if (auth) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const date = url.searchParams.get("date") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    return NextResponse.json({ ok: false, error: "bad_date" }, { status: 400 });
  }
  try {
    const out = await timbreConsultsForDay(date);
    return NextResponse.json({ ok: true, date, ...out }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `db:${(e as { code?: string }).code ?? "unknown"}` }, { status: 503 });
  }
}
