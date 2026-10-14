/**
 * GET /api/encounter-catalog/search?doctor_uid=&from=&to=&room=&has_prescription=&cursor=&limit= — read the encounter catalog (migration 0168).
 *
 * Auth: ADMIN_TOKEN via `Authorization: Bearer <token>` (lib/admin-gate requireAdmin; an unset token refuses): internal admins, who also get the identity columns
 * (doctor_name, patient_name, individual_uid, prescription_uid, presc_state: PHI, from the C3 join) and may filter on prescription_uid / individual_uid. ALSO accepted, GET only, WITHOUT identity: a bearer equal to
 * REB_INDEX_READ_TOKEN (constant-time compare, bearer header only; unset/blank means only ADMIN_TOKEN works), as app/api/encounter-windows does.
 * from / to are ist_date bounds (inclusive, YYYY-MM-DD); has_prescription is true|false; newest first, keyset paged by `cursor` (opaque, from next_cursor); limit 1..500 (default 100).
 *   200 { ok, count, next_cursor, rows }   rows as stored: ids, UTC times, R2 keys, layer status, stage states, allowance; no text exists
 *   400 { ok:false, error }                a code, never the value
 *   403 admin_only_filter                  the read token asked to filter on prescription_uid / individual_uid
 *   401                                    auth
 *   503 { ok:false, error: "db:<sqlstate>" }
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-gate";
import { parseSearch, searchCatalog } from "@/lib/encounter-catalog/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NO_STORE = { headers: { "cache-control": "no-store" } };
const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

function hasReadToken(req: NextRequest): boolean {
  const expected = (process.env.REB_INDEX_READ_TOKEN ?? "").trim();
  if (expected === "") return false;
  const header = req.headers.get("authorization") || "";
  const presented = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  return presented !== "" && timingSafeEqual(digest(presented), digest(expected));
}

export async function GET(req: NextRequest) {
  // An ADMIN_TOKEN holder is an internal admin and sees the identity columns; the box's read token (REB_INDEX_READ_TOKEN) does not, and may not filter on them.
  const admin = requireAdmin(req) === null;
  const denied = admin || hasReadToken(req) ? null : requireAdmin(req);
  if (denied) return denied;
  const parsed = parseSearch(req.nextUrl.searchParams);
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400, ...NO_STORE });
  if (!admin && (parsed.q.prescription_uid || parsed.q.individual_uid)) return NextResponse.json({ ok: false, error: "admin_only_filter" }, { status: 403, ...NO_STORE });
  try {
    const out = await searchCatalog(parsed.q, admin);
    return NextResponse.json({ ok: true, count: out.rows.length, next_cursor: out.next_cursor, rows: out.rows }, NO_STORE);
  } catch (e) {
    const code = (e as { code?: string }).code ?? "unknown";
    return NextResponse.json({ ok: false, error: `db:${code}` }, { status: 503, ...NO_STORE });
  }
}
