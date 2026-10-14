import { NextRequest } from "next/server";
import { portalJson } from "@/lib/portal/forbidden-keys";
import { neon } from "@neondatabase/serverless";
import { getCurrentPhysician } from "@/lib/physician-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GET — my resignation requests. POST — submit a request (admin processes it; doctors never self-change status). */
export async function GET() {
  const me = await getCurrentPhysician();
  if (!me) return portalJson({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE });
  const url = process.env.DATABASE_URL;
  if (!url) return portalJson({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);
  const rows = (await sql`
    SELECT r.id::text AS id, r.reason, r.intended_last_date, r.status, r.requested_at, h.code AS hospital_code
    FROM resignation_requests r LEFT JOIN hospitals h ON h.id = r.hospital_id
    WHERE r.physician_id = ${me.physicianId}::uuid ORDER BY r.requested_at DESC
  `) as Array<Record<string, unknown>>;
  return portalJson({ ok: true, rows }, { headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  const me = await getCurrentPhysician();
  if (!me) return portalJson({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE });
  const { reason, intended_last_date, hospital_id } = (await req.json().catch(() => ({}))) as { reason?: string; intended_last_date?: string; hospital_id?: string };
  if (!reason || !reason.trim()) return portalJson({ ok: false, error: "Please give a reason." }, { status: 400, headers: NO_STORE });
  if (hospital_id && !UUID_RE.test(hospital_id)) return portalJson({ ok: false, error: "invalid hospital_id" }, { status: 400, headers: NO_STORE });

  const url = process.env.DATABASE_URL;
  if (!url) return portalJson({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  // If a hospital is named, it must be one of the physician's engagements.
  if (hospital_id) {
    const ok = (await sql`SELECT 1 FROM physician_engagements WHERE physician_id = ${me.physicianId}::uuid AND hospital_id = ${hospital_id}::uuid LIMIT 1`) as Array<unknown>;
    if (ok.length === 0) return portalJson({ ok: false, error: "You have no engagement at that hospital." }, { status: 400, headers: NO_STORE });
  }
  // Block a duplicate open request for the same scope
  const dup = (await sql`SELECT 1 FROM resignation_requests WHERE physician_id = ${me.physicianId}::uuid AND status = 'pending' AND COALESCE(hospital_id::text,'') = ${hospital_id ?? ''} LIMIT 1`) as Array<unknown>;
  if (dup.length > 0) return portalJson({ ok: false, error: "You already have a pending resignation request for this scope." }, { status: 409, headers: NO_STORE });

  const ins = (await sql`
    INSERT INTO resignation_requests (physician_id, hospital_id, reason, intended_last_date, status)
    VALUES (${me.physicianId}::uuid, ${hospital_id ?? null}, ${reason.trim()}, ${intended_last_date || null}, 'pending')
    RETURNING id::text AS id
  `) as Array<{ id: string }>;
  await sql`INSERT INTO audit_log_v2 (action, entity_type, entity_id, after_json) VALUES ('resignation_request', 'physician', ${me.physicianId}, ${JSON.stringify({ request_id: ins[0].id, hospital_id: hospital_id ?? null, via: "portal" })}::jsonb)`;
  return portalJson({ ok: true, id: ins[0].id }, { headers: NO_STORE });
}
