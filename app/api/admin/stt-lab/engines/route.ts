/** GET /api/admin/stt-lab/engines — registry list. PATCH — toggle enabled/fanout + set cost. */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";

export async function GET(_req: NextRequest) {
  const cookie = await readAdminCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  try { await verifyAdminJwt(cookie); } catch { return respondError("AUTH_EXPIRED", "Session invalid"); }
  const engines = (await sql`
    SELECT id, display_name, adapter_key, capabilities_json, enabled, fanout_enabled, is_paid, cost_per_min_usd, sort_order
      FROM stt_engine ORDER BY sort_order ASC, id ASC
  `) as unknown[];
  return respondOk({ engines });
}

export async function PATCH(req: NextRequest, ) {
  const cookie = await readAdminCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  let adminId = "";
  try { adminId = String((await verifyAdminJwt(cookie)).admin_id ?? ""); } catch { return respondError("AUTH_EXPIRED", "Session invalid"); }
  const ar = (await sql`SELECT role FROM admin_user WHERE id = ${adminId}::uuid LIMIT 1`) as Array<{ role: string }>;
  if (ar[0]?.role === "viewer") return respondError("FORBIDDEN", "Read-only admins cannot edit engines");

  let body: { id?: string; enabled?: boolean; fanout_enabled?: boolean; cost_per_min_usd?: number | null } = {};
  try { body = (await req.json()) as typeof body; } catch { return respondError("VALIDATION_FAILED", "body_not_json"); }
  if (!body.id) return respondError("VALIDATION_FAILED", "id_required");

  if (typeof body.enabled === "boolean") await sql`UPDATE stt_engine SET enabled = ${body.enabled} WHERE id = ${body.id}`;
  if (typeof body.fanout_enabled === "boolean") await sql`UPDATE stt_engine SET fanout_enabled = ${body.fanout_enabled} WHERE id = ${body.id}`;
  if (body.cost_per_min_usd !== undefined) await sql`UPDATE stt_engine SET cost_per_min_usd = ${body.cost_per_min_usd} WHERE id = ${body.id}`;
  const row = (await sql`SELECT id, enabled, fanout_enabled, cost_per_min_usd FROM stt_engine WHERE id = ${body.id} LIMIT 1`) as unknown[];
  return respondOk({ ok: true, engine: row[0] ?? null });
}
