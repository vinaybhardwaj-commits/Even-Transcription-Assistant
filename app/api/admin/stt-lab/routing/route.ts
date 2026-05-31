/** GET /api/admin/stt-lab/routing — routing matrix + engines. PUT — set a cell. */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";

const STAGES = ["live", "note"];
const BUCKETS = ["english", "indic"];

export async function GET(_req: NextRequest) {
  const cookie = await readAdminCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  try { await verifyAdminJwt(cookie); } catch { return respondError("AUTH_EXPIRED", "Session invalid"); }
  const routing = (await sql`SELECT stage, language_bucket, engine_id, updated_at FROM stt_routing ORDER BY stage, language_bucket`) as unknown[];
  const engines = (await sql`SELECT id, display_name, enabled, capabilities_json FROM stt_engine ORDER BY sort_order, id`) as unknown[];
  return respondOk({ routing, engines, stages: STAGES, buckets: BUCKETS });
}

export async function PUT(req: NextRequest) {
  const cookie = await readAdminCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  let adminId = "";
  try { adminId = String((await verifyAdminJwt(cookie)).admin_id ?? ""); } catch { return respondError("AUTH_EXPIRED", "Session invalid"); }
  const ar = (await sql`SELECT role FROM admin_user WHERE id = ${adminId}::uuid LIMIT 1`) as Array<{ role: string }>;
  if (ar[0]?.role === "viewer") return respondError("FORBIDDEN", "Read-only admins cannot edit routing");

  let body: { stage?: string; language_bucket?: string; engine_id?: string } = {};
  try { body = (await req.json()) as typeof body; } catch { return respondError("VALIDATION_FAILED", "body_not_json"); }
  if (!body.stage || !body.language_bucket || !body.engine_id) return respondError("VALIDATION_FAILED", "stage_bucket_engine_required");

  await sql`
    INSERT INTO stt_routing (stage, language_bucket, engine_id, updated_by_admin_id, updated_at)
    VALUES (${body.stage}, ${body.language_bucket}, ${body.engine_id}, ${adminId || null}, NOW())
    ON CONFLICT (stage, language_bucket) DO UPDATE SET engine_id = EXCLUDED.engine_id, updated_by_admin_id = EXCLUDED.updated_by_admin_id, updated_at = NOW()
  `;
  try {
    await sql`INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
              VALUES ('admin', ${adminId || null}, 'stt_routing.set', 'stt_routing', ${body.stage + ":" + body.language_bucket}, ${JSON.stringify({ engine_id: body.engine_id })}::jsonb)`;
  } catch { /* best-effort */ }
  return respondOk({ ok: true });
}
