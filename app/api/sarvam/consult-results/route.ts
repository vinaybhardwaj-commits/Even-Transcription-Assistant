/**
 * GET /api/sarvam/consult-results — stored Sarvam consult_result heads for a box cron.
 *
 * Auth: Bearer REB_INDEX_READ_TOKEN or REB_INDEX_TOKEN (lib/reb/read-auth.ts). 503 when neither is set.
 * Query: ist_date=YYYY-MM-DD OR consult_uids=uid,uid (max 25). sealed=1 keeps consult_index.sealed rows.
 * include_text=1 opts into transcript text; the default is heads (counts, model, no text). Read-only. No Pulse write.
 *   200 { ok, selector, n, rows }    400 bad_args | invalid_ist_date    401 unauthorized    503 not_configured
 */
import { NextRequest, NextResponse } from "next/server";
import { consultResultsRead } from "@/lib/mcp/tools/s8";
import { checkRebReadBearer } from "@/lib/reb/read-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const auth = checkRebReadBearer(req.headers.get("authorization"));
  if (auth) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const url = new URL(req.url);
  const day = url.searchParams.get("ist_date");
  const listed = url.searchParams.get("consult_uids");
  const include = url.searchParams.get("include_text") === "1";
  const sealed = url.searchParams.get("sealed") === "1";
  const uids = listed ? listed.split(",").map((s) => s.trim()).filter((s) => s.length > 0) : undefined;
  if (!uids?.length && !day) return NextResponse.json({ ok: false, error: "bad_args" }, { status: 400 });
  try {
    const out = await consultResultsRead({ consult_uids: uids, ist_date: day, include_text: include, sealed_only: sealed });
    const status = out.ok === false && (out.error === "invalid_ist_date" || out.error === "bad_args") ? 400 : 200;
    return NextResponse.json(out, { status, headers: { "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `db:${(e as { code?: string }).code ?? "unknown"}` }, { status: 503 });
  }
}
