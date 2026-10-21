/**
 * GET /api/spine/explorer/encounters?ist_date=&room_id=&status=&flag=&cursor=&limit= — a page (max 200, default 100) of spine_encounter, oldest first (Spine S4b, read-only).
 * Rows: encounter_id, room_id, t_open, t_close, status, anchor_proxy, flags, proxies_seen, jobs (stage -> latest status), artefact_count (+ merged_into, ist_date, boundary_rev, merge_version, reason, created_at, updated_at).
 * Auth and gate as ../day. `flag` filters with flags @> ARRAY[..] (the GIN index serves @> only).
 *   200 { ok, count, next_cursor, rows }   400   401   404   503
 */
import { NextRequest, NextResponse } from "next/server";
import { encounterPage, parsePage } from "@/lib/spine/explorer-read";
import { dbFail, explorerGate, fail, NO_STORE } from "@/lib/spine/explorer-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const denied = await explorerGate(req);
  if (denied) return denied;
  const parsed = parsePage(req.nextUrl.searchParams);
  if (!parsed.ok) return fail(400, parsed.error);
  try {
    const out = await encounterPage(parsed.q);
    return NextResponse.json({ ok: true, count: out.rows.length, next_cursor: out.next_cursor, rows: out.rows }, NO_STORE);
  } catch (e) { return dbFail(e); }
}
