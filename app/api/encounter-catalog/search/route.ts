/**
 * GET /api/encounter-catalog/search?doctor_uid=&from=&to=&room=&has_prescription=&cursor=&limit= — read the encounter catalog (migration 0168).
 *
 * Auth: ADMIN_TOKEN ONLY, via `Authorization: Bearer <token>` (lib/admin-gate requireAdmin; an unset token refuses). Internal admins only (V, 14 Oct): the rows carry the C3 identity
 * columns (doctor_name, patient_name, individual_uid, prescription_uid, presc_state: PHI) and the prescription jsonb. REB_INDEX_READ_TOKEN and every other token are refused (401).
 * from / to are ist_date bounds (inclusive, YYYY-MM-DD); has_prescription is true|false; newest first, keyset paged by `cursor` (opaque, from next_cursor); limit 1..500 (default 100).
 *   200 { ok, count, next_cursor, rows }   rows as stored: ids, UTC times, R2 keys, layer status, stage states, allowance; no text exists
 *   400 { ok:false, error }                a code, never the value
 *   401                                    auth
 *   503 { ok:false, error: "db:<sqlstate>" }
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-gate";
import { parseSearch, searchCatalog } from "@/lib/encounter-catalog/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NO_STORE = { headers: { "cache-control": "no-store" } };

export async function GET(req: NextRequest) {
  // INTERNAL ADMINS ONLY (V, 14 Oct): rows carry identity (names, individual / prescription uid, presc_state) and the prescription join. No other token, including the box's REB read token, is accepted.
  const denied = requireAdmin(req);
  if (denied) return denied;
  const parsed = parseSearch(req.nextUrl.searchParams);
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400, ...NO_STORE });
  try {
    const out = await searchCatalog(parsed.q);
    return NextResponse.json({ ok: true, count: out.rows.length, next_cursor: out.next_cursor, rows: out.rows }, NO_STORE);
  } catch (e) {
    const code = (e as { code?: string }).code ?? "unknown";
    return NextResponse.json({ ok: false, error: `db:${code}` }, { status: 503, ...NO_STORE });
  }
}
