/**
 * GET /api/spine/explorer/day?ist_date=YYYY-MM-DD[&room_id=] — per room: encounters by status, flag counts, signals by proxy, jobs per stage by status + oldest queued age (Spine S4b, read-only).
 * Auth: the catalog's admin bearer (ADMIN_TOKEN, Authorization header only; any `token` query param is 401). spine_config `explorer` missing, malformed or off -> 404.
 *   200 { ok, ist_date, rooms }   400 { ok:false, error }   401   404   503 db:<sqlstate>.   Ids, times and counts only.
 */
import { NextRequest, NextResponse } from "next/server";
import { dayView, parseDay } from "@/lib/spine/explorer-read";
import { dbFail, explorerGate, fail, NO_STORE } from "@/lib/spine/explorer-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const denied = await explorerGate(req);
  if (denied) return denied;
  const parsed = parseDay(req.nextUrl.searchParams);
  if (!parsed.ok) return fail(400, parsed.error);
  try {
    return NextResponse.json({ ok: true, ...(await dayView(parsed.q, Date.now())) }, NO_STORE);
  } catch (e) { return dbFail(e); }
}
